// electron/speechInstall.cjs —— 语音包安装（下载 / 解压 / 校验 / 状态 / 删除）
//
// 设计约束（方案 6.3.1 / 6.9）：
//   · 模型不进安装包，存 <userData>/speech/models/，换模型不动应用；
//   · 以 .tar.bz2 分发，用系统 tar 解压（Windows 10 1803+ 自带 bsdtar），不新增依赖；
//   · 下载走 GitHub Releases，失败可见（不静默），支持取消；
//   · 解压成功后做完整性校验（关键文件齐全 + 体积合理），再写入 manifest；
//   · 模型文件巨大，安装过程中任何一步失败都要清理半成品，避免下次「看起来已安装」。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app } = require('electron');

/** 语音包目录（可用 BOSSCLAW_SPEECH_DIR 覆盖，便于开发期用本地已下载的模型验证） */
function rootDir() {
  const override = String(process.env.BOSSCLAW_SPEECH_DIR || '').trim();
  return override || path.join(app.getPath('userData'), 'speech');
}
function modelsDir() { return path.join(rootDir(), 'models'); }
function downloadsDir() { return path.join(rootDir(), 'downloads'); }
function cacheDir() { return path.join(rootDir(), 'cache'); }
function ttsDir() { return path.join(modelsDir(), 'tts'); }
function asrDir() { return path.join(modelsDir(), 'asr'); }
function cloneDir() { return path.join(modelsDir(), 'clone'); }
function manifestPath() { return path.join(rootDir(), 'manifest.json'); }

/**
 * 语音包目录。体积为归档体积（解压后更大；状态里显示归档体积与解压后体积两种口径）。
 * 只放「听」这一包（P2）；「说」（SenseVoice）在 P4 接入。
 */
const PACKS = {
  tts: {
    id: 'tts',
    name: 'Kokoro 多语言语音包',
    desc: '本地离线朗读题干与追问；24kHz，含 100+ 中文音色',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
    archiveBytes: 364816464,
    archiveRoot: 'kokoro-multi-lang-v1_1',
    // 解压后必须存在的文件/目录（缺一即判定安装不完整）
    required: ['voices.bin', 'tokens.txt', 'espeak-ng-data'],
    modelFiles: ['model.int8.onnx', 'model.onnx'],
  },
  // 「说」包：SenseVoice int8 + tokens。直接按文件下载，不打 tar（HF 镜像上就是散文件）。
  // 不用 GitHub Releases：这台机器到 release-assets 的链路会 502，HF 镜像稳定。
  asr: {
    id: 'asr',
    name: 'SenseVoice 语音识别包',
    desc: '本地离线转写你的口头回答；中/英/日/韩/粤，自带标点与数字规整',
    dirName: 'asr',
    required: ['model.int8.onnx', 'tokens.txt'],
    files: [
      {
        name: 'model.int8.onnx',
        url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
        bytes: 239233841,
      },
      {
        name: 'tokens.txt',
        url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
        bytes: 315894,
      },
    ],
    archiveBytes: 239233841 + 315894,
  },
  // 「克隆」包：ZipVoice distill int8（encoder/decoder/lexicon/tokens/espeak-ng-data）
  // + vocos 24k 声码器。两段来源不同（tar 包 + 裸 onnx），所以安装分两步。
  // 实测：归档 104.1MB + 54.2MB，解压后约 197MB；加载 1.8s，RTF≈1.04。
  clone: {
    id: 'clone',
    name: 'ZipVoice 克隆音色包',
    desc: '零样本克隆你的声音：3–10 秒参考音频即可；只用于题干预生成',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2',
    archiveBytes: 109162785,
    archiveRoot: 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
    vocoder: {
      name: 'vocos_24khz.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx',
      bytes: 54157409,
    },
  },
};

function readManifest() {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 缺失/损坏按空处理 */ }
  return { packs: {} };
}

function writeManifest(m) {
  try {
    fs.mkdirSync(rootDir(), { recursive: true });
    const tmp = `${manifestPath()}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, manifestPath());
  } catch { /* manifest 只是索引：写失败时按目录探测仍能工作 */ }
}

// ===== 语音设置（<userData>/speech/settings.json）=====
// 只放「引擎选择」这类用户偏好（体积近乎为零），与 manifest 同一套 tmp+rename 原子写。
// 与模型目录同处 speech/ 下：换模型/删语音包都不该动用户的引擎偏好。
function settingsPath() { return path.join(rootDir(), 'settings.json'); }

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 缺失/损坏按默认处理 */ }
  return {};
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  try {
    fs.mkdirSync(rootDir(), { recursive: true });
    const tmp = `${settingsPath()}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath());
  } catch { /* 偏好写失败不该阻断朗读：调用方不依赖落盘成功 */ }
  return next;
}

