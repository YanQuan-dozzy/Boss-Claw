// 统计数据导出（纯函数，零依赖，不碰 IO）—— 统计页 / PDF / 控制桥共用。
//
// 设计口径：
//   - 只做 CSV：Excel 与 WPS 双击即开、无需安装任何库、可再导入做透视分析。
//     加 UTF-8 BOM，否则中文在 Excel 里是乱码。
//   - 明细表「一行一岗位」；汇总表用长表（tidy）结构：分类 / 维度 / 名称 / 数值 / 占比
//     —— 一行一个数据点，可直接拖进数据透视表；「人看」的职责交给 PDF 报表。
//   - 导出范围跟随页面当前视图（时间范围 + 状态），不做静默全量。
//
// 隐私口径（与需求确认一致）：
//   - 剔除 `chatUrl`（内含 conversationId 会话 token）与 `encryptUserId`（账号级加密 ID），
//     导出文件一旦外发不至于把沟通入口一并交出去；
//   - 剔除 `deliveryGreeting` 招呼语正文（含个人经历表述）；
//   - 岗位链接保留（公开信息），但去掉 query —— 岗位 URL 的 query 里带 securityId 等会话参数；
//   - 招聘方姓名保留：核对投递对象必需，且属页面可见的公开展示信息。

import type { AppConfig, PendingItem, TaskRun } from './types';
import { cleanCompanyName, cleanSalary, cleanTitle } from './jobDisplay';
import { platformLabel } from './platforms';
import {
  STATS_DECISION_META,
  STATS_STATUS_META,
  formatDateTime,
  rangeText,
  type StatsSnapshot,
} from './statsAggregate';

export type CsvCell = string | number | null | undefined;

/* ============================ CSV 序列化 ============================ */

/**
 * 字段转义（RFC4180）：
 *   - 含逗号 / 引号 / 换行 / 首尾空格 → 整体加引号，内部引号翻倍；
 *   - 以 = + - @ 或制表符开头的文本 → 前置单引号，避免 Excel 当公式执行
 *     （岗位标题由招聘方填写，理论上可被构造成公式注入）。
 */
