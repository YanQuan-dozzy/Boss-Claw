// 模拟面试（Mock Interview）数据模型与确定性口径
//
// 命名避让：项目已有 `interviewMode.ts`（线上/线下筛选）与投递漏斗里的「面试」阶段（真实邀约），
// 本功能在代码层统一使用 `mockInterview*` 前缀，只在 UI 文案上叫「模拟面试」。
//
// 本文件的常量是评分与展示的唯一权威：
//   · 模型只输出「四档 + 档内位置」{ level, pos }，不直接给 0–100（见 LEVEL_SCORE）；
//   · 维度权重、证据档（总分映射）、证据状态枚举都只在这里定义一次；
//   · 报告里的总分、档位、维度分由本地确定性计算，模型自报的 total 一律丢弃。

/** 面试官类型：影响出题取向（HR 面偏动机/稳定性，技术面偏原理/深挖，主管面偏推进/取舍） */
export type MockInterviewRole = 'hr' | 'tech' | 'manager' | 'general';

/** 难度：基础 / 标准 / 压力 */
export type MockDifficulty = 'basic' | 'standard' | 'stress';

/** 作答方式：P1 仅文字可用，语音在 P4 接入（字段先落，避免后续改数据结构） */
export type MockAnswerMode = 'text' | 'voice';

/**
 * 会话状态机：
 * draft(配置) → ready(阶段一计划就绪) → running(逐题作答) → planning(生成阶段二)
 *   → running → reverse(反问) → reporting(批量评分) → finished(报告)
 * 中途退出后从文件恢复；planning 阶段重进可重新生成阶段二，阶段一答案不丢。
 */
export type MockSessionStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'planning'
  | 'reverse'
  | 'reporting'
  | 'finished';

/** 题目类型：计划题 / 动态插题 */
export type MockQuestionKind = 'planned' | 'injected';

/** 题型分类 */
export type MockQuestionCategory = 'icebreak' | 'fundamental' | 'project' | 'behavior' | 'closing';

/**
 * 六态证据（只在报告里出现，作答过程中不展示，避免变相泄露评分）：
 * insufficient 不足 / vague 模糊 / partial 部分 / solid 扎实 / strong 强 / conflict 矛盾
 */
export type MockEvidenceState =
  | 'insufficient'
  | 'vague'
  | 'partial'
  | 'solid'
  | 'strong'
  | 'conflict';

/**
 * 证据状态的判定来源：
 * `ai` = 模型裁决；`rule` = 本地五条规则命中（无 AI 输出，状态固定 partial）。
 * 报告必须显示来源，否则「证据强度」会变成没有出处的数字。
 */
export type MockEvidenceSource = 'ai' | 'rule';

/** 评分依据：仅主答 / 主答 + 追问补答（追问补答计入该题分，见方案 4.3） */
export type MockScoredWith = 'main' | 'withProbes';

/** 表达体征（P4）：只展示、不参与内容分；字段口径见 mockInterviewDelivery.ts */
export interface MockDeliveryMetrics {
  durationSec: number;
  speechSec: number;
  charsPerMinute: number;
  longPauses: number;
  pauseSec: number;
  fillerWords: Record<string, number>;
  fillerTotal: number;
  speechRatio: number;
  chars: number;
}

/** 要点来源：题库 / AI 现编 / 无要点 */
export type MockKeyPointsFrom = 'bank' | 'ai' | 'none';

/** 4+1 维（权重之和为 1） */
export type MockDimensionKey = 'relevance' | 'evidence' | 'structure' | 'depth' | 'reflection';

export interface MockDimensionDef {
  key: MockDimensionKey;
  label: string;
  weight: number;
  /** 该维对某些题型可能不适用（如行为题的专业深度），报告显示「不适用」而不是 0 分 */
  allowNotApplicable: boolean;
}

export const MOCK_DIMENSIONS: MockDimensionDef[] = [
  { key: 'relevance', label: '相关性', weight: 0.3, allowNotApplicable: false },
  { key: 'evidence', label: '证据具体性', weight: 0.25, allowNotApplicable: false },
  { key: 'structure', label: '思路结构', weight: 0.2, allowNotApplicable: false },
  { key: 'depth', label: '专业深度', weight: 0.15, allowNotApplicable: true },
  { key: 'reflection', label: '复盘与权衡', weight: 0.1, allowNotApplicable: true },
];

export const MOCK_DIMENSION_KEYS: MockDimensionKey[] = MOCK_DIMENSIONS.map((d) => d.key);

