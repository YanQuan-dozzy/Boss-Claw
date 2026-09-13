// 数据统计聚合层 —— 统计页 / CSV 导出 / PDF 报表 / 控制桥共用的**唯一数据源**。
//
// 为什么单独成层：
//   1) 原实现把聚合写在页面组件里，同一份 pending 在渲染期被反复全量遍历（状态分布 8 次、
//      趋势 7 次、汇总 1 次、卡片 pct 若干次）。岗位上千条时每帧都在扫描全表。
//      这里改为**单遍扫描**建 Map，页面/导出/报表都消费同一快照，口径天然一致。
//   2) 原实现「已投递」趋势用 createdAt（加入日期）冒充投递日期 —— 上周加入、今天投递的
//      岗位会被算进上周的柱子。这里改用 `PendingItem.sentAt`（真实投递成功时间）。
//   3) 原实现「今日目标达成」用累计已投递当分子，与「每日上限」语义倒错。这里改用
//      今日 sentAt 计数，与 `effectiveDailyCap`（每日上限）对齐。
//   4) 原实现的状态分布漏了 `opened`（已打开沟通窗未发送），导致各状态占比合计不足 100%。
//      这里 STATUS_META 覆盖全部 PendingStatus 成员。
//
// 口径约定（页面/CSV/PDF/agent 四处同源，禁止各自再算一遍）：
//   - 岗位维度指标（总数 / 状态 / 决策 / 分数 / 公司 / 城市 / 交叉视图）按**加入时间 createdAt**
//     是否落在所选时间范围内筛选。
//   - 趋势图「新增」按 createdAt 归桶；「已投递」按 sentAt 归桶（两者样本不受对方范围影响，
//     因此趋势柱合计与已投递卡片可能不等 —— 这是时间序列与存量指标的固有差异，UI 已注明）。
//   - 「今日目标」独立于时间范围，按 sentAt 统计今日已投递数。
//   - 平均匹配分只统计有 `analysis.score` 的记录，未分析的不计入分母（图上标注样本数）。

import type {
  AppConfig,
  Decision,
  DirectionPlan,
  JobPlatform,
  PendingItem,
  PendingStatus,
  TaskRun,
} from './types';
import { cleanCompanyName } from './jobDisplay';
import { platformLabel } from './platforms';
import { effectiveDailyCap } from './safety';
import { selectedDirectionItems } from './directions';

/* ============================ 时间范围 ============================ */

export type StatsRangeKey = '7d' | '30d' | 'all';

export interface StatsRangeMeta {
  key: StatsRangeKey;
  /** Segmented 上显示的短标签 */
  label: string;
  /** 文件名/报表抬头用的短口径（不含空格） */
  slug: string;
  /** null = 不限（以最早记录为起点） */
  days: number | null;
}

export const STATS_RANGES: readonly StatsRangeMeta[] = [
  { key: '7d', label: '近 7 天', slug: '近7天', days: 7 },
  { key: '30d', label: '近 30 天', slug: '近30天', days: 30 },
  { key: 'all', label: '全部', slug: '全部', days: null },
] as const;

export const DEFAULT_STATS_RANGE: StatsRangeKey = '7d';

export function statsRangeMeta(key: StatsRangeKey): StatsRangeMeta {
  return STATS_RANGES.find((r) => r.key === key) || STATS_RANGES[0];
}

/* ============================ 状态 / 决策元数据 ============================ */

/** 岗位状态口径（覆盖全部 PendingStatus 成员；顺序即页面展示顺序） */
export const STATS_STATUS_META: { key: PendingStatus; label: string; color: string; hint: string }[] = [
  { key: 'pending', label: '待确认', color: '#8C93A3', hint: 'AI 已分析、等待你确认是否投递' },
  { key: 'approved', label: '待投递', color: '#3B82F6', hint: '已确认、进入投递队列' },
  { key: 'approved_queue', label: '投递中', color: '#06B6D4', hint: '正在执行投递' },
  { key: 'opened', label: '已打开', color: '#A78BFA', hint: '已打开沟通窗口、尚未发送文字气泡' },
  { key: 'sent', label: '已投递', color: '#10B981', hint: '投递成功' },
  { key: 'failed', label: '失败', color: '#EF4444', hint: '投递失败，可重试或忽略' },
  { key: 'skipped', label: '已跳过', color: '#CBD5E1', hint: '未投递（外部网申 / 命中过滤条件等）' },
  { key: 'rejected', label: '不推荐', color: '#F59E0B', hint: 'AI 判定不推荐' },
  { key: 'ignored', label: '已忽略', color: '#E2E8F0', hint: '人工忽略' },
];

