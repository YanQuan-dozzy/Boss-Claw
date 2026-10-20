// 流式朗读的纯逻辑：PCM 编解码 + 分块排期
//
// 单独拆出来不是为了"分层好看"，而是因为这两块最容易悄悄错：
//   · base64 ↔ Float32 的对齐问题已经被咬过两次（Buffer 内存池 byteOffset 不是 4 的倍数）；
//   · 分块播放的间隙是"用户能听见、代码看不出来"的东西，必须能离线复现。
// 这里不碰 DOM，也不碰 IPC，回归脚本（scripts/tts-stream-regression.mjs）直接跑。

/**
 * Float32 PCM → base64。
 * 分片做 String.fromCharCode：一次性 apply 几十万个参数会直接爆栈。
 */
export function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const step = 4096;
  let bin = '';
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * base64 → Float32 PCM。
 * 长度不是 4 的倍数时截断到最后整采样：宁可丢半个采样，也不能让整句朗读直接抛异常。
 */
export function base64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const usable = bin.length - (bin.length % 4);
  if (usable <= 0) return new Float32Array(0);
  // 必须新建独立 ArrayBuffer：从别处借来的 buffer 起点不保证 4 字节对齐
  const ab = new ArrayBuffer(usable);
  const view = new Uint8Array(ab);
  for (let i = 0; i < usable; i += 1) view[i] = bin.charCodeAt(i);
  return new Float32Array(ab);
}

export interface ChunkSlot {
  /** 排给这一块的开始时刻（AudioContext 时间轴，秒） */
  start: number;
  /** 距上一块结束的空隙；块连续时为 0 */
  gap: number;
}

/**
 * 分块排期器：保证块与块首尾相接，迟到就顺延并记一次"断音"。
 *
 * 实测（Kokoro / 本机 CPU）各块到达时刻与时长（秒）：
 *   1.66→1.87、2.73→1.11、5.00→2.87、7.88→3.65 ……
 * 生成速度整体快于播放（RTF≈0.83），但单块大小不均，第二块到第三块之间会空 0.35s。
 * 这不是 bug，是"边合成边播"的固有代价；记录下来，将来要调 lead 也有依据。
 */
export class AudioChunkScheduler {
  private started = false;
  private endAt = 0;
  chunks = 0;
  /** 断音次数（间隙超过阈值） */
  underruns = 0;
  maxGap = 0;
  /** 第一块的开始时刻，用于统计"点击到出声" */
  firstStart = 0;
  /** 按目前排期，最后一块播完的时刻 */
  get endSec(): number {
    return this.endAt;
  }

  constructor(
    /** 首块留的缓冲：太小容易被系统调度吞掉开头，太大就失去"首包快"的意义 */
    readonly leadSec = 0.15,
    /** 超过这个间隙才算一次断音（20ms 级别听不出来） */
    readonly gapThresholdSec = 0.08,
  ) {}

  /** @param nowSec 当前 AudioContext 时间；@param durationSec 这一块的时长 */
  schedule(nowSec: number, durationSec: number): ChunkSlot {
    const duration = Math.max(0, durationSec);
    let start: number;
    let gap = 0;
    if (!this.started) {
      start = nowSec + this.leadSec;
      this.firstStart = start;
    } else {
      // 块来晚了：不能让开始时间落在过去（WebAudio 会立刻播放，等于把整块挤成一团）
      start = Math.max(this.endAt, nowSec + 0.01);
      gap = Math.max(0, start - this.endAt);
      if (gap > this.gapThresholdSec) {
        this.underruns += 1;
        this.maxGap = Math.max(this.maxGap, gap);
      }
    }
    this.started = true;
    this.chunks += 1;
    this.endAt = start + duration;
    return { start, gap };
  }
}