/**
 * 四档 × 档内位置 → 0–100 的映射表（唯一的分数来源）。
 * 模型不直接给分：宽尺度会聚集在 70–85（score clustering），四档 12 级分辨率既保留
 * 「这场比上场进步」的连续性，又让相邻档之间有明确语义边界。
 */
export const LEVEL_SCORE: Record<1 | 2 | 3 | 4, [number, number, number]> = {
  4: [85, 89, 93],
  3: [72, 76, 80],
  2: [55, 60, 65],
  1: [30, 40, 48],
};

/** 无证据 / 引用对不上时的硬性压分上限（严格小于 70） */
export const MOCK_EVIDENCE_SCORE_CAP = 69;

/** 证据原句最短长度（去空白后），低于此长度视为未提供证据 */
export const MOCK_MIN_EVIDENCE_CHARS = 10;

/** 同一题最多追问轮数（两轮用尽强制推进） */
export const MOCK_MAX_FOLLOWUPS = 2;

/** 评分口径版本：提示词或 LEVEL_SCORE 变更时 +1，旧报告按旧版本解释 */
export const MOCK_RUBRIC_VERSION = 1;

/** 开场白（报告与朗读共用；不进 AI 调用） */
export const MOCK_OPENING_LINE = '你好，我是今天的面试官。我们会围绕这个岗位聊 7 到 10 个问题，中间可能会追问，请尽量用具体的事例回答。准备好了我们就开始。';

export interface MockBand {
  key: 'strong' | 'effective' | 'improve' | 'insufficient';
  label: string;
  min: number;
}

/** 四档「证据档」：描述这场答得够不够硬，不预测录用结果（禁止 hiring_probability 口径） */
export const MOCK_BANDS: MockBand[] = [
  { key: 'strong', label: '证据充分且回答有力', min: 85 },
  { key: 'effective', label: '基本有效', min: 70 },
  { key: 'improve', label: '需要加强', min: 50 },
  { key: 'insufficient', label: '证据不足', min: 0 },
];

export const MOCK_ROLE_LABELS: Record<MockInterviewRole, string> = {
  hr: 'HR 面',
  tech: '技术面',
  manager: '主管面',
  general: '综合面',
};

export const MOCK_DIFFICULTY_LABELS: Record<MockDifficulty, string> = {
  basic: '基础',
  standard: '标准',
  stress: '压力',
};

export const MOCK_CATEGORY_LABELS: Record<MockQuestionCategory, string> = {
  icebreak: '破冰',
  fundamental: '专业基础',
  project: '项目深挖',
  behavior: '行为',
  closing: '收尾',
};

export const MOCK_EVIDENCE_LABELS: Record<MockEvidenceState, string> = {
  insufficient: '不足',
  vague: '模糊',
  partial: '部分',
  solid: '扎实',
  strong: '强',
  conflict: '矛盾',
};

export const MOCK_STATUS_LABELS: Record<MockSessionStatus, string> = {
  draft: '配置中',
  ready: '题目已就绪',
  running: '进行中',
  planning: '生成深挖题',
  reverse: '反问环节',
  reporting: '评分中',
  finished: '已完成',
};

/** 配置项（会话开始时快照，会话内不可改；音色在 P2 起生效） */
export interface MockInterviewConfig {
  role: MockInterviewRole;
  difficulty: MockDifficulty;
  /** 阶段一 4–6 题 */
  phase1Count: number;
  /** 阶段二 3–4 题 */
  phase2Count: number;
  answerMode: MockAnswerMode;
  readAloud: boolean;
  voiceId: string;
  speechRate: number;
  /** 题库参与（P3 生效；关掉则退化为纯 AI 出题） */
  bankEnabled: boolean;
  recallTopK: number;
}

export const MOCK_DEFAULT_CONFIG: MockInterviewConfig = {
  role: 'general',
  difficulty: 'standard',
  phase1Count: 4,
  phase2Count: 3,
  answerMode: 'text',
  // P2 起默认自动朗读题干；语音包未安装时页面会引导安装并静默降级为文字
  readAloud: true,
  voiceId: 'zf_001',
  speechRate: 1,
  bankEnabled: true,
  recallTopK: 20,
};

/** 岗位绑定：jobId 可空（手填岗位），JD 快照不可省（达标岗位缓存只留 7 天，没快照无法复盘） */
export interface MockJobRef {
  jobId: string | null;
  jobTitle: string;
  company: string;
  jdText: string;
  capturedAt: number;
}