/** 归入「待处理」的状态：尚未产生投递结果、仍需要推进的岗位 */
export const WAITING_STATUSES: PendingStatus[] = ['pending', 'approved', 'approved_queue', 'opened'];

export const STATS_DECISION_META: Record<Decision, { label: string; color: string }> = {
  recommend: { label: '推荐投递', color: '#10B981' },
  cautious: { label: '谨慎投递', color: '#F59E0B' },
  reject: { label: '不推荐', color: '#EF4444' },
};

/**
 * 任务状态中文口径（TaskRun.status）。
 * 页面与导出统一走这里 —— 原实现直接把英文枚举渲染成 mini-label（裸英文外露）。
 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
  ignored: '已忽略',
  waiting_review: '待复核',
  queued: '排队中',
  pending: '待处理',
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABEL[status] || status;
}

/* ============================ 快照结构 ============================ */

export type TrendGranularity = 'day' | 'week' | 'month';

export interface TrendBucket {
  key: string;
  /** 轴标签（M/D 或 M月） */
  label: string;
  /** tooltip / 导出用完整口径 */
  fullLabel: string;
  added: number;
  sent: number;
  /** 该桶内有 AI 分数的记录均分；无样本为 null */
  avgScore: number | null;
  analyzed: number;
}

export interface CrossRow {
  key: string;
  label: string;
  total: number;
  sent: number;
  failed: number;
  waiting: number;
  /** sent / (sent + failed)；分母为 0 时为 null */
  successRate: number | null;
  avgScore: number | null;
}

export interface StatsSnapshot {
  range: StatsRangeMeta;
  generatedAt: number;
  /** 时间范围起止（all 时起点取最早记录） */
  windowStart: number;
  windowEnd: number;
  /** 范围内是否有数据（用于决定页面上是否显示空态） */
  hasData: boolean;

  /** 范围内岗位数（按加入时间） */
  total: number;
  counts: Record<PendingStatus, number>;
  sent: number;
  failed: number;
  skippedIgnored: number;
  waiting: number;
  rejected: number;
  opened: number;

  decisions: Record<Decision, number>;
  decisionTotal: number;
  analyzed: number;
  /** 有有效 AI 分数的岗位数（平均分的分母） */
  scored: number;
  analysisCoverage: number;
  avgScore: number | null;
  scoreBands: { high: number; mid: number; low: number; none: number; total: number };

  /** 今日投递成功数（按 sentAt，独立于时间范围） */
  todaySent: number;
  dailyTarget: number;
  goalPct: number;

  /** sent / (sent + failed)，全范围为样本 */
  successRate: number | null;

  companyTop: [string, number][];
  cityTop: [string, number][];
  directionTop: [string, number][];
  platformCross: CrossRow[];
  directionCross: CrossRow[];
  /** 任务状态分布（已转中文口径，按数量降序） */
  runStatus: { key: string; label: string; value: number }[];
  taskTotal: number;
  /** 范围内出现的平台数（非「已启用平台数」） */
  platformCount: number;
  directionCount: number;

  trend: TrendBucket[];
  trendGranularity: TrendGranularity;

  /** 口径说明（PDF 页脚与页面提示共用） */
  notes: string[];
}

/* ============================ 内部工具 ============================ */

const DAY_MS = 86_400_000;

