// 数据统计报表 PDF 渲染（HTML → Electron printToPDF，零额外依赖）
//
// 为什么不用截屏：项目既有约定（见 resumeToImage.ts 注释）——
//   「不依赖 Electron capturePage / 隐藏窗口，规避『页面捕获结果为空』等截屏问题」。
// 因此报表走与 resumePdf.ts 同构的路线：渲染层输出**纯 HTML + 内联 CSS**，
// 由主进程加载到隐藏窗口后 printToPDF，排版完全由 CSS 控制。
//
// 版式口径（与需求确认一致）：
//   - A4 **横版**：统计页是宽幅布局（指标卡 / 三列图表），横版才装得下且不用挤成两屏；
//   - **纯报表不含岗位明细表**：岗位级明细是 CSV 的职责，几十页明细会让 PDF 无法使用；
//   - 图表用 CSS 实心条（不用 canvas / 图表库），`print-color-adjust: exact` 保证底色不丢；
//   - 报表不引入任何外部资源（字体用系统字体），data: URL 加载即可渲染。
//
// 排版约束：所有文本经 HTML 转义；不使用 letter-spacing（Chromium 打印会把字距实现为
// 字符间空格，破坏文本复制与检索）；文案用 sentence case、不用感叹号。

import {
  STATS_DECISION_META,
  STATS_STATUS_META,
  formatDateTime,
  formatRate,
  formatScore,
  pct,
  rangeText,
  type CrossRow,
  type StatsSnapshot,
} from './statsAggregate';

function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INK = '#0F172A';
const MUTED = '#5B6675';
const SUBTLE = '#94A3B8';
const LINE = '#E3E8EF';
const BAND = '#F5F7FA';
const ACCENT = '#0D9488';
const SUCCESS = '#10B981';
const SCORE = '#6366F1';

const BASE_CSS = `
@page { size: A4 landscape; margin: 10mm 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Source Han Sans SC", sans-serif;
  color: ${INK}; font-size: 9.5pt; line-height: 1.55;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.report { max-width: 100%; }
.num, .hbar-val, .rank, .chart-axis span { font-variant-numeric: tabular-nums; }

.rh { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
      padding-bottom: 8px; border-bottom: 2px solid ${ACCENT}; margin-bottom: 12px; }
.rh-title { margin: 0; font-size: 17pt; font-weight: 600; }
.rh-sub { margin: 3px 0 0; font-size: 8.5pt; color: ${MUTED}; }
.rh-meta { text-align: right; font-size: 8.5pt; color: ${MUTED}; white-space: nowrap; }
.rh-meta b { color: ${INK}; font-weight: 600; }

.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
.tile { border: 1px solid ${LINE}; border-radius: 8px; padding: 8px 10px; }
.tile-label { font-size: 8.5pt; color: ${MUTED}; }
.tile-value { font-size: 16pt; font-weight: 600; line-height: 1.2; }
.tile-u { font-size: 10pt; font-weight: 500; color: ${MUTED}; margin-left: 3px; }
.tile-note { font-size: 7.5pt; color: ${SUBTLE}; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.card { border: 1px solid ${LINE}; border-radius: 8px; padding: 10px 12px; break-inside: avoid; }
.card-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.card-t { font-size: 10pt; font-weight: 600; }
.card-x { font-size: 8pt; color: ${SUBTLE}; }
.block { margin-bottom: 8px; }
.block:last-child { margin-bottom: 0; }
.block-label { font-size: 8.5pt; font-weight: 600; color: ${MUTED}; margin-bottom: 5px; }

.hbar { margin-bottom: 6px; }
.hbar:last-child { margin-bottom: 0; }
.hbar-head { display: flex; justify-content: space-between; font-size: 8.5pt; margin-bottom: 3px; }
.hbar-val { color: ${MUTED}; }
.hbar-track { height: 6px; background: ${BAND}; border-radius: 3px; overflow: hidden; }
.hbar-fill { height: 100%; border-radius: 3px; }

.chart { padding-top: 4px; }
.chart-body { position: relative; }
.chart-guide { position: absolute; left: 0; right: 0; border-top: 1px dashed #CBD5E1; }
.chart-guide span { position: absolute; right: 0; top: -8px; z-index: 2; font-size: 7pt;
                    color: ${SUBTLE}; background: #fff; padding: 0 3px; }
.chart-cols { display: flex; align-items: flex-end; gap: 3px; height: 82px; }
.chart-col { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 2px; height: 100%; }
.chart-bar { width: 42%; border-radius: 3px 3px 0 0; }
.chart-bar.added { background: ${ACCENT}; }
.chart-bar.sent { background: ${SUCCESS}; }
.chart-bar.score { background: ${SCORE}; }
.chart-axis { display: flex; gap: 3px; margin-top: 4px; }
.chart-axis span { flex: 1; text-align: center; font-size: 6.5pt; color: ${SUBTLE}; }
.legend { display: flex; gap: 12px; font-size: 8pt; color: ${MUTED}; }
.legend i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; }

table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
th { text-align: left; font-weight: 600; color: ${MUTED}; padding: 5px 6px;
     border-bottom: 1px solid ${LINE}; white-space: nowrap; }
td { padding: 5px 6px; border-bottom: 1px solid ${BAND}; }
td.n, th.n { text-align: right; }
tbody tr:last-child td { border-bottom: none; }

.rf { margin-top: 12px; padding-top: 8px; border-top: 1px solid ${LINE}; font-size: 7.5pt; color: ${SUBTLE}; }
.rf p { margin: 0 0 2px; }
`;

