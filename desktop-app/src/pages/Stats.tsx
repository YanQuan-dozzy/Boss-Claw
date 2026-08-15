import { useMemo } from 'react';
import { Card, Empty, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import {
  BarChartOutlined,
  AimOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleOutlined,
  RocketOutlined,
  StopOutlined,
  TeamOutlined,
  EnvironmentOutlined,
  FlagOutlined,
  RiseOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { selectedDirectionItems } from '@/lib/bossclaw/directions';
import type { Decision, PendingStatus } from '@/lib/bossclaw/types';

const { Text } = Typography;

/* ---------- 口径常量（对齐 recomputeStats / rerankPending） ---------- */

const STATUS_META: { key: PendingStatus; label: string; color: string }[] = [
  { key: 'pending', label: '确认队列', color: '#8c8c8c' },
  { key: 'approved', label: '投递队列', color: '#1677ff' },
  { key: 'approved_queue', label: '投递中', color: '#13c2c2' },
  { key: 'sent', label: '已投递', color: '#52c41a' },
  { key: 'failed', label: '失败', color: '#ff4d4f' },
  { key: 'skipped', label: '已跳过', color: '#bfbfbf' },
  { key: 'ignored', label: '已忽略', color: '#d9d9d9' },
  { key: 'rejected', label: '不推荐', color: '#fa8c16' },
];

const DECISION_META: Record<Decision, { label: string; color: string }> = {
  recommend: { label: '推荐投递', color: '#52c41a' },
  cautious: { label: '谨慎投递', color: '#fa8c16' },
  reject: { label: '不推荐', color: '#ff4d4f' },
};

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const countBy = (items: (string | undefined)[]) => {
  const map = new Map<string, number>();
  items.forEach((v) => {
    if (v) map.set(v, (map.get(v) || 0) + 1);
  });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

/* ---------- 自绘小组件（不引入图表库） ---------- */

function HBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="hbar">
      <div className="hbar-head">
        <span className="hbar-label">{label}</span>
        <span className="hbar-value">
          {value} <span className="hbar-pct">{pct}%</span>
        </span>
      </div>
      <div className="hbar-track">
        <Tooltip title={`${label}：${value} 个（${pct}%）`}>
          <div className="hbar-fill" style={{ width: `${pct}%`, background: color }} />
        </Tooltip>
      </div>
    </div>
  );
}

function TopList({ items, icon }: { items: [string, number][]; icon: React.ReactNode }) {
  if (items.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>暂无数据</Text>;
  const max = items[0][1] || 1;
  return (
    <div className="top-list">
      {items.map(([name, n]) => (
        <div className="top-item" key={name}>
          <span className="top-rank">{icon}</span>
          <span className="top-name" title={name}>{name}</span>
          <span className="top-count">{n}</span>
          <span className="top-track"><span className="top-fill" style={{ width: `${Math.round((n / max) * 100)}%` }} /></span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ days }: { days: { label: string; added: number; sent: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.added), ...days.map((d) => d.sent));
  return (
    <div className="trend">
      {days.map((d) => (
        <div className="trend-col" key={d.label}>
          <div className="trend-bars">
            <Tooltip title={`加入 ${d.added} 个`}>
              <div className="trend-bar added" style={{ height: `${Math.max(2, Math.round((d.added / max) * 100))}%` }} />
            </Tooltip>
            <Tooltip title={`已投递 ${d.sent} 个`}>
              <div className="trend-bar sent" style={{ height: `${Math.max(2, Math.round((d.sent / max) * 100))}%` }} />
            </Tooltip>
          </div>
          <div className="trend-label">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- 页面 ---------- */

export default function Stats() {
  const pending = useDataStore((s) => s.pending);
  const taskRuns = useDataStore((s) => s.taskRuns);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const dailyTarget = useSettingsStore((s) => s.config.dailyTarget);

  const agg = useMemo(() => {
    const byStatus = (s: PendingStatus) => pending.filter((p) => p.status === s).length;
    const total = pending.length;

    const decisions: Record<Decision, number> = { recommend: 0, cautious: 0, reject: 0 };
    const scoreBands = { high: 0, mid: 0, low: 0, none: 0 };
    let analyzed = 0;
    pending.forEach((p) => {
      const a = p.analysis;
      if (a?.decision) decisions[a.decision] += 1;
      if (a) {
        analyzed += 1;
        const s = a.score ?? -1;
        if (s >= 70) scoreBands.high += 1;
        else if (s >= 40) scoreBands.mid += 1;
        else scoreBands.low += 1;
      } else {
        scoreBands.none += 1;
      }
    });

    const sent = byStatus('sent');
    const failed = byStatus('failed');
    const skippedIgnored = byStatus('skipped') + byStatus('ignored');
    const waiting = byStatus('pending') + byStatus('approved') + byStatus('approved_queue');

    const companyTop = countBy(pending.map((p) => p.job?.company)).slice(0, 8);
    const cityTop = countBy(pending.map((p) => p.job?.location)).slice(0, 8);
    const directionTop = countBy(taskRuns.map((r) => r.directionName)).slice(0, 8);

    const runStatus: Record<string, number> = {};
    taskRuns.forEach((r) => { runStatus[r.status] = (runStatus[r.status] || 0) + 1; });

    // 近 7 日趋势（按记录创建日期）
    const days: { label: string; added: number; sent: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d);
      const added = pending.filter((p) => dayKey(new Date(p.createdAt)) === key).length;
      const s = pending.filter((p) => p.status === 'sent' && dayKey(new Date(p.createdAt)) === key).length;
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, added, sent: s });
    }

    return {
      total, sent, failed, skippedIgnored, waiting,
      decisions, scoreBands, analyzed,
      companyTop, cityTop, directionTop, runStatus, days,
    };
  }, [pending, taskRuns]);

  const directionCount = selectedDirectionItems(directionPlan).length;
  const decisionTotal = agg.decisions.recommend + agg.decisions.cautious + agg.decisions.reject;
  const scoreTotal = agg.scoreBands.high + agg.scoreBands.mid + agg.scoreBands.low + agg.scoreBands.none;
  const target = Math.max(1, dailyTarget || 150);
  const goalPct = Math.min(100, Math.round((agg.sent / target) * 100));

  const overviewCards = [
    { icon: <TeamOutlined />, cls: 'teal', title: '岗位总数', value: agg.total, note: '全部已记录岗位' },
    { icon: <CheckCircleFilled />, cls: 'green', title: '已投递', value: agg.sent, note: '投递成功' },
    { icon: <ClockCircleOutlined />, cls: 'blue', title: '待处理', value: agg.waiting, note: '确认队列 + 投递队列 + 投递中' },
    { icon: <CloseCircleFilled />, cls: 'red', title: '失败', value: agg.failed, note: '可重试 / 忽略' },
    { icon: <StopOutlined />, cls: 'orange', title: '跳过 / 忽略', value: agg.skippedIgnored, note: '未投递' },
    { icon: <AimOutlined />, cls: 'purple', title: '已确认方向', value: directionCount, note: '投递方向模板' },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <BarChartOutlined className="page-title-icon" />数据统计
          </h1>
          <p className="page-sub">
            基于本地任务与岗位记录实时聚合，无需联网。口径与「任务进度」一致：已投递 / 失败 / 待处理 / 跳过忽略等按岗位状态统计。
          </p>
        </div>
        <div className="page-head-extra">
          <Tag icon={<RiseOutlined />} color="processing" style={{ borderRadius: 999 }}>
            AI 分析 {agg.analyzed} / {agg.total}
          </Tag>
        </div>
      </div>

      {agg.total === 0 && taskRuns.length === 0 ? (
        <Card>
          <Empty description="暂无统计数据。到「工作台」加入岗位或新建任务后，这里会展示完整统计。" />
        </Card>
      ) : (
        <>
          {/* 总览指标卡 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 20 }}>
            {overviewCards.map((c) => (
              <div className="stat-card" key={c.title}>
                <div className={'stat-icon ' + c.cls}>{c.icon}</div>
                <div className="stat-body">
                  <div className="stat-title">{c.title}</div>
                  <div className="stat-value">{c.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{c.note}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 20, marginBottom: 20 }}>
            {/* 岗位状态分布 */}
            <Card size="small" title="岗位状态分布" className="mb-16"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {agg.total} 条记录</Text>}>
              {STATUS_META.map((m) => (
                <HBar key={m.key} label={m.label} value={pending.filter((p) => p.status === m.key).length} total={agg.total} color={m.color} />
              ))}
            </Card>

            {/* AI 匹配分析 */}
            <Card size="small" title="AI 匹配分析" className="mb-16">
              <div className="stats-2col">
                <div>
                  <div className="block-label">决策分布</div>
                  {decisionTotal === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>尚无 AI 分析结果</Text>
                  ) : (
                    (Object.keys(DECISION_META) as Decision[]).map((k) => (
                      <HBar key={k} label={DECISION_META[k].label} value={agg.decisions[k]} total={decisionTotal} color={DECISION_META[k].color} />
                    ))
                  )}
                </div>
                <div>
                  <div className="block-label">匹配分数分布</div>
                  {scoreTotal === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>尚无匹配分数</Text>
                  ) : (
                    <>
                      <HBar label="高（≥70）" value={agg.scoreBands.high} total={scoreTotal} color="#52c41a" />
                      <HBar label="中（40-69）" value={agg.scoreBands.mid} total={scoreTotal} color="#fa8c16" />
                      <HBar label="低（&lt;40）" value={agg.scoreBands.low} total={scoreTotal} color="#ff4d4f" />
                      <HBar label="未分析" value={agg.scoreBands.none} total={scoreTotal} color="#d9d9d9" />
                    </>
                  )}
                </div>
              </div>

              {/* 今日目标达成 */}
              <div className="block-label mt-12" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                今日目标达成
                <Tooltip title="目标值可在「设置 → 投递」中调整 dailyTarget">
                  <QuestionCircleOutlined style={{ fontSize: 12, color: 'var(--fg-muted)' }} />
                </Tooltip>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Progress type="circle" size={72} percent={goalPct} strokeColor={{ from: '#13b5ac', to: '#078A83' }} />
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{agg.sent}<span style={{ fontSize: 13, fontWeight: 400, color: 'var(--fg-muted)' }}> / {target}</span></div>
                  <Text type="secondary" style={{ fontSize: 12 }}>累计已投递 / 目标</Text>
                </div>
              </div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 20, marginBottom: 20 }}>
            {/* 近 7 日趋势 */}
            <Card size="small" title="近 7 日趋势" className="mb-16"
              extra={
                <Space size={12}>
                  <span className="legend"><i className="legend-dot added" />新增岗位</span>
                  <span className="legend"><i className="legend-dot sent" />已投递</span>
                </Space>
              }>
              <TrendChart days={agg.days} />
              <Text type="secondary" style={{ fontSize: 11 }}>按岗位记录创建日期统计；已投递按同一加入日期归类。</Text>
            </Card>

            {/* 任务概览 */}
            <Card size="small" title="任务概览" className="mb-16"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {taskRuns.length} 个任务</Text>}>
              {taskRuns.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>尚未创建任务，到「工作台」新建任务</Text>
              ) : (
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {Object.entries(agg.runStatus).map(([k, n]) => (
                    <div className="mini-stat" key={k}>
                      <div className="mini-value">{n}</div>
                      <div className="mini-label">{k}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="block-label mt-12">方向 × 关键词 Top</div>
              <TopList items={agg.directionTop} icon={<FlagOutlined />} />
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 20 }}>
            <Card size="small" title="公司 Top">
              <TopList items={agg.companyTop} icon={<RocketOutlined />} />
            </Card>
            <Card size="small" title="城市 Top">
              <TopList items={agg.cityTop} icon={<EnvironmentOutlined />} />
            </Card>
            <Card size="small" title="状态汇总">
              <div className="summary-grid">
                <div className="summary-row"><span>已投递</span><b style={{ color: '#52c41a' }}>{agg.sent}</b></div>
                <div className="summary-row"><span>失败</span><b style={{ color: '#ff4d4f' }}>{agg.failed}</b></div>
                <div className="summary-row"><span>跳过 / 忽略</span><b>{agg.skippedIgnored}</b></div>
                <div className="summary-row"><span>待处理</span><b style={{ color: '#1677ff' }}>{agg.waiting}</b></div>
                <div className="summary-row"><span>不推荐</span><b style={{ color: '#fa8c16' }}>{pending.filter((p) => p.status === 'rejected').length}</b></div>
                <div className="summary-row"><span>AI 分析</span><b style={{ color: 'var(--brand)' }}>{agg.analyzed}</b></div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
