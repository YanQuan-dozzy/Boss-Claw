/**
 * 【主模块：首页】导航 key = 'home'（App.tsx 按 key 渲染本页）
 * 子模块：
 * - 欢迎区（hero：欢迎语 + 快捷入口按钮）
 * - 数据概览指标卡（今日投递 / 成功率 / 待处理岗位 / 剩余次数，MetricCard）
 * - 任务控制中心（开始/暂停/停止、批量确认、失败恢复、目标进度）
 * - 辅助信息区（运行状态 / 配置进度 / 快速入口 / 最近动态）
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Progress, Tag, Typography, Space, message, Divider, Drawer, Spin, Modal, notification } from 'antd';
import {
  FileTextOutlined,
  AimOutlined,
  ThunderboltOutlined,
  ProfileOutlined,
  ApiOutlined,
  SettingOutlined,
  BarChartOutlined,
  RocketOutlined,
  RobotOutlined,
  MessageOutlined,
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
  BookOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import type { SettingsTabKey } from '@/store/useAppStore';
import { useDataStore } from '@/store/useDataStore';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { profileHasCore } from '@/lib/bossclaw/profile';
import { selectedDirectionItems } from '@/lib/bossclaw/directions';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { createTasks } from '@/lib/bossclaw/tasks';
import { MetricCard } from '@/components/MetricCard';
import { electronApi } from '@/lib/electronApi';
import { effectiveDailyCap, enabledSentCount } from '@/lib/bossclaw/safety';
import { PLATFORM_IDS, platformLabel, type JobPlatform } from '@/lib/bossclaw/platforms';
import type { PendingItem } from '@/lib/bossclaw/types';
import MarkdownView from '@/components/MarkdownView';

const { Paragraph, Text } = Typography;

/** 首页配置进度步骤。带 tab 的步骤点击直达设置页对应分区（key='settings' + tab='llm'） */
interface HomeStep {
  key: string;
  /** 设置页分区（仅「配置 AI 模型」使用） */
  tab?: SettingsTabKey;
  icon: ReactNode;
  label: string;
  desc: string;
}

const STEPS: HomeStep[] = [
  { key: 'settings', tab: 'llm', icon: <ApiOutlined />, label: '配置 AI 模型', desc: 'API Key / 模型名' },
  { key: 'resume', icon: <FileTextOutlined />, label: '导入简历', desc: 'PDF / DOCX / DOC / MD / TXT' },
  { key: 'resume', icon: <ProfileOutlined />, label: '生成职业画像', desc: 'AI 生成，可编辑' },
  { key: 'directions', icon: <AimOutlined />, label: '选择投递方向', desc: '勾选并确认' },
  { key: 'workbench', icon: <ThunderboltOutlined />, label: '工作台投递', desc: '浏览器 + 人工确认/全自动' },
];

// 「未配置大模型」的顶部一次性通知：固定 key + 只弹一次（与设置页的同类提醒同一套写法：
// placement:'top' + duration 9s + 进度条 + 点击直达）。说明类文案不常驻页面，是项目既有口径。
const LLM_NOTICE_KEY = 'llm-not-configured-notice';
const LLM_NOTICE_DURATION = 9;
/** 本次会话是否已提示过（模块级：跨页面切换不重复弹；重启应用后重新评估） */
let llmNoticeShown = false;

const QUICK_ENTRIES = [
  { key: 'workbench', icon: <ThunderboltOutlined />, title: '打开工作台', desc: '浏览器为主，中栏看进度与岗位' },
  { key: 'tasks', icon: <ProfileOutlined />, title: '任务进度', desc: '查看任务与岗位记录，失败恢复' },
  { key: 'assistant', icon: <RobotOutlined />, title: '定制简历', desc: '针对岗位 AI 定制 / 导出 PDF' },
  { key: 'autochat', icon: <MessageOutlined />, title: '自动沟通', desc: '批量自动投递 / 智能打招呼' },
  { key: 'settings', icon: <SettingOutlined />, title: '设置', desc: '主题 / LLM / 数据管理' },
];

