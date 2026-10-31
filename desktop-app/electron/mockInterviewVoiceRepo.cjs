// electron/mockInterviewVoiceRepo.cjs —— 自定义音色存储（克隆 P4-B / 导入 P2）
//
// 目录：<userData>/speech/voices/<voiceId>/
//   克隆（kind=cloned）      manifest.json + ref.wav（3–10s 参考音频）
//   导入（kind=imported）    manifest.json + 模型文件副本（整目录复制）
//
// 为什么放在 speech/ 而不是 mock-interview/（方案 6.5 布局另一处写的是 mock-interview/voices）：
//   音色是语音资源，和模型包、缓存同域；「清空全部数据」会一起删掉，而只清面试记录时不能误删。
//
// 约束：
//   · 克隆：参考文本由页面给固定句，不用 ASR 转写（省一次调用，也避免错字拉低克隆质量）；
//   · 导入：复制而不是引用原目录（用户可能放在 U 盘或临时下载目录），复制前先探测试听；
//   · 单包 400MB 上限、最多 20 个音色；id 正则挡路径穿越。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const install = require('./speechInstall.cjs');
const pack = require('./mockInterviewVoicePack.cjs');

const MAX_VOICES = 20;
/** 参考音频时长窗口（秒）：短于 3s 音色不稳，长于 10s 收益很小且拖慢合成 */
const MIN_SEC = 3;
const MAX_SEC = 10;
const MIN_RMS = 0.004;

const ID_RE = /^(clone|voice)_[a-f0-9]{8,24}$/;

function voicesDir() { return path.join(install.rootDir(), 'voices'); }

function ensureDir() {
  fs.mkdirSync(voicesDir(), { recursive: true });
}

function safeId(id) {
  const s = String(id || '');
  return ID_RE.test(s) ? s : '';
}

function voiceDir(id) {
  const safe = safeId(id);
  if (!safe) throw new Error('音色 id 不合法');
  return path.join(voicesDir(), safe);
}

function readManifestAt(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!m || !m.id) return null;
    return m;
  } catch {
    return null;
  }
}

function dirBytesRec(dir) {
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

/** 目录是否仍是可用的音色（导入包被用户手动删掉文件后要能自动失效） */
function isUsable(dir, manifest) {
  if (!manifest) return false;
  if (manifest.kind === 'cloned') return fs.existsSync(path.join(dir, 'ref.wav'));
  if (manifest.kind === 'imported') {
    const p = pack.probe(dir);
    return Boolean(p.ok && p.engine === manifest.engine);
  }
  return false;
}

function toPublic(m, dir, bytes) {
  const base = {
    id: m.id,
    name: m.name,
    kind: m.kind,
    engine: m.engine,
    createdAt: m.createdAt,
    bytes,
  };
  if (m.kind === 'cloned') {
    return { ...base, refText: m.refText, durationSec: m.durationSec, sampleRate: m.sampleRate };
  }
  return {
    ...base,
    family: m.family,
    numSpeakers: m.numSpeakers || 1,
    sid: m.sid || 0,
    source: m.source || '',
    license: m.license || '',
  };
}

function list() {
  ensureDir();
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(voicesDir(), { withFileTypes: true }); } catch { return { ok: true, voices: [] }; }
  for (const e of entries) {
    if (!e.isDirectory() || !safeId(e.name)) continue;
    const dir = path.join(voicesDir(), e.name);
    const m = readManifestAt(dir);
    if (!m || !isUsable(dir, m)) continue;
    const bytes = m.kind === 'imported' ? Number(m.bytes || 0) || dirBytesRec(dir) : (() => {
      try { return fs.statSync(path.join(dir, 'ref.wav')).size; } catch { return 0; }
    })();
    out.push(toPublic(m, dir, bytes));
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return { ok: true, voices: out };
}

/** 读某个音色的 manifest（不区分类型；不存在返回 null） */
function get(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const dir = path.join(voicesDir(), safe);
  const m = readManifestAt(dir);
  if (!m) return null;
  return { ...m, dir };
}

// ===== WAV 编解码（只处理 16-bit PCM 单声道；录制侧保证这个格式） =====
// 编码实现与语音服务共用 wav.cjs，避免两条链路给出不同格式的参考音频
const { encodeWav } = require('./wav.cjs');

function decodeWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('参考音频不是合法 WAV');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      data = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + size));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('参考音频缺少 fmt/data 块');
  if (fmt.bits !== 16) throw new Error(`参考音频位深不支持：${fmt.bits}（只接受 16-bit PCM）`);
  const channels = fmt.channels || 1;
  const frames = Math.floor(data.length / (2 * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    // 多声道取平均：手机录的立体声不该只用左声道
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate || 16000 };
}