function tile(label: string, value: string, note?: string, unit?: string): string {
  return `<div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value num">${esc(value)}${unit ? `<span class="tile-u">${esc(unit)}</span>` : ''}</div>
    <div class="tile-note">${note ? esc(note) : '&nbsp;'}</div>
  </div>`;
}

function hbar(label: string, value: number, total: number, color: string): string {
  const percent = pct(value, total);
  return `<div class="hbar">
    <div class="hbar-head"><span>${esc(label)}</span><span class="hbar-val">${value} · ${percent}%</span></div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${percent}%;background:${color}"></div></div>
  </div>`;
}

function chartAxis(labels: string[], step: number): string {
  return `<div class="chart-axis">${labels
    .map((l, i) => `<span>${i % step === 0 || i === labels.length - 1 ? esc(l) : ''}</span>`)
    .join('')}</div>`;
}

function crossTable(rows: CrossRow[]): string {
  if (rows.length === 0) return '<div class="card-x">范围内暂无数据</div>';
  return `<table>
    <thead><tr>
      <th>名称</th><th class="n">岗位数</th><th class="n">已投递</th>
      <th class="n">失败</th><th class="n">待处理</th><th class="n">成功率</th><th class="n">平均分</th>
    </tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td>${esc(r.label)}</td>
        <td class="n">${r.total}</td>
        <td class="n">${r.sent}</td>
        <td class="n">${r.failed}</td>
        <td class="n">${r.waiting}</td>
        <td class="n">${esc(formatRate(r.successRate))}</td>
        <td class="n">${esc(formatScore(r.avgScore))}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function rankList(items: [string, number][], total: number): string {
  if (items.length === 0) return '<div class="card-x">范围内暂无数据</div>';
  return items.map(([name, n], i) => hbar(`${i + 1}. ${name}`, n, total, ACCENT)).join('');
}

/**
 * 生成报表 HTML。
 * @param snapshot 统计快照（页面 / CSV / 报表唯一数据源）
 * @param appVersion 应用版本（页脚标识，可空）
 */
export function buildStatsReportHtml(snapshot: StatsSnapshot, appVersion?: string): string {
  const s = snapshot;
  const axisStep = s.trend.length > 20 ? Math.ceil(s.trend.length / 10) : 1;

  const trendMax = Math.max(1, ...s.trend.map((b) => b.added), ...s.trend.map((b) => b.sent));
  const trendBars = s.trend
    .map(
      (b) => `<div class="chart-col">
      <div class="chart-bar added" style="height:${Math.max(1.5, (b.added / trendMax) * 100)}%"></div>
      <div class="chart-bar sent" style="height:${Math.max(1.5, (b.sent / trendMax) * 100)}%"></div>
    </div>`
    )
    .join('');

  // 分数趋势：纵轴固定 0-100（匹配分本身是百分制），并叠加 70 / 40 参考线
  const scoreBars = s.trend
    .map(
      (b) => `<div class="chart-col">
      <div class="chart-bar score" style="height:${b.avgScore === null ? 0 : Math.max(1.5, b.avgScore)}%"></div>
    </div>`
    )
    .join('');

  const decisionBars = (Object.keys(STATS_DECISION_META) as (keyof typeof STATS_DECISION_META)[])
    .map((k) => hbar(STATS_DECISION_META[k].label, s.decisions[k], s.decisionTotal, STATS_DECISION_META[k].color))
    .join('');

  const scoreBandBars =
    hbar('高（70 及以上）', s.scoreBands.high, s.scoreBands.total, SUCCESS) +
    hbar('中（40-69）', s.scoreBands.mid, s.scoreBands.total, '#F59E0B') +
    hbar('低（40 以下）', s.scoreBands.low, s.scoreBands.total, '#EF4444') +
    hbar('未分析', s.scoreBands.none, s.scoreBands.total, '#CBD5E1');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>BossClaw 数据统计报表</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="report">

  <header class="rh">
    <div>
      <h1 class="rh-title">数据统计报表</h1>
      <p class="rh-sub">岗位指标按加入时间落在所选范围内统计；趋势「新增」按加入日期、「已投递」按投递成功时间归桶。</p>
    </div>
    <div class="rh-meta">
      <div>时间范围 <b>${esc(rangeText(s))}</b></div>
      <div>生成时间 <b>${esc(formatDateTime(s.generatedAt))}</b></div>
      <div>范围内岗位 <b>${s.total}</b> 条</div>
    </div>
  </header>

  <section class="tiles">
    ${tile('岗位总数', String(s.total), '范围内已记录')}
    ${tile('已投递', String(s.sent), `占全部 ${pct(s.sent, s.total)}%`)}
    ${tile('待处理', String(s.waiting), '待确认/待投递/投递中/已打开')}
    ${tile('失败', String(s.failed), '可重试或忽略')}
    ${tile('跳过或忽略', String(s.skippedIgnored), '未投递岗位')}
    ${tile('投递成功率', formatRate(s.successRate), `已投递 ${s.sent} / 失败 ${s.failed}`)}
    ${tile('平均匹配分', formatScore(s.avgScore), `样本 ${s.scored} 条`)}
    ${tile('今日已投递', String(s.todaySent), `每日目标 ${s.dailyTarget}`)}
  </section>

  <section class="grid2">
    <div class="card">
      <div class="card-h"><span class="card-t">岗位状态分布</span><span class="card-x">共 ${s.total} 条记录</span></div>
      ${STATS_STATUS_META.map((m) => hbar(m.label, s.counts[m.key] ?? 0, s.total, m.color)).join('')}
    </div>
    <div class="card">
      <div class="card-h">
        <span class="card-t">AI 匹配分析</span>
        <span class="card-x">已分析 ${s.analyzed} / ${s.total}（${Math.round(s.analysisCoverage * 100)}%）</span>
      </div>
      <div class="block">
        <div class="block-label">决策分布</div>
        ${s.decisionTotal === 0 ? '<div class="card-x">尚无 AI 分析结果</div>' : decisionBars}
      </div>
      <div class="block">
        <div class="block-label">匹配分数分布</div>
        ${s.scoreBands.total === 0 ? '<div class="card-x">尚无匹配分数</div>' : scoreBandBars}
      </div>
      <div class="block">
        <div class="block-label">今日目标达成</div>
        ${hbar('今日已投递 / 每日目标', s.todaySent, s.dailyTarget, ACCENT)}
      </div>
    </div>
  </section>

  <section class="card" style="margin-bottom:12px">
    <div class="card-h">
      <span class="card-t">投递趋势</span>
      <span class="legend">
        <span><i style="background:${ACCENT}"></i>新增岗位</span>
        <span><i style="background:${SUCCESS}"></i>已投递</span>
      </span>
    </div>
    <div class="chart">
      <div class="chart-body"><div class="chart-cols">${trendBars}</div></div>
      ${chartAxis(s.trend.map((b) => b.label), axisStep)}
    </div>
  </section>

  <section class="card" style="margin-bottom:12px">
    <div class="card-h">
      <span class="card-t">匹配分数趋势</span>
      <span class="card-x">仅统计已有 AI 分数的岗位；虚线为 70 分与 40 分参考线</span>
    </div>
    <div class="chart">
      <div class="chart-body">
        <div class="chart-guide" style="bottom:70%"><span>70</span></div>
        <div class="chart-guide" style="bottom:40%"><span>40</span></div>
        <div class="chart-cols">${scoreBars}</div>
      </div>
      ${chartAxis(s.trend.map((b) => b.label), axisStep)}
    </div>
  </section>

  <section class="grid3">
    <div class="card">
      <div class="card-h"><span class="card-t">公司 Top</span><span class="card-x">前 ${s.companyTop.length}</span></div>
      ${rankList(s.companyTop, s.total)}
    </div>
    <div class="card">
      <div class="card-h"><span class="card-t">城市 Top</span><span class="card-x">前 ${s.cityTop.length}</span></div>
      ${rankList(s.cityTop, s.total)}
    </div>
    <div class="card">
      <div class="card-h"><span class="card-t">任务概览</span><span class="card-x">共 ${s.taskTotal} 个任务</span></div>
      ${s.taskTotal === 0
        ? '<div class="card-x">尚未创建任务</div>'
        : s.runStatus.map((r) => hbar(r.label, r.value, s.taskTotal, ACCENT)).join('')}
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="card-h"><span class="card-t">平台交叉视图</span><span class="card-x">按招聘平台</span></div>
      ${crossTable(s.platformCross)}
    </div>
    <div class="card">
      <div class="card-h"><span class="card-t">方向交叉视图</span><span class="card-x">按投递方向</span></div>
      ${crossTable(s.directionCross)}
    </div>
  </section>

  <footer class="rf">
    ${s.notes.map((n) => `<p>· ${esc(n)}</p>`).join('')}
    <p>· 报表不含岗位级明细（含招聘方信息），需要逐条数据请使用「导出 → 岗位明细 CSV」。</p>
    <p>BossClaw${appVersion ? ` v${esc(appVersion)}` : ''} · 报表由本地数据生成，未上传任何内容。</p>
  </footer>

</div>
</body>
</html>`;
}
