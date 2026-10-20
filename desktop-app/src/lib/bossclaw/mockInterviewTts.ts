// 模拟面试语音：播放控制（渲染层）
//
// 职责边界：
//   · 合成与缓存都在主进程（WAV 命中缓存直接返回 base64），这里只负责把音频播出来；
//   · 追问走流式：主进程每合成完一个内部段落就推一段，首块到了就开播（实测 1.7s vs 整段 13.8s）；
//   · 单实例播放器：新的朗读会先停掉上一句，并取消还在合成的流（只停播不听，后台会白烧 CPU）；
//   · 朗读与录音硬互斥（P4 接入录音时，开始录音必须先 stopSpeaking）；
//   · 朗读前做文本规范化（屏幕文本 → 朗读文本），否则会念出 Markdown 符号与圈号。
import { electronApi } from '@/lib/electronApi';
import { AudioChunkScheduler, base64ToFloat32 } from './mockInterviewAudio';
import {
  findVoice,
  isClonedVoiceId,
  isCustomVoiceId,
  normalizeForSpeech,
  onlineVoiceFor,
  type ClonedVoice,
  type CustomVoice,
  type SpeechProgress,
  type SpeechStatus,
  type TtsChunk,
  type TtsResult,
  type VoicePackProbe,
} from './mockInterviewVoice';

let audio: HTMLAudioElement | null = null;
let objectUrl = '';
let playToken = 0;

// ===== 流式朗读的播放侧 =====
// 用 Web Audio 逐块排期（而不是把块拼成一个 <audio>）：块与块首尾相接，迟到就顺延。
let ctx: AudioContext | null = null;
const liveSources = new Set<AudioBufferSourceNode>();
let scheduler: AudioChunkScheduler | null = null;
let activeStreamId = '';
let streamSeq = 0;
let chunkHandler: ((chunk: TtsChunk) => void) | null = null;
let chunkUnsub: (() => void) | null = null;
// 合成器是单实例（worker 里串行）：预渲染与「朗读」撞在一起时，必须让朗读先走。
// 这里记录"当前有几条交互式朗读占着合成器"，预渲染会等它让出来。
let synthBusy = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ensureChunkSubscription(): void {
  if (chunkUnsub) return;
  chunkUnsub = electronApi.mockInterview.onTtsChunk((chunk) => {
    try { chunkHandler?.(chunk); } catch { /* 单块播放失败不该打断整条流 */ }
  });
}

function ensureCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('当前环境不支持 Web Audio');
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 停掉正在播的块，并让主进程别再把剩下的句子合成下去 */
function stopStream(): void {
  const sid = activeStreamId;
  activeStreamId = '';
  chunkHandler = null;
  scheduler = null;
  for (const s of liveSources) {
    try { s.stop(); } catch { /* 已经自然结束 */ }
  }
  liveSources.clear();
  if (sid) void electronApi.mockInterview.ttsCancel(sid);
}

function release() {
  if (audio) {
    try { audio.pause(); } catch { /* ignore */ }
    audio.onended = null;
    audio.onerror = null;
    audio = null;
  }
  if (objectUrl) {
    try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    objectUrl = '';
  }
}

function base64ToBlob(b64: string, mime = 'audio/wav'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/wav' });
}

export function stopSpeaking(): void {
  playToken += 1;
  stopStream();
  release();
}

export function isSpeaking(): boolean {
  const audioBusy = Boolean(audio && !audio.paused && !audio.ended);
  const streamBusy = Boolean(ctx && scheduler && scheduler.endSec > ctx.currentTime + 0.02);
  return audioBusy || streamBusy;
}

/** 把一块 PCM 排进播放队列；第一块的 start 就是"出声时刻" */
function playChunk(chunk: TtsChunk, sch: AudioChunkScheduler): void {
  const c = ensureCtx();
  const samples = base64ToFloat32(chunk.samplesBase64);
  if (!samples.length) return;
  const rate = Math.max(8000, Math.min(48000, Number(chunk.sampleRate) || 24000));
  const buffer = c.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  const slot = sch.schedule(c.currentTime, buffer.duration);
  liveSources.add(src);
  src.onended = () => liveSources.delete(src);
  src.start(slot.start);
}

