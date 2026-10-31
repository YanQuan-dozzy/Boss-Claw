// MeloTTS 导入音色冒烟（真实包）：探测 → 试听 → 导入 → 合成 → 缓存 → 流式。
//
// 为什么单独一支：MeloTTS 走 vits 引擎，但它**不是** Piper 转换版——
//   ① 没有 `.onnx.json`（Piper 规则会把它判成「原生包，需转换」）；
//   ② 不需要 espeak-ng-data，包里那个 `dict/` 是 jieba 分词表，当音素目录传下去 sherpa 会报
//      `dict/phontab does not exist` 直接加载失败；
//   ③ 输出 44.1kHz，而内置 Kokoro 是 24kHz，播放/缓存/流式分块都要按模型自报采样率走。
// 这三条都只有在真模型上才验得出来，构造目录测不到。
//
// 用法：
//   node scripts/mock-interview-voice-melo-smoke.mjs --pack-dir <MeloTTS 目录> --speech-dir <语音根目录>
// 例：--pack-dir ../tmp/speech/candidates/x-melo/vits-melo-tts-zh_en --speech-dir ../tmp/speech
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
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
  console.error('[失败] 需要 --pack-dir 指向 MeloTTS 模型目录（含 model.onnx / tokens.txt / lexicon.txt）');
  process.exit(1);
}
if (!speechDir || !existsSync(speechDir)) {
  console.error('[失败] 需要 --speech-dir 指向语音根目录（导入的音色与缓存都落这里）');
  process.exit(1);
}
process.env.BOSSCLAW_SPEECH_DIR = speechDir;

const require = createRequire(import.meta.url);
const Module = require('node:module');

