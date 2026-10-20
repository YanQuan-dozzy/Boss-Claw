// 语音识别（ASR）冒烟：直接跑 electron/speechWorker.cjs（与生产同一份运行时代码）
//
// 用法：
//   node scripts/mock-interview-asr-smoke.mjs --model-dir <含 model.int8.onnx/tokens.txt 的目录> --wav <16k 单声道 wav>
// 输出：识别文本、分段、耗时、RTF；EXIT 0 = 成功。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const modelDir = resolve(arg('model-dir', ''));
const wavPath = resolve(arg('wav', ''));
if (!modelDir || !wavPath) {
  console.error('用法：node scripts/mock-interview-asr-smoke.mjs --model-dir <目录> --wav <16k wav>');
  process.exit(2);
}
for (const f of ['model.int8.onnx', 'tokens.txt']) {
  if (!existsSync(join(modelDir, f))) {
    console.error(`模型目录缺少 ${f}`);
    process.exit(2);
  }
}

/** 只支持 16-bit PCM 单声道 wav（sherpa 测试音频都是这个格式） */
function readWav16(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      data = buf.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`只支持 PCM16，实际 format=${fmt.format} bits=${fmt.bits}`);
  if (fmt.channels !== 1) throw new Error(`只支持单声道，实际 ${fmt.channels} 声道`);
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: fmt.sampleRate };
}

const { samples, sampleRate } = readWav16(wavPath);
const b64 = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');

const child = spawn(process.execPath, [join(root, 'electron', 'speechWorker.cjs')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i = buf.indexOf('\n');
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error));
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
    i = buf.indexOf('\n');
  }
});

let nextId = 1;
function call(cmd, payload, timeoutMs = 300000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`${cmd} 超时`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
  });
}

try {
  const t0 = Date.now();
  const init = await call('init-asr', { model: join(modelDir, 'model.int8.onnx'), tokens: join(modelDir, 'tokens.txt') });
  const loadMs = Date.now() - t0;
  console.log(`init ok · 加载 ${loadMs}ms`);

  const t1 = Date.now();
  const r = await call('asr', { samplesBase64: b64, sampleRate });
  const ms = Date.now() - t1;
  const duration = samples.length / sampleRate;
  console.log(`识别完成 · ${ms}ms · 音频 ${duration.toFixed(2)}s · RTF ${(ms / 1000 / duration).toFixed(2)}`);
  console.log(`文本：${r.text}`);
  if (r.segments) {
    console.log(`分段：${r.segments.length} 段 → ${r.segments.map((s) => `[${(s.start / sampleRate).toFixed(2)}-${(s.end / sampleRate).toFixed(2)}] ${s.text}`).join(' | ')}`);
  }
  if (!r.text || !r.text.trim()) {
    console.error('识别文本为空');
    process.exitCode = 1;
  }
  console.log('ASR 冒烟通过');
} catch (e) {
  console.error('ASR 冒烟失败：', e.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 100);
}
