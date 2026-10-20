// electron/speechWorker.cjs —— 语音运行时宿主（utilityProcess 常驻）
//
// 为什么单独一个进程：sherpa-onnx 是原生插件，段错误会直接带走宿主进程。
// 放在 utilityProcess 里，崩了只是语音不可用，主进程收到 exit 后把作答降级为文字。
//
// 协议（请求/响应，id 对齐）：
//   { id, cmd: 'init',      payload: { engine: 'kokoro'|'vits'|'zipvoice', model, voices, tokens, dataDir, lexicon,
//                                       encoder, decoder, vocoder }

//   { id, cmd: 'tts',       payload: { text, sid, speed, engine,
//                                      referenceAudioBase64, referenceSampleRate, referenceText, numSteps } }
//   { id, cmd: 'tts-stream', payload: 同 tts + streamId }
//       先回若干 { id, stream:'chunk', seq, samplesBase64, sampleRate, numSamples, progress }，
//       再回 { id, ok:true, result:{ canceled, chunks, samples, sampleRate, firstChunkMs, ms } }
//   { id, cmd: 'tts-cancel', payload: { streamId } }  —— 让正在合成的流在下一个内部段落处停下
//   { id, cmd: 'init-asr',  payload: { model, tokens, numThreads } }
//   { id, cmd: 'asr',       payload: { samplesBase64, sampleRate, segments } }
//   { id, cmd: 'status' }
//   响应：{ id, ok: true, result } / { id, ok: false, error }
//
// 双通道：Electron 里走 process.parentPort；单独 node 运行时走 stdin/stdout（一行一个 JSON），
// 这样离线冒烟脚本验证的是**同一份**运行时代码，而不是另写一套。
'use strict';

const os = require('node:os');
const sherpa = require('sherpa-onnx-node');

// TTS 实例槽：按「引擎 + 模型文件」缓存，最多 2 个（kokoro / zipvoice 各一个）。
// 方案 6.5.4 原本写「同时只驻留 1 个」，但同一节又要求「一场锁定 main + followup 两个音色槽」——
// 克隆题干 + 内置追问会来回切族，单实例会让每道题都重载 1.8s。两族各留一个实例是这两条约束的
// 最小公倍数：内存约 500MB（Kokoro 326MB + ZipVoice 130MB + vocos 54MB），仍在低配可接受范围。
const TTS_CACHE_LIMIT = 2;
const ttsInstances = new Map(); // key -> { tts, info, usedAt }
let tts = null;
let initKey = '';
let initInfo = null;

// ASR（P4）：与 TTS 是两个独立实例，各自按自己的 key 惰性加载。
// 不共用 initKey：用户可能只装「说」不装「听」，也可能装了两包但只用其中一个。
let asr = null;
let asrKey = '';

// TTS 调用串行化：generate / generateAsync 跑在同一个原生实例上，底层 ONNX 会话并非线程安全，
// 并发进来只会互相抢 CPU（预渲染与「朗读」很容易撞在一起）。串行后顺序确定，也不会把进程搞崩。
let ttsChain = Promise.resolve();
function runTts(fn) {
  const run = ttsChain.then(fn, fn);
  // 队列自身不能被前一次失败打断
  ttsChain = run.then(() => {}, () => {});
  return run;
}

// 进行中的流：streamId -> { canceled }
// 注意在**入队前**就登记：排在前面的任务还在跑时，取消也要能生效（轮到它时直接跳过）。
const ttsStreams = new Map();

function send(msg) {
  if (process.parentPort) {
    process.parentPort.postMessage(msg);
  } else {
    try { process.stdout.write(`${JSON.stringify(msg)}\n`); } catch { /* ignore */ }
  }
}

function numThreadsOf(cfg) {
  // 默认吃一半核、最多 4：再多对单句合成收益很小，反而与主进程抢 CPU
  return Math.max(1, Math.min(4, Number(cfg.numThreads) || Math.ceil(os.cpus().length / 2)));
}

