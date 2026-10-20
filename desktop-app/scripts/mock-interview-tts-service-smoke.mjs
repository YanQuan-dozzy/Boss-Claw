// 主进程语音服务冒烟：不装 Electron 也能跑通「主进程 → utilityProcess → sherpa」整条流式链路。
//
// 为什么需要它：本机没有 Electron 二进制（CI 也一样），但新加的流式链路有一半逻辑在主进程——
// 分块转发、拼回整段落缓存、取消后不落缓存。这些在 worker 冒烟里测不到，在浏览器里也测不到。
// 做法是把 'electron' 模块替换成一个最小实现：utilityProcess.fork 直接 spawn 同一个 worker
// （worker 在没有 parentPort 时会走 stdin/stdout 协议），其余行为与真实环境一致。
//
// 用法：
//   BOSSCLAW_SPEECH_DIR=<含 models/tts 的语音根目录> node scripts/mock-interview-tts-service-smoke.mjs
//   或：node scripts/mock-interview-tts-service-smoke.mjs --speech-dir <目录>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const speechDir = resolve(argOf('speech-dir', process.env.BOSSCLAW_SPEECH_DIR || ''));
if (!speechDir) {
  console.error('[失败] 需要 --speech-dir 或 BOSSCLAW_SPEECH_DIR（指向包含 models/tts 的目录）');
  process.exit(1);
}
process.env.BOSSCLAW_SPEECH_DIR = speechDir;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const childProcess = require('node:child_process');

// ===== 最小 electron 替身 =====
const bus = { message: [], exit: [] };
const fakeElectron = {
  app: { getPath: () => join(speechDir, '..'), isPackaged: false, getName: () => 'BossClaw' },
  utilityProcess: {
    fork(workerPath) {
      const proc = childProcess.spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'inherit'] });
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => {
        buf += c;
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            let msg = null;
            try { msg = JSON.parse(line); } catch { /* 原生库日志 */ }
            if (msg) for (const fn of bus.message) fn(msg);
          }
          idx = buf.indexOf('\n');
        }
      });
      proc.on('exit', (code) => { for (const fn of bus.exit) fn(code); });
      return {
        on(evt, fn) { if (bus[evt]) bus[evt].push(fn); },
        postMessage(msg) { proc.stdin.write(`${JSON.stringify(msg)}\n`); },
        kill() { proc.kill(); },
      };
    },
  },
  ipcMain: { handle() {} },
  BrowserWindow: class {},
};
const origLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const service = require(join(root, 'electron', 'speechService.cjs'));

function decode(b64) {
  const raw = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(raw.length);
  new Uint8Array(ab).set(raw);
  return new Float32Array(ab);
}

let failures = 0;
const say = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
};

// 每次跑用不同文本：缓存键含文本，固定文本第二次跑就会直接命中缓存，测不到流式
const RUN = String(Date.now()).slice(-6);
const TEXT = `这是第 ${RUN} 次冒烟测试。这个岗位需要你独立负责一条业务线，能说说你会怎么拆解前三个月的目标吗？`
  + '另外，如果资源只够做一件事，你会优先做哪一件，为什么？';

function cacheFiles() {
  const dir = join(speechDir, 'cache');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wav')) : [];
}

