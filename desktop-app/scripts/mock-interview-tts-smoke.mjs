// 语音运行时冒烟：用**生产同一份** worker（electron/speechWorker.cjs）合成一段中文，落成 wav。
//
// 为什么需要它：语音链路的失败大多不是逻辑错误，而是环境问题——原生 .node 加载不了、
// onnxruntime.dll 找不到、模型文件缺一个、Electron 的外部缓冲区限制。这些在浏览器里测不出来。
// 本脚本绕过 Electron，只验证「运行时 + 模型 + worker 协议」这一段；安装包冒烟仍需在真机做。
//
// 用法：
//   node scripts/mock-interview-tts-smoke.mjs --model-dir <解压后的 Kokoro 目录> [--out /tmp/tts.wav] [--sid 3]
// 退出码 0 = 合成成功且 WAV 可解析；1 = 失败。
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const modelDir = resolve(arg('model-dir', ''));
const out = resolve(arg('out', join(root, '..', '.tmp-tts-smoke.wav')));
const sid = Number(arg('sid', '3'));
const text = arg('text', '你好，我是今天的面试官。请先简单介绍一下你自己。');

function fail(msg) {
  console.error(`\n[失败] ${msg}`);
  process.exit(1);
}

if (!modelDir || !existsSync(modelDir)) fail(`模型目录不存在：${modelDir || '(未提供 --model-dir)'}`);

const modelFile = ['model.int8.onnx', 'model.onnx'].map((f) => join(modelDir, f)).find((p) => existsSync(p));
if (!modelFile) fail('模型目录里找不到 model.int8.onnx / model.onnx');
const required = ['voices.bin', 'tokens.txt', 'espeak-ng-data'];
const missing = required.filter((f) => !existsSync(join(modelDir, f)));
if (missing.length) fail(`模型目录不完整，缺少：${missing.join('、')}`);

const lexicon = (() => {
  try {
    const files = readdirSync(modelDir).filter((x) => /^lexicon.*\.txt$/i.test(x));
    const pick = files.find((x) => /zh/i.test(x)) || files[0];
    return pick ? join(modelDir, pick) : '';
  } catch { return ''; }
})();

console.log(`模型：${modelFile}`);
console.log(`目录：${modelDir}`);
console.log(`sid=${sid}，文本：${text}`);

const worker = spawn(process.execPath, [join(root, 'electron', 'speechWorker.cjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
let stdoutBuf = '';
worker.stdout.setEncoding('utf8');
worker.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let idx = stdoutBuf.indexOf('\n');
  while (idx >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      } catch { /* 非协议输出忽略 */ }
    }
    idx = stdoutBuf.indexOf('\n');
  }
});

const call = (cmd, payload, timeoutMs = 180000) =>
  new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`${cmd} 超时`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.ok) resolveP(msg.result);
      else rejectP(new Error(msg.error || `${cmd} 失败`));
    });
    worker.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
  });

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
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

try {
  const t0 = Date.now();
  const info = await call('init', {
    model: modelFile,
    voices: join(modelDir, 'voices.bin'),
    tokens: join(modelDir, 'tokens.txt'),
    dataDir: join(modelDir, 'espeak-ng-data'),
    lexicon,
  });
  console.log(`模型加载完成：${Date.now() - t0}ms，speakers=${info.numSpeakers}，sampleRate=${info.sampleRate}`);

  const t1 = Date.now();
  const r = await call('tts', { text, sid, speed: 1 });
  const ms = Date.now() - t1;
  const raw = Buffer.from(r.samplesBase64, 'base64');
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  if (!samples.length) fail('合成结果为空');
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 0.001) fail('合成结果接近静音（peak < 0.001），模型或 sid 可能不对');

  const wav = encodeWav(samples, r.sampleRate || info.sampleRate);
  await new Promise((resolveP, rejectP) => {
    const ws = createWriteStream(out);
    ws.on('error', rejectP);
    ws.on('finish', resolveP);
    ws.end(wav);
  });

  // 回读校验 WAV 头
  const fd = openSync(out, 'r');
  const head = Buffer.alloc(12);
  readSync(fd, head, 0, 12, 0);
  closeSync(fd);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    fail('输出文件不是合法 WAV');
  }
  console.log(`合成完成：${ms}ms，${samples.length} 采样（${(samples.length / (r.sampleRate || 24000)).toFixed(2)}s），peak=${peak.toFixed(3)}`);
  console.log(`WAV：${out}（${statSync(out).size} 字节）`);
  console.log('\n[通过] 语音运行时可用（安装包冒烟仍需在真机验证）');
  worker.kill();
  process.exit(0);
} catch (e) {
  console.error(`\n[失败] ${String((e && e.message) || e)}`);
  try { worker.kill(); } catch { /* ignore */ }
  process.exit(1);
}
