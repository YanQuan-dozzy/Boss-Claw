// 大模型**上下文窗口预算** —— 唯一权威。
//
// 背景（本模块要解决的问题）：
//   此前各 AI 调用点的「上下文投喂量」是**散落各处的裸字面量**：简历 6000 字（matching.ts）、
//   画像输入 22000 字（profile.ts）、方向细化 15000 字（jobMatch.ts）、简历整理 12000 字
//   （resumeAI.ts）……这些数字是「按当年某个模型的窗口 + 中文 token 比例手工估的保守值」，
//   有两个直接后果：
//     ① **窗口大的模型被白白浪费**：配置了 1M / 252K 窗口的模型，依然只吃到 6000 字简历，
//        长简历的后半段（项目细节、最近一段实习）从未进入模型视野，直接拖低评分与打招呼语质量；
//     ② **窗口小的模型有超窗风险**：固定 22000 字在 16K 窗口模型上必然 400，且报错后无从收敛。
//
//   因此把「本次请求能投喂多少上下文」收敛成一个**由用户声明的窗口大小驱动**的确定性计算：
//     可用输入预算 = 窗口上限 × 用量档位(100% / 40%) − 输出预留 − 安全边际
//   调用方只声明「这段文本占可用预算的多少份额」，不再自己写数字。
//
// 与其他权威模块的边界（禁止越界）：
//   · `llm.ts::effectiveMaxTokens` —— 单次**输出** token 上限，与本模块的**输入**预算正交；
//   · `thinkingCapability.ts` —— 是否/如何发思考参数，与本模块无关；
//   · 本模块只回答「文本能塞多少」，**不改变**任何提示词语义（评分口径、校名披露、招呼语长度
//     截断 clampGreetingText 等一律不受影响）。
//
// fail-safe 口径（与 thinkingCapability.ts 同风格）：
//   · `model.contextWindow` 缺失 / 非法（老用户持久化数据无该字段、浅合并不会补）→ 回落到
//     DEFAULT_CONTEXT_WINDOW，**绝不**算出 Infinity 或无视窗口直接全量投喂；
//   · `model.contextUsage` 非法 → 按 'full'（用户可见的默认档）；
//   · 估算器一律**高估** token 数（宁可少喂一点，不可超出窗口），误差方向单一、可控。

import type { AppConfig } from './types';

/** 上下文用量档位：full = 吃满窗口；compact = 只用窗口的 40%（省 token / 提速）。 */
export type ContextUsage = 'full' | 'compact';

/** 档位 → 窗口占用比例。UI 与预算计算共用同一张表（禁止在别处再写 0.4 / 1）。 */
export const CONTEXT_USAGE_RATIO: Record<ContextUsage, number> = {
  full: 1,
  compact: 0.4,
};

/** 档位中文标签（UI 用）。 */
export const CONTEXT_USAGE_LABELS: Record<ContextUsage, string> = {
  full: '全满',
  compact: '40%',
};

/**
 * 未声明窗口时的兜底值。
 * 取 128K 的理由：当前主流闭源模型（DeepSeek-V4 / GLM-5 / Qwen3.8 / GPT-5.6）窗口均 ≥128K，
 * 而 128K 本身也是「不会因配置缺失而超窗」的安全水位；用户可在设置页显式改成自己模型的实际值。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 设置页可选窗口预设（value 为 token 数；用户也可选「自定义」手填）。最低档与 CONTEXT_WINDOW_MIN 对齐。 */
export const CONTEXT_WINDOW_PRESETS: { value: number; label: string }[] = [
  { value: 1_000_000, label: '1,000K（1M）' },
  { value: 512_000, label: '512K' },
  { value: 256_000, label: '256K' },
  { value: 252_000, label: '252K' },
  { value: 200_000, label: '200K' },
  { value: 128_000, label: '128K' },
  { value: 64_000, label: '64K' },
  { value: 32_000, label: '32K' },
];

/**
 * 窗口**下限** 32K。
 * 为什么不是更小：本应用的单个提示词本身就很大（岗位分析 system + 评分细则 + 画像 + 简历 + JD，
 * 仅 system 契约骨架与技能正文合计就数万字符），4K / 8K / 16K 的窗口连「把指令放进去」都做不到，
 * 会让每一次调用都落到「分片越切越碎 + 截断」的最差路径；且当前主流模型窗口均在 128K 以上，
 * 低于 32K 的档位只是徒增误配风险（把窗口填小 → 上下文被过度截断 → 评分与招呼语质量下降，
 * 而界面上完全看不出异常）。
 * 保留 32K 而非直接顶到 128K：本地部署的小窗口模型（如 32K 上下文的 Qwen / GLM 量化版）仍需可用。
 */
