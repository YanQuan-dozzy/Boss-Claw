// 数据统计页
// ---------------------------------------------------------------------------
// 数据来源：`statsAggregate.buildStatsSnapshot` —— 页面 / CSV 导出 / PDF 报表 / 控制桥
// 四处的**唯一聚合源**，口径不允许各自再算一遍。
//
// 本轮修正的问题（原实现）：
//   1) 趋势「已投递」用 createdAt（加入日期）冒充投递日期 → 改用 sentAt；
//   2) 「今日目标达成」用累计已投递当分子 → 改用今日 sentAt，与每日上限同口径；
//   3) 状态分布漏了 `opened`（已打开沟通窗）→ 各状态占比合计不再是 100-n；
//   4) `mb-16` / `mt-12` 是死类（index.css 未定义）→ 改为显式 CSS 类；
//   5) 两处栅格列宽内联硬编码，窄屏不塌陷 → 移入 CSS 并按断点收起；
//   6) 同一份 pending 在渲染期被反复全量遍历 → 单遍扫描建 Map。
//
// 视觉口径（redesign 审计后收敛）：
//   - 去掉指标卡顶部 6 色渐变色条（AI 指纹），改 2px 实心语义色脊线；
//   - 数值统一 tabular-nums（等宽对齐），等宽字体走主题变量 `--font-mono`；
//   - 趋势图独占整行（30 日桶需要宽度），打破「全是等宽两栏」的呆板节奏；
//   - 空态从「暂无数据」升级为三步上手引导 + 主操作。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Dropdown, Progress, Segmented, Space, Tag, Tooltip, Typography, message } from 'antd';
import {
  AimOutlined,
  AlertOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DownloadOutlined,
  EnvironmentOutlined,
  FlagOutlined,
  QuestionCircleOutlined,
  RiseOutlined,
  RocketOutlined,
  StopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { ChevronDown } from '@/components/ChevronDown';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAppStore } from '@/store/useAppStore';
import { electronApi } from '@/lib/electronApi';
import {
  STATS_DIMENSION_META,
  STATS_FIT_LEVEL_META,
  STATS_RANGES,
  STATS_STATUS_META,
  buildStatsSnapshot,
  formatRate,
  formatScore,
  pct,
  rangeText,
  type CrossRow,
  type StatsRangeKey,
  type StatsSnapshot,
  type TrendBucket,
} from '@/lib/bossclaw/statsAggregate';
import { buildDetailRows, buildSummaryRows, exportFilename, toCsv, type ExportKind } from '@/lib/bossclaw/statsExport';
import { buildStatsReportHtml } from '@/lib/bossclaw/statsReport';
import { revealFile, saveCsvFile, saveReportPdf, type ExportOutcome } from '@/lib/bossclaw/statsExportRun';

const { Text } = Typography;

/* ============================ 小组件 ============================ */

function HBar({
  label,
  value,
  total,
  color,
  hint,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  hint?: string;
}) {
  const percent = pct(value, total);
  return (
    <div className="hbar">
      <div className="hbar-head">
        <span className="hbar-label" title={hint}>{label}</span>
        <span className="hbar-value">
          {value} <span className="hbar-pct">{percent}%</span>
        </span>
      </div>
      <div className="hbar-track">
        <Tooltip title={hint ? `${label}：${value} 个（${percent}%）· ${hint}` : `${label}：${value} 个（${percent}%）`}>
          <div className="hbar-fill" style={{ width: `${percent}%`, background: color }} />
        </Tooltip>
      </div>
    </div>
  );
}