/** 第 5 步「工作台投递」的进度事实：唯一判定入口。
 *
 * 语义 = **至少成功投出第一份**（`sent`），而不是「队列里有动作」。
 * 历史 bug：原判定为 `status === 'approved_queue' || status === 'sent'`，把「投递中」也算完成，
 * 且完全不认 `failed`，于是「批准后没启动」（停在 approved）与「投递失败」（变 failed）两种
 * 现实路径都会让进度永久停在 80%，而界面不给任何解释。
 * 这里把事实与「下一步该做什么」一起算出来，供进度、步骤条、诊断行三处共用（单一真相）。
 *
 * `engineRunning` 必须由调用方传入（即订阅的 `autoAssist`）：曾在函数内读 store 快照，
 * 结果引擎启停而 `pending` 未变时诊断文案不刷新，提示与实际状态脱节。 */
function evalDeliveryStep(pending: PendingItem[], engineRunning: boolean) {
  const count = (st: PendingItem['status']) => pending.filter((p) => p.status === st).length;
  const counts = {
    approved: count('approved'),
    approvedQueue: count('approved_queue'),
    sent: count('sent'),
    failed: count('failed'),
    pending: count('pending'),
  };
  // 已成功投递过（含历史：只要存在 sent 条目即算走完，不因后续条目失败而回退）
  const delivered = counts.sent > 0;

  /** 未完成时的归因提示（区分「该做什么」与「为什么没成」），已完成时返回 null */
  let diagnosis: string | null = null;
  if (!delivered) {
    if (counts.failed > 0) {
      // 失败优先于「待处理」：失败是用户最需要知道、也最容易忽略的终态
      diagnosis = `有 ${counts.failed} 个岗位投递失败，未成功投出：到工作台看错误详情后重试`;
    } else if (counts.approvedQueue > 0) {
      diagnosis = engineRunning
        ? `有 ${counts.approvedQueue} 个岗位投递中，未成功投出：打开工作台查看实时进度`
        : `有 ${counts.approvedQueue} 个岗位在队列中，但投递引擎已停止：点上方「开始投递」继续`;
    } else if (counts.approved > 0) {
      diagnosis = `有 ${counts.approved} 个岗位已确认但未启动：回工作台点「开始投递」`;
    } else if (counts.pending > 0) {
      diagnosis = `有 ${counts.pending} 个岗位待确认：到工作台确认后才会进入投递队列`;
    } else {
      diagnosis = '还没有岗位：先到工作台采集，再把岗位加入任务';
    }
  }
  return { delivered, counts, diagnosis };
}

