// 流式朗读冒烟：驱动**生产同一份** worker 走 tts-stream / tts-cancel 协议。
//
// 为什么单独一支：分块合成的坑都在时序上——首包什么时候来、块与块之间会不会断、
// 取消之后底层到底停没停。这些只有拿真实模型跑一遍才知道，浏览器里测不出来。
//
// 用法：
//   node scripts/mock-interview-tts-stream-smoke.mjs --model-dir <Kokoro 目录> [--sid 3]
// 退出码 0 = 分块、取消、参数校验三项都成立。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const modelDir = resolve(arg('model-dir', ''));
const sid = Number(arg('sid', '3'));

function fail(msg) {
  console.error(`\n[失败] ${msg}`);
  process.exit(1);
}

if (!modelDir || !existsSync(modelDir)) fail(`模型目录不存在：${modelDir || '(未提供 --model-dir)'}`);
const modelFile = ['model.int8.onnx', 'model.onnx'].map((f) => join(modelDir, f)).find((p) => existsSync(p));
if (!modelFile) fail('模型目录里找不到 model.int8.onnx / model.onnx');
const lexicon = (() => {
  try {
    const files = readdirSync(modelDir).filter((x) => /^lexicon.*\.txt$/i.test(x));
    const pick = files.find((x) => /zh/i.test(x)) || files[0];
    return pick ? join(modelDir, pick) : '';
  } catch { return ''; }
})();

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
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* 非协议输出（原生库日志）忽略 */ }
      if (msg && msg.id != null) {
        const p = pending.get(msg.id);
        if (p) {
          if (msg.stream === 'chunk') { if (p.onChunk) p.onChunk(msg); }
          else { pending.delete(msg.id); clearTimeout(p.timer); p.settle(msg); }
        }
      }
    }
    idx = stdoutBuf.indexOf('\n');
  }
});

function call(cmd, payload, timeoutMs = 300000, onChunk) {
  return new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rejectP(new Error(`${cmd} 超时`)); }, timeoutMs);
    pending.set(id, {
      timer,
      onChunk,
      settle: (msg) => (msg.ok ? resolveP(msg.result) : rejectP(new Error(msg.error || `${cmd} 失败`))),
    });
    worker.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
  });
}

const base = {
  sid,
  speed: 1,
  model: modelFile,
  voices: join(modelDir, 'voices.bin'),
  tokens: join(modelDir, 'tokens.txt'),
  dataDir: join(modelDir, 'espeak-ng-data'),
  lexicon,
};

let failures = 0;
const say = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
};

try {
  const t0 = Date.now();
  const info = await call('init', base);
  console.log(`模型加载：${Date.now() - t0}ms，speakers=${info.numSpeakers}，sampleRate=${info.sampleRate}\n`);

  // ===== 1. 分块合成：块顺序、块内采样数、首包时刻 =====
  const text = '你刚才提到用 Redis 做了缓存，这里的过期策略是怎么设计的？如果热点数据同时失效会出现什么情况？'
    + '另外，缓存和数据库的一致性你们是怎么保证的，有没有考虑过延迟双删的方案？';
  const streamId = `smoke-${Date.now().toString(36)}`;
  const arrivals = [];
  let chunkSamples = 0;
  let seqOk = true;
  const streamStart = Date.now();
  const r = await call('tts-stream', { ...base, text, streamId }, 300000, (msg) => {
    if (msg.seq !== arrivals.length + 1) seqOk = false;
    chunkSamples += msg.numSamples;
    arrivals.push(`${msg.elapsedMs}ms/${(msg.numSamples / 24000).toFixed(2)}s`);
  });
  const audioSec = r.samples / (r.sampleRate || info.sampleRate);
  console.log(`[1] chunks=${r.chunks} samples=${r.samples} 首包=${r.firstChunkMs}ms 总计=${r.ms}ms（墙钟 ${Date.now() - streamStart}ms）`);
  console.log(`    音频 ${audioSec.toFixed(2)}s，RTF=${(r.ms / 1000 / audioSec).toFixed(2)}`);
  console.log(`    分块到达：${arrivals.join(' | ')}`);
  say(r.chunks >= 2, `长句被切成 ${r.chunks} 块（>1）`);
  say(seqOk, 'seq 从 1 连续递增');
  say(chunkSamples === r.samples, `分块采样数合计 ${chunkSamples} == 汇总 ${r.samples}`);
  say(r.firstChunkMs > 0 && r.firstChunkMs < r.ms, `首包 ${r.firstChunkMs}ms 明显早于总时长 ${r.ms}ms`);
  say(r.canceled === false, '未取消的流返回 canceled=false');

  // ===== 2. 取消：第一块到达后立刻取消，底层应在下一个内部段落处停下 =====
  const cancelId = `smoke-cancel-${Date.now().toString(36)}`;
  let cancelChunks = 0;
  let cancelSentAt = 0;
  const cancelStart = Date.now();
  const slowText = `${text}${text}`;
  const rc = await call('tts-stream', { ...base, text: slowText, streamId: cancelId }, 300000, () => {
    cancelChunks += 1;
    if (cancelChunks === 1) {
      cancelSentAt = Date.now();
      void call('tts-cancel', { streamId: cancelId }, 20000);
    }
  });
  const stoppedAfter = cancelSentAt ? Date.now() - cancelSentAt : -1;
  console.log(`\n[2] 取消：canceled=${rc.canceled} chunks=${rc.chunks} 首块后 ${stoppedAfter}ms 停下（整段 ${Date.now() - cancelStart}ms）`);
  say(rc.canceled === true, '取消后返回 canceled=true');
  say(rc.chunks <= 4, `取消后只产出 ${rc.chunks} 块（没有跑完整段）`);

  // ===== 3. 参数校验：空文本必须在合成前被拒绝 =====
  let rejected = false;
  try { await call('tts-stream', { ...base, text: '   ', streamId: 'empty' }); } catch { rejected = true; }
  say(rejected, '空文本被拒绝');

  console.log(`\n${failures === 0 ? '[通过]' : `[失败] ${failures} 项`} 流式朗读协议`);
  worker.kill();
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n[失败] ${String((e && e.message) || e)}`);
  try { worker.kill(); } catch { /* ignore */ }
  process.exit(1);
}