function DimensionBar({ label, score, hint }: { label: string; score: number | null; hint?: string }) {
  const hasScore = score !== null && Number.isFinite(score);
  const color = !hasScore
    ? 'var(--border-strong)'
    : score >= 80
      ? '#10B981'
      : score >= 65
        ? '#13b5ac'
        : score >= 50
          ? '#F59E0B'
          : '#EF4444';

  return (
    <div className="ai-dim-row">
      <span className="ai-dim-label" title={hint}>{label}</span>
      <div className="ai-dim-track-wrap">
        <Tooltip title={hint ? `${label}：${hasScore ? `${score} 分` : '暂无'} · ${hint}` : `${label}：${hasScore ? `${score} 分` : '暂无'}`}>
          <div className="ai-dim-track">
            <div className="ai-dim-fill" style={{ width: `${hasScore ? Math.min(100, Math.max(4, score)) : 0}%`, background: color }} />
          </div>
        </Tooltip>
      </div>
      <span className="ai-dim-val">{hasScore ? `${score}分` : '—'}</span>
    </div>
  );
}

function InsightTags({
  items,
  type,
  emptyText,
}: {
  items: [string, number][];
  type: 'strength' | 'caution';
  emptyText: string;
}) {
  if (!items.length) {
    return <div className="ai-insight-empty">{emptyText}</div>;
  }
  return (
    <div className="ai-tag-group">
      {items.map(([tag, count]) => (
        <span className={`ai-insight-tag ${type}`} key={tag} title={`${tag}（出现 ${count} 次）`}>
          <span className="ai-insight-text">{tag}</span>
          {count > 1 && <span className="ai-insight-count">×{count}</span>}
        </span>
      ))}
    </div>
  );
}