/** 播放一段主进程返回的 WAV；cached 仅用于诊断 */
async function playResult(r: TtsResult): Promise<{ ok: boolean; cached: boolean; error?: string }> {
  if (!r.ok || !r.wavBase64) return { ok: false, cached: false, error: r.error || '语音合成失败' };
  const token = ++playToken;
  release();
  const blob = base64ToBlob(r.wavBase64, r.mime);
  objectUrl = URL.createObjectURL(blob);
  const el = new Audio(objectUrl);
  audio = el;
  const cleanup = () => {
    if (token === playToken) release();
  };
  el.onended = cleanup;
  el.onerror = cleanup;
  try {
    await el.play();
    return { ok: true, cached: Boolean(r.cached) };
  } catch (e) {
    cleanup();
    return {
      ok: false,
      cached: Boolean(r.cached),
      error: `播放被系统拦截：${String((e as Error)?.message || e)}（可点「朗读」手动播放）`,
    };
  }
}

export interface SpeakOutcome {
  ok: boolean;
  cached: boolean;
  error?: string;
  /** 走的分块通道（首包先响） */
  streamed?: boolean;
  firstChunkMs?: number;
}

interface TtsPayload {
  text: string;
  sid: number;
  speed: number;
  voiceId?: string;
  numSteps?: number;
  /** 'online' = 在线高音质引擎（Edge 神经语音）；缺省 = 本地模型 */
  engine?: string;
  /** 在线引擎的音色名（仅内置音色有映射） */
  onlineVoice?: string;
}

export interface SpeakOptions {
  voiceId?: string;
  speed?: number;
  /** 走在线高音质引擎（仅内置音色生效；克隆/导入音色由主进程自动留在本地） */
  online?: boolean;
}

/**
 * 组装一次合成请求。
 * 两处口径必须在这里一次性定死，否则会出两类错：
 *   · 自定义音色（clone_/voice_）不把 id 带下去 → 导入的音色会被当成内置音色播放（声音不变）；
 *   · 自定义音色却又带 online → 主进程只按 id 前缀判族，会把它送去 Edge，等于换了声音。
 */
function buildPayload(text: string, opts: SpeakOptions, numSteps?: number): TtsPayload {
  const custom = isCustomVoiceId(opts.voiceId);
  const voice = custom ? null : findVoice(opts.voiceId);
  const useOnline = Boolean(opts.online) && !custom;
  const payload: TtsPayload = {
    text,
    sid: voice ? voice.sid : 0,
    speed: Number(opts.speed) || 1,
    voiceId: custom ? opts.voiceId : undefined,
    engine: useOnline ? 'online' : undefined,
    onlineVoice: useOnline ? onlineVoiceFor(opts.voiceId) : undefined,
  };
  if (numSteps != null) payload.numSteps = numSteps;
  return payload;
}

/**
 * 流式朗读。
 * @returns null 表示这条通道不可用（旧主进程 / 非桌面端），调用方应退回整段合成；
 *          其余情况一律返回最终结论（首包一到就返回，不等整句合成完）。
 */
