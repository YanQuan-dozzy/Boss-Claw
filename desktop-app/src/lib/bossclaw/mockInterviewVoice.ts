// 模拟面试语音：音色目录、朗读文本规范化、语音状态类型
//
// 音色说明（方案 6.5）：
//   · Kokoro 自带 100+ 中文音色，但 `zf_047` 这类编号对用户没有意义，只暴露 8 个精选（4 女 4 男）；
//   · `sid` 是 voices.bin 里的 speaker 序号，必须与模型包一致（Kokoro multi-lang v1.1：中文女 3–57、男 58–102）；
//   · 音色「全局生效、会话内不可切」——一场面试的面试官不该中途换嗓子，也避免跨模型族重载。

export interface MockVoiceOption {
  id: string;
  name: string;
  gender: 'female' | 'male';
  style: string;
  sid: number;
}

/** 8 个精选音色（默认 zf_001 温和女声） */
export const MOCK_VOICES: MockVoiceOption[] = [
  { id: 'zf_001', name: '温和女声', gender: 'female', style: '温和', sid: 3 },
  { id: 'zf_010', name: '干练女声', gender: 'female', style: '干练', sid: 12 },
  { id: 'zf_020', name: '沉稳女声', gender: 'female', style: '严肃', sid: 22 },
  { id: 'zf_030', name: '年轻女声', gender: 'female', style: '年轻', sid: 32 },
  { id: 'zm_001', name: '温和男声', gender: 'male', style: '温和', sid: 58 },
  { id: 'zm_010', name: '沉稳男声', gender: 'male', style: '干练', sid: 68 },
  { id: 'zm_020', name: '年轻男声', gender: 'male', style: '年轻', sid: 78 },
  { id: 'zm_030', name: '厚重男声', gender: 'male', style: '严肃', sid: 88 },
];

export function findVoice(id: string | undefined | null): MockVoiceOption {
  return MOCK_VOICES.find((v) => v.id === id) || MOCK_VOICES[0];
}

/**
 * 在线高音质档（Edge 神经语音）的音色映射（方案 6.6）。
 * 只有内置 8 个精选音色有对应项：克隆 / 导入音色是用户自己的声学模型，在线档用不上，
 * 主进程遇到自定义音色会自动留在本地（见 speechService.wantsOnline）。
 */
export const MOCK_ONLINE_VOICES: Record<string, string> = {
  zf_001: 'zh-CN-XiaoxiaoNeural',
  zf_010: 'zh-CN-XiaochenNeural',
  zf_020: 'zh-CN-XiaoruiNeural',
  zf_030: 'zh-CN-XiaoyiNeural',
  zm_001: 'zh-CN-YunxiNeural',
  zm_010: 'zh-CN-YunjianNeural',
  zm_020: 'zh-CN-YunyangNeural',
  zm_030: 'zh-CN-YunxiaNeural',
};

/** 把内置音色 id 映射到 Edge 音色名；未知 id 回落默认女声 */
export function onlineVoiceFor(voiceId: string | undefined | null): string {
  return MOCK_ONLINE_VOICES[findVoice(voiceId).id] || 'zh-CN-XiaoxiaoNeural';
}

/** 语速档位（0.9 / 1.0 / 1.1 / 1.2） */
export const MOCK_SPEECH_RATES = [0.9, 1.0, 1.1, 1.2];

export interface SpeechPackInfo {
  installed: boolean;
  dir: string;
  bytes: number;
  cacheBytes: number;
  version: string;
  installedAt: number;
  archiveBytes: number;
  name: string;
  desc: string;
}

export interface SpeechPackInfoAsr extends SpeechPackInfo {}
/** 克隆音色包：与 tts/asr 同一结构，只是字段名给 UI 用 */
export interface SpeechPackInfoClone extends SpeechPackInfo {}

/**
 * 克隆音色（P4-B）。
 * `engine` 固定 zipvoice；`refText` 是录参考音频时读的那句固定文本——
 * 不能省：ZipVoice 需要「参考音频 + 与它逐字对应的文本」才能对齐音素。
 */
export interface ClonedVoice {
  id: string;
  name: string;
  kind: 'cloned';
  engine: 'zipvoice';
  refText: string;
  durationSec: number;
  sampleRate: number;
  createdAt: number;
  bytes: number;
}

/** 导入的音色包（P2：Piper/VITS、Kokoro 布局；Matcha/Kitten/Pocket 明确不支持） */
export interface ImportedVoice {
  id: string;
  name: string;
  kind: 'imported';
  engine: 'kokoro' | 'vits' | 'zipvoice';
  family: string;
  numSpeakers: number;
  sid: number;
  bytes: number;
  source: string;
  license: string;
  createdAt: number;
}

export type CustomVoice = ClonedVoice | ImportedVoice;

