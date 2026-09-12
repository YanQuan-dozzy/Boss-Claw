// ===== AI 薪资数据校准（防幻觉：AI 与本地确定性解析差距过大时以本地为准）=====
// 背景：岗位薪资在本地来自 BOSS 明文薪资字符串的确定性解析（含工作制度折算，见 workSchedule.ts），
//      而 AI 可能误读日薪/月薪口径、或凭印象编造薪资数字，从而给出错误的匹配结论。
// 策略：
//   ① 文本层：AI 输出（reason / 匹配点 / 缺口 / 风险）里出现的薪资数字，若与「本地解析的岗位薪资」
//      和「画像期望薪资」都对不上 → 判定为编造，剔除该句并附【本地薪资校准】说明（不静默改分）。
//   ② 评分层：AI 综合分与本地薪资维度的档位方向相反且差距过大 → 以本地薪资维度为准修正分数与决策档位。
// 注意：所有 AI 薪资提及统一折算到「千元/月」再比对（日薪按岗位工作制度的月工作日折算）。
import type { Decision } from './types';

export interface SalaryLocalView {
  /** 本地薪资区间是否解析成功 */
  valid: boolean;
  /** 本地解析的岗位月薪区间（千元/月） */
  monthlyLow: number;
  monthlyHigh: number;
  /** 原始薪资是否为日薪 / 时薪口径 */
  daily: boolean;
  hourly: boolean;
  /** 折算用的月工作日（来自岗位工作制度） */
  monthlyWorkDays: number;
  /** 画像期望薪资（千元/月），未设置为 null */
  expectedLow: number | null;
  expectedHigh: number | null;
  /** 岗位原始薪资文本 */
  salaryText: string;
}

export interface SalaryMention {
  /** 命中的原文片段 */
  raw: string;
  /** 统一折算到千元/月后的值 */
  monthlyK: number;
}

/** 本地薪资维度 ≤ 此值视为「本地判定薪资明显不达标」 */
export const SALARY_CONFLICT_LOW = 45;
/** 本地薪资维度 ≥ 此值视为「本地判定薪资显著高于期望」 */
export const SALARY_CONFLICT_HIGH = 88;
/** AI 薪资数字与本地/期望基准的相对偏差阈值（超过即判为对不上） */
export const SALARY_TEXT_REL_DIFF = 0.5;

/** 明显不是岗位薪资的语境词（年终奖/补贴/公司规模等），命中则跳过该数字 */
const SALARY_NOISE_RE = /年终奖|奖金|补贴|津贴|报销|注册资本|规模|融资|用户|期权股/;

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(b));
}

/**
 * 从文本中提取薪资提及并统一折算为「千元/月」。
 * 支持形态：元/天、元/小时、元/月、15-25K、1.5-2万；带「年薪」语境时按 12 个月折算。
 * 裸数字（无单位）不提取，避免把「3 年经验」误判为薪资。
 */
export function extractSalaryMentions(text: string, monthlyWorkDays = 22): SalaryMention[] {
  const t = String(text || '');
  const days = Math.max(20, Math.min(31, Number(monthlyWorkDays) || 22));
  const out: SalaryMention[] = [];
  const mid = (m: RegExpExecArray): number => {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return (a + b) / 2;
  };
  const isAnnual = (index: number): boolean => /年\s*薪|年薪|元\s*\/\s*年/.test(t.slice(Math.max(0, index - 8), index + 4));
  const noisy = (index: number, len: number): boolean => SALARY_NOISE_RE.test(t.slice(Math.max(0, index - 10), index + len));
  const push = (raw: string, index: number, monthlyK: number): void => {
    if (noisy(index, raw.length)) return;
    if (Number.isFinite(monthlyK) && monthlyK > 0) out.push({ raw, monthlyK: Math.round(monthlyK * 10) / 10 });
  };

  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-~–—至]\s*(\d+(?:\.\d+)?))?\s*元?\s*\/\s*(?:天|日)/g)) {
    const v = mid(m as RegExpExecArray);
    push(m[0], m.index || 0, ((v * days) / 1000));
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-~–—至]\s*(\d+(?:\.\d+)?))?\s*元?\s*\/\s*(?:小时|时)/g)) {
    const v = mid(m as RegExpExecArray);
    push(m[0], m.index || 0, ((v * 8 * days) / 1000));
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-~–—至]\s*(\d+(?:\.\d+)?))?\s*元\s*\/\s*月/g)) {
    push(m[0], m.index || 0, mid(m as RegExpExecArray) / 1000);
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-~–—至]\s*(\d+(?:\.\d+)?))?\s*[Kk](?![a-zA-Z0-9])/g)) {
    const v = mid(m as RegExpExecArray);
    push(m[0], m.index || 0, isAnnual(m.index || 0) ? v / 12 : v);
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-~–—至]\s*(\d+(?:\.\d+)?))?\s*万/g)) {
    const v = mid(m as RegExpExecArray) * 10;
    push(m[0], m.index || 0, isAnnual(m.index || 0) ? v / 12 : v);
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.raw) ? false : (seen.add(x.raw), true)));
}