export interface MockQuestion {
  id: string;
  phase: 1 | 2;
  kind: MockQuestionKind;
  /** 插题来源题 id（`kind === 'injected'` 时有值） */
  injectedFrom?: string | null;
  category: MockQuestionCategory;
  text: string;
  /** 对应 JD 原文要求（报告里反向定位「哪条要求没答到」） */
  jdRef?: string;
  /** 锚定的简历事实（证明面试官「看过简历」） */
  resumeRef?: string;
  /** 考察点 2–4 条；报告里「命中/漏答」对着它逐条比 */
  focus: string[];
  /** 评分要点：只在报告阶段使用，作答前不下发到 UI */
  rubric?: string[];
  /** 预设追问方向 1–2 条 */
  probeDirections?: string[];
  /** 改自题库某题时记其 id；AI 原创为 null */
  sourceQuestionId?: string | null;
  /** 来源题库 id（报告里可回溯到具体题库；AI 原创为 null） */
  sourceBankId?: string | null;
  /** 报告要点是否来自题库（决定「题库要点 / AI 推断」标注） */
  keyPointsFrom: MockKeyPointsFrom;
}

/** 追问记录：问答对计入该题评分（上限 2 轮） */
export interface MockProbe {
  id: string;
  question: string;
  answer: string;
  askedAt: number;
  answeredAt?: number;
  evidenceState?: MockEvidenceState;
  evidenceSource?: MockEvidenceSource;
}

export interface MockAttempt {
  id: string;
  questionId: string;
  /** 主答 */
  answer: string;
  /** 未提交的草稿（节流落盘，中途退出可恢复） */
  draft?: string;
  probes: MockProbe[];
  skipped: boolean;
  submittedAt: number;
  /** 追问裁决结果（六态）与来源 */
  evidenceState?: MockEvidenceState;
  evidenceSource?: MockEvidenceSource;
  /** 评分依据（主答 / 主答 + 追问） */
  scoredWith?: MockScoredWith;
  /** 该题总分（本地加权） */
  score?: number | null;
  dimensionScores?: Partial<Record<MockDimensionKey, number | null>>;
  dimensionEvidence?: Partial<Record<MockDimensionKey, string>>;
  /** 某个维度的引用未能在回答中定位 */
  invalidEvidence?: boolean;
  hitPoints?: string[];
  missedPoints?: string[];
  suggestion?: string;
  keyPointsFromAtScore?: MockKeyPointsFrom;
  /** 该次作答总计耗时（毫秒，P1 起记录，不参与内容分） */
  durationMs?: number;
  /** 语音作答的表达体征（文字作答时为空；不参与内容分） */
  delivery?: MockDeliveryMetrics;
}

/** 追问裁决结果（一次调用同时决定：证据状态、是否追问、追问什么、是否插题） */
export interface MockAdvanceResult {
  action: 'followup' | 'advance';
  evidenceState: MockEvidenceState;
  evidenceSource: MockEvidenceSource;
  /** action=followup 时的追问原话 */
  probe?: string;
  /** 动态插题（每阶段 ≤1、全场 ≤2）；不插时为 null */
  inject?: MockQuestion | null;
}

/** 反问环节：不计入内容总分；违反白名单的回答不入存档（kept=false 时清空 answer） */
export interface MockReverseTurn {
  question: string;
  answer: string;
  kept: boolean;
  comment?: string;
  askedAt: number;
}

export interface MockDimensionResult {
  key: MockDimensionKey;
  label: string;
  weight: number;
  /** null = N/A（未作答 / 不适用），不参与加权，不按 0 分处理 */
  score: number | null;
  na: boolean;
  naReason?: string;
}

export interface MockQuestionResult {
  questionId: string;
  questionText: string;
  phase: 1 | 2;
  answer: string;
  probes: { question: string; answer: string }[];
  dimensionScores: Partial<Record<MockDimensionKey, number | null>>;
  dimensionEvidence: Partial<Record<MockDimensionKey, string>>;
  evidenceState: MockEvidenceState;
  evidenceSource: MockEvidenceSource;
  invalidEvidence: boolean;
  scoredWith: MockScoredWith;
  hitPoints: string[];
  missedPoints: string[];
  suggestion: string;
  skipped: boolean;
  keyPointsFrom: MockKeyPointsFrom;
  score: number | null;
  /** 表达建议（AI 主观，纯文字；不参与内容分） */
  deliveryNote?: string;
  /** 本地计算的表达体征（录音作答才有；与内容分完全分离） */
  delivery?: MockDeliveryMetrics;
}

