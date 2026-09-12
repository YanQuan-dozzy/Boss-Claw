import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, Popconfirm, Progress, Segmented, Space, Tag, Tooltip, Typography, message } from 'antd';
import {
  ReloadOutlined,
  EyeOutlined,
  StopOutlined,
  RocketOutlined,
  ProfileOutlined,
  ForwardOutlined,
  FilterOutlined,
  CaretRightOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { taskStageMetaFor } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import PlatformChip from '@/components/PlatformChip';
import { formatMetaLine, cleanTitle, cleanSalary } from '@/lib/bossclaw/jobDisplay';
import { parseSalaryRange } from '@/lib/bossclaw/jobMatch';
import { detectWorkSchedule, scheduleBasisText } from '@/lib/bossclaw/workSchedule';
import { EmptyState } from '@/components/feedback';
import { electronApi } from '@/lib/electronApi';
import type { JobPlatform, PendingItem, PendingStatus, TaskRun } from '@/lib/bossclaw/types';

const { Text } = Typography;

const STATUS_COLOR: Record<string, { color: string; label: string }> = {
  approved: { color: 'blue', label: '待投递' },
  approved_queue: { color: 'cyan', label: '投递中' },
  pending: { color: 'gold', label: '待确认' },
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
  { label: '待确认', value: 'pending' },
  { label: '待投递', value: 'approved' },
  { label: '投递中', value: 'approved_queue' },
  { label: '已投递', value: 'sent' },
  { label: '失败', value: 'failed' },
  { label: '已忽略', value: 'ignored' },
];

export default function Tasks() {
  const pending = useDataStore((s) => s.pending);
  const taskRuns = useDataStore((s) => s.taskRuns);
  const profile = useDataStore((s) => s.profile);
  const updatePending = useDataStore((s) => s.updatePending);
  const setPending = useDataStore((s) => s.setPending);
  const updateTaskRun = useDataStore((s) => s.updateTaskRun);
  const removeTaskRun = useDataStore((s) => s.removeTaskRun);
  const addLog = useDataStore((s) => s.addLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const setRoute = useAppStore((s) => s.setRoute);
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  // 平台配置（含优先级）订阅：平台顺序变化时任务列表随设置实时重排
  const config = useSettingsStore((s) => s.config);
  const [filter, setFilter] = useState<'all' | PendingStatus>('all');
  const [showIgnored, setShowIgnored] = useState(false);

  const isHiddenStatus = (status: PendingStatus) => status === 'ignored' || status === 'skipped';

  const list = useMemo(
    () =>
      rerankPending(pending, config).filter((p) => {
        if (filter !== 'all') return p.status === filter;
        return showIgnored || !isHiddenStatus(p.status);
      }),
    [pending, config, filter, showIgnored]
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
    const next = rerankPending(pending.map((p) => p.id === id ? { ...p, status: 'approved' as const, approvedAt: p.approvedAt || Date.now() } : p), useSettingsStore.getState().config);
    setPending(next); message.success('已确认岗位，等待「一键投递」'); recomputeStats();
  };

  // ===== 执行任务列表：开始/继续 + 删除 =====
  // 采集任务 id 形如 cr_<platform>_<keyword>_<location>_<employmentType>（平台名不含下划线）
  const isCollectRun = (t: TaskRun) => String(t.id || '').startsWith('cr_');
  const runPlatform = (t: TaskRun): JobPlatform => {
    const p = String(t.id || '').split('_')[1] as JobPlatform;
    return (['boss', 'liepin', 'zhaopin', 'job51'] as JobPlatform[]).includes(p) ? p : 'boss';
  };
  /** 是否已跑过：决定按钮文案显示「开始」还是「继续」 */
  const everStarted = (t: TaskRun) =>
    t.status !== 'pending' || Boolean(t.processed || t.discovered || t.attempts);
  const isTaskBusy = (t: TaskRun) => t.status === 'running' || t.status === 'queued';
  const taskLabelOf = (t: TaskRun) =>
    `${t.directionName || (isCollectRun(t) ? '搜索采集' : '投递任务')}${t.keyword ? ` · ${t.keyword}` : ''}`;

  const onStartTask = (t: TaskRun) => {
    if (isTaskBusy(t)) { message.info('该任务正在执行中'); return; }
    if (isCollectRun(t)) {
      // 采集任务：把卡片置回队列并请求常驻工作台定向重跑该搜索组合（不跑整批）
      const platform = runPlatform(t);
      updateTaskRun(t.id, {
        status: 'queued',
        stage: 'queued',
        stageLabel: '已加入采集队列',
        error: '',
        attempts: (t.attempts || 0) + 1,
        updatedAt: Date.now(),
      });
      useScheduleStore.getState().setCollectRequest({ platforms: [platform], runIds: [t.id] });
      addLog('info', `已请求重新采集：${t.keyword} · ${t.location || '全国'} · ${t.employmentType || '不限'}`);
      message.success('已开始采集该搜索组合');
      setRoute('workbench');
      return;
    }
    // 投递任务：提升「待投递」岗位进投递队列并启动引擎（与首页「开始投递」同一入口）
    const { next, count } = promoteApprovedToQueue(useDataStore.getState().pending, config);
    if (count) setPending(next);
    updateTaskRun(t.id, {
      status: 'running',
      stageLabel: count ? `投递中（队列 ${count} 个岗位）` : '等待岗位入库',
      error: '',
      attempts: (t.attempts || 0) + 1,
      updatedAt: Date.now(),
    });
    if (!useAppStore.getState().autoAssist) setAutoAssist(true);
    addLog('info', `已启动投递引擎（待投递 ${count} 个岗位）`);
    message.success(count ? `已开始投递（${count} 个岗位）` : '已启动投递引擎，等待岗位入库');
    setRoute('workbench');
  };

  const onDeleteTask = (t: TaskRun) => {
    if (t.status === 'running') {
      message.warning('该任务正在执行中，请先在工作台停止采集后再删除');
      return;
    }
    removeTaskRun(t.id);
    addLog('warn', `已删除任务：${taskLabelOf(t)}`);
    message.success('已删除任务');
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
        extra={<Text type="secondary" style={{ fontSize: 12 }}>采集任务自动生成 · 投递任务基于已确认的投递方向</Text>}
      >
        {taskRuns.length === 0 ? (
          <EmptyState
            title="尚未创建任务"
            description="到「工作台」点「搜索采集」（自动按每个搜索组合生成采集任务）或「新建任务」（基于已确认的投递方向）"
            action={<Button type="primary" icon={<RocketOutlined />} onClick={() => setRoute('workbench')}>去工作台</Button>}
          />
        ) : (
          <div className="task-list-scrollable">
            {taskRuns.map((t) => {
              const meta = taskStatusMeta(t);
              const isCollectTask = String(t.id || '').startsWith('cr_');
              return (
                <div key={t.id} className="task-row">
                  <div style={{ minWidth: 220 }}>
                    <Text strong style={{ fontSize: 14 }}>{t.directionName || (isCollectTask ? '搜索采集' : '投递任务')}</Text>
                    <Tag
                      color={isCollectTask ? 'geekblue' : 'default'}
                      style={{ marginLeft: 6, margin: 0, transform: 'translateY(-1px)' }}
                    >
                      {isCollectTask ? '采集任务' : '投递任务'}
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                      关键词：{t.keyword}{t.location ? ` · 城市：${t.location}` : ''}
                    </Text>
                    {t.error ? (
                      <Text type="danger" style={{ fontSize: 12, display: 'block' }}>⚠ {t.error}</Text>
                    ) : null}
                  </div>
                  <div style={{ flex: 1, maxWidth: 320 }}>
                    <Progress
                      percent={Math.round(t.progress || 0)}
                      size="small"
                      strokeColor={{ from: '#14b8a6', to: '#0d9488' }}
                    />
                    {t.stageLabel ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>{t.stageLabel}</Text>
                    ) : null}
                  </div>
                  <div className="task-row-actions">
                    <Tag color={meta.color} style={{ margin: 0, padding: '2px 10px', borderRadius: 999 }}>{meta.label}</Tag>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<CaretRightOutlined />}
                      className="btn-uniform"
                      disabled={isTaskBusy(t)}
                      onClick={() => onStartTask(t)}
                    >
                      {everStarted(t) ? '继续' : '开始'}
                    </Button>
                    <Popconfirm
                      title={`删除任务「${taskLabelOf(t)}」？`}
                      description="仅移除这条任务记录，不影响已采集的岗位与投递进度。"
                      okText="确认删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => onDeleteTask(t)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} className="btn-uniform">删除</Button>
                    </Popconfirm>
                  </div>
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
          const meta = taskStageMetaFor(p.job?.platform, (p.status === 'approved_queue' ? 'queued' : 'waiting_review') as any);
          const st = STATUS_COLOR[p.status] || { color: 'default', label: p.status };
          const chip = scoreChip(p.analysis?.score);
          // 评分来源口径（对齐 JobAssistant 的「AI 分 / 本地分」）：AI 计算优先，
          // 仅当分析明确标记 scoreSource='local'（AI 未参与）时才提示「本地确定性计算」。
          const scoreIsLocal = p.analysis?.scoreSource === 'local';
          const sourceNote = scoreIsLocal
            ? '本地确定性计算 · AI 未参与'
            : `AI 计算优先 · 综合 ${p.analysis?.score ?? '-'} 分`;
          // 薪资具体数据：cleanSalary 已还原平台字体混淆（BOSS 直聘 PUA 数字），可直接展示
          const salaryText = cleanSalary(p.job?.salary);
          // 工作制度（双休/大小周/单休/每周 N 天/月休 N 天）：决定日薪折算月薪的工作日基数
          const schedule = detectWorkSchedule(p.job);
          const jdSalary = salaryText ? parseSalaryRange(salaryText, schedule.monthlyWorkDays) : null;
          const monthlyHint = jdSalary?.valid && (jdSalary.daily || jdSalary.hourly)
            ? ` · ≈${jdSalary.low.toFixed(1)}-${jdSalary.high.toFixed(1)}K/月（${scheduleBasisText(schedule)}）`
            : '';
          const scheduleHint = schedule.detected ? ` · 工作制度：${schedule.label}（${schedule.weeklyDays} 天/周）` : '';
          const expectedSalary = String(profile?.hardConstraints?.salary || '').trim() || '不限';
          return (
            <div key={p.id} className={'job-card job-card--tasks ' + jobCardStatus(p)}>
              <div className="job-top">
                <div style={{ minWidth: 0 }}>
                  <div className="job-title" style={{ fontSize: 15, fontWeight: 600 }}>
                    <PlatformChip platform={p.job?.platform} />
                    {cleanTitle(p.job?.title, p.job?.salary)}
                    {salaryText && <span className="job-salary-tag">{salaryText}</span>}
                  </div>
                  <div className="job-company" style={{ fontSize: 13, marginTop: 2 }}>
                    {formatMetaLine(p.job?.company, p.job?.location, null, p.job?.url)}
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
                      {chip.cls && (
                        <Tooltip title={sourceNote}>
                          <span className={'score-chip ' + chip.cls}>{scoreIsLocal ? '本地' : 'AI'} {chip.text} 分</span>
                        </Tooltip>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                        匹配决策：<Text strong>{p.analysis.decision}</Text>
                        {p.analysis.hardBlocks?.length ? (
                          <Tooltip
                            title={
                              <div style={{ maxWidth: 360, fontSize: 12 }}>
                                {p.analysis.hardBlocks.map((b, i) => (
                                  <div key={i}>· {b}</div>
                                ))}
                              </div>
                            }
                          >
                            <span style={{ color: 'var(--danger, #f5222d)', cursor: 'help' }}> · 拦截硬条件 {p.analysis.hardBlocks.length} 项</span>
                          </Tooltip>
                        ) : null}
                        {p.analysis.gaps?.length ? <span> · 存在缺口 {p.analysis.gaps.length} 项</span> : null}
                      </span>
                      {/* 本地确定性维度分解（可解释匹配：技能/方向/地点/薪资/学历/经验 六维） */}
                      {p.analysis.dimensions && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                          {[
                            ['技能', p.analysis.dimensions.skill],
                            ['方向', p.analysis.dimensions.direction],
                            ['地点', p.analysis.dimensions.location],
                            ['薪资', p.analysis.dimensions.salary],
                            ['学历', p.analysis.dimensions.education],
                            ['经验', p.analysis.dimensions.experience],
                          ]
                            .filter(([, v]) => v != null)
                            .map(([label, v]) => {
                              const value = v as number;
                              const tone = value >= 80 ? 'good' : value >= 55 ? 'mid' : 'low';
                              return (
                                <Tooltip
                                  key={label}
                                  title={
                                    label === '薪资' && salaryText
                                      ? `薪资匹配度 ${value}% · 岗位 ${salaryText}${monthlyHint}${scheduleHint} · 期望薪资 ${expectedSalary}（${sourceNote}）`
                                      : `${label}匹配度 ${value}%（${sourceNote}）`
                                  }
                                >
                                  <span className={'dim-chip dim-chip--' + tone}>
                                    {label} {value}
                                  </span>
                                </Tooltip>
                              );
                            })}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <Progress percent={meta.progress} size="small" style={{ width: 150, margin: 0 }} />
              </div>

              {/* 可解释匹配详情：本地命中证据 + 缺口（仅存在时展示） */}
              {p.analysis && (p.analysis.matchedEvidence?.length || p.analysis.gaps?.length) && (
                <div className="job-detail" style={{ marginTop: 6 }}>
                  {p.analysis.matchedEvidence?.length ? (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                      <span style={{ color: 'var(--ok, #16a34a)' }}>✓ 匹配点：</span>
                      {p.analysis.matchedEvidence.slice(0, 4).join('；')}
                    </div>
                  ) : null}
                  {p.analysis.gaps?.length ? (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                      <span style={{ color: 'var(--warn, #d97706)' }}>△ 缺口：</span>
                      {p.analysis.gaps.slice(0, 3).join('；')}
                    </div>
                  ) : null}
                </div>
              )}

              {p.error && <div className="job-error">⚠ {p.error}</div>}

              <div className="job-actions job-actions--tasks">
                <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && electronApi.external.open(p.job.url)}>
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