export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  const risky = /^[=+\-@\t\r]/.test(s);
  if (risky) s = `'${s}`;
  const needsQuote = /[",\n\r]/.test(s) || /^\s|\s$/.test(s);
  if (needsQuote) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 二维数组 → CSV 文本（前置 UTF-8 BOM） */
export function toCsv(rows: CsvCell[][]): string {
  return `\uFEFF${rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}

/* ============================ 时间与范围工具 ============================ */

function tsOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 岗位是否落在当前统计范围内（按加入时间，与页面口径一致） */
export function isItemInRange(item: PendingItem, snapshot: StatsSnapshot): boolean {
  const t = tsOf(item.createdAt);
  return t !== null && t >= snapshot.windowStart;
}

function fmtTs(v: unknown): string {
  const t = tsOf(v);
  return t === null ? '' : formatDateTime(t);
}

/** 岗位 URL 去掉 query / hash（保留可定位岗位的路径部分，剥离会话参数） */
export function sanitizeJobUrl(url?: string | null): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    const cut = raw.split(/[?#]/)[0];
    return cut || '';
  }
}

function statusLabel(status: string): string {
  return STATS_STATUS_META.find((m) => m.key === status)?.label || status;
}

/* ============================ 明细表 ============================ */

export const DETAIL_HEADERS = [
  '序号',
  '平台',
  '岗位名称',
  '公司',
  '薪资',
  '城市',
  '状态',
  '匹配分',
  '匹配决策',
  '优先级分',
  '招聘方',
  'HR活跃度',
  '加入时间',
  '投递时间',
  '重试次数',
  '失败原因',
  '岗位链接',
] as const;

export function buildDetailRows(items: PendingItem[], snapshot: StatsSnapshot): CsvCell[][] {
  const rows: CsvCell[][] = [[...DETAIL_HEADERS]];
  let index = 0;
  for (const p of items) {
    if (!isItemInRange(p, snapshot)) continue;
    index += 1;
    const score = typeof p.analysis?.score === 'number' && Number.isFinite(p.analysis.score) ? p.analysis.score : '';
    rows.push([
      index,
      platformLabel(p.job?.platform),
      cleanTitle(p.job?.title, p.job?.salary),
      cleanCompanyName(p.job?.company) || '',
      cleanSalary(p.job?.salary) || '',
      String(p.job?.location || ''),
      statusLabel(p.status),
      score,
      p.analysis?.decision ? STATS_DECISION_META[p.analysis.decision].label : '',
      typeof p.priorityScore === 'number' ? Math.round(p.priorityScore) : '',
      String(p.job?.recruiterName || ''),
      String(p.job?.hrActive || ''),
      fmtTs(p.createdAt),
      fmtTs(p.sentAt),
      typeof p.retryCount === 'number' ? p.retryCount : '',
      String(p.error || ''),
      sanitizeJobUrl(p.job?.url),
    ]);
  }
  return rows;
}

/* ============================ 汇总表（长表） ============================ */

export const SUMMARY_HEADERS = ['分类', '维度', '名称', '数值', '占比'] as const;

interface SummaryRow { category: string; dimension: string; name: string; value: CsvCell; ratio?: CsvCell }

function push(rows: SummaryRow[], category: string, dimension: string, name: string, value: CsvCell, ratio?: CsvCell) {
  rows.push({ category, dimension, name, value, ratio });
}

export function buildSummaryRows(
  snapshot: StatsSnapshot,
  ctx: { pending: PendingItem[]; taskRuns: TaskRun[]; config?: AppConfig | null }
): CsvCell[][] {
  const s = snapshot;
  const rows: SummaryRow[] = [];
  const total = s.total;

  /* ---- 元信息（数值列留空，文字信息放「名称」列，保持数值列干净可计算） ---- */
  push(rows, '元信息', '生成时间', formatDateTime(s.generatedAt), '');
  push(rows, '元信息', '时间范围', rangeText(s), '');
  push(rows, '元信息', '范围内岗位数', String(total), '');
  push(rows, '元信息', '任务数', String(s.taskTotal), '');

  /* ---- 总览指标 ---- */
  push(rows, '总览', '岗位总数', '全部已记录岗位', total);
  push(rows, '总览', '已投递', '投递成功', s.sent, total > 0 ? s.sent / total : '');
  push(rows, '总览', '待处理', '待确认/待投递/投递中/已打开', s.waiting, total > 0 ? s.waiting / total : '');
  push(rows, '总览', '失败', '可重试/忽略', s.failed, total > 0 ? s.failed / total : '');
  push(rows, '总览', '跳过或忽略', '未投递岗位', s.skippedIgnored, total > 0 ? s.skippedIgnored / total : '');
  push(rows, '总览', '已确认方向', '投递方向模板', s.directionCount);

  /* ---- 岗位状态分布 ---- */
  STATS_STATUS_META.forEach((m) => {
    const v = s.counts[m.key] ?? 0;
    push(rows, '岗位状态', m.label, m.hint, v, total > 0 ? v / total : '');
  });

  /* ---- AI 匹配分析 ---- */
  (Object.keys(STATS_DECISION_META) as (keyof typeof STATS_DECISION_META)[]).forEach((k) => {
    const v = s.decisions[k];
    push(rows, 'AI决策', STATS_DECISION_META[k].label, 'AI 决策分布', v, s.decisionTotal > 0 ? v / s.decisionTotal : '');
  });
  push(rows, 'AI分数分布', '高（>=70）', '匹配分数分布', s.scoreBands.high, s.scoreBands.total > 0 ? s.scoreBands.high / s.scoreBands.total : '');
  push(rows, 'AI分数分布', '中（40-69）', '匹配分数分布', s.scoreBands.mid, s.scoreBands.total > 0 ? s.scoreBands.mid / s.scoreBands.total : '');
  push(rows, 'AI分数分布', '低（<40）', '匹配分数分布', s.scoreBands.low, s.scoreBands.total > 0 ? s.scoreBands.low / s.scoreBands.total : '');
  push(rows, 'AI分数分布', '未分析', '匹配分数分布', s.scoreBands.none, s.scoreBands.total > 0 ? s.scoreBands.none / s.scoreBands.total : '');
  push(rows, 'AI分数分布', '平均匹配分', `样本 ${s.scored} 条`, s.avgScore === null ? '' : Number(s.avgScore.toFixed(2)));
  push(rows, 'AI分数分布', 'AI分析覆盖率(%)', `已分析 ${s.analyzed} / ${total}`, Math.round(s.analysisCoverage * 100));

  /* ---- 趋势 ---- */
  s.trend.forEach((b) => {
    push(rows, '趋势', '新增岗位', b.fullLabel, b.added);
  });
  s.trend.forEach((b) => {
    push(rows, '趋势', '已投递岗位', b.fullLabel, b.sent);
  });
  s.trend.forEach((b) => {
    push(rows, '趋势', '平均匹配分', b.fullLabel, b.avgScore === null ? '' : Number(b.avgScore.toFixed(2)));
  });

  /* ---- Top 榜 ---- */
  s.companyTop.forEach(([name, n]) => push(rows, '公司Top', '岗位数', name, n, total > 0 ? n / total : ''));
  s.cityTop.forEach(([name, n]) => push(rows, '城市Top', '岗位数', name, n, total > 0 ? n / total : ''));
  s.directionTop.forEach(([name, n]) => push(rows, '方向Top', '岗位数', name, n, ctx.taskRuns.length > 0 ? n / ctx.taskRuns.length : ''));

  /* ---- 交叉视图 ---- */
  const cross = (category: string, list: typeof s.platformCross) => {
    list.forEach((r) => push(rows, category, '岗位数', r.label, r.total, total > 0 ? r.total / total : ''));
    list.forEach((r) => push(rows, category, '已投递', r.label, r.sent, total > 0 ? r.sent / total : ''));
    list.forEach((r) => push(rows, category, '失败', r.label, r.failed, total > 0 ? r.failed / total : ''));
    list.forEach((r) => push(rows, category, '待处理', r.label, r.waiting, total > 0 ? r.waiting / total : ''));
    list.forEach((r) => push(rows, category, '成功率(%)', r.label, r.successRate === null ? '' : Math.round(r.successRate * 100), r.successRate ?? ''));
    list.forEach((r) => push(rows, category, '平均匹配分', r.label, r.avgScore === null ? '' : Number(r.avgScore.toFixed(2))));
  };
  cross('平台交叉', s.platformCross);
  cross('方向交叉', s.directionCross);

  /* ---- 任务概览 ---- */
  push(rows, '任务', '任务总数', '全部', s.taskTotal);
  s.runStatus.forEach((r) => push(rows, '任务', '任务状态', r.label, r.value, s.taskTotal > 0 ? r.value / s.taskTotal : ''));

  /* ---- 成功率总览 ---- */
  push(rows, '总览', '投递成功率(%)', `已投递 ${s.sent} / 失败 ${s.failed}`, s.successRate === null ? '' : Math.round(s.successRate * 100), s.successRate ?? '');
  push(rows, '总览', '今日已投递', '按投递成功时间', s.todaySent, `${s.dailyTarget}`);

  /* ---- 口径说明 ---- */
  s.notes.forEach((n) => push(rows, '口径说明', n, '', ''));

  return [
    [...SUMMARY_HEADERS],
    ...rows.map((r) => [r.category, r.dimension, r.name, r.value, r.ratio ?? ''] as CsvCell[]),
  ];
}

/* ============================ 文件名 ============================ */

export type ExportKind = 'detail' | 'summary' | 'report';

const KIND_LABEL: Record<ExportKind, string> = {
  detail: '岗位明细',
  summary: '统计汇总',
  report: '数据统计报表',
};

function stamp(ts: number): { date: string; time: string } {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

/** 例：BossClaw-岗位明细-近7天-20260913.csv */
export function exportFilename(kind: ExportKind, snapshot: StatsSnapshot, ext: 'csv' | 'pdf'): string {
  const { date } = stamp(snapshot.generatedAt);
  return `BossClaw-${KIND_LABEL[kind]}-${snapshot.range.slug}-${date}.${ext}`;
}
