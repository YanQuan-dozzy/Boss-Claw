import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, Progress, Segmented, Space, Tag, Typography, message } from 'antd';
import {
  ReloadOutlined,
  EyeOutlined,
  StopOutlined,
  RocketOutlined,
  ProfileOutlined,
  ForwardOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useAppStore } from '@/store/useAppStore';
import { rerankPending } from '@/lib/bossclaw/priority';
import { taskStageMeta } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import { formatMetaLine, cleanTitle } from '@/lib/bossclaw/jobDisplay';
import { EmptyState } from '@/components/feedback';
import type { PendingItem, PendingStatus, TaskRun } from '@/lib/bossclaw/types';

const { Text } = Typography;

const STATUS_COLOR: Record<string, { color: string; label: string }> = {
  approved: { color: 'blue', label: '投递队列' },
  approved_queue: { color: 'cyan', label: '投递中' },
  pending: { color: 'gold', label: '确认队列' },
  failed: { color: 'red', label: '失败' },
  sent: { color: 'green', label: '已投递' },
  skipped: { color: 'default', label: '已跳过' },
  rejected: { color: 'orange', label: '不推荐' },
  ignored: { color: 'default', label: '已忽略' },
  running: { color: 'blue', label: '执行中' },
  success: { color: 'green', label: '成功' },
  waiting_review: { color: 'orange', label: '待复核' },
  queued: { color: 'cyan', label: '排队中' },
};

const FILTERS: { label: string; value: 'all' | PendingStatus }[] = [
  { label: '全部', value: 'all' },
  { label: '确认队列', value: 'pending' },
  { label: '投递中', value: 'approved_queue' },
  { label: '已投递', value: 'sent' },
  { label: '失败', value: 'failed' },
  { label: '已忽略', value: 'ignored' },
];