/**
 * 两族引擎共用同一个 OfflineTts 实例槽位（LRU 容量 1，见方案 6.5.4）：
 *   · kokoro   —— 内置 8 音色，sid 选 speaker，快；
 *   · zipvoice —— 克隆，参考音频 + 参考文本，慢（RTF≈1.3–1.55），只用于题干预生成。
 */
function buildConfig(cfg) {
  const engine = String(cfg.engine || 'kokoro');
  if (engine === 'zipvoice') {
    return {
      model: {
        zipvoice: {
          encoder: String(cfg.encoder || ''),
          decoder: String(cfg.decoder || ''),
          // distill 包没有独立声码器；字段留空即可，不要传不存在的路径（会让加载直接报错）
          vocoder: String(cfg.vocoder || ''),
          tokens: String(cfg.tokens || ''),
          dataDir: String(cfg.dataDir || ''),
          lexicon: String(cfg.lexicon || ''),
        },
      },
      maxNumSentences: 1,
      numThreads: numThreadsOf(cfg),
      provider: 'cpu',
    };
  }
  if (engine === 'vits') {
    // Piper 系：单文件 model + tokens，中文包通常还带 espeak-ng-data / dict
    return {
      model: {
        vits: {
          model: String(cfg.model || ''),
          tokens: String(cfg.tokens || ''),
          lexicon: String(cfg.lexicon || ''),
          dataDir: String(cfg.dataDir || ''),
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
      },
      maxNumSentences: 1,
      numThreads: numThreadsOf(cfg),
      provider: 'cpu',
    };
  }
  return {
    model: {
      kokoro: {
        model: String(cfg.model || ''),
        voices: String(cfg.voices || ''),
        tokens: String(cfg.tokens || ''),
        dataDir: String(cfg.dataDir || ''),
        lexicon: String(cfg.lexicon || ''),
        lengthScale: 1.0,
      },
    },
    maxNumSentences: 1,
    numThreads: numThreadsOf(cfg),
    provider: 'cpu',
  };
}

async function ensureInit(cfg) {
  const engine = String(cfg.engine || 'kokoro');
  const key = [engine, cfg.model, cfg.voices, cfg.tokens, cfg.dataDir, cfg.lexicon, cfg.encoder, cfg.decoder].join('|');
  const hit = ttsInstances.get(key);
  if (hit) {
    hit.usedAt = Date.now();
    tts = hit.tts;
    initKey = key;
    initInfo = hit.info;
    return initInfo;
  }
  const conf = buildConfig(cfg);
  const inst = await sherpa.OfflineTts.createAsync(conf);
  const info = { engine, numSpeakers: inst.numSpeakers, sampleRate: inst.sampleRate };
  ttsInstances.set(key, { tts: inst, info, usedAt: Date.now() });
  // 超限时淘汰最久未用的（只可能出现在以后加第三族时）
  while (ttsInstances.size > TTS_CACHE_LIMIT) {
    let oldestKey = '';
    let oldestAt = Infinity;
    for (const [k, v] of ttsInstances) {
      if (k !== key && v.usedAt < oldestAt) {
        oldestAt = v.usedAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    ttsInstances.delete(oldestKey);
  }
  tts = inst;
  initKey = key;
  initInfo = info;
  return info;
}

function buildAsrConfig(cfg) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: String(cfg.model || ''),
        // auto：中文回答里夹英文术语（Redis / QPS）也能识别，不用用户选语言
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: String(cfg.tokens || ''),
      numThreads: Math.max(1, Math.min(4, Number(cfg.numThreads) || Math.ceil(os.cpus().length / 2))),
      provider: 'cpu',
      debug: 0,
    },
  };
}

async function ensureAsr(cfg) {
  const key = [cfg.model, cfg.tokens].join('|');
  if (asr && key === asrKey) return { loaded: true };
  asr = null;
  asrKey = '';
  const conf = buildAsrConfig(cfg);
  asr = sherpa.OfflineRecognizer.createAsync
    ? await sherpa.OfflineRecognizer.createAsync(conf)
    : new sherpa.OfflineRecognizer(conf);
  asrKey = key;
  return { loaded: true, sampleRate: 16000 };
}

