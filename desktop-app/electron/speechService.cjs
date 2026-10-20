// electron/speechService.cjs —— 语音服务（主进程侧）：拉起 utilityProcess、转发请求、WAV 缓存
//
// 分层：
//   主进程（本文件）→ utilityProcess（speechWorker.cjs）→ sherpa-onnx-node
// 主进程只做三件事：进程生命周期、请求关联与超时、Float32 → WAV 与缓存。
//
// 关键约束（方案 6.3.1）：
//   · fork 前把平台二进制目录注入动态库搜索路径，否则 .node 找不到 onnxruntime.dll；
//   · 不使用 electron-rebuild（N-API ABI 稳定）；
//   · 原生崩溃不能带走应用：worker exit 后清空实例，下一次请求自动重启一次。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const install = require('./speechInstall.cjs');
const voiceRepo = require('./mockInterviewVoiceRepo.cjs');
const voicePack = require('./mockInterviewVoicePack.cjs');
const edgeTts = require('./edgeTts.cjs');

let child = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer, label }
let lastError = '';
let initPromise = null;
let initKey = '';
// ASR 与 TTS 各自惰性加载：只装「说」包的用户不该被要求先装「听」包
let asrPromise = null;
let asrInitKey = '';
let startedAt = 0;

const PLATFORM_PACKAGES = [
  'sherpa-onnx-win-x64',
  'sherpa-onnx-win-ia32',
  'sherpa-onnx-linux-x64',
  'sherpa-onnx-linux-arm64',
  'sherpa-onnx-osx-x64',
  'sherpa-onnx-osx-arm64',
];

function platformPackageDir() {
  for (const name of PLATFORM_PACKAGES) {
    try {
      return path.dirname(require.resolve(`${name}/package.json`));
    } catch { /* 非当前平台 */ }
  }
  return '';
}

function withPlatformPath(env) {
  const dir = platformPackageDir();
  const next = { ...env };
  if (dir) {
    const key = process.platform === 'win32' ? 'PATH'
      : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    next[key] = `${dir}${path.delimiter}${next[key] || ''}`;
    // Windows 上 .dll 只认 PATH；POSIX 上两者都补一份，避免个别发行版只读其中一个
    if (process.platform !== 'win32') next.PATH = `${dir}${path.delimiter}${next.PATH || ''}`;
  }
  return next;
}

function rejectAll(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    try { p.reject(new Error(reason)); } catch { /* ignore */ }
    pending.delete(id);
  }
}

function ensureWorker() {
  if (child) return child;
  const { utilityProcess } = require('electron');
  const workerPath = path.join(__dirname, 'speechWorker.cjs');
  if (!fs.existsSync(workerPath)) throw new Error('语音运行时文件缺失（speechWorker.cjs）');
  let proc;
  try {
    proc = utilityProcess.fork(workerPath, [], {
      serviceName: 'bossclaw-speech',
      env: withPlatformPath(process.env),
    });
  } catch (e) {
    lastError = `语音进程启动失败：${String((e && e.message) || e)}`;
    throw new Error(lastError);
  }
  proc.on('message', (msg) => {
    const id = msg && msg.id;
    const p = pending.get(id);
    if (!p) return;
    // 流式分块不是应答：不摘掉 pending、不动超时，只转给调用方
    if (msg.stream === 'chunk') {
      if (typeof p.onChunk === 'function') {
        try { p.onChunk(msg); } catch { /* 单个分块处理失败不能拖垮整条流 */ }
      }
      return;
    }
    clearTimeout(p.timer);
    pending.delete(id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(String(msg.error || '语音运行时错误')));
  });
  proc.on('exit', (code) => {
    child = null;
    initPromise = null;
    initKey = '';
    asrPromise = null;
    asrInitKey = '';
    lastError = `语音进程已退出（code ${code}）`;
    rejectAll(lastError);
  });
  child = proc;
  startedAt = Date.now();
  return proc;
}

function request(cmd, payload, timeoutMs, label, onChunk) {
  const proc = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label || cmd} 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, label, onChunk });
    try {
      proc.postMessage({ id, cmd, payload });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`向语音进程发送请求失败：${String((e && e.message) || e)}`));
    }
  });
}

async function ensureInit(cfg) {
  if (!cfg) throw new Error('语音包尚未安装');
  const key = [cfg.engine || 'kokoro', cfg.model, cfg.voices, cfg.tokens, cfg.dataDir, cfg.lexicon, cfg.encoder, cfg.decoder].join('|');
  if (initPromise && initKey === key) return initPromise;
  initKey = key;
  initPromise = request('init', cfg, 180000, '加载语音模型')
    .catch((e) => {
      initPromise = null;
      initKey = '';
      lastError = String((e && e.message) || e);
      throw e;
    });
  return initPromise;
}

