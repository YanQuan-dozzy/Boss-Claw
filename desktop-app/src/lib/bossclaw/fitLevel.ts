// 岗位适配档位（AI 整体评估的唯一结构化产物；分数由档位映射得到）
//
// 为什么要有它：旧提示词用「基准 70 分 + 逐条加减分」（方向 ±15 / 技能命中数分档 / **每个缺口 -5** /
// 薪资 ±5），把「这个人整体上合不合适这个岗位」拆成了一堆互不相干的加减法。但单条差异通常不决定
// 成败——决定成败的是组合起来之后的整体判断。于是出现两种典型失真：
//   ① 五条无关痛痒的小差异被累加成 -25，把一个实质匹配的岗位压到谨慎档；
//   ② 一条致命错位（岗位要天天对外推进，简历全是单人技术实现）只值 -10，被其他加分抵消掉。
// 现在改为：AI 先按「硬门槛 → 优先条件 → 职责信号 → 团队信号」四层做**一次整体裁决**给出档位，
// 分数只是档位的具体化，**不得跨档**；同岗位重复分析必须落同一档——以此替代旧的「波动 ≤ ±5」约束。
//
// 纯函数、零依赖、无副作用：可离线回归测试（见 scripts/score-regression.mjs）。
import type { Decision } from './types';

export type FitLevel = 'strong' | 'match' | 'cautious' | 'unfit';

export interface FitLevelMeta {
  /** 界面展示用中文档位名 */
  label: string;
  /** 该档分数区间闭区间下界 */
  min: number;
  /** 该档分数区间闭区间上界 */
  max: number;
  /** 该档对应的决策档（与 score 区间一起保证档位-分数-决策三者不矛盾） */
  decision: Decision;
}

/**
 * 四档的分数区间：闭区间、互不重叠、并集覆盖 0-100。
 * 用户口径：不推荐 <50 / 谨慎 50-64 / 匹配 65-80 / 推荐 >80。
 * 边界与既有配置对齐：`minScore` 默认 75 落在匹配档（65-80）内；
 * `minQueueScore` 默认 60 落在谨慎档（50-64）内（谨慎档仍可入队交人工把关）。
 */
export const FIT_LEVEL_META: Record<FitLevel, FitLevelMeta> = {
  strong: { label: '推荐', min: 81, max: 100, decision: 'recommend' },
  match: { label: '匹配', min: 65, max: 80, decision: 'recommend' },
  cautious: { label: '谨慎', min: 50, max: 64, decision: 'cautious' },
  unfit: { label: '不推荐', min: 0, max: 49, decision: 'reject' },
};

/** 档位取值（从强到弱），供识别、UI 与测试复用 */
const FIT_LEVELS: FitLevel[] = ['strong', 'match', 'cautious', 'unfit'];

/** 档位展示顺序（从强到弱），供 UI 与测试使用 */
export const FIT_LEVEL_ORDER: FitLevel[] = FIT_LEVELS;

export function fitLevelLabel(level: FitLevel | undefined | null): string {
  return level ? FIT_LEVEL_META[level]?.label || '' : '';
}

/** 由分数反推档位（AI 未返回 fitLevel、或返回值不可识别时的兼容兜底） */
export function fitLevelFromScore(score: unknown): FitLevel {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'cautious'; // 信息不足：落到可人工把关的中间档，不盲目判死
  if (s >= FIT_LEVEL_META.strong.min) return 'strong';
  if (s >= FIT_LEVEL_META.match.min) return 'match';
  if (s >= FIT_LEVEL_META.cautious.min) return 'cautious';
  return 'unfit';
}

/**
 * 归一 AI 返回的档位：认标准四值，兼容少量中文/近义写法；无法识别或缺失时按 score 反推。
 * 注意识别顺序——「不推荐」必须先于「推荐」判断，否则「不推荐」会被「推荐」吞掉；
 * 「推荐」/「高度匹配」必须先于「匹配」判断，否则会被后者吞掉。
 */
export function normalizeFitLevel(raw: unknown, score?: unknown): FitLevel {
  const v = String(raw ?? '').trim().toLowerCase();
  if (FIT_LEVELS.includes(v as FitLevel)) return v as FitLevel;
  if (!v) return fitLevelFromScore(score);
  if (/unfit|不推荐|不适格|不合格|不匹配|reject/.test(v)) return 'unfit';
  if (/cautious|谨慎|存疑|待定/.test(v)) return 'cautious';
  if (/strong|推荐|高度|非常匹配|强匹配/.test(v)) return 'strong';
  if (/match|匹配|合适/.test(v)) return 'match';
  return fitLevelFromScore(score);
}

/**
 * 以档位为准反推分数：把 AI 自报的分数**夹到该档区间内**。
 * 这样既保留 AI 在档内的细腻度（例如同属 match，82 与 86 可以不同），
 * 又杜绝「档位说谨慎、分数给 95」这类自相矛盾（跨档分数会被直接夹回来）。
 * AI 未给分数时取档位区间中点。
 */
export function scoreForFitLevel(level: FitLevel, aiScore?: unknown): number {
  const meta = FIT_LEVEL_META[level];
  const s = Number(aiScore);
  if (!Number.isFinite(s)) return Math.round((meta.min + meta.max) / 2);
  return Math.min(meta.max, Math.max(meta.min, Math.round(s)));
}

/** 档位对应的决策档（保证 decision 不与档位矛盾） */
export function decisionForFitLevel(level: FitLevel): Decision {
  return FIT_LEVEL_META[level].decision;
}