export default function Home() {
  const profile = useDataStore((s) => s.profile);
  const resumeText = useDataStore((s) => s.resumeText); // P24：订阅 resumeText，避免外部改动后进度/步骤过期
  const directionPlan = useDataStore((s) => s.directionPlan);
  const pending = useDataStore((s) => s.pending);
  const stats = useDataStore((s) => s.stats);
  const logs = useRuntimeLogsStore((s) => s.logs);
  const setPending = useDataStore((s) => s.setPending);
  const addLog = useRuntimeLogsStore((s) => s.addLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const setTaskRuns = useDataStore((s) => s.setTaskRuns);
  const setRoute = useAppStore((s) => s.setRoute);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const bossLoggedIn = useAppStore((s) => s.bossLoggedIn);
  const bridgeStatus = useAppStore((s) => s.bridgeStatus);
  const isLLMConfigured = useSettingsStore((s) => s.isLLMConfigured);
  const config = useSettingsStore((s) => s.config);
  const openSettings = useAppStore((s) => s.openSettings);
  // 大模型是否已配置（Base URL / API Key / 模型名三者齐备）——配置进度的第 1 步判定依据
  const llmReady = isLLMConfigured();
  // 今日目标 = 各「已启用」平台每日目标合计（每平台上限于平台侧/防封号收窄；仅 BOSS 时即原 120）
  const dailyGoal = effectiveDailyCap(config);
  // 「今日投递」必须按 sentAt 过滤当天，**且与每日上限（dailyGoal = effectiveDailyCap）同源**：
  // 每日上限只累加「已启用」平台的额度，故分子也必须只统计「已启用」平台的今日投递，
  // 否则用户关闭某平台后，该平台的历史投递仍计入分子、却不贡献分母 → 进度条显示
  // 「今日 150 / 目标 120」这类越界值。（与批次 13 守卫口径对称，同一条规则）
  // 注意：store 的 stats.sent 是**累计**已投递总数（无日期过滤），直接拿来当「今日」会把
  // 昨天乃至更早投递的岗位也算进来（表现为「昨天投的显示成今日投递」）。
  const sentToday = enabledSentCount(config, pending);
  const [progress, setProgress] = useState(0);
  // 使用前必读文档抽屉
  const [docOpen, setDocOpen] = useState(false);
  const [docText, setDocText] = useState('');
  const [docLoading, setDocLoading] = useState(false);

  const handleOpenDoc = async () => {
    setDocOpen(true);
    if (docText || docLoading) return; // 已加载 / 加载中
    setDocLoading(true);
    const r = await electronApi.readDoc();
    setDocLoading(false);
    if (r.ok && r.text) {
      setDocText(r.text);
    } else {
      message.warning(r.error || '使用文档读取失败');
    }
  };

  // 第 5 步（投递）的事实 + 归因：进度条、步骤条、诊断行三处共用同一个结果（单一真相）。
  // 依赖 autoAssist：引擎启停会改变「队列中但已停止」这类归因文案，必须触发重算。
  const delivery = evalDeliveryStep(pending, autoAssist);

  useEffect(() => {
    // 配置进度 = 五个必做步骤各 20%。
    // 第 1 步「配置 AI 模型」是业务必需前置（岗位评分 / 打招呼语 / 职业画像 / 定制简历都以 AI 为准），
    // 此前只作为「运行状态」里的一格展示，用户看不到它对整体进度的影响。
    // 第 5 步的判定与归因统一走 evalDeliveryStep（单一真相），避免进度与步骤条各写一套条件而失配。
    let p = 0;
    if (llmReady) p += 20;
    if (resumeText) p += 20;
    if (profileHasCore(profile)) p += 20;
    if (directionPlan?.confirmed) p += 20;
    if (delivery.delivered) p += 20;
    setProgress(p);
  }, [profile, resumeText, directionPlan, pending, llmReady, delivery.delivered]);
  const selectedCount = selectedDirectionItems(directionPlan).length;

  const statusCells = [
    { icon: <ThunderboltOutlined />, label: '投递引擎', value: autoAssist ? '运行中' : '已停止', on: autoAssist },
    { icon: <GlobalOutlined />, label: 'BOSS 登录', value: bossLoggedIn === true ? '已登录' : bossLoggedIn === false ? '未登录' : '检测中', on: bossLoggedIn === true },
    { icon: <ApiOutlined />, label: '本地桥接', value: bridgeStatus === 'connected' ? '已连接' : '未连接', on: bridgeStatus === 'connected' },
    { icon: <RocketOutlined />, label: 'LLM', value: llmReady ? '已配置' : '未配置', on: llmReady },
    { icon: <AimOutlined />, label: '投递方向', value: directionPlan?.confirmed ? '已确认' : '未确认', on: Boolean(directionPlan?.confirmed) },
  ];

  const stepStates = [
    llmReady ? 'done' : 'todo',
    resumeText ? 'done' : 'todo',
    profileHasCore(profile) ? 'done' : 'todo',
    directionPlan?.confirmed ? 'done' : 'todo',
    delivery.delivered ? 'done' : 'todo',
  ];
  const currentStep = stepStates.findIndex((s) => s !== 'done');

  /** 真正启动投递引擎（通过前置校验之后） */
  const startAssistNow = () => {
    setRoute('workbench');
    const { next, count } = promoteApprovedToQueue(pending, useSettingsStore.getState().config);
    if (count) setPending(next);
    if (!useAppStore.getState().autoAssist) setAutoAssist(true);
  };

  const handleStartAssist = () => {
    // 登录门禁按「待投递岗位所在平台」判定（与工作台口径一致，platformLogins 为 cookie 权威探测）：
    // 只检查队列里真实要投递的平台，不再拿 BOSS 登录态去拦截智联/猎聘/51job 的投递。
    const pendingData = useDataStore.getState().pending;
    const platforms = new Set<JobPlatform>();
    for (const p of pendingData) {
      if (p.status === 'approved' || p.status === 'approved_queue') {
        platforms.add(String(p.job?.platform || 'boss') as JobPlatform);
      }
    }
    const logins = useAppStore.getState().platformLogins;
    for (const pf of PLATFORM_IDS) {
      if (!platforms.has(pf)) continue;
      const st = logins[pf];
      if (st === false) {
        message.warning(`请先在「工作台」右侧浏览器登录 ${platformLabel(pf)}，未登录不能启动`);
        setRoute('workbench');
        return;
      }
      if (st == null) {
        message.warning(`正在检测 ${platformLabel(pf)} 登录状态，请稍候再试`);
        return;
      }
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); setRoute('resume'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); setRoute('directions'); return; }
    // 未配置大模型：**不硬拦**（本地规则仍能评分并生成招呼语，功能可用），但必须让用户知情后再继续。
    // 此前无任何提示，用户会在不知道「AI 没参与」的情况下拿本地分数投递，事后才从日志里找原因。
    if (!llmReady) {
      Modal.confirm({
        title: '未配置大模型 API Key，AI 分析当前不可用',
        content:
          '岗位评分与打招呼语将改用本地规则生成，可用但与 AI 相比偏粗；采集与投递流程不受影响。建议先配置 API Key。',
        okText: '去配置',
        cancelText: '继续（本地规则）',
        onOk: () => openSettings('llm'),
        onCancel: () => startAssistNow(),
      });
      return;
    }
    startAssistNow();
  };

  const handlePauseAssist = () => setAutoAssist(false);
  const handleStopAssist = () => setAutoAssist(false);

  const handleCreateTasks = () => {
    if (!profile) { message.warning('请先生成职业画像'); setRoute('resume'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先确认投递方向'); setRoute('directions'); return; }
    const runs = createTasks(profile, config, directionPlan);
    // 「新建任务」只重建「投递任务」；采集任务（cr_ 前缀，由工作台「搜索采集」自动生成）必须保留，
    // 否则一次新建任务会把任务进度页的采集卡片全部清空（两模块共用 taskRuns 数据源）。
    const keptCollectRuns = useDataStore.getState().taskRuns.filter((r) => String(r.id || '').startsWith('cr_'));
    setTaskRuns([...runs, ...keptCollectRuns]);
    addLog('success', `已基于 ${runs.length} 个「方向×关键词×城市」组合新建任务`);
    message.success(`已新建 ${runs.length} 个任务`);
    setRoute('workbench');
  };

  const handleApproveAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (waiting.length === 0) { message.info('没有待确认的岗位'); return; }
    const next = rerankPending(
      pending.map((p) => (p.status === 'pending' ? { ...p, status: 'approved' as const, approvedAt: p.approvedAt || Date.now() } : p)),
      useSettingsStore.getState().config
    );
    setPending(next);
    addLog('success', `已确认 ${waiting.length} 个岗位，等待「开始投递」`);
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

  // 「状态事实」提醒：首页挂载时若大模型未配置 → 写一条 WARN + 弹一次顶部通知（各只一次）。
  // 与 llm.ts 里「AI 真回落本地时」的那条（行为事实）分工不同：这条在用户还没用任何 AI 功能时
  // 就能看到归因，不至于等到采集/投递跑完才去日志里猜「为什么没有 AI 结果」。
  useEffect(() => {
    if (llmReady || llmNoticeShown) return;
    llmNoticeShown = true;
    addLog(
      'warn',
      '未配置大模型 API Key：AI 分析 / 生成（岗位评分、打招呼语、职业画像、定制简历）将使用本地规则。可在「设置 → AI / LLM 配置」填写 API Key 后启用。'
    );
    notification.warning({
      key: LLM_NOTICE_KEY,
      placement: 'top',
      duration: LLM_NOTICE_DURATION,
      showProgress: true,
      message: '未配置大模型 API Key，AI 能力当前不可用',
      description: (
        <div style={{ fontSize: 13, lineHeight: '20px' }}>
          <div>岗位评分、打招呼语、职业画像、定制简历将改用本地规则生成；采集与投递流程不受影响。</div>
          <div style={{ marginTop: 6 }}>点击本通知前往「设置 → AI / LLM 配置」填写 API Key 即可启用 AI。</div>
        </div>
      ),
      onClick: () => openSettings('llm'),
    });
  }, [llmReady, addLog, openSettings]);

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

      {/* 子模块：欢迎区（hero） */}
      <div className="hero">
        <h2 className="hero-title">欢迎回来，开始今天的投递</h2>
        <p className="hero-sub">
          在右侧浏览器中打开 BOSS 直聘岗位 → 点「加入任务」→ AI 分析评分 → 确认后进入「待投递」队列。首次成功投递后会自动暂停，供你核对沟通对象与内容。
        </p>
        <div className="hero-actions">
          <Button type="primary" size="large" className="btn-uniform-lg" icon={<ThunderboltOutlined />} onClick={() => setRoute('workbench')}>
            打开工作台
          </Button>
          <Button size="large" className="btn-uniform-lg" icon={<ProfileOutlined />} onClick={() => setRoute('tasks')}>
            查看任务进度
          </Button>
          <Button size="large" className="btn-uniform-lg" icon={<BookOutlined />} onClick={handleOpenDoc}>
            阅读使用文档
          </Button>
        </div>
      </div>

      {/* 子模块：数据概览指标卡（今日投递/成功率/待处理岗位/剩余次数） */}
      <div className="short-grid cols-4" style={{ marginBottom: 20 }}>
        <MetricCard
          title="今日投递"
          value={sentToday}
          suffix="次"
          subText={`目标 ${dailyGoal} 次 / 建议分时段投递`}
          icon={<CheckCircleFilled />}
        />
        <MetricCard
          title="成功率"
          value={pending.length > 0 ? Math.round((sentToday / pending.length) * 100) : 0}
          type="success-rate"
          subText={`已处理 ${pending.length} 个岗位 (${selectedCount} 方向)`}
          icon={<BarChartOutlined />}
        />
        <MetricCard
          title="待处理岗位"
          value={stats.pending}
          suffix="个"
          type="pending"
          subText="需要在工作台或「待确认」队列核对"
          icon={<ProfileOutlined />}
        />
        <MetricCard
          title="剩余次数"
          value={Math.max(0, dailyGoal - sentToday)}
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
              已投递 <span style={{ fontWeight: 700, marginLeft: 4 }}>{sentToday}</span>
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
            <Text type="secondary" style={{ fontSize: 12 }}>今日投递目标（各已启用平台合计）</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{sentToday} / {dailyGoal}</Text>
          </div>
          <Progress
            percent={Math.min(100, Math.round((sentToday / Math.max(1, dailyGoal)) * 100))}
            showInfo={false}
            strokeColor={{ from: '#14B8A6', to: '#0D9488' }}
          />
          <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            已按真人作息分时段投递（默认 8:00–23:00 带每日抖动），非活跃时段自动暂停 —— 可在「自动沟通 → 防封号节奏」调整或关闭。
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

      {/* 配置进度 (5 个步骤独占整行 5 列网格；第 1 步为配置 AI 模型) */}
      <div className="soft-block" style={{ padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>配置进度</span>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{progress}%</span>
        </div>
        <Progress percent={progress} showInfo={false} strokeColor={{ from: '#14B8A6', to: '#0D9488' }} />
        <div className="short-grid cols-5" style={{ marginTop: 14 }}>
          {STEPS.map((s, i) => {
            const st = currentStep === -1 || i < currentStep ? 'done' : i === currentStep ? 'current' : 'todo';
            const isDeliveryStep = i === STEPS.length - 1;
            // 第 5 步的 desc 换成本次实际卡在哪的可定位说明（方案 C）：
            // 原来固定写「浏览器 + 人工确认/全自动」，进度停在 80% 时用户无从得知原因。
            const desc = isDeliveryStep && !delivery.delivered && delivery.diagnosis
              ? delivery.diagnosis
              : s.desc;
            // 带 tab 的步骤（配置 AI 模型）直达设置页对应分区；其余按 key 切页
            const go = () => (s.tab ? openSettings(s.tab as SettingsTabKey) : setRoute(s.key as any));
            return (
              <div
                key={s.label}
                className={'step-item is-' + st}
                role="button"
                tabIndex={0}
                onClick={go}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    go();
                  }
                }}
              >
                <span className="step-dot">
                  {st === 'done' ? <CheckCircleFilled style={{ fontSize: 14 }} /> : s.icon}
                </span>
                <div className="step-content">
                  <div className="step-label">{s.label}</div>
                  <div className={isDeliveryStep && !delivery.delivered && delivery.diagnosis ? 'step-desc step-desc-diagnosis' : 'step-desc'}>
                    {desc}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* 归因行：进度未满 100% 时，明确告知「差在哪一步、下一步做什么」——
            步骤条本身只表达 done/todo，无法承载原因，用户此前只能看到进度停在 80% 而不知为何。 */}
        {progress < 100 && (
          <div className="config-progress-hint">
            {delivery.diagnosis && !delivery.delivered && stepStates[STEPS.length - 1] !== 'done'
              ? `还差「工作台投递」这一步：${delivery.diagnosis}`
              : '还有步骤未完成：点上面对应卡片可直接前往'}
          </div>
        )}
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
              // 审查 §四表 24：key 用日志的稳定 id（批次 7 #96 已为 LogEntry 引入），
              // 不用 map 下标 —— 窗口 `slice(-5).reverse()` 每来一条新日志整体位移，
              // 下标 key 会让所有行错位复用（动画/悬停态串到别的行）。
              // 兼容历史持久化数据：缺 id 的旧条目回落 `time-i`（时间戳 + 当前下标，仍比裸下标稳定）。
              <div className="timeline-item" key={l.id ?? `${l.time}-${i}`}>
                <span className={'tl-dot ' + (l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : l.level === 'success' ? 'success' : 'info')} />
                <span className="tl-time">{new Date(l.time).toLocaleTimeString()}</span>
                <span className="tl-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 使用前必读文档抽屉 */}
      <Drawer
        title={
          <span>
            <BookOutlined style={{ color: 'var(--brand)', marginRight: 8 }} />使用前必读
          </span>
        }
        placement="right"
        width={760}
        open={docOpen}
        closable={false}
        onClose={() => setDocOpen(false)}
        styles={{ body: { padding: '16px 24px', overflow: 'auto' } }}
      >
        {docLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip="文档加载中..." />
          </div>
        ) : docText ? (
          <MarkdownView text={docText} />
        ) : (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--fg-muted)' }}>文档加载失败，请稍后重试</div>
        )}
      </Drawer>
    </div>
  );
}