/** 音色包探测结果（方案 6.5.2 三档：可用 / 不支持该族 / 判不出） */
export interface VoicePackProbe {
  ok: boolean;
  family: string;
  familyLabel?: string;
  engine: 'kokoro' | 'vits' | 'zipvoice' | null;
  /** vits 细分：'vits' = 已转换可直接用；'piper-raw' = 原生 Piper 包，必须换转换版 */
  kind?: 'vits' | 'piper-raw' | '';
  supported: boolean;
  reason: string;
  required: string[];
  missing: string[];
  /** vits 包没自带 espeak-ng-data，导入后会借用内置语音包的那份 */
  needsEspeak?: boolean;
  numSpeakers: number;
  bytes: number;
  fileCount: number;
  dir: string;
  error?: string;
}

/** 创建克隆音色时让用户照着读的固定文本（约 40 字，覆盖常见中文音素 + 一个英文词） */
export const CLONE_REFERENCE_TEXT =
  '大家好，我是今天的面试官。我们先用三分钟聊聊你最近负责的项目，再聊聊你在其中的具体贡献。';

export interface SpeechStatus {
  ok: boolean;
  tts?: SpeechPackInfo;
  asr?: SpeechPackInfoAsr;
  clone?: SpeechPackInfoClone;
  speechDir?: string;
  engine?: string;
  /** 在线高音质档是否开启（值来自主进程 speech/settings.json；默认 false） */
  onlineEngine?: boolean;
  workerAlive?: boolean;
  lastError?: string;
  error?: string;
}

export interface TtsResult {
  ok: boolean;
  cached?: boolean;
  /** 编码后的音频字节（WAV 或 MP3，由 mime 区分） */
  wavBase64?: string;
  /** 音频容器类型：本地合成 audio/wav，在线合成 audio/mpeg */
  mime?: string;
  /** 'online' 表示这一句由在线引擎合成；缺省表示本地 */
  engine?: string;
  bytes?: number;
  ms?: number;
  sampleRate?: number;
  error?: string;
}

/** 流式朗读的一段音频（主进程每合成完一个内部段落就推一段） */
export interface TtsChunk {
  streamId: string;
  seq: number;
  /** Float32 LE PCM 的 base64（不是 WAV，省一次编解码） */
  samplesBase64: string;
  sampleRate: number;
  numSamples: number;
  /** 0–1，底层给的合成进度 */
  progress: number;
  /** 从开始合成到这块产出的毫秒数 */
  elapsedMs: number;
}

export interface TtsStreamResult extends TtsResult {
  streamed?: boolean;
  canceled?: boolean;
  chunks?: number;
  firstChunkMs?: number;
  durationSec?: number;
  /** 主进程没有这条通道（旧版本 / 非桌面端），调用方应退回整段合成 */
  unavailable?: boolean;
}

export interface AsrSegment {
  /** 采样点下标（16k） */
  start: number;
  end: number;
  text: string;
}

export interface AsrResult {
  ok: boolean;
  text?: string;
  segments?: AsrSegment[];
  sampleRate?: number;
  durationSec?: number;
  ms?: number;
  error?: string;
}

export type SpeechInstallPhase = 'prepare' | 'download' | 'verify' | 'extract' | 'done';

/** 音色 id 是否指向克隆音色（克隆 id 前缀固定，主进程据此选引擎） */
export function isClonedVoiceId(id: string | undefined | null): boolean {
  return /^clone_[a-f0-9]{8,24}$/.test(String(id || ''));
}

/** 音色 id 是否指向任意自定义音色（clone_ / voice_） */
export function isCustomVoiceId(id: string | undefined | null): boolean {
  return /^(clone|voice)_[a-f0-9]{8,24}$/.test(String(id || ''));
}

/** 导入音色包支持/不支持的中文说明（探针结果直接用，UI 不再拼文案） */
export function describeProbe(p: VoicePackProbe | null): string {
  if (!p) return '';
  if (p.ok) {
    return `${p.familyLabel || p.family} · ${p.fileCount} 个文件 · ${formatSpeechBytes(p.bytes)}${
      p.numSpeakers > 1 ? ` · ${p.numSpeakers} 个说话人` : ''
    }`;
  }
  return p.reason || p.error || '无法识别这个目录';
}

export interface SpeechProgress {
  phase: SpeechInstallPhase;
  /** 哪一包（tts=听 / asr=说 / clone=克隆音色） */
  pack?: 'tts' | 'asr' | 'clone';
  file?: string;
  received?: number;
  total?: number;
  percent: number;
  bytes?: number;
}

/**
 * 朗读前的文本规范化（方案 6.4）：
 * 题干是给眼睛看的，含 Markdown 残留、圈号、箭头与括号，直接喂 TTS 会念出符号。
 * 屏幕文本与朗读文本分开——这里只处理朗读用的一份，英文缩写（Redis / QPS）保持原形。
 */
export function normalizeForSpeech(text: string): string {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/[*_~>]/g, '');
  s = s.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]/g, '，');
  s = s.replace(/[→⇒]/g, ' 到 ');
  s = s.replace(/[（）()]/g, '，');
  s = s.replace(/【|】/g, '，');
  s = s.replace(/[、；]/g, '，');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/，{2,}/g, '，');
  s = s.replace(/\s*\n\s*/g, '。');
  s = s.replace(/。{2,}/g, '。');
  return s.trim();
}

/** 语音包体积的人类可读格式（与 mockInterviewRepo.formatBytes 同口径，但独立导出避免跨模块耦合） */
export function formatSpeechBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
