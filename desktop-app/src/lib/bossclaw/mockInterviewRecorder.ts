// 麦克风录音（P4）：16k 单声道采集 + 能量 VAD 分段
//
// 为什么不用 MediaRecorder：它输出 webm/opus，还得在主进程解码；而 ASR 要的是 16k Float32。
// 这里直接拿 AudioContext 的 PCM，省一层编解码，也让「分段」与「转写」天然用同一份数据。
//
// AudioWorklet 需要额外模块文件（file:// 下加载有坑），这里用 ScriptProcessor：
// 已废弃但 Chromium 仍然稳定支持，且 1024 帧的延迟对「说完再转写」的离线场景完全够用。
//
// ScriptProcessor 必须在 destination 上挂着才会持续触发；用一个 0 增益节点接出去，避免回声。

import { analyzeEnergy, type EnergyAnalysis, type VoiceSegment } from './mockInterviewDelivery';

const TARGET_RATE = 16000;
const BUFFER_SIZE = 1024;

export interface RecordingResult {
  samples: Float32Array;
  sampleRate: number;
  analysis: EnergyAnalysis;
}

export interface RecordOptions {
  /** 实时音量（0–1，用于 UI 电平条） */
  onLevel?: (level: number) => void;
  /** 达到上限自动停止（UI 负责真正调用 stop） */
  onAutoStop?: () => void;
  maxSec?: number;
}

function pickMimeError(e: unknown): string {
  const name = (e as { name?: string })?.name || '';
  const msg = String((e as Error)?.message || e);
  if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
    return '麦克风权限被拒绝。请在系统设置里允许 BossClaw 使用麦克风后重试。';
  }
  if (name === 'NotFoundError' || /no.*device|not found/i.test(msg)) {
    return '没有找到可用的麦克风设备。';
  }
  if (name === 'NotReadableError') {
    return '麦克风被其他程序占用（会议软件 / 录音工具），请关闭后重试。';
  }
  return `无法开始录音：${msg}`;
}

/** 简单线性重采样（设备不支持 16k 时兜底；正常 Chromium 会直接给 16k） */
function resampleTo16k(input: Float32Array, from: number): Float32Array {
  if (from === TARGET_RATE) return input;
  const ratio = from / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private total = 0;
  private startedAt = 0;
  private autoStopFired = false;
  private options: RecordOptions = {};
  private levelTimer = 0;

  get isRecording(): boolean {
    return Boolean(this.ctx);
  }

  get elapsedSec(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  async start(options: RecordOptions = {}): Promise<void> {
    if (this.ctx) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风采集');
    this.options = options;
    this.chunks = [];
    this.total = 0;
    this.autoStopFired = false;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      throw new Error(pickMimeError(e));
    }

    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ sampleRate: TARGET_RATE });
    await this.ctx.resume().catch(() => undefined);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;

    this.processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      // copy：inputBuffer 的底层数组会被复用
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);
      this.total += copy.length;
      const maxSec = Number(this.options.maxSec) || 180;
      if (!this.autoStopFired && this.total / this.ctx!.sampleRate >= maxSec) {
        this.autoStopFired = true;
        this.options.onAutoStop?.();
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.startedAt = Date.now();

    // 电平条：ScriptProcessor 的块太短，按 100ms 采样一次就够 UI 用
    this.levelTimer = window.setInterval(() => {
      const last = this.chunks[this.chunks.length - 1];
      if (!last || !this.options.onLevel) return;
      let sum = 0;
      for (let i = 0; i < last.length; i += 4) sum += last[i] * last[i];
      const rms = Math.sqrt(sum / Math.max(1, Math.ceil(last.length / 4)));
      this.options.onLevel(Math.min(1, rms * 6));
    }, 100);
  }

  /** 停止并返回 PCM + 能量分段 */
  async stop(): Promise<RecordingResult> {
    const ctx = this.ctx;
    const rate = ctx?.sampleRate || TARGET_RATE;
    this.cleanup();
    const merged = new Float32Array(this.total);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];
    this.total = 0;
    const samples = resampleTo16k(merged, rate);
    return {
      samples,
      sampleRate: TARGET_RATE,
      analysis: analyzeEnergy(samples, TARGET_RATE),
    };
  }

  cancel(): void {
    this.cleanup();
    this.chunks = [];
    this.total = 0;
  }

  private cleanup(): void {
    if (this.levelTimer) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = 0;
    }
    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.sink?.disconnect(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    this.startedAt = 0;
  }
}

/** Float32 → base64（分块，避免 String.fromCharCode 参数过多爆栈） */
export function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 分段转成 IPC 需要的纯数据（不要带 Float32Array，结构化克隆会连音频一起传过去） */
export function segmentsForIpc(segments: VoiceSegment[]): Array<{ start: number; end: number }> {
  return segments.map((s) => ({ start: s.start, end: s.end }));
}
