// 表达体征（P4）：从录音 PCM 与转写文本算出「语速 / 长停顿 / 口头禅」
//
// 三条口径（方案 §4.5）：
//   1. 体征**不参与内容分**，单独展示。内容好但语速偏快，与内容空但口齿伶俐，改进方向相反；
//   2. 语音段与 ASR 输入用**同一份**分段结果——体征和转写必须能对上，否则「停顿 3 次」无法解释；
//   3. 只报可复算的量：字/分钟、≥1.5s 的停顿次数、口头禅次数。不做「自信度」「流畅度评分」这类无法复算的指标。
//
// VAD 说明：用 16k / 20ms 帧的短时能量做端点检测（自适应噪声底），不依赖额外模型。
// 对近场麦克风的单人作答足够稳定；分段结果同时用于把长录音切成 ASR 可处理的若干段。

export interface VoiceSegment {
  /** 起始采样点（含） */
  start: number;
  /** 结束采样点（不含） */
  end: number;
}

export interface EnergyAnalysis {
  segments: VoiceSegment[];
  /** 有声时长（秒） */
  speechSec: number;
  /** 段间停顿总时长（秒，不含首尾静音） */
  pauseSec: number;
  /** ≥1.5s 的停顿次数 */
  longPauses: number;
  /** 有声占比 0–1 */
  speechRatio: number;
  /** 总时长（秒） */
  durationSec: number;
  /** 噪声底（RMS），用于解释为什么某段被判成静音 */
  noiseFloor: number;
}

export interface DeliveryMetrics {
  durationSec: number;
  speechSec: number;
  /** 字/分钟（只数非空白字符） */
  charsPerMinute: number;
  longPauses: number;
  pauseSec: number;
  /** 口头禅命中次数（词 → 次数） */
  fillerWords: Record<string, number>;
  fillerTotal: number;
  speechRatio: number;
  /** 口播总字数 */
  chars: number;
}

export const FILLER_WORDS = ['那个', '然后', '就是', '这个', '其实', '嗯', '呃', '反正', '所以说'];

const FRAME_MS = 20;
const LONG_PAUSE_SEC = 1.5;
/** 段内允许合并的最大静音（说一句话中间的正常换气） */
const MERGE_GAP_SEC = 0.32;
/** 短于这个时长的「有声段」按噪声丢弃 */
const MIN_SPEECH_SEC = 0.18;

function frameRms(samples: Float32Array, from: number, to: number, stride: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i += stride) {
    const v = samples[i];
    sum += v * v;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * 短时能量端点检测。
 * - 20ms 一帧，每帧取 4 个采样点算 RMS（16k 下 320 点一帧，步长 4 足够稳定且快）；
 * - 噪声底取 20 分位，阈值 = max(0.008, 噪声底 × 2.5)：安静房间与有底噪的房间都能用；
 * - 间隔 < 320ms 的有声段合并（正常换气不算停顿）；
 * - 短于 180ms 的有声段丢弃（键盘、咳嗽）。
 */
export function analyzeEnergy(
  samples: Float32Array,
  sampleRate = 16000,
  opts: { minSpeechSec?: number; mergeGapSec?: number; longPauseSec?: number; threshold?: number } = {},
): EnergyAnalysis {
  const sr = Number(sampleRate) || 16000;
  const frameLen = Math.max(1, Math.round((sr * FRAME_MS) / 1000));
  const total = samples.length;
  const durationSec = total / sr;
  const minSpeech = opts.minSpeechSec ?? MIN_SPEECH_SEC;
  const mergeGap = opts.mergeGapSec ?? MERGE_GAP_SEC;
  const longPause = opts.longPauseSec ?? LONG_PAUSE_SEC;

  const rms: number[] = [];
  for (let i = 0; i + frameLen <= total; i += frameLen) {
    rms.push(frameRms(samples, i, i + frameLen, 4));
  }
  const noiseFloor = percentile(rms, 0.2);
  // 噪声底要设上限：整段几乎都在说话时，20 分位拿到的就是语音本身的能量，
  // 直接乘 2.5 会把所有帧判成静音（实测：3 秒说话 + 0.2 秒换气 → 0 段）。
  const adaptive = Math.min(Math.max(noiseFloor * 2.5, 0.008), 0.03);
  const threshold = Math.max(0.005, opts.threshold ?? adaptive);

  // 原始有声帧 → 采样区间
  const raw: VoiceSegment[] = [];
  let runStart = -1;
  rms.forEach((v, idx) => {
    const isSpeech = v > threshold;
    if (isSpeech && runStart < 0) runStart = idx * frameLen;
    if (!isSpeech && runStart >= 0) {
      raw.push({ start: runStart, end: idx * frameLen });
      runStart = -1;
    }
  });
  if (runStart >= 0) raw.push({ start: runStart, end: Math.floor(total / frameLen) * frameLen });

  // 合并相邻段（间隙 < mergeGap）
  const merged: VoiceSegment[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (seg.start - prev.end) / sr < mergeGap) prev.end = seg.end;
    else merged.push({ ...seg });
  }

  const segments = merged.filter((s) => (s.end - s.start) / sr >= minSpeech);
  const speechSec = segments.reduce((sum, s) => sum + (s.end - s.start) / sr, 0);
  let pauseSec = 0;
  let longPauses = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const gap = (segments[i].start - segments[i - 1].end) / sr;
    if (gap > 0) {
      pauseSec += gap;
      if (gap >= longPause) longPauses += 1;
    }
  }

  return {
    segments,
    speechSec: Number(speechSec.toFixed(2)),
    pauseSec: Number(pauseSec.toFixed(2)),
    longPauses,
    speechRatio: durationSec > 0 ? Number((speechSec / durationSec).toFixed(3)) : 0,
    durationSec: Number(durationSec.toFixed(2)),
    noiseFloor: Number(noiseFloor.toFixed(4)),
  };
}

