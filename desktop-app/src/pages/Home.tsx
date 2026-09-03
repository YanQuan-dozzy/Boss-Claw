import { useEffect, useState } from 'react';
import { Button, Progress, Tag, Typography, Space, message, Divider } from 'antd';
import {
  FileTextOutlined,
  AimOutlined,
  ThunderboltOutlined,
  ProfileOutlined,
  ApiOutlined,
  SettingOutlined,
  BarChartOutlined,
  RocketOutlined,
  CheckCircleFilled,
  RightOutlined,
  HomeOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  PlusOutlined,
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { profileHasCore } from '@/lib/bossclaw/profile';
import { selectedDirectionItems } from '@/lib/bossclaw/directions';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { createTasks } from '@/lib/bossclaw/tasks';
import { MetricCard } from '@/components/MetricCard';

const { Paragraph, Text } = Typography;

const STEPS = [
  { key: 'resume', icon: <FileTextOutlined />, label: '导入简历', desc: 'PDF / DOCX / MD / TXT' },
  { key: 'resume', icon: <ProfileOutlined />, label: '生成职业画像', desc: 'AI 生成，可编辑' },
  { key: 'directions', icon: <AimOutlined />, label: '选择投递方向', desc: '勾选并确认' },
  { key: 'workbench', icon: <ThunderboltOutlined />, label: '工作台投递', desc: '浏览器 + 人工确认/全自动' },
];

const QUICK_ENTRIES = [
  { key: 'workbench', icon: <ThunderboltOutlined />, title: '打开工作台', desc: '浏览器为主，中栏看进度与岗位' },
  { key: 'tasks', icon: <ProfileOutlined />, title: '任务进度', desc: '查看任务与岗位记录，失败恢复' },
  { key: 'stats', icon: <BarChartOutlined />, title: '数据统计', desc: '岗位状态 / AI 分析 / 趋势排行' },
  { key: 'openclaw', icon: <ApiOutlined />, title: 'OpenClaw 桥接', desc: 'OCR / 日报 / 任务恢复' },
  { key: 'settings', icon: <SettingOutlined />, title: '设置', desc: '主题 / LLM / 数据管理' },
];

export default function Home() {
  const profile = useDataStore((s) => s.profile);
  const resumeText = useDataStore((s) => s.resumeText); // P24：订阅 resumeText，避免外部改动后进度/步骤过期
  const directionPlan = useDataStore((s) => s.directionPlan);
  const pending = useDataStore((s) => s.pending);
  const stats = useDataStore((s) => s.stats);
  const logs = useDataStore((s) => s.logs);
  const setPending = useDataStore((s) => s.setPending);
  const addLog = useDataStore((s) => s.addLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const upsertTaskRun = useDataStore((s) => s.upsertTaskRun);
  const setTaskRuns = useDataStore((s) => s.setTaskRuns);
  const setRoute = useAppStore((s) => s.setRoute);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const bossLoggedIn = useAppStore((s) => s.bossLoggedIn);
  const bridgeStatus = useAppStore((s) => s.bridgeStatus);
  const isLLMConfigured = useSettingsStore((s) => s.isLLMConfigured);
  const config = useSettingsStore((s) => s.config);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let p = 0;
    if (resumeText) p += 25;
    if (profileHasCore(profile)) p += 25;
    if (directionPlan?.confirmed) p += 25;
    if (pending.some((x) => x.status === 'approved_queue' || x.status === 'sent')) p += 25;
    setProgress(p);
  }, [profile, resumeText, directionPlan, pending]);

  const selectedCount = selectedDirectionItems(directionPlan).length;

  const statusCells = [
    { icon: <ThunderboltOutlined />, label: '投递引擎', value: autoAssist ? '运行中' : '已停止', on: autoAssist },
    { icon: <GlobalOutlined />, label: 'BOSS 登录', value: bossLoggedIn === true ? '已登录' : bossLoggedIn === false ? '未登录' : '检测中', on: bossLoggedIn === true },
    { icon: <ApiOutlined />, label: '本地桥接', value: bridgeStatus === 'connected' ? '已连接' : '未连接', on: bridgeStatus === 'connected' },
    { icon: <RocketOutlined />, label: 'LLM', value: isLLMConfigured() ? '已配置' : '未配置', on: isLLMConfigured() },
    { icon: <AimOutlined />, label: '投递方向', value: directionPlan?.confirmed ? '已确认' : '未确认', on: Boolean(directionPlan?.confirmed) },
  ];

  const stepStates = [
    resumeText ? 'done' : 'todo',
    profileHasCore(profile) ? 'done' : 'todo',
    directionPlan?.confirmed ? 'done' : 'todo',
    pending.some((x) => x.status === 'approved_queue' || x.status === 'sent') ? 'done' : 'todo',
  ];
  const currentStep = stepStates.findIndex((s) => s !== 'done');

  const handleStartAssist = () => {
    if (bossLoggedIn === false) {
      message.warning('请先在「工作台」右侧浏览器登录 BOSS 直聘，未登录不能启动');
      setRoute('workbench');
      return;
    }
    if (bossLoggedIn === null) {
      message.warning('正在检测 BOSS 登录状态，请稍候再试');
      return;
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); setRoute('resume'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); setRoute('directions'); return; }
    setRoute('workbench');
    const { next, count } = promoteApprovedToQueue(pending);
    if (count) setPending(next);
    if (!useAppStore.getState().autoAssist) setAutoAssist(true);
  };

  const handlePauseAssist = () => setAutoAssist(false);
  const handleStopAssist = () => setAutoAssist(false);

  const handleCreateTasks = () => {
    if (!profile) { message.warning('请先生成职业画像'); setRoute('resume'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先确认投递方向'); setRoute('directions'); return; }
    const runs = createTasks(profile, config, directionPlan);
    runs.forEach((run) => upsertTaskRun(run));
    setTaskRuns(runs);
    addLog('success', `已基于 ${runs.length} 个「方向×关键词×城市」组合新建任务`);
    message.success(`已新建 ${runs.length} 个任务`);
    setRoute('workbench');
  };

  const handleApproveAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (waiting.length === 0) { message.info('没有待确认的岗位'); return; }
    const next = rerankPending(
      pending.map((p) => (p.status === 'pending' ? { ...p, status: 'approved' as const, approvedAt: p.approvedAt || Date.now() } : p))
    );
    setPending(next);
    addLog('success', `已批准 ${waiting.length} 个岗位进入投递队列（等待「开始投递」）`);
    message.success(`已批准 ${waiting.length} 个岗位（待投递）`);
    setRoute('workbench');
  };

  const handleRejectAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (waiting.length === 0) { message.info('没有待忽略的岗位'); return; }
    setPending(pending.map((p) => (p.status === 'pending' ? { ...p, status: 'ignored' as const } : p)));
    addLog('info', `已忽略 ${waiting.length} 个岗位`);
    message.success(`已忽略 ${waiting.length} 个岗位`);
    recomputeStats();
  };

  useEffect(() => { recomputeStats(); }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <HomeOutlined className="page-title-icon" />首页
          </h1>
          <p className="page-sub">
            面向求职者的本地 AI 投递助手：简历解析 → 职业画像 → 方向选择 → 岗位整理 → AI 匹配 → 沟通草稿 → 投递进度，集中在一个应用内完成。
          </p>
        </div>
        <div className="page-head-extra">
          <Tag color={progress === 100 ? 'success' : 'processing'} style={{ borderRadius: 999 }}>
            配置进度 {progress}%
          </Tag>
        </div>
      </div>

      <div className="hero">
        <h2 className="hero-title">欢迎回来，开始今天的投递</h2>
        <p className="hero-sub">
          在右侧浏览器中打开 BOSS 直聘岗位 → 点「加入任务」→ AI 分析评分 → 批准后进入投递队列。首次成功投递后会自动暂停，供你核对沟通对象与内容。
        </p>
        <div className="hero-actions">
          <Button type="primary" size="large" className="btn-uniform-lg" icon={<ThunderboltOutlined />} onClick={() => setRoute('workbench')}>
            打开工作台
          </Button>
          <Button size="large" className="btn-uniform-lg" icon={<ProfileOutlined />} onClick={() => setRoute('tasks')}>
            查看任务进度
          </Button>
        </div>
      </div>

      <div className="short-grid cols-4" style={{ marginBottom: 20 }}>
        <MetricCard
          title="今日投递"
          value={stats.sent}
          suffix="次"
          subText={`目标 ${config.dailyTarget || 150} 次 / 建议分时段投递`}
          icon={<CheckCircleFilled />}
        />
        <MetricCard
          title="成功率"
          value={pending.length > 0 ? Math.round((stats.sent / pending.length) * 100) : 0}
          type="success-rate"
          subText={`已处理 ${pending.length} 个岗位 (${selectedCount} 方向)`}
          icon={<BarChartOutlined />}
        />
        <MetricCard
          title="待处理岗位"
          value={stats.pending}
          suffix="个"
          type="pending"
          subText="需要在工作台或确认队列核对"
          icon={<ProfileOutlined />}
        />
        <MetricCard
          title="剩余次数"
          value={Math.max(0, (config.dailyTarget || 150) - stats.sent)}
          suffix="次"
          type="remaining"
          subText="今日安全限制额度内"
          icon={<RocketOutlined />}
        />
      </div>

      {/* 任务控制中心 */}
      <div className="soft-block ctrl-panel" style={{ marginBottom: 20 }}>
        <div className="ctrl-panel__head">
          <div className="ctrl-panel__title">
            <ThunderboltOutlined style={{ color: 'var(--brand)' }} /> 任务控制中心
          </div>
          <Space size={10}>
            <Tag color="warning" style={{ margin: 0, padding: '4px 12px', fontSize: 13, borderRadius: 6 }}>
              待处理 <span style={{ fontWeight: 700, marginLeft: 4 }}>{stats.pending}</span>
            </Tag>
            <Tag color="cyan" style={{ margin: 0, padding: '4px 12px', fontSize: 13, borderRadius: 6 }}>
              已投递 <span style={{ fontWeight: 700, marginLeft: 4 }}>{stats.sent}</span>
            </Tag>
            <Tag color="error" style={{ margin: 0, padding: '4px 12px', fontSize: 13, borderRadius: 6 }}>
              失败 <span style={{ fontWeight: 700, marginLeft: 4 }}>{stats.failed}</span>
            </Tag>
          </Space>
        </div>

        {/* 规范操作工具栏 */}
        <div className="ctrl-toolbar">
          <div className="ctrl-group">
            {!autoAssist ? (
              <Button type="primary" className="btn-uniform" icon={<PlayCircleOutlined />} onClick={handleStartAssist}>
                开始投递
              </Button>
            ) : (
              <Button className="btn-uniform" icon={<PauseCircleOutlined />} onClick={handlePauseAssist}>
                暂停
              </Button>
            )}
            <Button danger className="btn-uniform" icon={<StopOutlined />} onClick={handleStopAssist} disabled={!autoAssist}>
              停止
            </Button>
          </div>

          <Divider type="vertical" style={{ height: 24, margin: '0 4px' }} />

          <div className="ctrl-group">
            <Button className="btn-uniform" icon={<PlusOutlined />} onClick={handleCreateTasks}>
              新建任务
            </Button>
            <Button className="btn-uniform" icon={<CheckOutlined />} onClick={handleApproveAll}>
              批量确认
            </Button>
            <Button className="btn-uniform" icon={<CloseOutlined />} onClick={handleRejectAll}>
              全部忽略
            </Button>
          </div>

          <Divider type="vertical" style={{ height: 24, margin: '0 4px' }} />

          <div className="ctrl-group">
            <Button className="btn-uniform" icon={<AimOutlined />} onClick={() => setRoute('directions')}>
              管理方向
            </Button>
            <Button className="btn-uniform" icon={<ReloadOutlined />} onClick={() => setRoute('tasks')}>
              失败恢复
            </Button>
          </div>
        </div>

        {/* 目标进度条 */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>今日投递目标</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{stats.sent} / {config.dailyTarget || 150}</Text>
          </div>
          <Progress
            percent={Math.min(100, Math.round((stats.sent / Math.max(1, config.dailyTarget || 150)) * 100))}
            showInfo={false}
            strokeColor={{ from: '#14B8A6', to: '#0D9488' }}
          />
          <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            建议分时段投递（早 / 午 / 晚），避免触发平台风控。
          </Text>
        </div>
      </div>

      {/* 运行状态 (5 个组件独占整行 5 列网格) */}
      <div className="soft-block" style={{ padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>运行状态</div>
        <div className="short-grid cols-5">
          {statusCells.map((c) => (
            <div className="status-cell" key={c.label}>
              <span className="cell-icon" style={{ color: c.on ? 'var(--brand)' : 'var(--fg-muted)' }}>{c.icon}</span>
              <div>
                <div className="cell-label">{c.label}</div>
                <div className="cell-value">{c.value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 配置进度 (4 个步骤独占整行 4 列网格) */}
      <div className="soft-block" style={{ padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>配置进度</span>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{progress}%</span>
        </div>
        <Progress percent={progress} showInfo={false} strokeColor={{ from: '#14B8A6', to: '#0D9488' }} />
        <div className="short-grid cols-4" style={{ marginTop: 14 }}>
          {STEPS.map((s, i) => {
            const st = currentStep === -1 || i < currentStep ? 'done' : i === currentStep ? 'current' : 'todo';
            return (
              <div
                key={i}
                className={'step-item is-' + st}
                role="button"
                tabIndex={0}
                onClick={() => setRoute(s.key as any)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setRoute(s.key as any);
                  }
                }}
              >
                <span className="step-dot">
                  {st === 'done' ? <CheckCircleFilled style={{ fontSize: 14 }} /> : s.icon}
                </span>
                <div className="step-content">
                  <div className="step-label">{s.label}</div>
                  <div className="step-desc">{s.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 快速入口 (5 个入口独占整行 5 列网格) */}
      <div className="soft-block" style={{ padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>快速入口</div>
        <div className="short-grid cols-5">
          {QUICK_ENTRIES.map((q) => (
            <button key={q.key} className="quick-entry" onClick={() => setRoute(q.key as any)}>
              <span className="qe-icon">{q.icon}</span>
              <div className="qe-content">
                <div className="qe-title">{q.title}</div>
                <div className="qe-desc">{q.desc}</div>
              </div>
              <RightOutlined className="qe-arrow" />
            </button>
          ))}
        </div>
      </div>

      {/* 最近动态 */}
      <div className="soft-block" style={{ padding: '16px 18px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>最近动态</div>
        {logs.length === 0 ? (
          <Paragraph type="secondary" style={{ padding: '16px 0', textAlign: 'center' }}>
            暂无动态，去工作台开始第一次投递吧
          </Paragraph>
        ) : (
          <div>
            {logs.slice(-5).reverse().map((l, i) => (
              <div className="timeline-item" key={i}>
                <span className={'tl-dot ' + (l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : l.level === 'success' ? 'success' : 'info')} />
                <span className="tl-time">{new Date(l.time).toLocaleTimeString()}</span>
                <span className="tl-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
