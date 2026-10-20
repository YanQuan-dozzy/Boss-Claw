// 克隆音色冒烟：用生产同一份 worker（electron/speechWorker.cjs）跑 ZipVoice 零样本克隆。
//
// 验证的是三件事（这三件在浏览器里都测不出来）：
//   1. ZipVoice int8 能加载（encoder/decoder/tokens 组合正确、无独立声码器也不报错）；
//   2. generationConfig 里的 referenceAudio / referenceSampleRate / referenceText 被真正采纳
//      （互换两段参考音频，输出应有可辨差异，而不是恒定音色）；
//   3. 单句耗时（RTF）是否仍在「只预生成、不现场等」的预算内。
//
// 用法：
//   node scripts/mock-interview-clone-smoke.mjs --model-dir <解压后的 zipvoice 目录> \
//     [--ref <参考 wav>] [--ref-text "参考文本"] [--out <输出 wav>]
// 退出码 0 = 成功；1 = 失败。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function fail(msg) {
  console.error(`\n[失败] ${msg}`);
  process.exit(1);
}

/** 只解 16-bit PCM 单声道/立体声 WAV，返回 Float32 交错前的平均声道 */
function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') fail(`不是 WAV：${file}`);
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
  if (!fmt || !data) fail('WAV 缺少 fmt/data 块');
  if (fmt.bits !== 16) fail(`只支持 16-bit PCM，当前 ${fmt.bits}`);
  const ch = fmt.channels || 1;
  const frames = Math.floor(data.length / (2 * ch));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < ch; c += 1) sum += data.readInt16LE((i * ch + c) * 2);
    samples[i] = sum / ch / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate, durationSec: frames / fmt.sampleRate };
}

function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

const modelDir = resolve(arg('model-dir', ''));
if (!modelDir || !existsSync(modelDir)) fail(`模型目录不存在：${modelDir || '(未提供 --model-dir)'}`);

const pick = (re) => readdirSync(modelDir).find((f) => re.test(f)) || '';
const encoder = join(modelDir, pick(/^encoder.*\.onnx$/i));
const decoder = join(modelDir, pick(/^decoder.*\.onnx$/i));
const tokens = join(modelDir, 'tokens.txt');
const dataDir = join(modelDir, 'espeak-ng-data');
const lexicon = join(modelDir, 'lexicon.txt');
const vocoderFile = pick(/^(vocoder|vocos).*\.onnx$/i);
const vocoder = vocoderFile ? join(modelDir, vocoderFile) : '';
for (const [label, p] of [['encoder', encoder], ['decoder', decoder], ['tokens', tokens]]) {
  if (!p || !existsSync(p)) fail(`模型目录缺少 ${label}`);
}

const refPath = resolve(arg('ref', join(modelDir, 'test_wavs', 'news-female.wav')));
if (!existsSync(refPath)) fail(`参考音频不存在：${refPath}`);
const ref = readWav(refPath);
const refText = arg('ref-text', '本台消息，中共中央国务院近日印发关于构建数据基础制度更好发挥数据要素作用的意见。');
console.log(`模型：${encoder} / ${decoder}`);
console.log(`参考：${refPath}（${ref.durationSec.toFixed(2)}s，${ref.sampleRate}Hz）`);
console.log(`参考文本：${refText.slice(0, 40)}…`);

const worker = spawn(process.execPath, [join(root, 'electron', 'speechWorker.cjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
let buf = '';
worker.stdout.setEncoding('utf8');
worker.stdout.on('data', (chunk) => {
  buf += chunk;
  let i = buf.indexOf('\n');
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error));
        }
      } catch { /* 非 JSON 行（原生库日志）忽略 */ }
    }
    i = buf.indexOf('\n');
  }
});
worker.on('exit', (code) => {
  for (const [, p] of pending) p.reject(new Error(`worker 退出（code=${code}）`));
});

function call(cmd, payload, timeoutMs = 300000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${cmd} 超时`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolvePromise(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
  });
}

const b64 = (samples) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');

try {
  const t0 = Date.now();
  const info = await call('init', { engine: 'zipvoice', encoder, decoder, vocoder, tokens, dataDir, lexicon });
  const loadMs = Date.now() - t0;
  console.log(`加载：${loadMs}ms，sampleRate=${info.sampleRate}，engine=${info.engine}`);

  const text = arg('text', '你好，我是今天的面试官。请先简单介绍一下你最近做的一个项目。');
  const t1 = Date.now();
  const out = await call('tts', {
    text,
    speed: 1,
    engine: 'zipvoice',
    referenceAudioBase64: b64(ref.samples),
    referenceSampleRate: ref.sampleRate,
    referenceText: refText,
    numSteps: 4,
  });
  const totalMs = Date.now() - t1;

  const raw = Buffer.from(out.samplesBase64, 'base64');
  const ab = new ArrayBuffer(raw.length);
  new Uint8Array(ab).set(raw);
  const samples = new Float32Array(ab);
  const duration = samples.length / out.sampleRate;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const outFile = resolve(arg('out', join(root, '..', '.tmp-clone-smoke.wav')));
  writeFileSync(outFile, encodeWav(samples, out.sampleRate));

  console.log(`合成：${duration.toFixed(2)}s 音频 / ${totalMs}ms（RTF≈${(totalMs / 1000 / duration).toFixed(2)}）`);
  console.log(`峰值 ${peak.toFixed(3)}，RMS ${rms.toFixed(4)}，输出：${outFile}`);
  console.log(`内部耗时 ${out.ms}ms`);

  if (!samples.length) fail('合成结果为空');
  if (peak < 0.05) fail(`输出几乎静音（峰值 ${peak.toFixed(3)}）`);
  console.log('\n[通过] ZipVoice 克隆链路可用');
  worker.stdin.end();
  worker.kill();
  process.exit(0);
} catch (e) {
  fail(String((e && e.message) || e));
}
