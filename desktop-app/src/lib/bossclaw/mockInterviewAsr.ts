// 语音作答：把录音交给本地 SenseVoice 转写，并算出表达体征
//
// 一次录音只调一次识别（主进程把长录音按能量 VAD 切成若干段、逐段解码）。
// 体征与分段来自同一份数据，所以「长停顿 3 次」能和转写里的断句对上。

import { electronApi } from '@/lib/electronApi';
import { computeDelivery, type DeliveryMetrics } from './mockInterviewDelivery';
import { float32ToBase64, segmentsForIpc, type RecordingResult } from './mockInterviewRecorder';

export interface TranscribeResult {
  ok: boolean;
  text: string;
  metrics: DeliveryMetrics | null;
  ms?: number;
  error?: string;
}

export async function transcribeRecording(rec: RecordingResult): Promise<TranscribeResult> {
  if (!rec.samples.length) return { ok: false, text: '', metrics: null, error: '没有录到声音' };
  const seconds = rec.samples.length / rec.sampleRate;
  if (seconds < 0.6) return { ok: false, text: '', metrics: null, error: '录音太短，说完整一点再停' };

  const r = await electronApi.mockInterview.asr({
    samplesBase64: float32ToBase64(rec.samples),
    sampleRate: rec.sampleRate,
    segments: segmentsForIpc(rec.analysis.segments),
  });
  if (!r.ok) {
    return { ok: false, text: '', metrics: null, error: r.error || '语音识别失败' };
  }
  const text = String(r.text || '').trim();
  if (!text) {
    return {
      ok: false,
      text: '',
      metrics: null,
      error: '没有识别出文字。可能是麦克风离得太远或环境太吵，可以重录，或改用文字作答。',
    };
  }
  return {
    ok: true,
    text,
    metrics: computeDelivery(text, rec.analysis),
    ms: r.ms,
  };
}

/** 预热识别模型（进入语音作答时后台调用，第一次录音不用等 1.3s 加载） */
export async function warmupAsr(): Promise<void> {
  try {
    await electronApi.mockInterview.asrWarmup();
  } catch {
    /* 预热失败不影响后续（第一次识别会再尝试） */
  }
}
