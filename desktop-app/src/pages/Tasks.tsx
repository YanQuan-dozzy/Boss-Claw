import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, Modal, Popconfirm, Progress, Segmented, Space, Tag, Tooltip, Typography, message } from 'antd';
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
  CheckOutlined,
  WarningOutlined,
  CheckCircleFilled,
  UndoOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { pendingStatusMeta } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import PlatformChip from '@/components/PlatformChip';
import { cleanTitle, cleanSalary } from '@/lib/bossclaw/jobDisplay';
import { detectWorkSchedule } from '@/lib/bossclaw/workSchedule';
import { fitLevelLabel } from '@/lib/bossclaw/fitLevel';
import type { FitLevel } from '@/lib/bossclaw/fitLevel';
import { EmptyState } from '@/components/feedback';
import { electronApi } from '@/lib/electronApi';
import type { JobPlatform, MatchDimensionEvidence, PendingItem, PendingStatus, TaskRun } from '@/lib/bossclaw/types';

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

/**
 * 缺口拆分：技能名 + 匹配说明（弹窗展示用）。
 * 兼容四种写法：
 *  - AI 新格式「技能名：匹配说明」（说明由 AI 按岗位场景/简历现状/补强建议生成）；
 *  - 「表达缺口：技能名」（简历做过相关工作但未写清，说明由展示端补充）；
 *  - 本地兜底格式「岗位要求「X」画像未体现」；
 *  - 历史纯技能名（说明统一兜底，不编造具体内容，但给可执行建议）。
 */
function splitGapWithNote(gap: string): { name: string; note: string } {
  const expr = gap.match(/^表达缺口[：:]\s*(.+)$/);
  if (expr) return { name: expr[1].trim(), note: '简历做过相关工作但未写清：建议在简历「技能/项目」中补充该能力的真实落地场景，属可快速补强。' };
  const local = gap.match(/^岗位要求「(.+?)」画像未体现$/);
  if (local) return { name: local[1].trim(), note: '岗位明确要求该技能，简历与职业画像均未体现相关经历。建议通过课程或实操项目补齐，并在简历中如实补充。' };
  const colon = gap.match(/^(.{1,24}?)[：:]\s*(.+)$/);
  if (colon && colon[1].trim()) return { name: colon[1].trim(), note: colon[2].trim() };
  return { name: gap, note: '岗位明确要求该技能，简历/画像未体现相关经历。建议通过实操项目补齐，或在求职信中如实说明学习意愿与进度。' };
}

/** 匹配决策枚举本地化与徽标视觉渲染 */
function renderDecisionBadge(decision?: string) {
  if (!decision) return null;
  const d = String(decision).trim().toLowerCase();
  if (d === 'recommend' || d === '推荐') {
    return (
      <span className="task-decision-badge task-decision-badge--recommend">
        <span className="task-decision-dot" /> 建议投递
      </span>
    );
  }
  if (d === 'cautious' || d === '谨慎') {
    return (
      <span className="task-decision-badge task-decision-badge--cautious">
        <span className="task-decision-dot" /> 谨慎考虑
      </span>
    );
  }
  if (d === 'reject' || d === '不推荐') {
    return (
      <span className="task-decision-badge task-decision-badge--reject">
        <span className="task-decision-dot" /> 不推荐
      </span>
    );
  }
  return <span className="task-decision-badge">{decision}</span>;
}