function TopList({ items, icon }: { items: [string, number][]; icon: React.ReactNode }) {
  if (items.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>范围内暂无数据</Text>;
  const max = items[0][1] || 1;
  return (
    <div className="top-list">
      {items.map(([name, n], i) => (
        <div className="top-item" key={name}>
          <span className="top-rank">{icon}</span>
          <span className="top-name" title={name}>{name}</span>
          <span className="top-count">{n}</span>
          <span className="top-track">
            <span className="top-fill" style={{ width: `${Math.round((n / max) * 100)}%`, opacity: i === 0 ? 1 : 0.72 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** 轴标签抽样步长：桶多时避免标签糊成一团 */
function axisStepFor(count: number): number {
  if (count <= 12) return 1;
  return Math.ceil(count / 10);
}

function TrendChart({ buckets }: { buckets: TrendBucket[] }) {
  const max = Math.max(1, ...buckets.map((d) => d.added), ...buckets.map((d) => d.sent));
  const step = axisStepFor(buckets.length);
  return (
    <div className="trend">
      <div className="trend-cols">
        {buckets.map((d) => (
          <div className="trend-col" key={d.key}>
            <div className="trend-bars">
              <Tooltip title={`${d.fullLabel} · 加入 ${d.added} 个`}>
                <div className="trend-bar added" style={{ height: `${Math.max(2, (d.added / max) * 100)}%` }} />
              </Tooltip>
              <Tooltip title={`${d.fullLabel} · 已投递 ${d.sent} 个`}>
                <div className="trend-bar sent" style={{ height: `${Math.max(2, (d.sent / max) * 100)}%` }} />
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
      <div className="trend-axis">
        {buckets.map((d, i) => (
          <span key={d.key}>{i % step === 0 || i === buckets.length - 1 ? d.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

/** 匹配分数趋势：纵轴固定 0-100（分数本身是百分制），叠加 70 / 40 参考线 */
function ScoreTrend({ buckets }: { buckets: TrendBucket[] }) {
  const withSample = buckets.filter((b) => b.avgScore !== null).length;
  if (withSample === 0) return <Text type="secondary" style={{ fontSize: 12 }}>范围内暂无 AI 分数</Text>;
  const step = axisStepFor(buckets.length);
  return (
    <div className="score-chart">
      <div className="score-chart-frame">
        <div className="score-chart-body">
          <div className="score-guide" style={{ bottom: '70%' }}><span>70</span></div>
          <div className="score-guide" style={{ bottom: '40%' }}><span>40</span></div>
          <div className="score-cols">
            {buckets.map((b) => (
              <Tooltip
                key={b.key}
                title={
                  b.avgScore === null
                    ? `${b.fullLabel} · 无样本`
                    : `${b.fullLabel} · 均分 ${b.avgScore.toFixed(1)}（${b.analyzed} 条）`
                }
              >
                <div className="score-col">
                  <div
                    className="score-bar"
                    style={{ height: b.avgScore === null ? '0%' : `${Math.max(2, b.avgScore)}%` }}
                  />
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <div className="trend-axis">
        {buckets.map((b, i) => (
          <span key={b.key}>{i % step === 0 || i === buckets.length - 1 ? b.label : ''}</span>
        ))}
      </div>
      <p className="stats-note">
        仅统计已有 AI 分数的 {withSample} 个时间桶；虚线为 70 分与 40 分参考线。
      </p>
    </div>
  );
}

function CrossTable({ rows }: { rows: CrossRow[] }) {
  if (rows.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>范围内暂无数据</Text>;
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>名称</th>
            <th className="num">岗位数</th>
            <th className="num">已投递</th>
            <th className="num">失败</th>
            <th className="num">待处理</th>
            <th className="num">成功率</th>
            <th className="num">平均分</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="name">{r.label}</td>
              <td className="num">{r.total}</td>
              <td className="num">{r.sent}</td>
              <td className="num">{r.failed}</td>
              <td className="num">{r.waiting}</td>
              <td className="num">{formatRate(r.successRate)}</td>
              <td className="num">{formatScore(r.avgScore)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ============================ 页面 ============================ */

export default function Stats() {
  const pending = useDataStore((s) => s.pending);
  const taskRuns = useDataStore((s) => s.taskRuns);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const addLog = useDataStore((s) => s.addLog);
  const config = useSettingsStore((s) => s.config);
  const setRoute = useAppStore((s) => s.setRoute);

  const [range, setRange] = useState<StatsRangeKey>('7d');
  const [crossBy, setCrossBy] = useState<'platform' | 'direction'>('platform');
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    let alive = true;
    electronApi
      .getAppInfo()
      .then((info) => { if (alive && info?.version) setAppVersion(info.version); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const snapshot = useMemo<StatsSnapshot>(
    () => buildStatsSnapshot({ pending, taskRuns, directionPlan, config, range }),
    [pending, taskRuns, directionPlan, config, range]
  );

  /* ---------- 导出（硬契约：每次都由用户在弹出的系统对话框里选保存位置） ---------- */
  const runExport = useCallback(
    async (kind: ExportKind) => {
      if (exporting) return;
      setExporting(kind);
      try {
        // 导出时重建快照：拿到「此刻」的数据与生成时间，避免用上一次渲染的旧快照
        const snap = buildStatsSnapshot({ pending, taskRuns, directionPlan, config, range, now: Date.now() });
        let outcome: ExportOutcome;
        if (kind === 'report') {
          outcome = await saveReportPdf(exportFilename('report', snap, 'pdf'), buildStatsReportHtml(snap, appVersion));
        } else {
          const rows =
            kind === 'detail'
              ? buildDetailRows(pending, snap)
              : buildSummaryRows(snap, { pending, taskRuns, config });
          outcome = await saveCsvFile(exportFilename(kind, snap, 'csv'), toCsv(rows), kind);
        }

        if (outcome.ok) {
          const label = kind === 'detail' ? '岗位明细' : kind === 'summary' ? '统计汇总' : '统计报表';
          addLog('info', `导出${label}：${outcome.filePath}`);
          if (outcome.viaDownload) {
            // 浏览器兜底只有文件名，没有真实路径
            message.success(`已下载 ${outcome.filePath}`);
          } else {
            const filePath = outcome.filePath;
            message.success({
              content: (
                <span className="stats-export-toast">
                  已保存到 {filePath}
                  <Button type="link" size="small" icon={<RocketOutlined />} onClick={() => revealFile(filePath)}>
                    打开所在文件夹
                  </Button>
                </span>
              ),
              duration: 8,
            });
          }
        } else if (!outcome.canceled) {
          // 用户取消保存不属于失败：按契约不写盘、不报错、不提示
          message.error(`导出失败：${outcome.error}`);
        }
      } catch (e) {
        message.error(`导出失败：${(e as Error).message}`);
      } finally {
        setExporting(null);
      }
    },
    [exporting, pending, taskRuns, directionPlan, config, range, appVersion, addLog]
  );

  /* ---------- 指标卡 ---------- */
  const overviewCards = [
    { icon: <TeamOutlined />, cls: 'teal', title: '岗位总数', value: snapshot.total, note: '范围内已记录岗位', badge: '记录' },
    {
      icon: <CheckCircleFilled />, cls: 'green', title: '已投递', value: snapshot.sent,
      note: '投递成功', pctText: `${pct(snapshot.sent, snapshot.total)}%`,
    },
    {
      icon: <ClockCircleOutlined />, cls: 'blue', title: '待处理', value: snapshot.waiting,
      note: '待确认 / 待投递 / 投递中 / 已打开', pctText: `${pct(snapshot.waiting, snapshot.total)}%`,
    },
    {
      icon: <CloseCircleFilled />, cls: 'red', title: '失败', value: snapshot.failed,
      note: '可重试或忽略', pctText: `${pct(snapshot.failed, snapshot.total)}%`,
    },
    {
      icon: <StopOutlined />, cls: 'orange', title: '跳过 / 忽略', value: snapshot.skippedIgnored,
      note: '未投递岗位', pctText: `${pct(snapshot.skippedIgnored, snapshot.total)}%`,
    },
    { icon: <AimOutlined />, cls: 'purple', title: '已确认方向', value: snapshot.directionCount, note: '投递方向模板', badge: '模板' },
  ];

  const empty = pending.length === 0 && taskRuns.length === 0;

  const exportMenu = {
    items: [
      { key: 'detail', label: '岗位明细 CSV', icon: <DownloadOutlined /> },
      { key: 'summary', label: '统计汇总 CSV', icon: <DownloadOutlined /> },
      { type: 'divider' as const },
      { key: 'report', label: '统计报表 PDF（A4 横版）', icon: <DownloadOutlined /> },
    ],
    onClick: ({ key }: { key: string }) => void runExport(key as ExportKind),
  };

  return (
    <div className="page stats-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <BarChartOutlined className="page-title-icon" />数据统计
          </h1>
          <p className="page-sub">
            基于本地任务与岗位记录实时聚合，无需联网。岗位指标按「加入时间」落在所选范围内统计；
            趋势「已投递」按投递成功时间归桶。每次导出都会弹出系统保存对话框，由你选择保存位置。
          </p>
        </div>
        <div className="page-head-extra stats-head-extra">
          <Segmented
            value={range}
            onChange={(v) => setRange(v as StatsRangeKey)}
            options={STATS_RANGES.map((r) => ({ label: r.label, value: r.key }))}
          />
          <Dropdown
            menu={exportMenu}
            trigger={['click']}
            placement="bottomRight"
            open={exportOpen}
            onOpenChange={setExportOpen}
          >
            <Button type="primary" icon={<DownloadOutlined />} loading={Boolean(exporting)}>
              导出 <ChevronDown open={exportOpen} size={11} style={{ marginLeft: 4 }} />
            </Button>
          </Dropdown>
        </div>
      </div>

      {empty ? (
        <Card>
          <div className="stats-empty">
            <div className="stats-empty-icon"><BarChartOutlined /></div>
            <h2 className="stats-empty-title">还没有可统计的数据</h2>
            <p className="stats-empty-desc">
              统计页只读取本地记录，不联网也不会上传。走完下面三步，指标、趋势与交叉视图会自动出现。
            </p>
            <ol className="stats-empty-steps">
              <li><b>配置投递方向</b><span>在「投递方向」确认关键词与城市，让筛选有依据</span></li>
              <li><b>采集岗位</b><span>在「工作台」用内置浏览器打开岗位并加入队列</span></li>
              <li><b>确认并投递</b><span>在「任务进度」确认后由安全引擎执行投递</span></li>
            </ol>
            <div className="stats-empty-actions">
              <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => setRoute('workbench')}>
                前往工作台
              </Button>
              <Button onClick={() => setRoute('directions')}>先配置方向</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* 总览指标卡 */}
          <div className="stat-cards-grid">
            {overviewCards.map((c) => (
              <div className={`stat-card stat-card-${c.cls}`} key={c.title}>
                <div className="stat-card-spine" />
                <div className="stat-card-content">
                  <div className="stat-card-header">
                    <div className={'stat-icon ' + c.cls}>{c.icon}</div>
                    {c.pctText ? (
                      <span className={`stat-badge ${c.cls}`}>{c.pctText}</span>
                    ) : c.badge ? (
                      <span className={`stat-badge ${c.cls}`}>{c.badge}</span>
                    ) : null}
                  </div>
                  <div className="stat-body">
                    <div className="stat-title">{c.title}</div>
                    <div className="stat-value">{c.value}</div>
                    <div className="stat-note" title={c.note}>{c.note}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 状态分布 + AI 匹配分析 */}
          <div className="stats-row stats-row--2">
            <Card
              size="small"
              title="岗位状态分布"
              className="stats-card-status"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {snapshot.total} 条记录</Text>}
            >
              <div className="status-hbar-list">
                {STATS_STATUS_META.map((m) => (
                  <HBar
                    key={m.key}
                    label={m.label}
                    hint={m.hint}
                    value={snapshot.counts[m.key] ?? 0}
                    total={snapshot.total}
                    color={m.color}
                  />
                ))}
              </div>
            </Card>

            <Card
              size="small"
              title="AI 匹配分析"
              className="stats-card-ai"
              extra={
                <Tag icon={<RiseOutlined />} color="processing" style={{ borderRadius: 6 }}>
                  已分析 {snapshot.analyzed} / {snapshot.total}
                </Tag>
              }
            >
              {/* 头部微指标看板 */}
              <div className="ai-kpi-grid">
                <div className="ai-kpi-item">
                  <div className="ai-kpi-val">{formatScore(snapshot.avgScore)}</div>
                  <div className="ai-kpi-lbl">平均匹配分</div>
                </div>
                <div className="ai-kpi-item">
                  <div className="ai-kpi-val">{formatRate(snapshot.recommendRate)}</div>
                  <div className="ai-kpi-lbl">推荐投递率</div>
                </div>
                <div className="ai-kpi-item">
                  <div className="ai-kpi-val">{formatRate(snapshot.highScoreRate)}</div>
                  <div className="ai-kpi-lbl">优质高分率</div>
                </div>
                <div className="ai-kpi-item">
                  <div className="ai-kpi-val">{formatRate(snapshot.analysisCoverage)}</div>
                  <div className="ai-kpi-lbl">分析覆盖率</div>
                </div>
              </div>

              {/* 决策分布（提示词四档）与匹配分数分布 */}
              <div className="stats-2col">
                <div>
                  <div className="block-label">决策分布（四档）</div>
                  {snapshot.analyzed === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>尚无 AI 分析结果</Text>
                  ) : (
                    STATS_FIT_LEVEL_META.map((m) => (
                      <HBar
                        key={m.key}
                        label={`${m.label}（${m.scoreRange}）`}
                        hint={m.hint}
                        value={snapshot.fitLevels[m.key] ?? 0}
                        total={snapshot.analyzed || 1}
                        color={m.color}
                      />
                    ))
                  )}
                </div>
                <div>
                  <div className="block-label">匹配分数分布</div>
                  {snapshot.scoreBands.total === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>尚无匹配分数</Text>
                  ) : (
                    <>
                      <HBar label="高（70 及以上）" value={snapshot.scoreBands.high} total={snapshot.scoreBands.total} color="#10B981" />
                      <HBar label="中（40-69）" value={snapshot.scoreBands.mid} total={snapshot.scoreBands.total} color="#F59E0B" />
                      <HBar label="低（40 以下）" value={snapshot.scoreBands.low} total={snapshot.scoreBands.total} color="#EF4444" />
                      <HBar label="未分析" value={snapshot.scoreBands.none} total={snapshot.scoreBands.total} color="#CBD5E1" />
                    </>
                  )}
                </div>
              </div>

              {/* 深度多维评估与特征洞察 */}
              <div className="ai-divider" />

              <div className="ai-deep-grid">
                <div>
                  <div className="ai-section-title">
                    <span>六维契合度均分</span>
                    <Tooltip title="基于 AI 语义评估与本地确定性规则的多维评分均值（0-100分）">
                      <QuestionCircleOutlined style={{ fontSize: 11, cursor: 'pointer' }} />
                    </Tooltip>
                  </div>
                  <div className="ai-dim-list">
                    {STATS_DIMENSION_META.map((dim) => (
                      <DimensionBar
                        key={dim.key}
                        label={dim.label}
                        hint={dim.hint}
                        score={snapshot.dimensionAvg[dim.key]}
                      />
                    ))}
                  </div>
                </div>

                <div className="ai-insight-box">
                  <div>
                    <div className="ai-insight-sub">
                      <CheckCircleFilled style={{ color: '#10B981', fontSize: 11 }} />
                      <span>高频优势亮点</span>
                    </div>
                    <InsightTags
                      items={snapshot.topStrengths.slice(0, 3)}
                      type="strength"
                      emptyText={snapshot.analyzed > 0 ? '未提取到突出技能优势' : '尚无分析数据'}
                    />
                  </div>

                  <div>
                    <div className="ai-insight-sub">
                      <AlertOutlined style={{ color: '#F59E0B', fontSize: 11 }} />
                      <span>关注风险与门槛</span>
                    </div>
                    <InsightTags
                      items={snapshot.topCautions.slice(0, 3)}
                      type="caution"
                      emptyText={snapshot.analyzed > 0 ? '未检出明显风险项' : '尚无风险数据'}
                    />
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* 投递趋势（独占整行：30 日桶需要宽度） */}
          <div className="stats-block">
            <Card
              size="small"
              title="投递趋势"
              extra={
                <Space size={12}>
                  <span className="legend"><i className="legend-dot added" />新增岗位</span>
                  <span className="legend"><i className="legend-dot sent" />已投递</span>
                </Space>
              }
            >
              <TrendChart buckets={snapshot.trend} />
              <p className="stats-note">
                时间范围 {rangeText(snapshot)}；「新增」按岗位加入日期归桶，「已投递」按投递成功时间归桶 ——
                两者依据不同，因此柱子合计与「已投递」卡片可能不相等。
              </p>
            </Card>
          </div>

          {/* 分数趋势 + 投递质量 */}
          <div className="stats-row stats-row--2">
            <Card size="small" title="匹配分数趋势"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>样本 {snapshot.scored} 条</Text>}>
              <ScoreTrend buckets={snapshot.trend} />
            </Card>

            <Card size="small" title="投递质量与目标">
              <div className="quality-grid">
                <div className="quality-item">
                  <div className="quality-label">平均匹配分</div>
                  <div className="quality-value">{formatScore(snapshot.avgScore)}</div>
                  <div className="quality-note">仅统计已有 AI 分数的岗位</div>
                </div>
                <div className="quality-item">
                  <div className="quality-label">投递成功率</div>
                  <div className="quality-value">{formatRate(snapshot.successRate)}</div>
                  <div className="quality-note">已投递 {snapshot.sent} / 失败 {snapshot.failed}</div>
                </div>
              </div>

              <div className="block-label stats-mt stats-label-row">
                <span>今日目标达成</span>
                <Tooltip title="今日目标 = 各已启用平台每日目标合计，可在「设置 → 招聘平台」逐平台调整（上限于平台侧限制与防封号上限）。统计口径为今日投递成功数，与每日投递上限一致">
                  <QuestionCircleOutlined className="stats-help-icon" />
                </Tooltip>
              </div>
              <div className="quality-goal">
                <Progress
                  type="circle"
                  size={72}
                  percent={snapshot.goalPct}
                  strokeColor={{ from: '#13b5ac', to: '#078A83' }}
                />
                <div>
                  <div className="quality-goal-value">
                    {snapshot.todaySent}
                    <span className="quality-goal-target"> / {snapshot.dailyTarget}</span>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>今日已投递 / 每日目标</Text>
                </div>
              </div>
            </Card>
          </div>

          {/* 平台 / 方向交叉视图 */}
          <div className="stats-block">
            <Card
              size="small"
              title="交叉视图"
              extra={
                <Segmented
                  size="small"
                  value={crossBy}
                  onChange={(v) => setCrossBy(v as 'platform' | 'direction')}
                  options={[
                    { label: '按平台', value: 'platform' },
                    { label: '按方向', value: 'direction' },
                  ]}
                />
              }
            >
              <CrossTable rows={crossBy === 'platform' ? snapshot.platformCross : snapshot.directionCross} />
              <p className="stats-note">
                成功率 = 已投递 /（已投递 + 失败）；「待处理」含待确认、待投递、投递中与已打开沟通窗。
                方向按岗位所属任务归类，未关联任务的记为「未归属方向」。
              </p>
            </Card>
          </div>

          {/* Top 榜 + 任务概览 */}
          <div className="stats-row stats-row--3">
            <Card size="small" title="公司 Top">
              <TopList items={snapshot.companyTop} icon={<RocketOutlined />} />
            </Card>
            <Card size="small" title="城市 Top">
              <TopList items={snapshot.cityTop} icon={<EnvironmentOutlined />} />
            </Card>
            <Card size="small" title="任务概览"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {snapshot.taskTotal} 个</Text>}>
              {snapshot.taskTotal === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>尚未创建任务，到「工作台」新建任务</Text>
              ) : (
                <div className="mini-stat-row">
                  {snapshot.runStatus.map((r) => (
                    <div className="mini-stat" key={r.key}>
                      <div className="mini-value">{r.value}</div>
                      <div className="mini-label">{r.label}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="block-label stats-mt">方向 × 关键词 Top</div>
              <TopList items={snapshot.directionTop} icon={<FlagOutlined />} />
            </Card>
          </div>

          {/* 状态汇总 */}
          <div className="stats-block">
            <Card size="small" title="状态汇总"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>口径与上方指标卡一致</Text>}>
              <div className="summary-grid">
                <div className="summary-row"><span>已投递</span><b className="c-success">{snapshot.sent}</b></div>
                <div className="summary-row"><span>失败</span><b className="c-danger">{snapshot.failed}</b></div>
                <div className="summary-row"><span>跳过 / 忽略</span><b>{snapshot.skippedIgnored}</b></div>
                <div className="summary-row"><span>待处理</span><b className="c-info">{snapshot.waiting}</b></div>
                <div className="summary-row"><span>已打开沟通窗</span><b>{snapshot.opened}</b></div>
                <div className="summary-row"><span>不推荐</span><b className="c-warning">{snapshot.rejected}</b></div>
                <div className="summary-row"><span>AI 分析覆盖</span><b className="c-brand">{Math.round(snapshot.analysisCoverage * 100)}%</b></div>
                <div className="summary-row"><span>导出时间范围</span><b className="summary-text">{rangeText(snapshot)}</b></div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