export const CONTEXT_WINDOW_MIN = 32_000;
export const CONTEXT_WINDOW_MAX = 2_000_000;

/**
 * 输出预留的默认值：一次响应最多可能写回的 token（reason + greeting + 五维 evidence 等）。
 * 调用点能用 `outputTokens` 覆盖；不覆盖时按此值保守预留。
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;

/**
 * 安全边际：吸收「估算误差 + 消息协议开销（role / 分隔符）+ 服务端模板注入」。
 * 本模块的估算器本身已偏高，这里再留一层，确保预算不会顶到窗口天花板。
 */
export const SAFETY_MARGIN_TOKENS = 2_000;

/** 预算下限：窗口极小（如 4K）时仍保证有一个可用的投喂量，避免算出 0 或负数。 */
const MIN_INPUT_BUDGET_TOKENS = 1_500;

/** 截断标记：让模型与用户都能看出「这里是断的」，而不是把半句话当完整事实。 */
const TRUNCATION_MARK = '\n…（上下文超出当前窗口预算，后续内容已省略）';

/** 极端预算下（小到连完整标记都放不下）的退化标记。 */
const SHORT_TRUNCATION_MARK = '…';

/** 判断是否 CJK 等「一字 ≈ 一 token」的宽字符。 */
const WIDE_CHAR_RE =
  /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE4F\uFF00-\uFFEF]/g;

/**
 * 估算文本的 token 数（**保守偏高**，宁可高估不可低估）。
 *   宽字符（中日韩、全角标点）：1 字 ≈ 1 token（DeepSeek 实测约 0.6，这里按 1 记 → 高估 ~66%）；
 *   其余（ASCII 字母数字、半角标点、空白）：4 字符 ≈ 1 token（按 0.34/字符记 → 高估 ~36%）。
 * 只用于「能不能塞进预算」的判断，**不用于计费与统计展示**。
 */
export function estimateTokens(text: string): number {
  const s = String(text || '');
  if (!s) return 0;
  // 用正则计数而非逐字符循环：长简历（数万字）在批量分析时每岗位都会调用，必须够快。
  // 注：带 /g 的 match 不依赖 lastIndex，无需重置状态。
  const matched = s.match(WIDE_CHAR_RE);
  const wide = matched ? matched.length : 0;
  const narrow = Math.max(0, s.length - wide);
  return wide + Math.ceil(narrow * 0.34);
}

/** 解析并规范化窗口大小（非法值一律回落默认，杜绝 NaN / 越界）。 */
export function resolveContextWindow(model: Partial<AppConfig['model']> | undefined): number {
  const raw = Number(model?.contextWindow);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(Math.max(Math.floor(raw), CONTEXT_WINDOW_MIN), CONTEXT_WINDOW_MAX);
}

/** 解析并规范化用量档位（非法值一律按 full，与用户可见默认档一致）。 */
export function resolveContextUsage(
  model: Partial<AppConfig['model']> | undefined,
): ContextUsage {
  return model?.contextUsage === 'compact' ? 'compact' : 'full';
}

export interface ContextBudget {
  /** 规范化后的窗口上限（tokens） */
  windowTokens: number;
  /** 用户在设置页声明的窗口是否合法（false = 走了默认兜底，UI 可提示） */
  windowConfigured: boolean;
  usage: ContextUsage;
  ratio: number;
  /** 本次响应预留的输出 token */
  outputReserveTokens: number;
  safetyMarginTokens: number;
  /** 可用于「输入侧上下文」的 token 上限（已扣除输出预留与安全边际，恒 ≥ MIN_INPUT_BUDGET_TOKENS） */
  inputBudgetTokens: number;
  /** 设置页展示用的一行口径说明 */
  note: string;
}

/**
 * 计算本次请求的上下文预算。**纯函数**（同输入恒同输出）——
 * 因此 `contextBudgetSignature` 可以安全地参与 AI 缓存 key。
 */