export default function Tasks() {
  const pending = useDataStore((s) => s.pending);
  const taskRuns = useDataStore((s) => s.taskRuns);
  const updatePending = useDataStore((s) => s.updatePending);
  const setPending = useDataStore((s) => s.setPending);
  const addLog = useDataStore((s) => s.addLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const setRoute = useAppStore((s) => s.setRoute);
  const [filter, setFilter] = useState<'all' | PendingStatus>('all');
  const [showIgnored, setShowIgnored] = useState(false);

  const isHiddenStatus = (status: PendingStatus) => status === 'ignored' || status === 'skipped';

  const list = useMemo(
    () =>
      rerankPending(pending).filter((p) => {
        if (filter !== 'all') return p.status === filter;
        return showIgnored || !isHiddenStatus(p.status);
      }),
    [pending, filter, showIgnored]
  );

  const counts = useMemo(() => {
    return {
      all: pending.length,
      pending: pending.filter((p) => p.status === 'pending').length,
      approved_queue: pending.filter((p) => p.status === 'approved_queue').length,
      sent: pending.filter((p) => p.status === 'sent').length,
      failed: pending.filter((p) => p.status === 'failed').length,
      ignored: pending.filter((p) => ['skipped', 'ignored'].includes(p.status)).length,
    };
  }, [pending]);

  const onRetry = (id: string) => {
    updatePending(id, { status: 'pending', retryCount: (pending.find((p) => p.id === id)?.retryCount || 0) + 1, error: '' });
    addLog('info', '已重置岗位，可重新分析/投递');
    recomputeStats();
  };
  const onIgnore = (id: string) => { updatePending(id, { status: 'ignored' }); recomputeStats(); };
  const onSkip = (id: string) => { updatePending(id, { status: 'skipped' }); recomputeStats(); };
  const onApprove = (id: string) => {
    const next = rerankPending(pending.map((p) => p.id === id ? { ...p, status: 'approved' as const, approvedAt: p.approvedAt || Date.now() } : p));
    setPending(next); message.success('已加入投递队列（等待一键投递）'); recomputeStats();
  };

  const taskStatusMeta = (t: TaskRun) => {
    if (t.status === 'success') return { label: '已完成', color: 'green' };
    if (t.status === 'failed') return { label: '失败', color: 'red' };
    if (t.status === 'skipped' || t.status === 'ignored') return { label: t.status, color: 'default' };
    return { label: t.stageLabel || '进行中', color: 'blue' };
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <ProfileOutlined className="page-title-icon" />任务进度
          </h1>
          <p className="page-sub">按「投递方向」模板管理任务执行进度；岗位记录支持重试、跳过、忽略与批准投递。</p>
        </div>
        <div className="page-head-extra">
          <Button type="primary" className="btn-uniform" icon={<RocketOutlined />} onClick={() => setRoute('workbench')}>去工作台</Button>
        </div>
      </div>

      {/* 任务列表卡片 */}
      <Card
        size="small"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ProfileOutlined style={{ color: 'var(--brand)' }} />
            <span>执行任务列表</span>
          </div>
        }
        className="mb-16"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>基于已确认的投递方向生成</Text>}
      >
        {taskRuns.length === 0 ? (
          <EmptyState
            title="尚未创建任务"
            description="到「工作台」点击「新建任务」（基于已确认的投递方向）"
            action={<Button type="primary" icon={<RocketOutlined />} onClick={() => setRoute('workbench')}>去工作台</Button>}
          />
        ) : (
          <div>
            {taskRuns.map((t) => {
              const meta = taskStatusMeta(t);
              return (
                <div key={t.id} className="task-row">
                  <div style={{ minWidth: 220 }}>
                    <Text strong style={{ fontSize: 14 }}>{t.directionName}</Text>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                      关键词：{t.keyword}{t.location ? ` · 城市：${t.location}` : ''}
                    </Text>
                  </div>
                  <div style={{ flex: 1, maxWidth: 320 }}>
                    <Progress
                      percent={Math.round(t.progress || 0)}
                      size="small"
                      strokeColor={{ from: '#14b8a6', to: '#0d9488' }}
                    />
                  </div>
                  <Tag color={meta.color} style={{ margin: 0, padding: '2px 10px', borderRadius: 999 }}>{meta.label}</Tag>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 岗位筛选工具栏 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <Space size={12}>
            <FilterOutlined style={{ color: 'var(--brand)' }} />
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as any)}
              options={FILTERS.map((f) => {
                const cnt = f.value === 'all' ? counts.all : counts[f.value as keyof typeof counts] ?? 0;
                return {
                  label: (
                    <span>
                      {f.label} <span style={{ opacity: 0.65, fontSize: 11 }}>({cnt})</span>
                    </span>
                  ),
                  value: f.value,
                };
              })}
            />
          </Space>
          <Space size={14}>
            <Checkbox checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)}>
              显示已忽略 / 已跳过
            </Checkbox>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前显示 <Text strong>{list.length}</Text> / {pending.length} 个岗位
            </Text>
          </Space>
        </div>
      </Card>

      {/* 岗位记录列表 */}
      {list.length === 0 ? (
        <Card>
          <EmptyState
            title="暂无岗位记录"
            description={
              pending.length === 0
                ? '请到「工作台」采集岗位或手动加入任务'
                : '当前筛选条件下没有匹配记录，可调整筛选或勾选「显示已忽略/已跳过」'
            }
          />
        </Card>
      ) : (
        list.map((p: PendingItem) => {
          const meta = taskStageMeta((p.status === 'approved_queue' ? 'queued' : 'waiting_review') as any);
          const st = STATUS_COLOR[p.status] || { color: 'default', label: p.status };
          const chip = scoreChip(p.analysis?.score);
          return (
            <div key={p.id} className={'job-card job-card--tasks ' + jobCardStatus(p)}>
              <div className="job-top">
                <div style={{ minWidth: 0 }}>
                  <div className="job-title" style={{ fontSize: 15, fontWeight: 600 }}>
                    {cleanTitle(p.job?.title, p.job?.salary)}
                  </div>
                  <div className="job-company" style={{ fontSize: 13, marginTop: 2 }}>
                    {formatMetaLine(p.job?.company, p.job?.location, p.job?.salary, p.job?.url)}
                  </div>
                </div>
                <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto', padding: '2px 10px', fontSize: 12, borderRadius: 4 }}>
                  {st.label}
                </Tag>
              </div>

              <div className="job-meta">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {p.analysis && (
                    <>
                      {chip.cls && <span className={'score-chip ' + chip.cls}>AI {chip.text} 分</span>}
                      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                        匹配决策：<Text strong>{p.analysis.decision}</Text>
                        {p.analysis.hardBlocks?.length ? ` · 拦截硬条件 ${p.analysis.hardBlocks.length} 项` : ''}
                        {p.analysis.gaps?.length ? ` · 存在缺口 ${p.analysis.gaps.length} 项` : ''}
                      </span>
                    </>
                  )}
                </div>
                <Progress percent={meta.progress} size="small" style={{ width: 150, margin: 0 }} />
              </div>

              {p.error && <div className="job-error">⚠ {p.error}</div>}

              <div className="job-actions job-actions--tasks">
                <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && window.open(p.job.url)}>
                  查看详情
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(p.id)}>
                  重试
                </Button>
                <Button size="small" type="text" icon={<StopOutlined />} onClick={() => onIgnore(p.id)}>
                  忽略
                </Button>
                <Button size="small" type="text" icon={<ForwardOutlined />} onClick={() => onSkip(p.id)}>
                  跳过
                </Button>
                <span className="action-spacer" />
                <Button size="small" type="primary" icon={<RocketOutlined />} onClick={() => onApprove(p.id)}>
                  批准投递
                </Button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