async function ensureAsrInit() {
  const cfg = install.asrConfig();
  if (!cfg) throw new Error('语音识别包尚未安装');
  const key = [cfg.model, cfg.tokens].join('|');
  if (asrPromise && asrInitKey === key) return asrPromise;
  asrInitKey = key;
  asrPromise = request('init-asr', cfg, 180000, '加载语音识别模型').catch((e) => {
    asrPromise = null;
    asrInitKey = '';
    lastError = String((e && e.message) || e);
    throw e;
  });
  return asrPromise;
}

/**
 * 转写一段 16k Float32 录音。
 * @param {{samplesBase64:string, sampleRate?:number, segments?:Array<{start:number,end:number}>}} opts
 */
async function recognize(opts) {
  const b64 = String((opts && opts.samplesBase64) || '');
  if (!b64) return { ok: false, error: '录音数据为空' };
  const sampleRate = Number(opts && opts.sampleRate) || 16000;
  const bytes = Math.floor((b64.length * 3) / 4);
  const durationSec = bytes / 4 / sampleRate;
  if (durationSec > 180) return { ok: false, error: '单次录音过长（上限 3 分钟），请分段作答' };
  try {
    await ensureAsrInit();
    const r = await request(
      'asr',
      { samplesBase64: b64, sampleRate, segments: opts && opts.segments ? opts.segments : [] },
      180000,
      '语音识别',
    );
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 预热识别模型（安装完 / 首次进入语音作答时后台调用） */
async function warmupAsr() {
  if (!install.asrConfig()) return { ok: false, error: '语音识别包尚未安装' };
  try {
    const info = await ensureAsrInit();
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ===== WAV 编码（16-bit PCM 单声道；浏览器 <audio> 直接可播）=====
// 实现与 PCM 拼接放在 wav.cjs：分块缓存写盘前要先拼回整段，这段逻辑必须能离线断言。
const { encodeWav, concatFloat32 } = require('./wav.cjs');

function cacheKey(engine, voiceKey, speed, text) {
  // 键必须带音色与引擎：换了克隆音色却命中旧缓存，等于「换了声音还是原声」
  return crypto.createHash('sha1')
    .update(`${engine}|v2|${voiceKey}|${speed}|${text}`)
    .digest('hex');
}

function readCache(key, ext = 'wav') {
  const file = path.join(install.cacheDir(), `${key}.${ext}`);
  try {
    if (!fs.existsSync(file)) return null;
    return { file, buf: fs.readFileSync(file) };
  } catch {
    return null;
  }
}

function writeCache(key, buf, ext = 'wav') {
  // 单条上限 2MB：再大就不缓存，避免一条超长题干把磁盘占满
  if (buf.length > 2 * 1024 * 1024) return '';
  try {
    fs.mkdirSync(install.cacheDir(), { recursive: true });
    const file = path.join(install.cacheDir(), `${key}.${ext}`);
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return '';
  }
}

/** 状态（不触发模型加载；status 只反映进程存活与安装情况） */
function status() {
  const st = install.status();
  return {
    ...st,
    engine: 'kokoro',
    // 在线高音质档（默认关）：值来自 <userData>/speech/settings.json，UI 据此显示开关状态
    onlineEngine: install.getOnlineEngine(),
    workerAlive: Boolean(child),
    lastError,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
  };
}

/**
 * 渲染层请求是否走在线引擎。
 * 只有显式 engine='online' 且是**内置音色**才走在线：
 * 克隆 / 导入音色是用户自己的声学模型，Edge 服务端只认它自己的音色名，必须留在本地。
 */
function wantsOnline(opts) {
  if (String((opts && opts.engine) || '') !== 'online') return false;
  if (!install.getOnlineEngine()) return false;
  const voiceId = String((opts && opts.voiceId) || '');
  return !/^(clone|voice)_/.test(voiceId);
}

function resolveOnlineVoice(opts) {
  return String((opts && opts.onlineVoice) || '').trim() || edgeTts.DEFAULT_VOICE;
}

/**
 * 在线合成一句：命中缓存直接返回 mp3，否则调 Edge 接口并落缓存。
 * 返回值与本地合成同形（`wavBase64` 承载编码后的音频字节），只多一个 `mime`——
 * 渲染层据此决定用 audio/wav 还是 audio/mpeg 建 Blob，播放队列与缓存键完全共用。
 */
async function synthesizeOnline(opts) {
  const text = String((opts && opts.text) || '').trim();
  if (!text) return { ok: false, error: '朗读文本为空' };
  const speed = Math.min(1.5, Math.max(0.5, Number(opts && opts.speed) || 1));
  const voice = resolveOnlineVoice(opts);
  const key = cacheKey('online', voice, speed, text);
  const hit = readCache(key, 'mp3');
  if (hit) {
    return { ok: true, cached: true, engine: 'online', mime: 'audio/mpeg', wavBase64: hit.buf.toString('base64'), bytes: hit.buf.length, ms: 0 };
  }
  const r = await edgeTts.synthesize({ text, voice, speed });
  if (!r.ok) return { ok: false, engine: 'online', error: r.error };
  writeCache(key, r.mp3, 'mp3');
  return {
    ok: true,
    cached: false,
    engine: 'online',
    mime: 'audio/mpeg',
    wavBase64: r.mp3.toString('base64'),
    bytes: r.mp3.length,
    ms: r.ms,
  };
}

/**
 * 合成一句并返回音频（base64）。
 * @param {{text:string, sid:number, speed:number, engine?:'online', onlineVoice?:string}} opts
 */
async function synthesize(opts) {
  if (wantsOnline(opts)) {
    const online = await synthesizeOnline(opts);
    if (online.ok) return online;
    // 静默回落本地（方案 6.6）：在线是非官方接口，任何失败都只影响这一句，不弹错误
    lastError = `在线语音不可用，已回落本地：${online.error}`;
    return { ...(await synthesizeLocal(opts)), fellBack: true, fellBackReason: online.error };
  }
  return synthesizeLocal(opts);
}

/**
 * 解析一次朗读要用哪个音色 / 哪族引擎 / 命中哪个缓存键。
 * 整段合成与流式合成共用这一份判断，否则两条路会漂移（换了克隆音色却命中旧缓存就是这么来的）。
 */
function planVoice(opts) {
  const text = String(opts && opts.text ? opts.text : '').trim();
  if (!text) return { ok: false, error: '朗读文本为空' };
  const sid = Math.max(0, Math.round(Number(opts.sid) || 0));
  const speed = Math.min(1.5, Math.max(0.5, Number(opts.speed) || 1));

  // 自定义音色：clone_（克隆）/ voice_（导入）都从 voiceRepo 解析引擎与模型配置
  const voiceId = String((opts && opts.voiceId) || '');
  const custom = voiceId ? voiceRepo.get(voiceId) : null;
  const looksCustom = /^(clone|voice)_/.test(voiceId);
  if (looksCustom && !custom) {
    return {
      ok: false,
      error: voiceId.startsWith('clone_')
        ? '克隆音色不存在或参考音频已损坏，请在设置 → 语音中重新录制'
        : '导入的音色不存在或模型文件已缺失，请在设置 → 语音中重新导入',
    };
  }
  const resolved = custom ? voiceRepo.engineConfig(voiceId) : null;
  if (custom && resolved && !resolved.config) {
    // 音色存在但跑不起来（典型：vits 包缺 espeak-ng-data）：把具体原因带出去
    return { ok: false, error: resolved.error || '该音色的模型文件不完整，请重新导入' };
  }
  if (custom && !resolved) {
    return {
      ok: false,
      error: custom.kind === 'cloned'
        ? '克隆音色需要先安装「ZipVoice 克隆音色包」（设置 → 语音）'
        : '该音色的模型文件不完整，请重新导入',
    };
  }
  const engine = resolved ? resolved.engine : 'kokoro';
  const voiceKey = custom ? custom.id : `sid:${sid}`;
  const cfg = resolved ? resolved.config : install.modelConfig();
  if (!cfg) return { ok: false, error: '语音包尚未安装' };

  const cloned = custom && custom.kind === 'cloned' ? voiceRepo.readRef(voiceId) : null;
  if (custom && custom.kind === 'cloned' && !cloned) {
    return { ok: false, error: '克隆音色的参考音频读取失败，请重新录制' };
  }
  // 导入包的多说话人模型用 manifest 里的 sid；内置音色用调用方传的 sid
  const effectiveSid = custom && custom.kind === 'imported' ? Number(custom.sid) || 0 : sid;
  const payload = { text, sid: effectiveSid, speed, engine, engineConfig: cfg };
  if (cloned) {
    payload.referenceAudioBase64 = Buffer
      .from(cloned.samples.buffer, cloned.samples.byteOffset, cloned.samples.byteLength)
      .toString('base64');
    payload.referenceSampleRate = cloned.sampleRate;
    payload.referenceText = cloned.refText;
    payload.numSteps = Math.max(1, Math.min(16, Number(opts && opts.numSteps) || 4));
  }
  return {
    ok: true,
    text,
    speed,
    engine,
    payload,
    cloned: Boolean(cloned),
    key: cacheKey(engine, voiceKey, speed, text),
  };
}

/** 本地 Kokoro / ZipVoice / 导入模型合成：把 planVoice 的 payload 送 worker 并落 WAV 缓存 */
async function synthesizeLocal(opts) {
  const plan = planVoice(opts);
  if (!plan.ok) return plan;
  const hit = readCache(plan.key);
  if (hit) {
    return { ok: true, cached: true, mime: 'audio/wav', wavBase64: hit.buf.toString('base64'), bytes: hit.buf.length, ms: 0 };
  }
  // 克隆单句可能 5–10s（RTF≈1.04），超时给足；内置仍按 90s
  const r = await request('tts', plan.payload, plan.cloned ? 180000 : 90000, plan.cloned ? '克隆语音合成' : '语音合成');
  const raw = Buffer.from(String(r.samplesBase64 || ''), 'base64');
  // 同 worker：Buffer 可能来自内存池，byteOffset 不保证 4 字节对齐，必须拷到独立 ArrayBuffer
  const ab = new ArrayBuffer(raw.length);
  new Uint8Array(ab).set(raw);
  const samples = new Float32Array(ab);
  const sampleRate = Number(r.sampleRate) || 24000;
  const wav = encodeWav(samples, sampleRate);
  writeCache(plan.key, wav);
  return {
    ok: true,
    cached: false,
    mime: 'audio/wav',
    wavBase64: wav.toString('base64'),
    bytes: wav.length,
    ms: Number(r.ms) || 0,
    sampleRate,
  };
}

/**
 * 流式合成：每合成出一块就通过 onChunk 交给渲染层先播，全部结束后再落缓存。
 *
 * 为什么值得单开一条链路：本机实测一句 16.7s 的追问整段要 13.8s 才出声，
 * 而首块 1.66s 就到了（块内就有 1.87s 音频）。追问是「用户正等着听」的场景，
 * 这 12 秒的差别是可用与不可用的差别。
 *
 * @param {{text:string, sid:number, speed:number, voiceId?:string, streamId?:string}} opts
 * @param {(chunk:{streamId:string,seq:number,samplesBase64:string,sampleRate:number,numSamples:number,progress:number,elapsedMs:number}) => void} onChunk
 */
async function synthesizeStream(opts, onChunk) {
  // 在线引擎没有"分块 PCM"这条通道：它是服务端整句返回 mp3（且通常远快于本地合成）。
  // 这里整段返回并标记 streamed=false，渲染层按"整段播放"处理——不假装分块，避免两条路语义漂移。
  if (wantsOnline(opts)) {
    const online = await synthesizeOnline(opts);
    if (online.ok) return { ...online, streamed: false };
    lastError = `在线语音不可用，已回落本地：${online.error}`;
  }
  const plan = planVoice(opts);
  if (!plan.ok) return plan;
  const hit = readCache(plan.key);
  if (hit) {
    // 命中缓存就直接整段给：此时「首包」没有意义，整段本来就在内存里
    return { ok: true, cached: true, wavBase64: hit.buf.toString('base64'), bytes: hit.buf.length, ms: 0 };
  }
  const streamId = String((opts && opts.streamId) || '') || `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = [];
  let total = 0;
  let sampleRate = 24000;
  const timeout = plan.cloned ? 300000 : 180000;
  const r = await request(
    'tts-stream',
    { ...plan.payload, streamId },
    timeout,
    plan.cloned ? '克隆语音合成' : '语音合成',
    (msg) => {
      const b64 = String(msg.samplesBase64 || '');
      if (!b64) return;
      // 这里不重新编码：worker 给的就是 Float32 的 base64，直接转给渲染层，省一次双程编解码
      const raw = Buffer.from(b64, 'base64');
      const ab = new ArrayBuffer(raw.length);
      new Uint8Array(ab).set(raw);
      const chunk = new Float32Array(ab);
      sampleRate = Number(msg.sampleRate) || sampleRate;
      parts.push(chunk);
      total += chunk.length;
      if (onChunk) {
        onChunk({
          streamId,
          seq: Number(msg.seq) || parts.length,
          samplesBase64: b64,
          sampleRate,
          numSamples: chunk.length,
          progress: Number(msg.progress) || 0,
          elapsedMs: Number(msg.elapsedMs) || 0,
        });
      }
    },
  );

  if (r.canceled) {
    // 取消的流不落缓存：半句话进了缓存，下次朗读会静默变成「说到一半就停」
    return { ok: true, canceled: true, streamed: true, chunks: 0, sampleRate, firstChunkMs: 0, ms: Number(r.ms) || 0 };
  }
  if (!total) return { ok: false, error: '合成结果为空' };
  const all = concatFloat32(parts);
  const wav = encodeWav(all, sampleRate);
  writeCache(plan.key, wav);
  return {
    ok: true,
    cached: false,
    streamed: true,
    chunks: parts.length,
    sampleRate,
    durationSec: Number((total / sampleRate).toFixed(2)),
    firstChunkMs: Number(r.firstChunkMs) || 0,
    ms: Number(r.ms) || 0,
    bytes: wav.length,
  };
}

/** 叫停一条正在合成的流（渲染层点「停止」/ 开始录音时） */
function cancelTtsStream(streamId) {
  const sid = String(streamId || '');
  if (!sid) return { ok: false, error: '缺少流标识' };
  if (!child) return { ok: false, error: '语音进程未运行' };
  try {
    // 这条请求不登记 pending：worker 的应答无人关心，但取消动作必须立刻送达
    child.postMessage({ id: nextId++, cmd: 'tts-cancel', payload: { streamId: sid } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 试听一个还没落盘的音色包（导入向导第 3 步）。
 * 直接用用户目录加载模型，合成失败就说明这个包与运行时版本不兼容——
 * 在 utilityProcess 里崩了只影响这一次试听，不带走应用，也不会留下半份复制。
 */
async function previewPack(opts) {
  const dir = String((opts && opts.dir) || '');
  const probe = voicePack.probe(dir);
  if (!probe.ok) return { ok: false, error: probe.error || probe.reason || '音色包校验未通过' };
  const sid = Math.max(0, Math.round(Number(opts && opts.sid) || 0));
  // vits 包常不自带 espeak-ng-data：借用内置包的那份，缺了就在试听这步说清楚
  const fallback = probe.needsEspeak ? install.espeakDataDir() : '';
  const cfg = voicePack.buildEngineConfig(dir, probe.engine, { sid, fallbackDataDir: fallback });
  if (probe.engine === 'vits' && !cfg.dataDir) {
    return {
      ok: false,
      error: '这个音色包需要 espeak-ng-data（音素数据），但它没带、本机也没有可借用的内置语音包。请先安装「听」包（Kokoro）。',
    };
  }
  const text = '你好，我是今天的面试官。请先简单介绍一下你自己。';
  try {
    const started = Date.now();
    const r = await request('tts', { text, sid, speed: 1, engine: probe.engine, engineConfig: cfg }, 180000, '音色包试听');
    const raw = Buffer.from(String(r.samplesBase64 || ''), 'base64');
    const ab = new ArrayBuffer(raw.length);
    new Uint8Array(ab).set(raw);
    const samples = new Float32Array(ab);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < 0.01) return { ok: false, error: '试听合成几乎是静音，这个音色包可能与该运行时版本不兼容' };
    const wav = encodeWav(samples, Number(r.sampleRate) || 22050);
    return {
      ok: true,
      wavBase64: wav.toString('base64'),
      bytes: wav.length,
      ms: Date.now() - started,
      engine: probe.engine,
      family: probe.family,
      // 借用了内置包的音素数据：UI 上要说明，否则用户会以为包里自带了
      borrowedDataDir: Boolean(fallback && cfg.dataDir === fallback),
    };
  } catch (e) {
    return { ok: false, error: `试听失败：${String((e && e.message) || e)}` };
  }
}

/** 预热（安装完 / 打开朗读开关时后台调用，避免第一句等 2–4s） */
async function warmup(engine = 'kokoro') {
  const cfg = engine === 'zipvoice' ? install.zipvoiceConfig() : install.modelConfig();
  if (!cfg) return { ok: false, error: engine === 'zipvoice' ? '克隆音色包尚未安装' : '语音包尚未安装' };
  try {
    const info = await ensureInit(cfg);
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function shutdown() {
  rejectAll('语音服务已关闭');
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }
}

module.exports = {
  status,
  synthesize,
  synthesizeStream,
  cancelTtsStream,
  recognize,
  previewPack,
  voiceRepo,
  warmup,
  warmupAsr,
  shutdown,
  encodeWav,
  cacheKey,
  // 诊断
  _platformPackageDir: platformPackageDir,
};
