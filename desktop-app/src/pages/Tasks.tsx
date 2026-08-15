import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, Empty, Progress, Select, Space, Tag, Typography, message } from 'antd';
import { ReloadOutlined, EyeOutlined, StopOutlined, RocketOutlined, ProfileOutlined, ForwardOutlined } from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useAppStore } from '@/store/useAppStore';
import { rerankPending } from '@/lib/bossclaw/priority';
import { taskStageMeta } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import { formatMetaLine, cleanTitle } from '@/lib/bossclaw/jobDisplay';
import type { PendingItem, PendingStatus, TaskRun } from '@/lib/bossclaw/types';

const { Text } = Typography;

const STATUS_COLOR: Record<string, { color: string; label: string }> = {
  approved: { color: 'blue', label: '投递队列' },
  approved_queue: { color: 'cyan', label: '投递中' },
  pending: { color: 'default', label: '确认队列' },
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
  { label: '失败', value: 'failed' },
  { label: '已投递', value: 'sent' },
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
        // 默认「全部」隐藏已忽略/已跳过，可通过开关显示
        return showIgnored || !isHiddenStatus(p.status);
      }),
    [pending, filter, showIgnored]
  );

  const onRetry = (id: string) => {
    updatePending(id, { status: 'pending', retryCount: (pending.find((p) => p.id === id)?.retryCount || 0) + 1, error: '' });
    addLog('info', '已重置岗位，可重新分析/投递');
    recomputeStats();
  };
  const onIgnore = (id: string) => { updatePending(id, { status: 'ignored' }); recomputeStats(); };
  const onSkip = (id: string) => { updatePending(id, { status: 'skipped' }); recomputeStats(); };
  const onApprove = (id: string) => {
    // 批准：只进入「投递队列·等待」(approved)，不自动投递；真正投递由「一键投递」触发。
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
          <p className="page-sub">任务列表按「投递方向」模板生成；单条岗位记录支持重试 / 忽略 / 跳过 / 批准投递。</p>
        </div>
        <div className="page-head-extra">
          <Button type="primary" icon={<RocketOutlined />} onClick={() => setRoute('workbench')}>去工作台</Button>
        </div>
      </div>

      <Card size="small" title="任务列表" className="mb-16"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>按投递方向模板生成</Text>}>
        {taskRuns.length === 0 ? (
          <Empty description="尚未创建任务。到「工作台」点击「新建任务」（基于已确认的投递方向）" />
        ) : (
          <div>
            {taskRuns.map((t) => {
              const meta = taskStatusMeta(t);
              return (
                <div key={t.id} className="task-row">
                  <div style={{ minWidth: 200 }}>
                    <Text strong>{t.directionName}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}> · {t.keyword}{t.location ? ` · ${t.location}` : ''}</Text>
                  </div>
                  <div style={{ flex: 1, maxWidth: 280 }}>
                    <Progress percent={Math.round(t.progress || 0)} size="small"
                      strokeColor={{ from: '#13b5ac', to: '#078A83' }} />
                  </div>
                  <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="stat-strip">
        <div className="ss-item">
          <span className="ss-label">全部岗位</span>
          <span className="ss-value">{pending.length}</span>
        </div>
        <div className="ss-item">
          <span className="ss-label">确认队列</span>
          <span className="ss-value em-warn">{pending.filter((p) => p.status === 'pending').length}</span>
        </div>
        <div className="ss-item">
          <span className="ss-label">投递中</span>
          <span className="ss-value em-brand">{pending.filter((p) => p.status === 'approved_queue').length}</span>
        </div>
        <div className="ss-item">
          <span className="ss-label">已投递</span>
          <span className="ss-value">{pending.filter((p) => p.status === 'sent').length}</span>
        </div>
        <div className="ss-item">
          <span className="ss-label">失败</span>
          <span className="ss-value em-danger">{pending.filter((p) => p.status === 'failed').length}</span>
        </div>
        <div className="ss-item">
          <span className="ss-label">已跳过 / 忽略</span>
          <span className="ss-value">{pending.filter((p) => ['skipped', 'ignored'].includes(p.status)).length}</span>
        </div>
      </div>

      <Space className="mb-12" style={{ marginBottom: 12 }}>
        <Select value={filter} onChange={setFilter} style={{ width: 160 }} options={FILTERS.map((f) => ({ label: f.label, value: f.value }))} />
        <Checkbox checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)}>
          显示已忽略 / 已跳过
        </Checkbox>
        <Text type="secondary">共 {pending.length} 个岗位记录</Text>
      </Space>

      {list.length === 0 ? (
        <Card><Empty description="暂无岗位记录" /></Card>
      ) : (
        list.map((p: PendingItem) => {
          const meta = taskStageMeta((p.status === 'approved_queue' ? 'queued' : 'waiting_review') as any);
          const st = STATUS_COLOR[p.status] || { color: 'default', label: p.status };
          const chip = scoreChip(p.analysis?.score);
          return (
            <div key={p.id} className={'job-card ' + jobCardStatus(p)}>
              <div className="job-top">
                <div style={{ minWidth: 0 }}>
                  <div className="job-title">{cleanTitle(p.job?.title, p.job?.salary)}</div>
                  <div className="job-company">{formatMetaLine(p.job?.company, p.job?.location, p.job?.salary, p.job?.url)}</div>
                </div>
                <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto' }}>{st.label}</Tag>
              </div>
              <div className="job-meta">
                {p.analysis && (
                  <>
                    {chip.cls && <span className={'score-chip ' + chip.cls}>AI {chip.text} 分</span>}
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                      {p.analysis.decision}
                      {p.analysis.hardBlocks?.length ? ` · 硬条件拦截 ${p.analysis.hardBlocks.length}` : ''}
                      {p.analysis.gaps?.length ? ` · 缺口 ${p.analysis.gaps.length}` : ''}
                    </span>
                  </>
                )}
                <Progress percent={meta.progress} size="small" style={{ width: 140, margin: 0 }} />
              </div>
              {p.error && <div className="job-error">⚠ {p.error}</div>}
              <div className="job-actions job-actions--tasks">
                <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && window.open(p.job.url)}>查看</Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(p.id)}>重试</Button>
                <Button size="small" type="text" icon={<StopOutlined />} onClick={() => onIgnore(p.id)}>忽略</Button>
                <Button size="small" type="text" icon={<ForwardOutlined />} onClick={() => onSkip(p.id)}>跳过</Button>
                <span className="action-spacer" />
                <Button size="small" type="primary" icon={<RocketOutlined />} onClick={() => onApprove(p.id)}>批准投递</Button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