/** 非法/缺失时间戳安全归零（避免 new Date(undefined) → NaN 悄悄丢数据） */
function safeTs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 周一为一周起点 */
function mondayOf(ts: number): number {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function fmtMD(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按粒度决定趋势桶；「全部」按跨度自适应（短期内按天、中期按周、长期按月） */
function pickGranularity(range: StatsRangeKey, spanDays: number): TrendGranularity {
  if (range === '7d' || range === '30d') return 'day';
  if (spanDays <= 14) return 'day';
  if (spanDays <= 120) return 'week';
  return 'month';
}

interface Bucket { key: string; label: string; fullLabel: string; start: number }

function buildBuckets(gran: TrendGranularity, windowStart: number, windowEnd: number): Bucket[] {
  const out: Bucket[] = [];
  if (gran === 'day') {
    let cur = startOfDay(windowStart);
    const last = startOfDay(windowEnd);
    while (cur <= last) {
      out.push({ key: `d${cur}`, label: fmtMD(cur), fullLabel: fmtDate(cur), start: cur });
      cur += DAY_MS;
    }
    return out;
  }
  if (gran === 'week') {
    let cur = mondayOf(windowStart);
    const last = startOfDay(windowEnd);
    while (cur <= last) {
      const end = cur + 6 * DAY_MS;
      out.push({
        key: `w${cur}`,
        label: fmtMD(cur),
        fullLabel: `${fmtDate(cur)} ~ ${fmtDate(Math.min(end, last))}`,
        start: cur,
      });
      cur += 7 * DAY_MS;
    }
    return out;
  }
  let cur = startOfMonth(windowStart);
  const last = startOfDay(windowEnd);
  while (cur <= last) {
    const d = new Date(cur);
    out.push({
      key: `m${cur}`,
      label: `${d.getMonth() + 1}月`,
      fullLabel: `${d.getFullYear()}年${d.getMonth() + 1}月`,
      start: cur,
    });
    cur = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }
  return out;
}

/** 时间戳 → 桶下标（桶连续，按粒度做算术定位，无需查找 Map） */
function bucketIndexOf(ts: number, gran: TrendGranularity, buckets: Bucket[]): number {
  if (buckets.length === 0) return -1;
  const base = buckets[0].start;
  let idx: number;
  if (gran === 'day') idx = Math.round((startOfDay(ts) - base) / DAY_MS);
  else if (gran === 'week') idx = Math.round((mondayOf(ts) - base) / (7 * DAY_MS));
  else {
    const a = new Date(base);
    const b = new Date(ts);
    idx = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }
  return idx >= 0 && idx < buckets.length ? idx : -1;
}

/** 计数 Map → 降序 Top N（同数量按名称稳定排序，避免每次渲染顺序抖动） */
function topN(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, n);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

interface CrossAcc {
  label: string;
  total: number;
  sent: number;
  failed: number;
  waiting: number;
  scoreSum: number;
  analyzed: number;
}

function toCrossRows(acc: Map<string, CrossAcc>): CrossRow[] {
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      total: v.total,
      sent: v.sent,
      failed: v.failed,
      waiting: v.waiting,
      successRate: rate(v.sent, v.sent + v.failed),
      avgScore: v.analyzed > 0 ? v.scoreSum / v.analyzed : null,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/* ============================ 主入口 ============================ */

export interface BuildStatsInput {
  pending: PendingItem[];
  taskRuns: TaskRun[];
  directionPlan: DirectionPlan | null;
  config: AppConfig | null | undefined;
  range: StatsRangeKey;
  /** 可注入的「现在」（便于测试与报表对齐） */
  now?: number;
}

export function buildStatsSnapshot(input: BuildStatsInput): StatsSnapshot {
  const now = input.now ?? Date.now();
  const range = statsRangeMeta(input.range);
  const pending = Array.isArray(input.pending) ? input.pending : [];
  const taskRuns = Array.isArray(input.taskRuns) ? input.taskRuns : [];
  const todayStart = startOfDay(now);

  /* ---- 时间窗口：all 以最早记录为起点，无记录则退回近 7 天 ---- */
  const createdTimes = pending.map((p) => safeTs(p.createdAt)).filter((v): v is number => v !== null);
  const earliest = createdTimes.length ? Math.min(...createdTimes) : null;
  const windowEnd = now;
  let windowStart: number;
  if (range.days === null) {
    windowStart = earliest !== null ? startOfDay(earliest) : startOfDay(now - 6 * DAY_MS);
  } else {
    windowStart = startOfDay(now - (range.days - 1) * DAY_MS);
  }

  const spanDays = Math.max(1, Math.round((startOfDay(windowEnd) - windowStart) / DAY_MS) + 1);
  const trendGranularity = pickGranularity(range.key, spanDays);
  const buckets = buildBuckets(trendGranularity, windowStart, windowEnd);

  /* ---- 单遍扫描：范围内存量指标 + 趋势桶 ---- */
  const counts = Object.fromEntries(STATS_STATUS_META.map((m) => [m.key, 0])) as Record<PendingStatus, number>;
  const decisions: Record<Decision, number> = { recommend: 0, cautious: 0, reject: 0 };
  const companyMap = new Map<string, number>();
  const cityMap = new Map<string, number>();
  const platformAcc = new Map<string, CrossAcc>();
  const directionAcc = new Map<string, CrossAcc>();
  const trendAdded = new Array<number>(buckets.length).fill(0);
  const trendSent = new Array<number>(buckets.length).fill(0);
  const trendScoreSum = new Array<number>(buckets.length).fill(0);
  const trendAnalyzed = new Array<number>(buckets.length).fill(0);

  let total = 0;
  let analyzed = 0;
  let scored = 0;
  let scoreSum = 0;
  let scoreNone = 0;
  let scoreHigh = 0;
  let scoreMid = 0;
  let scoreLow = 0;

  // runId → 方向名（pending 只有 runId，方向要回查 taskRuns）
  const runDirection = new Map<string, string>();
  taskRuns.forEach((r) => {
    if (r?.id) runDirection.set(String(r.id), String(r.directionName || '').trim() || '未归属方向');
  });

  for (const p of pending) {
    const created = safeTs(p.createdAt);
    const inScope = created !== null && created >= windowStart;

    // 趋势「新增」：按加入时间归桶（全量，受桶窗口约束）
    if (created !== null) {
      const i = bucketIndexOf(created, trendGranularity, buckets);
      if (i >= 0) trendAdded[i] += 1;
    }
    // 趋势「已投递」：按真实投递成功时间归桶（修复原 createdAt 冒充问题）
    const sentAt = safeTs(p.sentAt);
    if (sentAt !== null) {
      const i = bucketIndexOf(sentAt, trendGranularity, buckets);
      if (i >= 0) trendSent[i] += 1;
    }

    // 分数趋势：分数属于岗位本身，按加入时间归桶
    const score = typeof p.analysis?.score === 'number' && Number.isFinite(p.analysis.score) ? p.analysis.score : null;
    if (score !== null && created !== null) {
      const i = bucketIndexOf(created, trendGranularity, buckets);
      if (i >= 0) {
        trendScoreSum[i] += score;
        trendAnalyzed[i] += 1;
      }
    }

    if (!inScope) continue;

    total += 1;
    const st = (counts[p.status] !== undefined ? p.status : 'pending') as PendingStatus;
    counts[st] += 1;

    if (p.analysis?.decision && decisions[p.analysis.decision] !== undefined) decisions[p.analysis.decision] += 1;

    if (p.analysis) {
      analyzed += 1;
      const s = typeof p.analysis.score === 'number' && Number.isFinite(p.analysis.score) ? p.analysis.score : -1;
      if (s < 0) scoreNone += 1;
      else {
        scored += 1;
        scoreSum += s;
        if (s >= 70) scoreHigh += 1;
        else if (s >= 40) scoreMid += 1;
        else scoreLow += 1;
      }
    } else {
      scoreNone += 1;
    }

    const company = cleanCompanyName(p.job?.company);
    if (company) companyMap.set(company, (companyMap.get(company) || 0) + 1);
    const city = String(p.job?.location || '').trim();
    if (city) cityMap.set(city, (cityMap.get(city) || 0) + 1);

    const pf = (p.job?.platform || 'boss') as JobPlatform;
    const pfAcc = platformAcc.get(pf) || { label: platformLabel(pf), total: 0, sent: 0, failed: 0, waiting: 0, scoreSum: 0, analyzed: 0 };
    pfAcc.total += 1;
    if (p.status === 'sent') pfAcc.sent += 1;
    else if (p.status === 'failed') pfAcc.failed += 1;
    else if (WAITING_STATUSES.includes(p.status)) pfAcc.waiting += 1;
    if (score !== null) { pfAcc.scoreSum += score; pfAcc.analyzed += 1; }
    platformAcc.set(pf, pfAcc);

    const dirKey = p.runId ? runDirection.get(String(p.runId)) || '未归属方向' : '未归属方向';
    const dirAcc = directionAcc.get(dirKey) || { label: dirKey, total: 0, sent: 0, failed: 0, waiting: 0, scoreSum: 0, analyzed: 0 };
    dirAcc.total += 1;
    if (p.status === 'sent') dirAcc.sent += 1;
    else if (p.status === 'failed') dirAcc.failed += 1;
    else if (WAITING_STATUSES.includes(p.status)) dirAcc.waiting += 1;
    if (score !== null) { dirAcc.scoreSum += score; dirAcc.analyzed += 1; }
    directionAcc.set(dirKey, dirAcc);
  }

  /* ---- 今日投递（独立于时间范围，按 sentAt） ---- */
  let todaySent = 0;
  for (const p of pending) {
    const sentAt = safeTs(p.sentAt);
    if (sentAt !== null && sentAt >= todayStart) todaySent += 1;
  }

  /* ---- 任务维度（现有口径：任务数量与方向 Top 仍按 taskRuns） ---- */
  const runStatusMap = new Map<string, number>();
  const directionMap = new Map<string, number>();
  taskRuns.forEach((r) => {
    const st = String(r?.status || 'pending');
    runStatusMap.set(st, (runStatusMap.get(st) || 0) + 1);
    const name = String(r?.directionName || '').trim();
    if (name) directionMap.set(name, (directionMap.get(name) || 0) + 1);
  });

  const dailyTarget = Math.max(1, effectiveDailyCap(input.config || ({} as AppConfig)));

  const snapshot: StatsSnapshot = {
    range,
    generatedAt: now,
    windowStart,
    windowEnd,
    hasData: pending.length > 0 || taskRuns.length > 0,

    total,
    counts,
    sent: counts.sent,
    failed: counts.failed,
    skippedIgnored: counts.skipped + counts.ignored,
    waiting: WAITING_STATUSES.reduce((s, k) => s + counts[k], 0),
    rejected: counts.rejected,
    opened: counts.opened,

    decisions,
    decisionTotal: decisions.recommend + decisions.cautious + decisions.reject,
    analyzed,
    scored,
    analysisCoverage: rate(analyzed, total) ?? 0,
    avgScore: scored > 0 ? scoreSum / scored : null,
    scoreBands: { high: scoreHigh, mid: scoreMid, low: scoreLow, none: scoreNone, total: scoreHigh + scoreMid + scoreLow + scoreNone },

    todaySent,
    dailyTarget,
    goalPct: Math.min(100, Math.round((todaySent / dailyTarget) * 100)),

    successRate: rate(counts.sent, counts.sent + counts.failed),

    companyTop: topN(companyMap, 8),
    cityTop: topN(cityMap, 8),
    directionTop: topN(directionMap, 8),
    platformCross: toCrossRows(platformAcc),
    directionCross: toCrossRows(directionAcc),
    runStatus: [...runStatusMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, label: taskStatusLabel(key), value })),
    taskTotal: taskRuns.length,
    platformCount: platformAcc.size,
    directionCount: selectedDirectionItems(input.directionPlan).length,

    trend: buckets.map((b, i) => ({
      key: b.key,
      label: b.label,
      fullLabel: b.fullLabel,
      added: trendAdded[i],
      sent: trendSent[i],
      analyzed: trendAnalyzed[i],
      avgScore: trendAnalyzed[i] > 0 ? trendScoreSum[i] / trendAnalyzed[i] : null,
    })),
    trendGranularity,

    notes: buildNotes(range, trendGranularity),
  };

  return snapshot;
}

function buildNotes(range: StatsRangeMeta, gran: TrendGranularity): string[] {
  const granText = gran === 'day' ? '按天' : gran === 'week' ? '按周' : '按月';
  return [
    `岗位指标按「加入时间」落在「${range.label}」范围内统计。`,
    `趋势${granText}归桶：「新增」按加入日期、「已投递」按投递成功时间，两者归桶依据不同。`,
    '「今日目标」按投递成功时间统计今日已投递数，与每日投递上限同口径，不随时间范围变化。',
    '平均匹配分只统计已有 AI 分数的岗位，未分析岗位不计入分母。',
  ];
}

/* ============================ 展示辅助（页面/PDF 共用） ============================ */

export function pct(value: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((value / denominator) * 100);
}

export function formatRate(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`;
}

export function formatScore(s: number | null): string {
  return s === null ? '—' : s.toFixed(1);
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function rangeText(snapshot: StatsSnapshot): string {
  if (snapshot.range.days === null) {
    const hasAny = snapshot.total > 0 || snapshot.trend.some((b) => b.added > 0 || b.sent > 0);
    return hasAny ? `全部（${fmtDate(snapshot.windowStart)} 起）` : '全部';
  }
  return `${fmtDate(snapshot.windowStart)} ~ ${fmtDate(snapshot.windowEnd)}`;
}