/** 统计非空白字符数（中文按字、英文按字符，量级一致，避免「一个英文单词算几个字」的口径争议） */
export function countChars(text: string): number {
  return [...String(text || '').replace(/\s/g, '')].length;
}

/** 口头禅统计（不重叠匹配；「然后」出现 3 次就记 3 次） */
export function countFillers(text: string, words: string[] = FILLER_WORDS): { total: number; detail: Record<string, number> } {
  const s = String(text || '');
  const detail: Record<string, number> = {};
  let total = 0;
  for (const w of words) {
    if (!w) continue;
    let from = 0;
    let count = 0;
    while (from <= s.length) {
      const i = s.indexOf(w, from);
      if (i < 0) break;
      count += 1;
      from = i + w.length;
    }
    if (count) {
      detail[w] = count;
      total += count;
    }
  }
  return { total, detail };
}

/**
 * 汇总体征。语速以「有声时长」为分母——用总时长会把停顿算成语速慢，
 * 而停顿已经单独报了，混在一起就无法解释。
 */
export function computeDelivery(
  transcript: string,
  analysis: EnergyAnalysis,
  sampleRateSpeechSec?: number,
): DeliveryMetrics {
  const chars = countChars(transcript);
  const speechSec = Math.max(0.5, sampleRateSpeechSec ?? analysis.speechSec);
  const filler = countFillers(transcript);
  return {
    durationSec: analysis.durationSec,
    speechSec: Number(speechSec.toFixed(2)),
    charsPerMinute: Math.round((chars / speechSec) * 60),
    longPauses: analysis.longPauses,
    pauseSec: analysis.pauseSec,
    fillerWords: filler.detail,
    fillerTotal: filler.total,
    speechRatio: analysis.speechRatio,
    chars,
  };
}

export const EMPTY_DELIVERY: DeliveryMetrics = {
  durationSec: 0,
  speechSec: 0,
  charsPerMinute: 0,
  longPauses: 0,
  pauseSec: 0,
  fillerWords: {},
  fillerTotal: 0,
  speechRatio: 0,
  chars: 0,
};

/** 语速区间（中文面试口播的经验区间，只做提示不做评分） */
export function paceLabel(cpm: number): { text: string; tone: 'ok' | 'warn' } {
  if (!cpm) return { text: '—', tone: 'warn' };
  if (cpm < 170) return { text: '偏慢', tone: 'warn' };
  if (cpm > 330) return { text: '偏快', tone: 'warn' };
  return { text: '适中', tone: 'ok' };
}

/** 多题体征汇总（报告顶部一行） */
export function aggregateDelivery(list: DeliveryMetrics[]): DeliveryMetrics | null {
  const valid = list.filter((d) => d && d.speechSec > 0.5);
  if (!valid.length) return null;
  const speechSec = valid.reduce((s, d) => s + d.speechSec, 0);
  const chars = valid.reduce((s, d) => s + d.chars, 0);
  const fillerWords: Record<string, number> = {};
  valid.forEach((d) => {
    Object.entries(d.fillerWords || {}).forEach(([k, v]) => {
      fillerWords[k] = (fillerWords[k] || 0) + v;
    });
  });
  return {
    durationSec: Number(valid.reduce((s, d) => s + d.durationSec, 0).toFixed(2)),
    speechSec: Number(speechSec.toFixed(2)),
    charsPerMinute: Math.round((chars / Math.max(0.5, speechSec)) * 60),
    longPauses: valid.reduce((s, d) => s + d.longPauses, 0),
    pauseSec: Number(valid.reduce((s, d) => s + d.pauseSec, 0).toFixed(2)),
    fillerWords,
    fillerTotal: valid.reduce((s, d) => s + d.fillerTotal, 0),
    speechRatio: Number((speechSec / Math.max(0.1, valid.reduce((s, d) => s + d.durationSec, 0))).toFixed(3)),
    chars,
  };
}