try {
  console.log(`语音根目录：${speechDir}`);
  console.log(`状态：${JSON.stringify({ installed: service.status().tts.installed, dir: service.status().tts.dir })}\n`);

  // ===== 1. 流式：分块被逐段转发、结束后拼成整段落进缓存 =====
  const chunks = [];
  const t0 = Date.now();
  const r1 = await service.synthesizeStream(
    { text: TEXT, sid: 3, speed: 1, streamId: 'svc-1' },
    (c) => chunks.push(c),
  );
  const wall = Date.now() - t0;
  const audioSec = (r1.durationSec || 0);
  console.log(`[1] ok=${r1.ok} chunks=${r1.chunks} 首包=${r1.firstChunkMs}ms 总计=${r1.ms}ms 墙钟=${wall}ms 音频=${audioSec}s`);
  say(r1.ok === true && r1.streamed === true, '流式合成成功');
  say(chunks.length >= 2, `回调收到 ${chunks.length} 块（>1）`);
  say(chunks.every((c, i) => c.seq === i + 1 && c.streamId === 'svc-1'), 'seq 连续且 streamId 对齐');
  const sumSamples = chunks.reduce((n, c) => n + decode(c.samplesBase64).length, 0);
  say(sumSamples / 24000 > 0.5, `分块采样合计 ${sumSamples}（${(sumSamples / 24000).toFixed(2)}s）`);
  say(r1.firstChunkMs > 0 && r1.firstChunkMs < r1.ms / 2, `首包 ${r1.firstChunkMs}ms 不到总时长 ${r1.ms}ms 的一半`);

  // 缓存文件：流式路径必须自己把整段写进去，否则下次朗读还是整段等
  const cacheDir = join(speechDir, 'cache');
  const files = cacheFiles();
  say(files.length > 0, `缓存目录里有 ${files.length} 个 WAV`);
  const newest = files
    .map((f) => ({ f, m: statSync(join(cacheDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (newest) {
    const buf = readFileSync(join(cacheDir, newest.f));
    const dataBytes = buf.readUInt32LE(40);
    say(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE', '缓存是合法 WAV');
    say(buf.readUInt32LE(24) === 24000, `缓存采样率 ${buf.readUInt32LE(24)}`);
    say(Math.abs(dataBytes / 2 / 24000 - audioSec) < 0.05, `缓存时长 ${(dataBytes / 2 / 24000).toFixed(2)}s ≈ 合成时长 ${audioSec}s`);
  }

  // ===== 2. 同一句第二次：命中缓存，必须瞬时返回整段 =====
  const t1 = Date.now();
  const r2 = await service.synthesizeStream({ text: TEXT, sid: 3, speed: 1, streamId: 'svc-2' }, () => {
    throw new Error('缓存命中不应再有分块');
  });
  const hitMs = Date.now() - t1;
  console.log(`\n[2] cached=${r2.cached} ${hitMs}ms bytes=${r2.bytes}`);
  say(r2.ok === true && r2.cached === true, '第二次命中缓存');
  say(hitMs < 500, `命中缓存耗时 ${hitMs}ms（<500ms）`);
  say(Boolean(r2.wavBase64) && r2.wavBase64.length > 1000, '缓存返回整段 WAV');

  // ===== 3. 整段合成（旧通道）仍然可用 =====
  const r3 = await service.synthesize({ text: '你好，我是今天的面试官。', sid: 3, speed: 1 });
  say(r3.ok === true && Boolean(r3.wavBase64), '整段合成通道未被流式改造破坏');

  // ===== 4. 取消：首块到达后立刻取消，且不落缓存 =====
  const longText = `${TEXT}${TEXT}`;
  const cancelId = 'svc-cancel';
  const before = new Set(cacheFiles());
  let canceled = false;
  const cancelStart = Date.now();
  const rc = await service.synthesizeStream({ text: longText, sid: 3, speed: 1, streamId: cancelId }, () => {
    if (!canceled) {
      canceled = true;
      void service.cancelTtsStream(cancelId);
    }
  });
  console.log(`\n[4] canceled=${rc.canceled} 用时 ${Date.now() - cancelStart}ms`);
  say(rc.canceled === true, '取消后返回 canceled=true');
  const added = cacheFiles().filter((f) => !before.has(f));
  say(added.length === 0, `取消的整段没有写进缓存（新增 ${added.length} 个文件）`);

  service.shutdown();
  console.log(`\n${failures === 0 ? '[通过]' : `[失败] ${failures} 项`} 主进程语音服务流式链路`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n[失败] ${String((e && e.message) || e)}`);
  service.shutdown();
  process.exit(1);
}