export interface MockReportSummary {
  gaps: { text: string; jdRef?: string }[];
  advice: string[];
}

export interface MockReport {
  rubricVersion: number;
  dimensions: MockDimensionResult[];
  total: number | null;
  band: MockBand | null;
  questions: MockQuestionResult[];
  reverse: MockReverseTurn | null;
  summary: MockReportSummary;
  deliveryAdvice: string;
  /** 全场体征汇总（按有声时长加权；没有录音作答时为 null） */
  delivery?: MockDeliveryMetrics | null;
  /** AI 评分是否可用；false 时只给转写与「评估不可用」，不造假分数 */
  aiAvailable: boolean;
  generatedAt: number;
}

export interface MockSession {
  id: string;
  version: 1;
  job: MockJobRef;
  config: MockInterviewConfig;
  status: MockSessionStatus;
  /** 当前所处阶段：1=阶段一，2=阶段二，3=反问/收尾 */
  phase: 1 | 2 | 3;
  questions: MockQuestion[];
  attempts: MockAttempt[];
  currentQuestionId: string | null;
  /** 当前题待作答的追问（有值时作答区切到追问模式） */
  pendingProbe: { question: string; askedAt: number } | null;
  reverse: MockReverseTurn | null;
  report: MockReport | null;
  /** 报告态「重答此题」的临时标记：有值时作答区回到该题，提交后只重算该题 */
  retry: { questionId: string; startedAt: number } | null;
  /** 降级标记：本地题兜底 / 阶段二不可用（报告里必须如实标注，不静默跳过） */
  flags?: {
    localFallback?: boolean;
    phase2Unavailable?: boolean;
    /** 题库召回摘要（配置页/报告用于说明「这场的题有没有用题库」） */
    bankRecall?: { candidates: number; poolSize: number; relaxed: boolean; tookMs: number; phase2Candidates?: number } | null;
    /** 本场实际采用了题库来源的题数 */
    bankHits?: number;
  };
  /** 写盘序号：主进程拒绝比已落盘更小的 seq，避免并发写互相覆盖 */
  seq: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** 历史会话索引（派生缓存，可扫 sessions/ 重建） */
export interface MockIndexEntry {
  id: string;
  jobId: string | null;
  jobTitle: string;
  company: string;
  role: MockInterviewRole;
  difficulty: MockDifficulty;
  startedAt: number;
  finishedAt: number;
  status: MockSessionStatus;
  score: number | null;
  band: string | null;
  rubricVersion: number;
  phase1Count: number;
  phase2Count: number;
  injectedCount: number;
  reverseAsked: boolean;
  updatedAt: number;
}

export interface MockSessionUsage {
  count: number;
  bytes: number;
}

/** 由 total 映射证据档；null 时返回 null（不给档位） */
export function bandForScore(total: number | null): MockBand | null {
  if (total == null || !Number.isFinite(total)) return null;
  return MOCK_BANDS.find((b) => total >= b.min) || MOCK_BANDS[MOCK_BANDS.length - 1];
}

/**
 * { level, pos } → 0–100。非法输入返回 null（调用方按 N/A 处理，绝不默认 0 分）。
 * level 1–4、pos 1–3 一律取整并 clamp 到合法区间，避免模型给出 2.7 / 0 这类值导致报表崩。
 */
export function levelToScore(level: unknown, pos: unknown): number | null {
  const lv = Math.round(Number(level));
  if (!Number.isFinite(lv) || lv < 1 || lv > 4) return null;
  const p = Math.round(Number(pos));
  const idx = Number.isFinite(p) ? Math.min(3, Math.max(1, p)) - 1 : 1;
  return LEVEL_SCORE[lv as 1 | 2 | 3 | 4][idx];
}

/** 会话是否还有未完成的工作（UI 判断是否显示「继续」） */
export function isSessionResumable(s: MockSession | null | undefined): boolean {
  if (!s) return false;
  return s.status === 'ready' || s.status === 'running' || s.status === 'planning' || s.status === 'reverse' || s.status === 'reporting';
}

/** 已答题目数（含跳过） */
export function answeredCount(s: MockSession): number {
  const ids = new Set(s.attempts.map((a) => a.questionId));
  return s.questions.filter((q) => ids.has(q.id)).length;
}