export function resolveContextBudget(
  model: Partial<AppConfig['model']> | undefined,
  opts: { outputTokens?: number } = {},
): ContextBudget {
  const windowTokens = resolveContextWindow(model);
  const windowConfigured = Number.isFinite(Number(model?.contextWindow)) && Number(model?.contextWindow) > 0;
  const usage = resolveContextUsage(model);
  const ratio = CONTEXT_USAGE_RATIO[usage];
  const rawOutput = Number(opts.outputTokens);
  const outputReserveTokens =
    Number.isFinite(rawOutput) && rawOutput > 0
      ? Math.floor(rawOutput)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  const usableWindow = Math.floor(windowTokens * ratio);
  const inputBudgetTokens = Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    usableWindow - outputReserveTokens - SAFETY_MARGIN_TOKENS,
  );
  const note =
    `${formatTokenCount(windowTokens)} 窗口 × ${CONTEXT_USAGE_LABELS[usage]}` +
    `（${Math.round(ratio * 100)}%）− 输出预留 ${formatTokenCount(outputReserveTokens)}` +
    ` − 安全边际 ${formatTokenCount(SAFETY_MARGIN_TOKENS)}` +
    ` → 可投喂上下文约 ${formatTokenCount(inputBudgetTokens)} tokens（≈${formatTokenCount(inputBudgetTokens)} 汉字）`;
  return {
    windowTokens,
    windowConfigured,
    usage,
    ratio,
    outputReserveTokens,
    safetyMarginTokens: SAFETY_MARGIN_TOKENS,
    inputBudgetTokens,
    note,
  };
}