// 与其它语音冒烟同一套最小 electron 替身：utilityProcess.fork 映射成 spawn 同一个 worker
const bus = { message: [], exit: [] };
const fakeElectron = {
  app: { getPath: () => join(speechDir, '..'), isPackaged: false, getName: () => 'BossClaw', getAppPath: () => join(speechDir, '..') },
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
const service = require(join(root, 'electron', 'speechService.cjs'));

function wavInfo(b64) {
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
  // ===== 1. 探测：必须被认成 vits / melo，且不借 espeak =====
  const probe = pack.probe(packDir);
  console.log(`[1] family=${probe.family} kind=${probe.kind} engine=${probe.engine} needsEspeak=${probe.needsEspeak} speakers=${probe.numSpeakers}`);
  say(probe.ok === true, `MeloTTS 包通过探测${probe.ok ? '' : `：${probe.error}`}`);
  say(probe.kind === 'melo', '识别为 melo 细分（不是被拒的 piper-raw）');
  say(probe.engine === 'vits', '走 vits 引擎');
  say(probe.needsEspeak === false, '不要求 espeak-ng-data');
  say(pack.needsEspeakData(packDir, 'vits') === false, 'needsEspeakData 对 MeloTTS 返回 false（不会去借内置包）');

  // ===== 2. 配置：dataDir 必须为空 =====
  const cfg = pack.buildEngineConfig(packDir, 'vits', { fallbackDataDir: join(speechDir, 'models', 'tts', 'espeak-ng-data') });
  console.log(`[2] model=${cfg.model.split(/[\\/]/).pop()} dataDir="${cfg.dataDir}" lexicon=${Boolean(cfg.lexicon)}`);
  say(cfg.dataDir === '', 'dataDir 为空（塞 dict/ 或 espeak 都会让 sherpa 报 phontab 不存在）');
  say(/^model\.onnx$/i.test(cfg.model.split(/[\\/]/).pop()), '主模型解析到 model.onnx');
  say(Boolean(cfg.lexicon), 'lexicon.txt 被认出');

  // ===== 3. 试听（不落盘）=====
  const t0 = Date.now();
  const preview = await service.previewPack({ dir: packDir, sid: 0 });
  console.log(`[3] 试听 ok=${preview.ok} engine=${preview.engine} ${Date.now() - t0}ms`);
  say(preview.ok === true, `试听成功${preview.ok ? '' : `：${preview.error}`}`);
  const pv = preview.ok ? wavInfo(preview.wavBase64) : { sec: 0, rate: 0 };
  say(pv.sec > 1, `试听音频 ${pv.sec.toFixed(2)}s（>1s）`);
  say(pv.rate === 44100, `采样率 ${pv.rate}Hz（MeloTTS 是 44.1k，不能套 Kokoro 的 24k）`);
  say(preview.borrowedDataDir === false, '没有借用内置包音素数据');

  // ===== 4. 导入 =====
  const before = voiceRepo.list().voices.length;
  const imported = voiceRepo.importFromDir(packDir, { name: 'MeloTTS 测试', license: 'smoke-test', sid: 0 });
  say(imported.ok === true, `导入成功${imported.ok ? '' : `：${imported.error}`}`);
  if (!imported.ok) throw new Error(imported.error);
  say(voiceRepo.list().voices.length === before + 1, `音色列表 ${before} → ${before + 1}`);
  say(imported.voice.engine === 'vits', 'manifest 里 engine=vits');
  const ec = voiceRepo.engineConfig(imported.voice.id);
  say(Boolean(ec && ec.config), 'engineConfig 解析出可用配置');
  say(Boolean(ec && ec.config && ec.config.dataDir === ''), '导入后 engineConfig 的 dataDir 仍为空');

  // ===== 5. 合成 + 缓存 =====
  const t1 = Date.now();
  const r1 = await service.synthesize({ text: TEXT, voiceId: imported.voice.id, speed: 1 });
  const ms1 = Date.now() - t1;
  say(r1.ok === true, `导入音色合成成功${r1.ok ? '' : `：${r1.error}`}`);
  if (r1.ok) {
    const d = wavInfo(r1.wavBase64);
    console.log(`[5] 合成 ${ms1}ms，音频 ${d.sec.toFixed(2)}s @${d.rate}Hz，RTF=${(ms1 / 1000 / d.sec).toFixed(2)}`);
    say(d.sec > 2, `音频 ${d.sec.toFixed(2)}s（中文没有被丢成静音）`);
    say(d.rate === 44100, '输出采样率 44100');
    const t2 = Date.now();
    const r2 = await service.synthesize({ text: TEXT, voiceId: imported.voice.id, speed: 1 });
    say(r2.ok === true && r2.cached === true, `第二次命中缓存（${Date.now() - t2}ms）`);
  }

  // ===== 6. 流式通道也要按 44100 分块（追问走的就是这条路）=====
  const chunks = [];
  const rs = await service.synthesizeStream(
    { text: `${TEXT}另外，你为什么想换工作？`, voiceId: imported.voice.id, speed: 1, streamId: 'melo-stream' },
    (c) => chunks.push(c),
  );
  say(rs.ok === true && chunks.length >= 1, `流式合成可用（${chunks.length} 块）`);
  if (chunks.length) {
    const sum = chunks.reduce((n, c) => n + Buffer.from(c.samplesBase64, 'base64').length / 4, 0);
    console.log(`[6] 流式 ${chunks.length} 块 / ${(sum / 44100).toFixed(2)}s，首包 ${rs.firstChunkMs}ms`);
    say(chunks[0].sampleRate === 44100, `分块采样率 ${chunks[0].sampleRate}Hz`);
    say(rs.firstChunkMs > 0, '首包时刻有记录');
  }

  // ===== 7. 清理 =====
  say(voiceRepo.remove(imported.voice.id).ok === true, '删除导入的音色');
  say(voiceRepo.list().voices.length === before, '音色数量回到导入前');

  service.shutdown();
  console.log(`\n${failures === 0 ? '[通过]' : `[失败] ${failures} 项`} MeloTTS 导入链路`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n[失败] ${String((e && e.message) || e)}`);
  try { service.shutdown(); } catch { /* ignore */ }
  process.exit(1);
}