function rmsOf(samples) {
  if (!samples.length) return 0;
  const step = Math.max(1, Math.floor(samples.length / 100000));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += step) {
    sum += samples[i] * samples[i];
    n += 1;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

/**
 * 创建克隆音色。
 * @param {{name?:string, samplesBase64:string, sampleRate?:number, refText:string}} payload
 */
function create(payload) {
  const p = payload || {};
  const refText = String(p.refText || '').trim();
  if (refText.length < 10) return { ok: false, error: '参考文本过短' };

  const { voices } = list();
  if (voices.length >= MAX_VOICES) return { ok: false, error: `最多保留 ${MAX_VOICES} 个自定义音色，请先删除不用的` };

  const b64 = String(p.samplesBase64 || '');
  if (!b64) return { ok: false, error: '没有录到声音' };
  const raw = Buffer.from(b64, 'base64');
  if (raw.length % 4 !== 0) return { ok: false, error: '录音数据格式错误' };
  const ab = new ArrayBuffer(raw.length);
  new Uint8Array(ab).set(raw);
  const samples = new Float32Array(ab);
  const sampleRate = Math.round(Number(p.sampleRate) || 0);
  if (sampleRate < 8000 || sampleRate > 48000) return { ok: false, error: '录音采样率异常' };

  const durationSec = samples.length / sampleRate;
  if (durationSec < MIN_SEC) {
    return { ok: false, error: `录音只有 ${durationSec.toFixed(1)} 秒，至少需要 ${MIN_SEC} 秒（3–10 秒最佳）` };
  }
  if (durationSec > MAX_SEC + 0.5) {
    return { ok: false, error: `录音 ${durationSec.toFixed(1)} 秒，超过 ${MAX_SEC} 秒上限` };
  }
  const rms = rmsOf(samples);
  if (rms < MIN_RMS) {
    return { ok: false, error: '这段录音几乎没声音（或麦克风没收到），请检查输入设备后重录' };
  }

  ensureDir();
  const id = `clone_${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(voicesDir(), id);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const wav = encodeWav(samples, sampleRate);
    fs.writeFileSync(path.join(tmp, 'ref.wav'), wav);
    const manifest = {
      id,
      name: String(p.name || '我的声音').trim().slice(0, 24) || '我的声音',
      kind: 'cloned',
      engine: 'zipvoice',
      refText,
      sampleRate,
      durationSec: Number(durationSec.toFixed(2)),
      sha256: crypto.createHash('sha256').update(wav).digest('hex'),
      createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, dir);
    return { ok: true, voice: { ...manifest, bytes: wav.length } };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 导入音色包：整目录复制到 voices/<id>/，写 manifest。
 * 调用方应先 `pack.probe` + 试听，再调这里；这里再做一次探测，防止中间目录被改动。
 * @param {string} srcDir
 * @param {{name?:string, license?:string, source?:string, sid?:number}} opts
 */
function importFromDir(srcDir, opts = {}) {
  const probe = pack.probe(srcDir);
  if (!probe.ok) return { ok: false, error: probe.error || '音色包校验未通过', probe };

  const { voices } = list();
  if (voices.length >= MAX_VOICES) return { ok: false, error: `最多保留 ${MAX_VOICES} 个自定义音色，请先删除不用的` };

  ensureDir();
  const id = `voice_${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(voicesDir(), id);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.cpSync(srcDir, tmp, { recursive: true, errorOnExist: false });
    const bytes = dirBytesRec(tmp);
    // 复制后再探一次：避免复制过程中源目录被改动/删除一半
    const after = pack.probe(tmp);
    if (!after.ok) throw new Error(`复制后的目录校验失败：${after.error || '文件不完整'}`);
    const manifest = {
      id,
      name: String(opts.name || path.basename(srcDir)).trim().slice(0, 24) || '导入音色',
      kind: 'imported',
      engine: after.engine,
      family: after.family,
      numSpeakers: after.numSpeakers || 1,
      sid: Math.max(0, Math.round(Number(opts.sid) || 0)),
      bytes,
      source: String(opts.source || srcDir).slice(0, 500),
      license: String(opts.license || '').slice(0, 200),
      createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, dir);
    return { ok: true, voice: toPublic(manifest, dir, bytes) };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 删除任意类型的音色目录（导入包与克隆都适用） */
function remove(id) {
  const dir = voiceDir(id);
  if (!fs.existsSync(dir)) return { ok: false, error: '音色不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function rename(id, name) {
  const dir = voiceDir(id);
  const m = readManifestAt(dir);
  if (!m) return { ok: false, error: '音色不存在' };
  const next = String(name || '').trim().slice(0, 24);
  if (!next) return { ok: false, error: '名称不能为空' };
  const tmp = path.join(dir, `manifest.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ ...m, name: next }, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(dir, 'manifest.json'));
  return { ok: true, voice: { ...m, name: next } };
}

/** 供合成使用：克隆音色返回 Float32 参考音频 + 参考文本（不存在返回 null） */
function readRef(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const dir = path.join(voicesDir(), safe);
  const m = readManifestAt(dir);
  if (!m || m.kind !== 'cloned') return null;
  try {
    const buf = fs.readFileSync(path.join(dir, 'ref.wav'));
    const { samples, sampleRate } = decodeWav(buf);
    return {
      id: m.id,
      name: m.name,
      refText: m.refText,
      samples,
      sampleRate,
      durationSec: m.durationSec,
    };
  } catch {
    return null;
  }
}

/**
 * 供合成使用：任意自定义音色 → { engine, config, sid }
 *   cloned   → zipvoice + 参考音频（reference 由调用方从 readRef 取）
 *   imported → 按 manifest.engine 拼配置
 * 返回 null 表示这个 id 不是自定义音色（调用方走内置 kokoro）。
 */
function engineConfig(id) {
  const m = get(id);
  if (!m) return null;
  if (m.kind === 'cloned') {
    const cfg = install.zipvoiceConfig();
    return cfg ? { engine: 'zipvoice', config: cfg, sid: 0, kind: 'cloned' } : null;
  }
  if (m.kind === 'imported') {
    // vits 包经常不自带 espeak-ng-data：先借用已装内置包的音素数据，借不到就把原因带回去，
    // 而不是让 worker 抛出一句英文错误（"Not a model using characters as modeling unit..."）。
    const needsEspeak = pack.needsEspeakData(m.dir, m.engine);
    const fallback = needsEspeak ? install.espeakDataDir() : '';
    const config = pack.buildEngineConfig(m.dir, m.engine, { sid: m.sid || 0, fallbackDataDir: fallback });
    // 只有真的依赖 espeak 的 vits 包才拦；MeloTTS 用 lexicon，dataDir 本就该为空
    if (needsEspeak && !config.dataDir) {
      return {
        engine: 'vits',
        config: null,
        error: '这个音色包需要 espeak-ng-data（音素数据），但它没带、本机也没有可借用的内置语音包。'
          + '请先安装「听」包（Kokoro），或把 espeak-ng-data 目录放进这个音色包。',
      };
    }
    return {
      engine: m.engine,
      config,
      sid: m.sid || 0,
      kind: 'imported',
      borrowedDataDir: Boolean(fallback && fallback === config.dataDir),
    };
  }
  return null;
}

function usage() {
  const { voices } = list();
  const bytes = voices.reduce((n, v) => n + (v.bytes || 0), 0);
  return { ok: true, count: voices.length, bytes };
}

function clearAll() {
  const before = usage();
  try { fs.rmSync(voicesDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true, removed: before.count, freedBytes: before.bytes };
}

module.exports = {
  list,
  get,
  create,
  importFromDir,
  rename,
  remove,
  readRef,
  engineConfig,
  usage,
  clearAll,
  encodeWav,
  decodeWav,
  voicesDir,
  // 诊断
  _voicesDir: voicesDir,
  _limits: { MIN_SEC, MAX_SEC, MAX_VOICES },
};