/** 在线高音质引擎是否开启（默认关；方案 6.6：本地优先是定位，联网是唯一例外且须用户主动开） */
function getOnlineEngine() { return readSettings().onlineEngine === true; }

function setOnlineEngine(on) {
  writeSettings({ onlineEngine: Boolean(on) });
  return { ok: true, onlineEngine: Boolean(on) };
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return total;
}

function findModelFile(dir) {
  for (const f of PACKS.tts.modelFiles) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 目录里是否是一个完整的 Kokoro 包 */
function isCompleteTtsDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (!findModelFile(dir)) return false;
  return PACKS.tts.required.every((f) => fs.existsSync(path.join(dir, f)));
}

function isCompleteAsrDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return PACKS.asr.required.every((f) => {
    try { return fs.statSync(path.join(dir, f)).size > 1024; } catch { return false; }
  });
}

function resolveAsrDir() {
  if (isCompleteAsrDir(asrDir())) return asrDir();
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteAsrDir(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 克隆包完整性：encoder / decoder / 声码器 / tokens 四类齐全。
 * 不带 test_wavs 也能用（它只是样例），但没声码器加载必失败——这一步拦住比运行时 C++ 报错好。
 */
function cloneFilesIn(dir) {
  const list = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  return {
    encoder: list.find((f) => /^encoder.*\.onnx$/i.test(f)) || '',
    decoder: list.find((f) => /^decoder.*\.onnx$/i.test(f)) || '',
    vocoder: list.find((f) => /^(vocoder|vocos).*\.onnx$/i.test(f)) || '',
    tokens: list.includes('tokens.txt') ? 'tokens.txt' : '',
  };
}

function isCompleteCloneDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const f = cloneFilesIn(dir);
  return Boolean(f.encoder && f.decoder && f.vocoder && f.tokens);
}

function resolveCloneDir() {
  if (isCompleteCloneDir(cloneDir())) return cloneDir();
  // 兼容手动放置：models/ 下任意一个完整 zipvoice 目录
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteCloneDir(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

/** 供克隆合成使用（未安装返回 null） */
function zipvoiceConfig() {
  const dir = resolveCloneDir();
  if (!dir) return null;
  const f = cloneFilesIn(dir);
  return {
    engine: 'zipvoice',
    encoder: path.join(dir, f.encoder),
    decoder: path.join(dir, f.decoder),
    vocoder: path.join(dir, f.vocoder),
    tokens: path.join(dir, f.tokens),
    dataDir: fs.existsSync(path.join(dir, 'espeak-ng-data')) ? path.join(dir, 'espeak-ng-data') : '',
    lexicon: fs.existsSync(path.join(dir, 'lexicon.txt')) ? path.join(dir, 'lexicon.txt') : '',
    numThreads: Math.max(1, Math.min(4, Math.ceil(require('node:os').cpus().length / 2))),
  };
}

function resolveTtsDir() {
  if (isCompleteTtsDir(ttsDir())) return ttsDir();
  // 兼容「手动把解压目录放进 models/」的场景（用户可能自己下载）
  try {
    const entries = fs.readdirSync(modelsDir(), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteTtsDir(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function status() {
  const dir = resolveTtsDir();
  const asr = resolveAsrDir();
  const clone = resolveCloneDir();
  const manifest = readManifest();
  const installed = Boolean(dir);
  // 解压目录有上万个文件，每次 status 都全量 walk 会阻塞主进程；
  // 安装时已把体积写进 manifest，这里优先读缓存值。
  let bytes = installed ? Number((manifest.packs && manifest.packs.tts && manifest.packs.tts.bytes) || 0) : 0;
  if (installed && !bytes) bytes = dirBytes(dir);
  const cacheBytes = dirBytes(cacheDir());
  return {
    ok: true,
    tts: {
      installed,
      dir: dir || '',
      bytes,
      cacheBytes,
      version: (manifest.packs && manifest.packs.tts && manifest.packs.tts.version) || '',
      installedAt: (manifest.packs && manifest.packs.tts && manifest.packs.tts.installedAt) || 0,
      archiveBytes: PACKS.tts.archiveBytes,
      name: PACKS.tts.name,
      desc: PACKS.tts.desc,
    },
    asr: {
      installed: Boolean(asr),
      dir: asr || '',
      bytes: asr ? Number((manifest.packs && manifest.packs.asr && manifest.packs.asr.bytes) || 0) || dirBytes(asr) : 0,
      version: (manifest.packs && manifest.packs.asr && manifest.packs.asr.version) || '',
      installedAt: (manifest.packs && manifest.packs.asr && manifest.packs.asr.installedAt) || 0,
      archiveBytes: PACKS.asr.archiveBytes,
      name: PACKS.asr.name,
      desc: PACKS.asr.desc,
    },
    clone: {
      installed: Boolean(clone),
      dir: clone || '',
      bytes: clone ? Number((manifest.packs && manifest.packs.clone && manifest.packs.clone.bytes) || 0) || dirBytes(clone) : 0,
      version: (manifest.packs && manifest.packs.clone && manifest.packs.clone.version) || '',
      installedAt: (manifest.packs && manifest.packs.clone && manifest.packs.clone.installedAt) || 0,
      archiveBytes: PACKS.clone.archiveBytes + PACKS.clone.vocoder.bytes,
      name: PACKS.clone.name,
      desc: PACKS.clone.desc,
    },
    speechDir: rootDir(),
  };
}

/** 供 ASR worker 使用的模型配置（未安装时返回 null） */
function asrConfig() {
  const dir = resolveAsrDir();
  if (!dir) return null;
  return {
    model: path.join(dir, 'model.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt'),
    numThreads: Math.max(1, Math.min(4, Math.ceil(require('node:os').cpus().length / 2))),
  };
}

/**
 * 可借用的 espeak-ng-data 目录（内置「听」包自带；克隆包通常也带）。
 *
 * 为什么需要：社区 vits 包（Piper 转换版）经常只发模型 + tokens，不发 13MB 音素数据，
 * 缺了它 sherpa 会在 InitFrontend 直接抛英文错——用户看到的是「Not a model using characters...」。
 * 这些音素数据与模型无强绑定（同一份 espeak-ng 数据服务所有 vits 包），借一份即可。
 */
function espeakDataDir() {
  const seen = new Set();
  const candidates = [ttsDir(), cloneDir()];
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) candidates.push(path.join(modelsDir(), e.name));
    }
  } catch { /* models 还没建 */ }
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const p = path.join(dir, 'espeak-ng-data');
    // phontab + phondata 是 espeak-ng 的核心数据，缺一个都跑不起来
    if (fs.existsSync(path.join(p, 'phontab')) && fs.existsSync(path.join(p, 'phondata'))) return p;
  }
  return '';
}

/** 供 TTS worker 使用的模型配置（未安装时返回 null） */
function modelConfig() {
  const dir = resolveTtsDir();
  if (!dir) return null;
  const model = findModelFile(dir);
  const dataDir = path.join(dir, 'espeak-ng-data');
  // 优先中文词典：Kokoro 多语言包同时带 gb-en / us-en / zh，按字母序会先拿到英文词典，
  // 中文题干会被英文音素表念错。
  const lexicon = (() => {
    try {
      const files = fs.readdirSync(dir).filter((x) => /^lexicon.*\.txt$/i.test(x));
      const zh = files.find((x) => /zh/i.test(x));
      const pick = zh || files[0];
      return pick ? path.join(dir, pick) : '';
    } catch { return ''; }
  })();
  return { model, voices: path.join(dir, 'voices.bin'), tokens: path.join(dir, 'tokens.txt'), dataDir, lexicon };
}

// ===== 下载 =====
const installState = {
  active: null, // { pack, aborted, req }
};

function followDownload(url, dest, onProgress, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('下载重定向次数过多')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'BossClaw-SpeechInstaller' } }, (res) => {
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        resolve(followDownload(new URL(res.headers.location, url).toString(), dest, onProgress, signal, redirects + 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`下载失败：HTTP ${code}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      const out = fs.createWriteStream(dest);
      let lastEmit = 0;
      const cleanup = () => { try { out.destroy(); } catch { /* ignore */ } };
      signal.onAbort = () => {
        cleanup();
        try { req.destroy(); } catch { /* ignore */ }
        reject(new Error('已取消'));
      };
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          onProgress({ phase: 'download', received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
        }
      });
      res.on('error', (e) => { cleanup(); reject(e); });
      out.on('error', (e) => { cleanup(); reject(e); });
      out.on('finish', () => {
        onProgress({ phase: 'download', received, total, percent: 100 });
        if (total > 0 && received !== total) {
          reject(new Error(`下载不完整：${received}/${total} 字节`));
          return;
        }
        resolve({ received, total });
      });
      res.pipe(out);
    });
    req.on('error', (e) => reject(e));
    installState.active = { ...(installState.active || {}), req };
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function extractTarBz2(archive, targetDir) {
  return new Promise((resolve, reject) => {
    // Windows 的 bsdtar 会把 `-f C://...` 里的盘符当远程主机（"Cannot connect to C: resolve failed"）。
    // 规避方式：cwd 切到归档所在目录，-f 只传文件名，绝对路径就不进 -f 参数了。
    const cwd = path.dirname(archive);
    const name = path.basename(archive);
    execFile('tar', ['-xjf', name, '-C', targetDir], { cwd, timeout: 10 * 60 * 1000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`解压失败（系统 tar 不可用或文件损坏）：${String(stderr || err.message).slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 在解压目录里找模型根目录。
 * 判定函数可换：克隆包的声码器是后下的，解压完时还不完整，不能用 isCompleteCloneDir 判。
 */
function findExtractedDir(tmpDir, isComplete = isCompleteTtsDir, preferredName = PACKS.tts.archiveRoot) {
  const preferred = path.join(tmpDir, preferredName);
  if (isComplete(preferred)) return preferred;
  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(tmpDir, e.name);
      if (isComplete(p)) return p;
      // 有些包会多套一层目录
      try {
        for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const sp = path.join(p, sub.name);
          if (isComplete(sp)) return sp;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 安装「听」包（下载 → 解压 → 校验 → 落盘）。
 * @param {(p:object)=>void} onProgress
 */
async function installTts(onProgress) {
  if (installState.active) throw new Error('已有安装任务在进行');
  const signal = { onAbort: null };
  installState.active = { pack: 'tts', signal, req: null };

  const downloads = downloadsDir();
  const tmpDir = path.join(modelsDir(), '.tmp-tts');
  const archive = path.join(downloads, 'kokoro-multi-lang-v1_1.tar.bz2');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(modelsDir(), { recursive: true });
  rmrf(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    onProgress({ phase: 'prepare', percent: 0 });
    const dl = await followDownload(PACKS.tts.url, archive, onProgress, signal);
    onProgress({ phase: 'verify', percent: 100 });
    const sha256 = await sha256File(archive);

    onProgress({ phase: 'extract', percent: 100 });
    await extractTarBz2(archive, tmpDir);

    const extracted = findExtractedDir(tmpDir);
    if (!extracted) throw new Error('解压后未找到完整的 Kokoro 模型目录（缺 model.onnx / voices.bin / tokens.txt / espeak-ng-data）');

    // 落盘：先删旧目录再 rename，避免半新半旧
    const target = ttsDir();
    rmrf(target);
    try {
      fs.renameSync(extracted, target);
    } catch {
      // 跨盘/占用时退化为复制
      fs.cpSync(extracted, target, { recursive: true });
    }
    if (!isCompleteTtsDir(target)) throw new Error('安装校验失败：目标目录不完整');

    const bytes = dirBytes(target);
    const manifest = readManifest();
    manifest.packs = manifest.packs || {};
    manifest.packs.tts = {
      version: PACKS.tts.archiveRoot,
      installedAt: Date.now(),
      bytes,
      archiveBytes: dl.received,
      sha256,
      source: PACKS.tts.url,
    };
    writeManifest(manifest);

    onProgress({ phase: 'done', percent: 100, bytes });
    // 归档已解压完，删掉 348MB 临时文件；失败时保留，便于重试不再重下
    rmrf(archive);
    return { ok: true, bytes, sha256 };
  } finally {
    rmrf(tmpDir);
    installState.active = null;
  }
}

/**
 * 安装「克隆」包：ZipVoice tar 解压 + vocos 声码器单独下载。
 * 两个来源必须落在同一目录（运行时用同一份配置读四个文件），所以先都放进 .tmp-clone 再整体 rename。
 */
async function installClone(onProgress) {
  if (installState.active) throw new Error('已有安装任务在进行');
  const signal = { onAbort: null };
  installState.active = { pack: 'clone', signal, req: null };

  const downloads = downloadsDir();
  const tmpDir = path.join(modelsDir(), '.tmp-clone');
  const archive = path.join(downloads, 'zipvoice-distill-int8.tar.bz2');
  const vocoderFile = path.join(downloads, PACKS.clone.vocoder.name);
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(modelsDir(), { recursive: true });
  rmrf(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  let done = false;

  try {
    onProgress({ phase: 'prepare', percent: 0, pack: 'clone' });
    // 第一段：模型 tar（占总进度 2/3）
    const dl = await followDownload(PACKS.clone.url, archive, (p) => {
      onProgress({ ...p, pack: 'clone', percent: Math.round((p.percent || 0) * (2 / 3)), file: 'model.tar.bz2' });
    }, signal);
    onProgress({ phase: 'extract', percent: 66, pack: 'clone' });
    await extractTarBz2(archive, tmpDir);

    const extracted = findExtractedDir(
      tmpDir,
      (p) => Boolean(cloneFilesIn(p).encoder && cloneFilesIn(p).decoder),
      PACKS.clone.archiveRoot,
    );
    if (!extracted) throw new Error('解压后未找到 ZipVoice 模型目录（缺 encoder/decoder）');
    // 拍平：把解压出的子目录内容搬到 tmpDir 根，保证最终目录结构固定
    if (path.resolve(extracted) !== path.resolve(tmpDir)) {
      for (const name of fs.readdirSync(extracted)) {
        fs.renameSync(path.join(extracted, name), path.join(tmpDir, name));
      }
      rmrf(extracted);
    }

    // 第二段：声码器（占 1/3）
    const v = PACKS.clone.vocoder;
    await followDownload(v.url, vocoderFile, (p) => {
      onProgress({
        ...p,
        pack: 'clone',
        percent: 66 + Math.round((p.percent || 0) / 3),
        file: v.name,
      });
    }, signal);
    const vst = (() => { try { return fs.statSync(vocoderFile); } catch { return null; } })();
    if (!vst || vst.size < 10 * 1024 * 1024) {
      throw new Error(`声码器下载结果异常（${vst ? vst.size : 0} 字节）`);
    }
    fs.renameSync(vocoderFile, path.join(tmpDir, v.name));

    if (!isCompleteCloneDir(tmpDir)) {
      const f = cloneFilesIn(tmpDir);
      const missing = [
        !f.encoder ? 'encoder.onnx' : '',
        !f.decoder ? 'decoder.onnx' : '',
        !f.vocoder ? 'vocos_24khz.onnx' : '',
        !f.tokens ? 'tokens.txt' : '',
      ].filter(Boolean);
      throw new Error(`安装校验失败，缺少：${missing.join('、')}`);
    }

    const target = cloneDir();
    rmrf(target);
    try {
      fs.renameSync(tmpDir, target);
    } catch {
      fs.cpSync(tmpDir, target, { recursive: true });
    }
    if (!isCompleteCloneDir(target)) throw new Error('安装校验失败：目标目录不完整');

    const bytes = dirBytes(target);
    const manifest = readManifest();
    manifest.packs = manifest.packs || {};
    manifest.packs.clone = {
      version: PACKS.clone.archiveRoot,
      installedAt: Date.now(),
      bytes,
      archiveBytes: dl.received + (vst ? vst.size : 0),
      source: `${PACKS.clone.url} ${v.url}`,
    };
    writeManifest(manifest);
    onProgress({ phase: 'done', percent: 100, bytes, pack: 'clone' });
    done = true;
    rmrf(archive);
    return { ok: true, bytes };
  } finally {
    rmrf(tmpDir);
    if (!done) {
      try { fs.unlinkSync(archive); } catch { /* 未下载或已移走 */ }
      try { fs.unlinkSync(vocoderFile); } catch { /* 同上 */ }
    }
    installState.active = null;
  }
}

function removeClone() {
  rmrf(cloneDir());
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteCloneDir(p)) rmrf(p);
    }
  } catch { /* ignore */ }
  const manifest = readManifest();
  if (manifest.packs) delete manifest.packs.clone;
  writeManifest(manifest);
  return { ok: true };
}

/**
 * 安装「说」包（逐个文件下载 → 校验体积 → 原子落盘）。
 * 任何一个文件失败都清理 tmp 目录，不会出现「半个模型」。
 */
async function installAsr(onProgress) {
  if (installState.active) throw new Error('已有安装任务在进行');
  const signal = { onAbort: null };
  installState.active = { pack: 'asr', signal, req: null };

  const downloads = downloadsDir();
  const tmpDir = path.join(modelsDir(), '.tmp-asr');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(modelsDir(), { recursive: true });
  rmrf(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  let done = false;

  try {
    onProgress({ phase: 'prepare', percent: 0, pack: 'asr' });
    const files = PACKS.asr.files;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const dest = path.join(downloads, f.name);
      const wrap = (p) => {
        // 总体进度按文件序号折算，避免第二个文件时进度条从头开始
        const overall = Math.round(((i + (p.percent || 0) / 100) / files.length) * 100);
        onProgress({ ...p, percent: overall, pack: 'asr', file: f.name, fileIndex: i + 1, fileTotal: files.length });
      };
      await followDownload(f.url, dest, wrap, signal);
      const st = (() => { try { return fs.statSync(dest); } catch { return null; } })();
      if (!st || st.size < 1024) throw new Error(`${f.name} 下载结果异常（${st ? st.size : 0} 字节）`);
      // 官方体积有偏差时只警告不失败（镜像可能重新打包），完整性交给模型加载验证
      if (st.size !== f.bytes) {
        onProgress({
          phase: 'verify',
          percent: Math.round(((i + 1) / files.length) * 100),
          pack: 'asr',
          file: f.name,
          note: `体积与预期不同：${st.size} / ${f.bytes}`,
        });
      }
      fs.renameSync(dest, path.join(tmpDir, f.name));
    }

    if (!isCompleteAsrDir(tmpDir)) throw new Error('安装校验失败：模型或词表缺失');
    const target = asrDir();
    rmrf(target);
    try {
      fs.renameSync(tmpDir, target);
    } catch {
      fs.cpSync(tmpDir, target, { recursive: true });
    }
    if (!isCompleteAsrDir(target)) throw new Error('安装校验失败：目标目录不完整');

    const bytes = dirBytes(target);
    const manifest = readManifest();
    manifest.packs = manifest.packs || {};
    manifest.packs.asr = {
      version: 'sense-voice-zh-en-ja-ko-yue-2024-07-17-int8',
      installedAt: Date.now(),
      bytes,
      source: PACKS.asr.files.map((f) => f.url).join(' '),
    };
    writeManifest(manifest);
    onProgress({ phase: 'done', percent: 100, bytes, pack: 'asr' });
    done = true;
    return { ok: true, bytes };
  } finally {
    rmrf(tmpDir);
    // 失败/取消时清掉半份下载（228MB 留着没有意义，下次还得重下）
    if (!done) {
      for (const f of PACKS.asr.files) {
        try { fs.unlinkSync(path.join(downloads, f.name)); } catch { /* 未下载或已移走 */ }
      }
    }
    installState.active = null;
  }
}

function removeAsr() {
  rmrf(asrDir());
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteAsrDir(p)) rmrf(p);
    }
  } catch { /* ignore */ }
  const manifest = readManifest();
  if (manifest.packs) delete manifest.packs.asr;
  writeManifest(manifest);
  return { ok: true };
}

function cancel() {
  const st = installState.active;
  if (!st) return { ok: true, canceled: false };
  try { if (st.signal && st.signal.onAbort) st.signal.onAbort(); } catch { /* ignore */ }
  try { if (st.req) st.req.destroy(); } catch { /* ignore */ }
  return { ok: true, canceled: true };
}

function clearCache() {
  const before = dirBytes(cacheDir());
  rmrf(cacheDir());
  return { ok: true, freedBytes: before };
}

function remove() {
  rmrf(ttsDir());
  // 兼容手动放置的目录：只删 models 下能识别为完整 TTS 的目录
  try {
    for (const e of fs.readdirSync(modelsDir(), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(modelsDir(), e.name);
      if (isCompleteTtsDir(p)) rmrf(p);
    }
  } catch { /* ignore */ }
  rmrf(cacheDir());
  const manifest = readManifest();
  if (manifest.packs) delete manifest.packs.tts;
  writeManifest(manifest);
  return { ok: true };
}

module.exports = {
  PACKS,
  status,
  modelConfig,
  asrConfig,
  zipvoiceConfig,
  espeakDataDir,
  installTts,
  installAsr,
  installClone,
  removeAsr,
  removeClone,
  cancel,
  clearCache,
  remove,
  cacheDir,
  rootDir,
  // 语音偏好（在线引擎开关）
  settingsPath,
  readSettings,
  getOnlineEngine,
  setOnlineEngine,
  // 诊断
  _ttsDir: ttsDir,
  _asrDir: asrDir,
  _cloneDir: cloneDir,
  _isCompleteClone: isCompleteCloneDir,
  _isCompleteAsr: isCompleteAsrDir,
  _isComplete: isCompleteTtsDir,
  _dirBytes: dirBytes,
};
