// 导入音色包冒烟（真实 vits 包）：探测 → 试听 → 导入 → 合成 → 缓存。
//
// 为什么需要它：`voice-pack-regression.mjs` 用的是构造目录，只能证明「判定逻辑对」，
// 证明不了「这个包真的能被 sherpa 加载并念出中文」。vits 分支此前从未跑过真实模型，
// 而它和 Kokoro 的差别恰好都在加载期（onnx 元数据、tokens.txt、espeak-ng-data、22050Hz）。
//
// 用法：
//   node scripts/mock-interview-voice-vits-smoke.mjs --pack-dir <转换版 vits 包目录> --speech-dir <语音根目录>
// 其中 --speech-dir 需要已装「听」包（用来借 espeak-ng-data）。本机可用：
//   --speech-dir C:/Users/<你>/AppData/Local/Temp/kokoro
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const packDir = resolve(argOf('pack-dir', ''));
const speechDir = resolve(argOf('speech-dir', process.env.BOSSCLAW_SPEECH_DIR || ''));
if (!packDir || !existsSync(packDir)) {
  console.error('[失败] 需要 --pack-dir 指向一个转换版 vits 包目录');
  process.exit(1);
}
if (!speechDir || !existsSync(speechDir)) {
  console.error('[失败] 需要 --speech-dir 指向已装「听」包的语音根目录（用来借 espeak-ng-data）');
  process.exit(1);
}
process.env.BOSSCLAW_SPEECH_DIR = speechDir;

const require = createRequire(import.meta.url);
const Module = require('node:module');

// 与 tts-service-smoke 同一套最小 electron 替身：把 utilityProcess.fork 映射成 spawn 同一个 worker
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

const pack = require(join(root, 'electron', 'mockInterviewVoicePack.cjs'));
const voiceRepo = require(join(root, 'electron', 'mockInterviewVoiceRepo.cjs'));
const install = require(join(root, 'electron', 'speechInstall.cjs'));
const service = require(join(root, 'electron', 'speechService.cjs'));

function wavSeconds(b64) {
  const buf = Buffer.from(b64, 'base64');
  const dataBytes = buf.readUInt32LE(40);
  const rate = buf.readUInt32LE(24);
  return { sec: dataBytes / 2 / rate, rate };
}

let failures = 0;
const say = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
};

const TEXT = '你好，我是今天的面试官。请先简单介绍一下你自己，重点说说最近一个项目。';