/** 岗位适配档位标签（四层整体裁决的产物）；存量数据缺 fitLevel 时优雅降级为不渲染 */
function renderFitLevelTag(level?: FitLevel) {
  if (!level) return null;
  const cls =
    level === 'strong' ? 'task-fit-strong' : level === 'match' ? 'task-fit-match' : level === 'cautious' ? 'task-fit-cautious' : 'task-fit-unfit';
  return <span className={`task-fit-tag ${cls}`}>{fitLevelLabel(level)}</span>;
}

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
  // 匹配点 / 缺口「查看全部」弹窗（展示完整内容 + 缺口匹配说明）
  const [detailModal, setDetailModal] = useState<{ kind: 'match' | 'gap'; item: PendingItem } | null>(null);

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
      approved: pending.filter((p) => p.status === 'approved').length,
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
  const onRevert = (id: string) => {
    const next = rerankPending(pending.map((p) => p.id === id ? { ...p, status: 'pending' as const } : p), useSettingsStore.getState().config);
    setPending(next);
    message.info('已撤回岗位，退回「待确认」');
    recomputeStats();
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
      addLog('info', `已请求重新采集：${t.keyword || '随机推荐'} · ${t.location || '全国'} · ${t.employmentType || '不限'}`);
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

  // 已停止 / 已跳过：进度区下方 stageLabel 已说明「已停止（未完成）」等原因，
  // 右侧不再重复展示状态标签（原先会外露裸英文 "skipped"）。
  const taskStatusMeta = (t: TaskRun) => {
    if (t.status === 'success') return { label: '已完成', color: 'green' };
    if (t.status === 'failed') return { label: '失败', color: 'red' };
    if (t.status === 'skipped' || t.status === 'ignored') return null;
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
                    {meta ? (
                      <Tag color={meta.color} style={{ margin: 0, padding: '2px 10px', borderRadius: 999 }}>{meta.label}</Tag>
                    ) : null}
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
          const meta = pendingStatusMeta(p.status, p.job?.platform);
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
          // 工作制度（双休/大小周/单休/每周 N 天/月休 N 天）
          const schedule = detectWorkSchedule(p.job);
          const scheduleHint = schedule.detected ? ` · 工作制度：${schedule.label}（${schedule.weeklyDays} 天/周）` : '';
          const expectedSalary = String(profile?.hardConstraints?.salary || '').trim() || '不限';
          const pf = String(p.job?.platform || 'boss').toLowerCase();
          return (
            <div key={p.id} className={`job-card job-card--tasks job-card--pf-${pf} ${jobCardStatus(p)}`}>
              {/* 卡片头部：职位、平台、薪资、状态与公司元信息 */}
              <div className="task-job-header">
                <div className="task-job-header-main">
                  <div className="task-job-title-row">
                    <PlatformChip platform={p.job?.platform} />
                    <span className="task-job-title" title={cleanTitle(p.job?.title, p.job?.salary)}>
                      {cleanTitle(p.job?.title, p.job?.salary)}
                    </span>
                    {salaryText && (
                      <span className="task-salary-pill" title={salaryText}>
                        {salaryText}
                      </span>
                    )}
                  </div>
                  <div className="task-company-meta">
                    <span className="task-company-name">{p.job?.company || '未知企业'}</span>
                    {p.job?.location && <span className="task-meta-dot">·</span>}
                    {p.job?.location && <span className="task-location-text">{p.job.location}</span>}
                    {schedule.detected && <span className="task-schedule-tag">{schedule.label}</span>}
                  </div>
                </div>
                <div className="task-job-header-right">
                  <Tag color={st.color} className="task-status-tag">
                    {st.label}
                  </Tag>
                </div>
              </div>

              {/* 核心分析面板 */}
              <div className="task-analysis-panel">
                {/* 评分行：主色调 AI 评分胶囊 / 决策胶囊 / 中性缺口标签 / 右侧紧凑阶段进度 */}
                <div className="task-score-row">
                  <div className="task-score-left">
                    {p.analysis && (
                      <>
                        {chip.text && (
                          <Tooltip title={sourceNote}>
                            <div className="task-score-pill">
                              <span className="task-score-dot" />
                              <span>{scoreIsLocal ? '本地' : 'AI'} {chip.text} 分</span>
                            </div>
                          </Tooltip>
                        )}
                        {renderDecisionBadge(p.analysis.decision)}
                        {renderFitLevelTag(p.analysis.fitLevel)}
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
                            <span className="task-flag-badge task-flag-badge--neutral">
                              拦截硬条件 {p.analysis.hardBlocks.length} 项
                            </span>
                          </Tooltip>
                        ) : null}
                        {p.analysis.gaps?.length ? (
                          <span className="task-flag-badge task-flag-badge--neutral">
                            存在缺口 {p.analysis.gaps.length} 项
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div className="task-progress-wrap">
                    <span className="task-progress-label">{meta.label || '执行进度'}</span>
                    <div className="task-progress-bar">
                      <div className="task-progress-inner" style={{ width: `${meta.progress}%` }} />
                    </div>
                    <span className="task-progress-pct">{meta.progress}%</span>
                  </div>
                </div>

                {/* 维度托盘：AI 语义评估优先、本地确定性兜底；悬浮可见每维依据 */}
                {p.analysis?.dimensions && (
                  <div className="task-dims-tray">
                    {(
                      [
                        ['skill', '技能'],
                        ['direction', '方向'],
                        ['salary', '薪资'],
                        ['education', '学历'],
                        ['experience', '经验'],
                      ] as [keyof MatchDimensionEvidence, string][]
                    )
                      .map(([key, label]) => {
                        const value = p.analysis?.dimensions?.[key];
                        return value == null ? null : { key, label, value };
                      })
                      .filter((x): x is { key: keyof MatchDimensionEvidence; label: string; value: number } => x != null)
                      .map(({ key, label, value }) => {
                        const isAi = p.analysis?.scoreSource === 'ai';
                        const ev = p.analysis?.dimensionEvidence?.[key];
                        const salaryCtx =
                          key === 'salary' && salaryText
                            ? `岗位 ${salaryText}${scheduleHint} · 期望 ${expectedSalary}`
                            : '';
                        return (
                          <Tooltip
                            key={key}
                            title={
                              <div style={{ maxWidth: 380, fontSize: 12 }}>
                                <div>
                                  {label} {value} 分（{isAi ? 'AI 语义评估' : '本地确定性维度'}）
                                </div>
                                {ev ? (
                                  <div style={{ opacity: 0.95 }}>{ev}</div>
                                ) : isAi ? (
                                  <div style={{ opacity: 0.7 }}>该维度 AI 未给出依据，由本地规则兜底</div>
                                ) : null}
                                {salaryCtx ? <div>{salaryCtx}</div> : null}
                                <div style={{ opacity: 0.8 }}>
                                  {isAi
                                    ? '维度分由 AI 按简历与岗位语义逐维评估；AI 缺失的维度由本地规则兜底。最终分数 = 60% AI 整体分 + 40% 维度加权分；档位以四层整体裁决为准，技能维 ≤25（根本性技术栈错位）时档位不高于谨慎。'
                                    : 'AI 未参与评分，维度分由本地关键词确定性计算，仅供可解释性参考。'}
                                </div>
                              </div>
                            }
                          >
                            <div className="dim-item">
                              <div className="dim-item-header">
                                <span className="dim-item-label">{label}</span>
                                <span className="dim-item-value">{value}</span>
                              </div>
                              <div className="dim-item-track">
                                <div className="dim-item-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
                              </div>
                            </div>
                          </Tooltip>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* 优劣势分析区（优势匹配为浅主色，能力缺口与风险提示并入同一区块，中性/警告灰阶）：
                  原「分析结论 reason 大段」已按条归入优势/缺口/风险展示，不再单独渲染大段落。 */}
              {p.analysis && (p.analysis.matchedEvidence?.length || p.analysis.gaps?.length || p.analysis.risks?.length) && (
                <div className="task-prop-section">
                  {p.analysis.matchedEvidence?.length ? (
                    <div className="task-prop-row">
                      <span className="task-prop-label task-prop-label--match">
                        <CheckOutlined /> 优势匹配
                      </span>
                      <div className="task-prop-chips">
                        {p.analysis.matchedEvidence.slice(0, 3).map((e, i) => (
                          <Tooltip key={i} title={e}>
                            <span className="task-prop-chip">{e}</span>
                          </Tooltip>
                        ))}
                      </div>
                      <Button
                        type="link"
                        size="small"
                        className="task-prop-more-btn"
                        onClick={() => setDetailModal({ kind: 'match', item: p })}
                      >
                        全部 {p.analysis.matchedEvidence.length} 条 ›
                      </Button>
                    </div>
                  ) : null}

                  {(p.analysis.gaps?.length || p.analysis.risks?.length) ? (
                    <div className="task-prop-row">
                      <span className="task-prop-label task-prop-label--gap">
                        <WarningOutlined /> 缺口与提醒
                      </span>
                      <div className="task-prop-chips">
                        {p.analysis.gaps?.slice(0, 4).map((g, i) => {
                          const { name, note } = splitGapWithNote(g);
                          return (
                            <Tooltip
                              key={i}
                              title={
                                <div style={{ maxWidth: 320 }}>
                                  <div>{g}</div>
                                  {note && note !== g ? <div style={{ opacity: 0.92, marginTop: 4 }}>{note}</div> : null}
                                </div>
                              }
                            >
                              <span className="task-prop-chip">{name}</span>
                            </Tooltip>
                          );
                        })}
                        {p.analysis.risks?.map((r, i) => (
                          <Tooltip key={`risk-${i}`} title={r}>
                            <span className="task-prop-chip task-prop-chip--risk">{r}</span>
                          </Tooltip>
                        ))}
                      </div>
                      {p.analysis.gaps?.length || p.analysis.risks?.length ? (
                        <Button
                          type="link"
                          size="small"
                          className="task-prop-more-btn"
                          onClick={() => setDetailModal({ kind: 'gap', item: p })}
                        >
                          全部 {(p.analysis.gaps?.length || 0) + (p.analysis.risks?.length || 0)} 项 ›
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}

              

              {p.error && <div className="job-error">⚠ {p.error}</div>}

              {/* 操作按钮栏 */}
              <div className="job-actions job-actions--tasks">
                <div className="task-actions-left">
                  <Button size="small" className="task-ghost-btn" icon={<EyeOutlined />} onClick={() => p.job?.url && electronApi.external.open(p.job.url)}>
                    查看详情
                  </Button>
                  <Button size="small" className="task-ghost-btn" icon={<ReloadOutlined />} onClick={() => onRetry(p.id)}>
                    重试
                  </Button>
                  <Button size="small" className="task-ghost-btn" icon={<StopOutlined />} onClick={() => onIgnore(p.id)}>
                    忽略
                  </Button>
                  <Button size="small" className="task-ghost-btn" icon={<ForwardOutlined />} onClick={() => onSkip(p.id)}>
                    跳过
                  </Button>
                </div>
                <div className="task-actions-right">
                  {p.status === 'pending' ? (
                    <Button size="small" type="primary" className="task-approve-btn" icon={<CheckCircleFilled />} onClick={() => onApprove(p.id)}>
                      批准投递
                    </Button>
                  ) : p.status === 'approved' ? (
                    <Space size={8}>
                      <span className="task-status-hint task-status-hint--approved">
                        <span className="task-hint-dot" /> 待投递（工作台可一键发起）
                      </span>
                      <Button size="small" className="task-ghost-btn" icon={<UndoOutlined />} onClick={() => onRevert(p.id)}>
                        撤回
                      </Button>
                    </Space>
                  ) : p.status === 'approved_queue' ? (
                    <span className="task-status-hint task-status-hint--queued">
                      <span className="task-hint-dot" /> 正在投递队列中
                    </span>
                  ) : p.status === 'sent' ? (
                    <span className="task-status-hint task-status-hint--sent">
                      ✓ 已投递完成
                    </span>
                  ) : p.status === 'failed' ? (
                    <Button size="small" danger icon={<ReloadOutlined />} onClick={() => onRetry(p.id)}>
                      重试投递
                    </Button>
                  ) : (
                    <Button size="small" type="primary" className="task-approve-btn" icon={<CheckCircleFilled />} onClick={() => onApprove(p.id)}>
                      批准投递
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* 匹配点 / 缺口「查看全部」小窗：完整内容展示，缺口逐条附匹配说明 */}
      <Modal
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={null}
        width={580}
        title={
          detailModal ? (
            <div>
              <span style={{ fontSize: 15 }}>{detailModal.kind === 'match' ? '匹配点（全部）' : '缺口与提醒（全部）'}</span>
              <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--fg-muted)', marginTop: 2 }}>
                {cleanTitle(detailModal.item.job?.title, detailModal.item.job?.salary)}
              </div>
            </div>
          ) : ''
        }
      >
        {detailModal && detailModal.kind === 'match' && (
          <ul className="detail-modal-list">
            {(detailModal.item.analysis?.matchedEvidence || []).map((e, i) => (
              <li key={i} className="detail-modal-item detail-modal-item--match">
                <span className="detail-modal-idx">{i + 1}</span>
                <span className="detail-modal-text">{e}</span>
              </li>
            ))}
          </ul>
        )}
        {detailModal && detailModal.kind === 'gap' && (
          <>
            <ul className="detail-modal-list">
              {(detailModal.item.analysis?.gaps || []).map((g, i) => {
                const { name, note } = splitGapWithNote(g);
                return (
                  <li key={i} className="detail-modal-item">
                    <span className="detail-modal-idx">{i + 1}</span>
                    <div className="detail-modal-gap">
                      <span className={'detail-modal-gap-name' + (g.startsWith('表达缺口') ? ' detail-modal-gap-name--expr' : '')}>{name}</span>
                      <span className="detail-modal-gap-note">{note}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {detailModal.item.analysis?.risks?.length ? (
              <>
                <div className="detail-modal-subtitle">
                  <WarningOutlined /> 风险提醒
                </div>
                <ul className="detail-modal-list">
                  {(detailModal.item.analysis.risks || []).map((r, i) => (
                    <li key={i} className="detail-modal-item detail-modal-item--risk">
                      <span className="detail-modal-idx">{i + 1}</span>
                      <span className="detail-modal-text">{r}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </Modal>
    </div>
  );
}