async function speakStreamed(payload: TtsPayload, token: number): Promise<SpeakOutcome | null> {
  ensureChunkSubscription();
  streamSeq += 1;
  const streamId = `tts-${Date.now().toString(36)}-${streamSeq.toString(36)}`;
  const sch = new AudioChunkScheduler();

  let resolveFirst: (() => void) | null = null;
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  let firstChunkMs = 0;
  let playError = '';

  chunkHandler = (chunk) => {
    if (chunk.streamId !== streamId || token !== playToken) return;
    try {
      playChunk(chunk, sch);
    } catch (e) {
      // 播放通道起不来（没有音频设备 / Web Audio 不可用）：别再等整段合成，也让它停下
      playError = String((e as Error)?.message || e);
      resolveFirst?.();
      resolveFirst = null;
      void electronApi.mockInterview.ttsCancel(streamId);
      return;
    }
    if (!firstChunkMs) firstChunkMs = Number(chunk.elapsedMs) || 0;
    resolveFirst?.();
    resolveFirst = null;
  };
  activeStreamId = streamId;
  scheduler = sch;

  const done = electronApi.mockInterview.ttsStream(payload, streamId);
  synthBusy += 1;
  // 注意：不能无条件 await done —— 首包已经在播时，整段合成还要跑十几秒，
  // 那会把「已开始朗读」硬生生拖成「合成完才算开始」。
  void done.finally(() => {
    synthBusy = Math.max(0, synthBusy - 1);
    if (token === playToken && activeStreamId === streamId) {
      activeStreamId = '';
      chunkHandler = null;
    }
  });

  const winner = await Promise.race([
    first.then(() => ({ kind: 'first' as const })),
    done.then((r) => ({ kind: 'done' as const, r })),
  ]);

  if (winner.kind === 'first') {
    if (playError) return { ok: false, cached: false, streamed: true, error: `播放失败：${playError}` };
    return { ok: true, cached: false, streamed: true, firstChunkMs };
  }
  const r = winner.r;
  // 首包没来就结束了：可能是缓存命中、参数错误、取消，或这条通道根本不存在
  if (r.unavailable) return null;
  if (r.canceled) return { ok: false, cached: false, error: '朗读已停止' };
  if (!r.ok) return { ok: false, cached: false, error: r.error || '语音合成失败' };
  if (r.cached && r.wavBase64) {
    // 命中缓存时走整段播放：playToken 会被 playResult 抬起，先把流状态摘干净
    if (activeStreamId === streamId) {
      activeStreamId = '';
      chunkHandler = null;
    }
    const played = await playResult(r);
    return { ok: played.ok, cached: true, error: played.error };
  }
  if (r.wavBase64 && !r.streamed) {
    // 主进程整段返回（在线引擎：服务端一次给 mp3，没有分块 PCM）——按整段播放，不假装分块
    if (activeStreamId === streamId) {
      activeStreamId = '';
      chunkHandler = null;
    }
    const played = await playResult(r);
    return { ok: played.ok, cached: false, error: played.error };
  }
  if (r.streamed && !r.chunks) return { ok: false, cached: false, error: '合成结果为空' };
  // 有块但全都播完了（极短句）：算成功，只不过没来得及观察首包
  return { ok: true, cached: false, streamed: true, firstChunkMs: r.firstChunkMs };
}

/**
 * 朗读一句（题干 / 追问 / 反问）。
 * @returns ok=false 时调用方应静默降级为纯文字，不弹错误（朗读失败不影响作答）。
 */
export async function speak(
  text: string,
  opts: SpeakOptions = {},
): Promise<SpeakOutcome> {
  const spoken = normalizeForSpeech(text);
  if (!spoken) return { ok: false, cached: false, error: '没有可朗读的文本' };
  if (spoken.length > 600) return speak(spoken.slice(0, 600), opts);
  const payload = buildPayload(spoken, opts);
  stopSpeaking();
  const token = playToken;
  // 流式优先：题干有预渲染（缓存命中直接整段播），追问没有——整段合成要等 8–14s
  const streamed = await speakStreamed(payload, token);
  if (streamed) return streamed;
  synthBusy += 1;
  try {
    const r = await electronApi.mockInterview.tts(payload);
    const played = await playResult(r);
    return { ok: played.ok, cached: played.cached, error: played.error };
  } finally {
    synthBusy = Math.max(0, synthBusy - 1);
  }
}

/**
 * 预渲染（只合成、不播放）：阶段计划生成后把后面几题先在主进程缓存好，
 * 用户点「下一题」时命中缓存为 0 耗时。失败静默忽略——朗读本来就不阻塞作答。
 */
export async function prefetchTts(
  text: string,
  opts: SpeakOptions = {},
): Promise<void> {
  const spoken = normalizeForSpeech(text);
  if (!spoken) return;
  const cloned = isClonedVoiceId(opts.voiceId);
  // 合成器是单实例：预渲染抢在前面会让用户点「朗读」时白等一句的时间。
  // 先让出一拍（同一批 effect 里的朗读会立刻把 synthBusy 打上），再等到朗读让出合成器。
  await sleep(200);
  const deadline = Date.now() + 60000;
  while (synthBusy > 0 && Date.now() < deadline) await sleep(150);
  try {
    // 预渲染本来就慢，克隆多给两步换音质稳定；追问现场合成不走这里
    await electronApi.mockInterview.tts(buildPayload(spoken.slice(0, 600), opts, cloned ? 5 : undefined));
  } catch {
    /* 预渲染失败不影响流程 */
  }
}

/** 音色试听（固定 3 秒试听句，不落盘） */
export async function previewVoice(voiceId: string, speed = 1, online = false): Promise<{ ok: boolean; error?: string }> {
  const payload = buildPayload('', { voiceId, speed, online });
  stopSpeaking();
  // 试听句由主进程固定（渲染层不重复维护这句文案）
  const r = await electronApi.mockInterview.ttsPreview({
    sid: payload.sid,
    speed: payload.speed,
    voiceId: payload.voiceId,
    engine: payload.engine,
    onlineVoice: payload.onlineVoice,
  });
  return playResult(r);
}