function decodeChunk(samples, sampleRate) {
  const stream = asr.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  asr.decode(stream);
  const r = asr.getResult(stream);
  return { text: String((r && r.text) || '').trim(), raw: r };
}

function decodeBase64Float32(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new Error('录音数据为空');
  if (buf.length % 4 !== 0) throw new Error('录音数据格式错误（Float32 长度不是 4 的倍数）');
  // 不能直接在 Buffer 的底层 ArrayBuffer 上开 Float32Array：Buffer.from 走内存池，
  // byteOffset 不保证 4 字节对齐，某些长度下会直接抛 RangeError。拷一份自己对齐。
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function buildTtsRequest(p) {
  const text = String(p.text || '').trim();
  if (!text) throw new Error('朗读文本为空');
  if (text.length > 1200) throw new Error('单次朗读文本过长');
  const sid = Math.max(0, Math.round(Number(p.sid) || 0));
  const speed = Math.min(1.5, Math.max(0.5, Number(p.speed) || 1));
  // 变量名不能叫 req：handle 的入参就是 req，同作用域重名会落进 TDZ
  const ttsReq = { text, sid, speed, enableExternalBuffer: false };
  if (p.referenceAudioBase64) {
    // 克隆：参考音频由主进程从 ref.wav 读出来传进来（worker 不碰文件系统，便于复跑冒烟）
    const refSamples = decodeBase64Float32(p.referenceAudioBase64);
    if (!refSamples.length) throw new Error('参考音频为空');
    ttsReq.generationConfig = {
      referenceAudio: refSamples,
      referenceSampleRate: Math.max(8000, Math.min(48000, Number(p.referenceSampleRate) || 24000)),
      referenceText: String(p.referenceText || ''),
      numSteps: Math.max(1, Math.min(16, Number(p.numSteps) || 4)),
    };
  }
  return ttsReq;
}

/** 主进程会把「这次该用哪族、模型在哪」一起传下来：切族时在这里重载，调用方不需要额外发 init */
async function prepareTts(p) {
  if (p.engineConfig) await ensureInit(p.engineConfig);
  if (!tts) throw new Error('语音模型尚未加载');
}

async function handle(req) {
  const id = req && req.id;
  try {
    if (!req || typeof req !== 'object') throw new Error('无效请求');
    if (req.cmd === 'status') {
      send({
        id,
        ok: true,
        result: {
          loaded: Boolean(tts),
          ...(initInfo || {}),
          asrLoaded: Boolean(asr),
          streaming: ttsStreams.size,
          runtime: 'sherpa-onnx-node',
        },
      });
      return;
    }
    if (req.cmd === 'init-asr') {
      const info = await ensureAsr(req.payload || {});
      send({ id, ok: true, result: info });
      return;
    }
    if (req.cmd === 'asr') {
      if (!asr) throw new Error('语音识别模型尚未加载');
      const p = req.payload || {};
      const samples = decodeBase64Float32(p.samplesBase64);
      const sampleRate = Math.max(8000, Math.min(48000, Number(p.sampleRate) || 16000));
      const started = Date.now();
      // segments 由渲染层的能量 VAD 给出：分段与「语速 / 长停顿」用的是同一份结果，
      // 否则报告里的「停顿 3 次」和转写对不上。
      const segs = Array.isArray(p.segments) && p.segments.length
        ? p.segments
            .map((s) => ({
              start: Math.max(0, Math.round(Number(s && s.start) || 0)),
              end: Math.min(samples.length, Math.round(Number(s && s.end) || 0)),
            }))
            .filter((s) => s.end > s.start)
        : [{ start: 0, end: samples.length }];

      const out = [];
      for (const seg of segs) {
        const piece = samples.subarray(seg.start, seg.end);
        if (piece.length < sampleRate * 0.1) continue;
        const r = decodeChunk(piece, sampleRate);
        out.push({ start: seg.start, end: seg.end, text: r.text });
      }
      const text = out.map((x) => x.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      send({
        id,
        ok: true,
        result: {
          text,
          segments: out,
          sampleRate,
          durationSec: Number((samples.length / sampleRate).toFixed(2)),
          ms: Date.now() - started,
        },
      });
      return;
    }
    if (req.cmd === 'init') {
      const info = await ensureInit(req.payload || {});
      send({ id, ok: true, result: info });
      return;
    }
    if (req.cmd === 'tts') {
      const p = req.payload || {};
      await runTts(async () => {
        const started = Date.now();
        await prepareTts(p);
        const ttsReq = buildTtsRequest(p);
        // Electron ≥21 禁止外部缓冲区：必须显式关闭（见方案 6.3.1）
        const audio = tts.generate(ttsReq);
        const samples = audio && audio.samples ? audio.samples : new Float32Array(0);
        if (!samples.length) throw new Error('合成结果为空');
        const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        send({
          id,
          ok: true,
          result: {
            samplesBase64: buf.toString('base64'),
            sampleRate: Number(audio.sampleRate) || tts.sampleRate,
            numSamples: samples.length,
            ms: Date.now() - started,
          },
        });
      });
      return;
    }
    if (req.cmd === 'tts-stream') {
      const p = req.payload || {};
      const streamId = String(p.streamId || '');
      const state = { canceled: false };
      if (streamId) ttsStreams.set(streamId, state);
      try {
        await runTts(async () => {
          const started = Date.now();
          // 排队期间就被取消：连模型都不用加载
          if (state.canceled) {
            send({ id, ok: true, result: { canceled: true, chunks: 0, samples: 0, ms: 0 } });
            return;
          }
          await prepareTts(p);
          const ttsReq = buildTtsRequest(p);
          const sampleRate = tts.sampleRate;
          let seq = 0;
          let total = 0;
          let firstChunkMs = 0;
          // 分块回调是「边合成边给音频」的唯一入口：返回 0 会让底层在下一个内部段落处停下
          ttsReq.onProgress = (info) => {
            if (state.canceled) return 0;
            const s = info && info.samples ? info.samples : null;
            if (!s || !s.length) return 1;
            seq += 1;
            if (!firstChunkMs) firstChunkMs = Date.now() - started;
            total += s.length;
            // 每次都要立刻转成 base64：原生侧的内存不受 GC 管，回调返回后可能就失效了
            const buf = Buffer.from(s.buffer, s.byteOffset, s.byteLength);
            send({
              id,
              stream: 'chunk',
              seq,
              samplesBase64: buf.toString('base64'),
              sampleRate,
              numSamples: s.length,
              progress: Number(info.progress) || 0,
              elapsedMs: Date.now() - started,
            });
            return 1;
          };
          await tts.generateAsync(ttsReq);
          send({
            id,
            ok: true,
            result: {
              canceled: state.canceled,
              chunks: seq,
              samples: total,
              sampleRate,
              firstChunkMs,
              ms: Date.now() - started,
            },
          });
        });
      } finally {
        if (streamId) ttsStreams.delete(streamId);
      }
      return;
    }
    if (req.cmd === 'tts-cancel') {
      const streamId = String((req.payload && req.payload.streamId) || '');
      const state = ttsStreams.get(streamId);
      if (state) state.canceled = true;
      // 已经结束的流也算「已取消」：渲染层只关心「别再出声」，不需要区分时机
      send({ id, ok: true, result: { canceled: Boolean(state) } });
      return;
    }
    throw new Error(`未知命令：${String(req.cmd)}`);
  } catch (e) {
    send({ id, ok: false, error: String((e && e.message) || e) });
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    void handle(event && event.data ? event.data : event);
  });
  // utilityProcess 生命周期由主进程管理；保持事件循环不退出
} else {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try { void handle(JSON.parse(line)); } catch (e) {
          send({ id: null, ok: false, error: String((e && e.message) || e) });
        }
      }
      idx = buf.indexOf('\n');
    }
  });
}
