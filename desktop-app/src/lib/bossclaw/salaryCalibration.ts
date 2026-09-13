// ===== AI 薪资数据校准（防幻觉：AI 与本地确定性解析差距过大时以本地为准）=====
// 背景：岗位薪资在本地来自 BOSS 明文薪资字符串的确定性解析（含工作制度折算，见 workSchedule.ts），
//      而 AI 可能误读日薪/月薪口径、或凭印象编造薪资数字，从而给出错误的匹配结论。
// 策略：
//   ① 文本层：AI 输出（reason / 匹配点 / 缺口 / 风险）里出现的薪资数字，若与「本地解析的岗位薪资」
//      和「画像期望薪资」都对不上 → 判定为编造，剔除该句并附【本地薪资校准】说明（不静默改分）。
//   ② （已移除）评分层校准：原按「本地薪资维度分」抬分/压分。薪资原始文本是确定性解析、可信，
//      但由它派生的维度分依赖期望薪资格式与工作制度折算，拿派生量去否决 AI 的综合判断属于越权。
//      需要「薪资不达标就不投递」时，请走硬性过滤 → 最低日薪（minSalaryPerDay）这条确定性硬约束。
// 注意：所有 AI 薪资提及统一折算到「千元/月」再比对（日薪按岗位工作制度的月工作日折算）。

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

// ===== 已移除：评分层校准 calibrateSalaryScore =====
// 原实现：AI 报推荐档但本地薪资维度 ≤45 分 → 压回谨慎档（≤55）；AI 给低分但本地薪资维度 ≥88 分 → 托底 60。
// 移除原因：抬分/压分依据的是**本地薪资维度分**（由期望薪资格式 + 工作制度折算派生），不是薪资原始数据本身。
// 用派生量否决 AI 的综合判断属于越权，且与「本地规则不参与改分、只做确定性闸门 + 可解释维度」的定位冲突；
// 薪资文本层面的防幻觉（上方 collectMismatchedSalaryMentions / stripMismatchedSalarySentences）保持不变。
// 若需要「薪资不达标即不投递」，走硬性过滤 → 最低日薪（config.minSalaryPerDay，见 jobMatch 硬约束第 10 条）。