// ===== 克隆音色（P4-B）=====

/** 全部自定义音色（克隆 + 导入）；UI 按 kind 过滤 */
export async function listCustomVoices(): Promise<{ ok: boolean; voices: CustomVoice[]; error?: string }> {
  return electronApi.mockInterview.voiceList();
}

/** 兼容旧调用：只要克隆音色 */
export async function listClonedVoices(): Promise<{ ok: boolean; voices: ClonedVoice[]; error?: string }> {
  const r = await listCustomVoices();
  return { ...r, voices: (r.voices || []).filter((v): v is ClonedVoice => v.kind === 'cloned') };
}

// ===== 导入音色包（P2）=====

export async function pickVoicePack(): Promise<{
  ok: boolean;
  canceled?: boolean;
  dir?: string;
  probe?: VoicePackProbe;
  error?: string;
}> {
  return electronApi.mockInterview.voicePackPick();
}

/** 试听未落盘的音色包（直接加载用户目录，失败不会留下半份复制） */
export async function previewVoicePack(
  dir: string,
  sid = 0,
): Promise<{ ok: boolean; error?: string; ms?: number; borrowedDataDir?: boolean }> {
  stopSpeaking();
  const r = await electronApi.mockInterview.voicePackPreview(dir, sid);
  if (!r.ok || !r.wavBase64) return { ok: false, error: r.error || '试听失败' };
  const played = await playWavBase64(r.wavBase64);
  return { ...played, ms: r.ms, borrowedDataDir: r.borrowedDataDir };
}

export async function importVoicePack(
  dir: string,
  opts: { name?: string; license?: string; sid?: number },
): Promise<{ ok: boolean; voice?: CustomVoice; error?: string }> {
  return electronApi.mockInterview.voiceImport(dir, { ...opts, source: dir });
}

export async function createClonedVoice(payload: {
  name: string;
  samplesBase64: string;
  sampleRate: number;
  refText: string;
  licenseAck: boolean;
}): Promise<{
  ok: boolean;
  voice?: ClonedVoice;
  previewOk?: boolean;
  previewError?: string;
  previewWavBase64?: string;
  error?: string;
}> {
  return electronApi.mockInterview.voiceCreate(payload);
}

export async function removeClonedVoice(id: string): Promise<{ ok: boolean; error?: string }> {
  return electronApi.mockInterview.voiceRemove(id);
}

export async function renameClonedVoice(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
  return electronApi.mockInterview.voiceRename(id, name);
}

/** 直接播放一段 base64 WAV（创建音色后主进程顺手合成的试听） */
export async function playWavBase64(b64: string): Promise<{ ok: boolean; error?: string }> {
  if (!b64) return { ok: false, error: '没有音频' };
  return playResult({ ok: true, wavBase64: b64 });
}

export async function getSpeechStatus(): Promise<SpeechStatus> {
  return electronApi.mockInterview.speechStatus();
}

export async function installSpeechPack(
  pack: 'tts' | 'asr' | 'clone' = 'tts',
  onProgress?: (p: SpeechProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const off = onProgress ? electronApi.mockInterview.onSpeechProgress(onProgress) : () => {};
  try {
    return await electronApi.mockInterview.speechInstall(pack);
  } finally {
    off();
  }
}

export async function cancelSpeechInstall(): Promise<{ ok: boolean }> {
  return electronApi.mockInterview.speechCancel();
}

export async function removeSpeechPack(pack: 'tts' | 'asr' | 'clone' = 'tts'): Promise<{ ok: boolean; error?: string }> {
  stopSpeaking();
  return electronApi.mockInterview.speechRemove(pack);
}

/** 在线高音质引擎开关（默认关；开启前由设置页弹隐私提示） */
export async function setOnlineEngine(on: boolean): Promise<{ ok: boolean; onlineEngine?: boolean; error?: string }> {
  stopSpeaking();
  return electronApi.mockInterview.speechSetOnline(on);
}

export async function clearSpeechCache(): Promise<{ ok: boolean; freedBytes?: number; error?: string }> {
  return electronApi.mockInterview.clearTtsCache();
}