/** 该薪资提及是否与「本地岗位薪资」或「期望薪资」任一基准相符（任一侧接近即放行，避免误伤引述期望的表述） */
export function isSalaryMentionAcceptable(m: SalaryMention, view: SalaryLocalView): boolean {
  const centers: number[] = [];
  if (view.valid && view.monthlyHigh > 0) centers.push((view.monthlyLow + view.monthlyHigh) / 2);
  if (view.expectedLow != null && view.expectedHigh != null) centers.push((view.expectedLow + view.expectedHigh) / 2);
  if (!centers.length) return true; // 无基准可比 → 不作判定
  return centers.some((c) => relDiff(m.monthlyK, c) <= SALARY_TEXT_REL_DIFF);
}

/** 从一批 AI 文本里挑出「与本地/期望都对不上」的薪资提及 */
export function collectMismatchedSalaryMentions(texts: (string | null | undefined)[], view: SalaryLocalView): SalaryMention[] {
  const bad: SalaryMention[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of extractSalaryMentions(String(text || ''), view.monthlyWorkDays)) {
      if (isSalaryMentionAcceptable(m, view)) continue;
      if (seen.has(m.raw)) continue;
      seen.add(m.raw);
      bad.push(m);
    }
  }
  return bad;
}

/** 剔除含矛盾薪资数字的句子（按句切分；全部被剔除时返回空串，调用方应丢弃该条） */
export function stripMismatchedSalarySentences(text: string, bad: SalaryMention[]): string {
  const raw = String(text || '');
  if (!raw || !bad.length) return raw;
  const raws = bad.map((b) => b.raw);
  return raw
    .split(/(?<=[。；;！!])|\n/)
    .map((s) => s.trim())
    .filter((s) => s && !raws.some((r) => s.includes(r)))
    .join(' ')
    .trim();
}

export interface SalaryScoreCalibration {
  score: number;
  decision: Decision;
  changed: boolean;
  note?: string;
}

/**
 * 评分层校准：AI 综合分与本地薪资维度「方向相反且差距过大」时，以本地确定性数据为准。
 * - AI 报推荐档（≥ minScore）但本地薪资明显不达标 → 压回谨慎档（≤ 55 分）。
 * - AI 给低分（< 55）但本地薪资显著高于期望 → 托底到 60 分（不越级升为推荐，保留人工把关）。
 * 存在硬约束拦截或已判 reject 时不动分（硬拦截语义优先）。
 */
export function calibrateSalaryScore(input: {
  score: number;
  decision: Decision;
  localSalaryScore: number | null;
  minScore: number;
  hasHardBlocks: boolean;
  salaryText?: string;
  monthlyLow?: number;
  monthlyHigh?: number;
}): SalaryScoreCalibration {
  const { score, decision, localSalaryScore, minScore, hasHardBlocks } = input;
  if (hasHardBlocks || decision === 'reject' || localSalaryScore == null) return { score, decision, changed: false };
  const range = input.monthlyLow != null && input.monthlyHigh != null && (input.monthlyLow > 0 || input.monthlyHigh > 0)
    ? `岗位「${input.salaryText || ''}」≈ ${Number(input.monthlyLow).toFixed(1)}-${Number(input.monthlyHigh).toFixed(1)}K/月`
    : `岗位薪资「${input.salaryText || ''}」`;
  if (score >= minScore && localSalaryScore <= SALARY_CONFLICT_LOW) {
    const capped = Math.min(score, SALARY_CONFLICT_LOW + 10);
    return {
      score: capped,
      decision: 'cautious',
      changed: true,
      note: `【本地薪资校准】${range}，本地薪资匹配仅 ${localSalaryScore} 分（明显低于期望），AI 的 ${score} 分存疑，已按本地确定性数据修正为 ${capped} 分（谨慎）。`,
    };
  }
  if (score < 55 && localSalaryScore >= SALARY_CONFLICT_HIGH) {
    return {
      score: 60,
      decision,
      changed: true,
      note: `【本地薪资校准】${range}，本地薪资匹配 ${localSalaryScore} 分（显著高于期望），AI 的 ${score} 分偏低，已按本地确定性数据托底为 60 分。`,
    };
  }
  return { score, decision, changed: false };
}