try {
  // ===== 1. 探测 =====
  const probe = pack.probe(packDir);
  console.log(`[1] family=${probe.family} engine=${probe.engine} kind=${probe.kind} needsEspeak=${probe.needsEspeak} speakers=${probe.numSpeakers}`);
  say(probe.ok === true, '转换版 vits 包通过探测');
  say(probe.engine === 'vits', '识别为 vits 引擎');
  say(probe.needsEspeak === true, '包内没带 espeak-ng-data（要走借用）');

  // ===== 2. espeak-ng-data 借用 =====
  const borrowed = install.espeakDataDir();
  console.log(`[2] 借用目录：${borrowed}`);
  say(Boolean(borrowed) && existsSync(join(borrowed, 'phontab')), '从已装内置包借到 espeak-ng-data');
  const cfg = pack.buildEngineConfig(packDir, 'vits', { fallbackDataDir: borrowed });
  say(cfg.dataDir === borrowed, 'buildEngineConfig 回落到借用目录');
  say(cfg.tokens.endsWith('tokens.txt'), 'tokens.txt 被认出');

  // ===== 3. 试听（不落盘） =====
  const t0 = Date.now();
  const preview = await service.previewPack({ dir: packDir, sid: 0 });
  console.log(`[3] 试听 ok=${preview.ok} engine=${preview.engine} borrowed=${preview.borrowedDataDir} ${Date.now() - t0}ms`);
  say(preview.ok === true, `试听成功${preview.ok ? '' : `：${preview.error}`}`);
  const pv = preview.ok ? wavSeconds(preview.wavBase64) : { sec: 0, rate: 0 };
  say(pv.sec > 1, `试听音频 ${pv.sec.toFixed(2)}s（>1s）`);
  say(pv.rate === 22050, `采样率 ${pv.rate}Hz（vits 常用 22050，不能套用 Kokoro 的 24000）`);
  say(preview.borrowedDataDir === true, '试听结果标注了「借用了内置包音素数据」');

  // ===== 4. 导入 =====
  const before = voiceRepo.list().voices.length;
  const imported = voiceRepo.importFromDir(packDir, { name: 'Huayan 测试', license: 'smoke-test', sid: 0 });
  say(imported.ok === true, `导入成功${imported.ok ? '' : `：${imported.error}`}`);
  if (!imported.ok) throw new Error(imported.error);
  const after = voiceRepo.list().voices.length;
  say(after === before + 1, `音色列表 ${before} → ${after}`);
  say(imported.voice.engine === 'vits', 'manifest 里 engine=vits');
  const ec = voiceRepo.engineConfig(imported.voice.id);
  say(Boolean(ec && ec.config && ec.config.dataDir), 'engineConfig 解析出了可用配置');
  say(ec.borrowedDataDir === true, 'engineConfig 标记了借用音素数据');

  // ===== 5. 合成 =====
  const t1 = Date.now();
  const r1 = await service.synthesize({ text: TEXT, voiceId: imported.voice.id, speed: 1 });
  const ms1 = Date.now() - t1;
  say(r1.ok === true, `导入音色合成成功${r1.ok ? '' : `：${r1.error}`}`);
  if (r1.ok) {
    const d = wavSeconds(r1.wavBase64);
    console.log(`[5] 合成 ${ms1}ms（其中模型 ${r1.ms}ms），音频 ${d.sec.toFixed(2)}s @${d.rate}Hz，RTF=${(r1.ms / 1000 / d.sec).toFixed(2)}`);
    say(d.sec > 2, `音频 ${d.sec.toFixed(2)}s（中文没有被丢成静音）`);
    say(d.rate === 22050, '输出采样率 22050');
    const t2 = Date.now();
    const r2 = await service.synthesize({ text: TEXT, voiceId: imported.voice.id, speed: 1 });
    const hitMs = Date.now() - t2;
    say(r2.ok === true && r2.cached === true, `第二次命中缓存（${hitMs}ms）`);
  }

  // ===== 6. 流式通道也要认 22050（追问用的就是这条路）=====
  // 换一句没合成过的文本：否则会命中第 5 步写下的缓存，直接返回整段、看不到分块
  const chunks = [];
  const rs = await service.synthesizeStream(
    { text: `${TEXT}另外，你为什么想换工作？`, voiceId: imported.voice.id, speed: 1, streamId: 'vits-stream' },
    (c) => chunks.push(c),
  );
  say(rs.ok === true && chunks.length >= 1, `流式合成可用（${chunks.length} 块）`);
  if (chunks.length) {
    const sum = chunks.reduce((n, c) => n + Buffer.from(c.samplesBase64, 'base64').length / 4, 0);
    console.log(`[6] 流式 ${chunks.length} 块 / ${(sum / 22050).toFixed(2)}s，首包 ${rs.firstChunkMs}ms`);
    say(chunks[0].sampleRate === 22050, `分块采样率 ${chunks[0].sampleRate}Hz`);
    say(rs.firstChunkMs > 0, '首包时刻有记录');
  }

  // ===== 7. 清理 =====
  const removed = voiceRepo.remove(imported.voice.id);
  say(removed.ok === true, '删除导入的音色');
  say(voiceRepo.list().voices.length === before, '音色数量回到导入前');

  service.shutdown();
  console.log(`\n${failures === 0 ? '[通过]' : `[失败] ${failures} 项`} 真实 vits 包导入链路`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n[失败] ${String((e && e.message) || e)}`);
  try { service.shutdown(); } catch { /* ignore */ }
  process.exit(1);
}