/** token 数的可读展示（12345 → 12.3K）。 */
export function formatTokenCount(tokens: number): string {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/**
 * 缓存 key 签名：把「窗口 + 档位」纳入 AI 结果缓存的 key。
 * 必要性——短文本（如几百字的简历片段）在任何档位下都不会被截断，messages 完全相同；
 * 若不把档位写进 key，用户从 40% 切到全满后会**命中旧缓存**、看起来像「开关没生效」。
 */
export function contextBudgetSignature(model: Partial<AppConfig['model']> | undefined): string {
  return `ctx:${resolveContextWindow(model)}:${resolveContextUsage(model)}`;
}

/** 把文本裁到「不允许超过 tokenLimit」的字符下标（先按比例粗切，再渐进收敛 + 行/句边界对齐）。 */
function cutIndexByTokens(text: string, tokenLimit: number): number {
  if (tokenLimit <= 0) return 0;
  const total = estimateTokens(text);
  if (total <= tokenLimit) return text.length;
  let cut = Math.floor(text.length * (tokenLimit / total));
  // 估算对「宽窄字符混杂」不是严格线性的 → 逐步回收直到满足（最多 8 轮，收敛很快）
  for (let i = 0; i < 8; i++) {
    if (cut <= 0) return 0;
    if (estimateTokens(text.slice(0, cut)) <= tokenLimit) break;
    cut = Math.floor(cut * 0.92);
  }
  return Math.max(0, Math.min(cut, text.length));
}

/**
 * 按 token 上限裁剪文本并附加截断标记。
 * **关键：省略标记自身也占 token，必须从预算里先扣掉**——
 * 否则「裁到上限 + 再拼标记」的结果会超出上限（16K/40% 这类小预算下会稳定越界 20+ token），
 * 而超窗正是本模块要杜绝的事。回归脚本 scripts/context-budget-regression.mjs 对此有断言。
 */
function truncateToTokenLimit(text: string, tokenLimit: number): string {
  const markTokens = estimateTokens(TRUNCATION_MARK);
  const bodyLimit = tokenLimit - markTokens;
  if (bodyLimit <= 0) {
    // 预算小到装不下完整标记：退化为最短标记（再小则返回空，宁可不喂也不超窗）
    return tokenLimit >= estimateTokens(SHORT_TRUNCATION_MARK) ? SHORT_TRUNCATION_MARK : '';
  }
  const cut = alignToBoundary(text, cutIndexByTokens(text, bodyLimit));
  if (cut <= 0) return '';
  return `${text.slice(0, cut)}${TRUNCATION_MARK}`;
}

/** 把截断点回退到最近的换行/句末，避免把一句话、一个 JSON 字段切在中间。 */
function alignToBoundary(text: string, cut: number): number {
  if (cut >= text.length) return cut;
  const floor = Math.max(0, cut - Math.floor(cut * 0.15)); // 最多回退 15%，防止整段被吃掉
  for (let i = cut; i > floor; i--) {
    const c = text[i - 1];
    if (c === '\n' || c === '。' || c === '；' || c === '！' || c === '？') return i;
  }
  return cut;
}

/**
 * 按预算裁剪一段上下文文本。
 * @param share 该段占「可用输入预算」的份额（0~1），默认 1（独占全部预算）。
 *
 * 语义边界：这是**给模型的上下文投喂量**，不是业务字段的长度约束。
 * 业务侧的长度红线（招呼语 200 字、gaps ≤3 条等）一律由各自权威模块负责，不得走本函数。
 */
export function fitContext(
  text: string,
  model: Partial<AppConfig['model']> | undefined,
  opts: { outputTokens?: number; share?: number } = {},
): string {
  const s = String(text || '');
  if (!s) return s;
  const { inputBudgetTokens } = resolveContextBudget(model, { outputTokens: opts.outputTokens });
  const share = Number.isFinite(Number(opts.share)) ? Math.min(Math.max(Number(opts.share), 0), 1) : 1;
  const tokenLimit = Math.max(1, Math.floor(inputBudgetTokens * share));
  if (estimateTokens(s) <= tokenLimit) return s;
  return truncateToTokenLimit(s, tokenLimit);
}

/**
 * 按 token 上限把长文本切成多片，**不丢弃任何内容**（与 `fitContext` 的截断语义相对）。
 *
 * 用途：上下文超出窗口预算时的「分片提炼后续调」（见 `oversizedContext.ts`）——
 * 与其把长简历的后半段直接砍掉，不如切片后逐片提炼要点再合并，让模型仍能看到全部经历。
 *
 * 切点优先落在换行 / 句末；不足一片时返回单元素数组。
 *
 * **不丢内容是本函数的硬语义**：即使触及 `maxChunks` 保护上限，也会把剩余内容并入最后一片
 * （此时最后一片会超过 tokenLimit，属极端输入下的既定退化——由调用方按自己的成本护栏取舍），
 * 绝不静默截掉尾部。否则「分片」就退化成了另一种截断，违背本能力存在的理由。
 *
 * @param maxChunks 硬保护上限，防止异常输入产生海量分片（正常调用由上层再按成本护栏取前 N 片）
 */
export function splitContext(text: string, tokenLimit: number, maxChunks = 64): string[] {
  const s = String(text || '');
  if (!s) return [];
  const limit = Number(tokenLimit);
  // 非法上限：不做无意义切分，原样单片返回（由调用方决定后续如何裁剪）
  if (!Number.isFinite(limit) || limit <= 0) return [s];
  if (estimateTokens(s) <= limit) return [s];
  const chunks: string[] = [];
  let rest = s;
  while (rest) {
    if (estimateTokens(rest) <= limit) {
      chunks.push(rest);
      break;
    }
    // 已达片数上限：剩余内容整体并入最后一片（宁可超限，也不丢弃）
    if (chunks.length >= maxChunks - 1) {
      chunks.push(rest);
      break;
    }
    const cut = alignToBoundary(rest, cutIndexByTokens(rest, limit));
    if (cut <= 0) {
      // 无法再切（理论上不会发生）：同样整段保留
      chunks.push(rest);
      break;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  return chunks;
}

/**
 * 多段上下文共享一次请求的预算：按权重把可用输入预算拆给各段。
 * 用于「同一个 prompt 里既有简历又有岗位描述」的场景（如岗位分析），
 * 避免各段各自按「全额预算」截断、加起来反而超窗。
 *
 * @param weights 各段权重（会自动归一化）；未在表中出现的段按 0 处理
 * @returns 各段可用的 token 上限
 */
export function allocateContextBudget(
  model: Partial<AppConfig['model']> | undefined,
  weights: Record<string, number>,
  opts: { outputTokens?: number } = {},
): Record<string, number> {
  const { inputBudgetTokens } = resolveContextBudget(model, { outputTokens: opts.outputTokens });
  const keys = Object.keys(weights);
  const totalWeight = keys.reduce((sum, k) => {
    const w = Number(weights[k]);
    return sum + (Number.isFinite(w) && w > 0 ? w : 0);
  }, 0);
  const out: Record<string, number> = {};
  for (const k of keys) {
    const w = Number(weights[k]);
    out[k] = totalWeight > 0 && Number.isFinite(w) && w > 0
      ? Math.max(1, Math.floor((inputBudgetTokens * w) / totalWeight))
      : 0;
  }
  return out;
}

/** 按显式 token 上限裁剪（供多段预算分配后的二次裁剪使用；口径与 fitContext 完全一致）。 */
export function fitContextToTokens(text: string, tokenLimit: number): string {
  const s = String(text || '');
  if (!s) return s;
  const limit = Number(tokenLimit);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (estimateTokens(s) <= limit) return s;
  return truncateToTokenLimit(s, limit);
}
