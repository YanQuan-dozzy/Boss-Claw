import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { Button, Card, Checkbox, Empty, Progress, Tag, Typography, message, Steps, Segmented, Tooltip, Space, Input } from 'antd';
import {
  CheckOutlined, ReloadOutlined, EyeOutlined, SearchOutlined,
  DownOutlined, RightOutlined, StopOutlined, UndoOutlined, ThunderboltOutlined,
  PauseOutlined, CaretRightOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAppStore } from '@/store/useAppStore';
import BrowserView, { NavInfo, WebviewApi } from '@/components/BrowserView';
import { LogConsole } from '@/components/LogConsole';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { analyzeJob } from '@/lib/bossclaw/matching';
import { isLocationExcluded } from '@/lib/bossclaw/locationFilter';
import { isCompanyExcluded } from '@/lib/bossclaw/companyFilter';
import { makePendingItem } from '@/store/useDataStore';
import { PHASE_LABELS, stageToPhase, taskStageMeta } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import { formatMetaLine, cleanTitle } from '@/lib/bossclaw/jobDisplay';
import { meetsHrActivityFilter, HR_ACTIVITY_FILTER_LABEL } from '@/lib/bossclaw/hrActivity';
import { detectInterviewMode } from '@/lib/bossclaw/interviewMode';
import { buildSearchQueue } from '@/lib/bossclaw/searchUrl';
import {
  ActionPacer, effectiveDailyCap, dailySentCount, isLockedOut,
  cooldownRemaining, classifyRiskCode, humanDelayMs, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { resolveCityCode, loadBossCityCodes } from '@/lib/bossclaw/searchUrl';
import { camoufoxSearch, camoufoxSend, camoufoxStatus, isCamoufoxStopCode, isCamoufoxEnvCode, type CamoufoxJob } from '@/lib/bossclaw/camoufox';
import { claimDelivery, isDeliveryClaimed, releaseDelivery } from '@/lib/bossclaw/deliveryLock';
import type { JobMeta, PendingItem, TaskStage } from '@/lib/bossclaw/types';

const { Text } = Typography;

// 与任务状态机对应的可跟踪阶段（webview DOM 兜底投递会回传这些阶段）
const TRACKED_STAGES: TaskStage[] = [
  'queued', 'open_job', 'open_chat', 'verify_chat_target',
  'fill_message', 'send_message', 'verify_message', 'send_resume', 'verify_result',
];

// 「沟通」阶段包含的跟踪阶段：进入这些阶段后若超过阈值无进展，则跳过当前岗位转投下一个
const COMM_PHASE_STAGES: TaskStage[] = ['open_job', 'open_chat', 'verify_chat_target'];

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '确认队列' },
  approved_queue: { color: 'cyan', label: '投递中' },
  approved: { color: 'blue', label: '投递队列' },
  failed: { color: 'red', label: '失败' },
  sent: { color: 'green', label: '已投递' },
  skipped: { color: 'default', label: '已跳过' },
  ignored: { color: 'default', label: '已忽略' },
};

// BOSS 官方接口 friend/add 返回码 → 风控码（17 未登录按 31 归类）
const FRIEND_ADD_RISK_CODES: Record<number, number> = { 17: 31, 31: 31, 32: 32, 35: 35, 36: 36, 37: 37, 38: 38, 1006: 1006 };

const isJobListUrl = (url: string): boolean => {
  try {
    const p = new URL(url).pathname;
    return /^\/web\/geek\/jobs?\/?$/i.test(p) && !/\/job_detail\//i.test(p);
  } catch {
    return false;
  }
};

const LogStream = memo(function LogStream() {
  const logs = useDataStore((s) => s.logs);
  const formattedLogs = useMemo(() => {
    return logs.slice(-80).map((l, i) => ({
      id: `${l.time}-${i}`,
      time: typeof l.time === 'number' ? new Date(l.time).toLocaleTimeString() : String(l.time),
      level: l.level || 'info',
      msg: l.msg,
    }));
  }, [logs]);

  return (
    <LogConsole
      logs={formattedLogs}
      title="消息与日志"
      maxHeight={220}
      className="wb-log-console"
    />
  );
});

// 从简历中心招呼语中挑一条与岗位最匹配的
function pickGreetingForJob(job: JobMeta | undefined | null, greetings: string[]): { greeting: string; index: number; score: number } {
  if (!Array.isArray(greetings) || !greetings.length) return { greeting: '', index: -1, score: 0 };
  const title = String(job?.title || '').toLowerCase();
  const skills = Array.isArray(job?.skills) ? job.skills.join(' ').toLowerCase() : '';
  const haystack = `${title} ${skills}`;
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < greetings.length; i += 1) {
    const g = String(greetings[i] || '').trim();
    if (!g) continue;
    const keywords = g.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
    let score = 0;
    for (const kw of keywords) if (haystack.includes(kw)) score += 1;
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return { greeting: String(greetings[bestIndex] || '').trim(), index: bestIndex, score: bestScore };
}

export default function Workbench() {
  const profile = useDataStore((s) => s.profile);
  const pending = useDataStore((s) => s.pending);
  const addPendingItem = useDataStore((s) => s.addPendingItem);
  const updatePending = useDataStore((s) => s.updatePending);
  const setPending = useDataStore((s) => s.setPending);
  const addLog = useDataStore((s) => s.addLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const config = useSettingsStore((s) => s.config);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const bossLoggedIn = useAppStore((s) => s.bossLoggedIn);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const [running, setRunning] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [applyStage, setApplyStage] = useState<TaskStage | null>(null);
  const [, setNav] = useState<NavInfo>({ url: '', title: '' });
  const [filter, setFilter] = useState('all');
  const [showIgnored, setShowIgnored] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [jobsExpanded, setJobsExpanded] = useState(false);
  const webviewApi = useRef<WebviewApi | null>(null);
  // P02：岗位解析请求的去重占位。extractLock 拒绝并发点击；seq token 让超时兜底不会串到新请求。
  const pendingExtract = useRef<{ resolve: (job: JobMeta) => void; seq: number } | null>(null);
  const extractSeq = useRef(0);
  const extractTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extractLock = useRef(false);
  const searchTriggered = useRef(false);
  const runNextRef = useRef<() => void>(() => {});
  const preferIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<string | null>(null);
  const commStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // P01：runNext 互斥守卫。只允许一个投递循环在途；执行中再有触发则排队，结束后续跑。
  // 解决多入口（running effect / handleDelivered / 失败分支 / 采集）并发进入 runNext，
  // 造成 activeId/applyStage 相互覆盖、看门狗绑错、waitForSlot 并发等待者超发动作预算的问题。
  const runNextLock = useRef(false);
  const runNextQueued = useRef(false);

  // ===== 可视化采集状态（对齐 job-claw-main：逐卡片平滑滚动 + 高亮 + 点击展开详情）=====
  const [visualCollecting, setVisualCollecting] = useState(false);
  const [visualPaused, setVisualPaused] = useState(false);
  const [visualItem, setVisualItem] = useState<{ index: number; total: number; title: string; company: string; status: string; phase: string }>({
    index: 0, total: 0, title: '', company: '', status: '', phase: '',
  });
  const visualActiveRef = useRef(false);
  const visualTabRef = useRef('');
  const collectDoneResolve = useRef<(() => void) | null>(null);
  // P09：collect-progress 高频回传 → rAF 节流 setVisualItem，避免逐条进度整页重渲染
  const visualItemBufRef = useRef<{ index: number; total: number; title: string; company: string; status: string; phase: string }>({ index: 0, total: 0, title: '', company: '', status: '', phase: '' });
  const visualsRafRef = useRef<number | null>(null);
  const visualProcessedRef = useRef(0);

  // ===== Camoufox 隐身采集（可选增强）=====
  const [cfxCollecting, setCfxCollecting] = useState(false);
  const cfxActiveRef = useRef(false);

  // ===== 防封号：限速器 + 投递节奏 =====
  const pacerRef = useRef<ActionPacer>(new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE));
  const lastDeliveryAt = useRef(0);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  useEffect(() => { recomputeStats(); }, [pending, recomputeStats]);

  // P09：卸载时取消未执行的 rAF，避免卸载后 setState
  useEffect(() => () => {
    if (visualsRafRef.current != null) cancelAnimationFrame(visualsRafRef.current);
  }, []);

  const ensureBossLogin = (): boolean => {
    if (bossLoggedIn === true) return true;
    if (bossLoggedIn === false) message.warning('请先在右侧浏览器登录 BOSS 直聘，未登录不能启动');
    else message.warning('正在检测 BOSS 登录状态，请稍候再试');
    return false;
  };

  // ===== 监听全局 autoAssist，自动启停 =====
  useEffect(() => {
    if (autoAssist) {
      const cfg = useSettingsStore.getState().config;
      if (isLockedOut(cfg)) {
        message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟），暂不能启动投递`);
      }
      if (bossLoggedIn !== true) {
        message.warning(bossLoggedIn === false ? '请先在右侧浏览器登录 BOSS 直聘，未登录不能启动' : '正在检测 BOSS 登录状态，请稍候再试');
      }
      if (!profile) message.warning('请先在简历中心生成职业画像');
      if (!directionPlan?.confirmed) message.warning('请先到「投递方向」确认方向');
      if (!running) {
        searchTriggered.current = false;
        setRunning(true);
        addLog('info', '投递已启动');
      }
    } else {
      if (running) {
        visualActiveRef.current = false;
        setVisualCollecting(false);
        setVisualPaused(false);
        cfxActiveRef.current = false;
        setCfxCollecting(false);
        setRunning(false);
        setActiveId(null);
        setApplyStage(null);
        addLog('warn', '已停止投递');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAssist, profile, directionPlan, bossLoggedIn]);

  const handleJobExtracted = useCallback((job: JobMeta) => {
    const cur = pendingExtract.current;
    if (cur) {
      if (extractTimer.current) { clearTimeout(extractTimer.current); extractTimer.current = null; }
      pendingExtract.current = null;
      cur.resolve(job);
    }
  }, []);

  // 页面级登录态实时回传（配合 App.tsx 的 wt2 cookie 权威检测，登录后立即感知）
  const handleLoginState = useCallback((data: any) => {
    if (data && typeof data.loggedIn === 'boolean') {
      const cur = useAppStore.getState().bossLoggedIn;
      if (cur !== data.loggedIn) useAppStore.getState().setBossLoggedIn(data.loggedIn);
    }
  }, []);

  const onJoinTask = async (info: { url: string; title: string }) => {
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return; }
    if (isJobListUrl(info.url)) {
      message.warning('当前是岗位列表页（含多个岗位）。请点击具体岗位进入详情页后，再点「加入任务」加入单个岗位');
      return;
    }
    // P02：拒绝并发点击（一次只允许一个岗位解析在途），并清理上一次兜底定时器
    if (extractLock.current) {
      message.warning('正在解析上一个岗位，请稍候再点「加入任务」');
      return;
    }
    if (extractTimer.current) { clearTimeout(extractTimer.current); extractTimer.current = null; }
    extractLock.current = true;
    const seq = ++extractSeq.current;
    addLog('info', `请求解析岗位：${info.url}`);
    let job: JobMeta;
    try {
      job = await new Promise<JobMeta>((resolve) => {
        pendingExtract.current = { resolve, seq };
        webviewApi.current?.send('extract-job');
        extractTimer.current = setTimeout(() => {
          if (pendingExtract.current && pendingExtract.current.seq === seq) {
            pendingExtract.current.resolve({ url: info.url, title: info.title || '手动添加岗位', description: '' });
            pendingExtract.current = null;
            extractTimer.current = null;
          }
        }, 4000);
      });
    } finally {
      // 兜底：解析已结束（无论成功/超时），清掉可能残留的占位与定时器，并释放并发锁
      if (extractTimer.current) { clearTimeout(extractTimer.current); extractTimer.current = null; }
      if (pendingExtract.current && pendingExtract.current.seq === seq) pendingExtract.current = null;
      extractLock.current = false;
    }

    if ((job as any).isListPage || (job as any).listCardCount > 1) {
      message.warning('当前是岗位列表页（含多个岗位）。请点击具体岗位进入详情页后，再点「加入任务」加入单个岗位');
      return;
    }
    const runId = `task_${Date.now().toString(36)}`;

    const cfg = useSettingsStore.getState().config;
    const hrFilter = cfg.hrActivityFilter || 'any';
    if (hrFilter !== 'any' && !meetsHrActivityFilter(job.hrActive, hrFilter)) {
      addPendingItem({ id: runId, runId, job, status: 'skipped', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '', error: `HR 活跃度「${String(job.hrActive || '未识别').trim()}」不满足设定阈值「${HR_ACTIVITY_FILTER_LABEL[hrFilter]}」，已跳过` });
      addLog('info', `已跳过：${job.title || job.url}（HR 活跃度不满足阈值）`);
      recomputeStats();
      return;
    }
    if (cfg.excludeHeadhunters && job.isHeadhunter) {
      addPendingItem({ id: runId, runId, job, status: 'skipped', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '', error: '该岗位为猎头发布，已按「排除猎头」跳过' });
      addLog('info', `已跳过：${job.title || job.url}（猎头岗位）`);
      recomputeStats();
      return;
    }
    if (isLocationExcluded(job.location, cfg)) {
      addPendingItem({ id: runId, runId, job, status: 'skipped', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '', error: `岗位所在地「${String(job.location || '未知').trim()}」命中「城市反选」排除规则，已跳过` });
      addLog('info', `已跳过：${job.title || job.url}（城市反选排除）`);
      recomputeStats();
      return;
    }
    const bl = isCompanyExcluded(job, cfg);
    if (bl.excluded) {
      addPendingItem({ id: runId, runId, job, status: 'skipped', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '', error: bl.reason });
      addLog('info', `已跳过：${job.title || job.url}（${bl.reason}）`);
      recomputeStats();
      return;
    }
    const imFilterM = cfg.interviewModeFilter || 'any';
    if (imFilterM !== 'any') {
      const modeM = detectInterviewMode(job);
      if (modeM !== 'unknown' && modeM !== imFilterM) {
        const requiredM = modeM === 'offline' ? '线下' : '线上';
        const wantedM = imFilterM === 'online' ? '线上' : '线下';
        addPendingItem({ id: runId, runId, job: { ...job, interviewMode: modeM }, status: 'skipped', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '', error: `岗位要求${requiredM}面试，与设定的「仅${wantedM}」冲突，已跳过` });
        addLog('info', `已跳过：${job.title || job.url}（要求${requiredM}面试）`);
        recomputeStats();
        return;
      }
    }

    try {
      addLog('info', `AI 正在分析岗位：${job.title || job.url}`);
      const customGreetingPrompt = useDataStore.getState().greetingPrompt;
      const analysis = await analyzeJob(job, profile, useDataStore.getState().resumeText, config, config.model, customGreetingPrompt || undefined);
      const item = makePendingItem(job, analysis, analysis.greeting, runId);
      addPendingItem(item);
      addLog(analysis.decision === 'reject' ? 'warn' : 'success', `分析完成：${job.title || ''} 评分 ${analysis.score}（${analysis.decision === 'recommend' ? '推荐' : analysis.decision === 'cautious' ? '谨慎' : '不推荐'}）`);
    } catch (err: any) {
      addPendingItem({ id: runId, runId, job, status: 'pending', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '' });
      addLog('error', `岗位分析失败，已加入待处理：${err?.message || err}`);
    }
    recomputeStats();
  };

  const startDelivery = () => { if (!running) setAutoAssist(true); };

  const onApprove = (id: string, greeting?: string) => {
    const latestPending = useDataStore.getState().pending;
    const target = latestPending.find((p) => p.id === id);
    let finalGreeting = String(greeting ?? target?.deliveryGreeting ?? target?.analysis?.greeting ?? '').trim();
    if (!finalGreeting) {
      const fallback = pickGreetingForJob(target?.job, useDataStore.getState().greetings || []);
      if (fallback.greeting) {
        finalGreeting = fallback.greeting;
        if (target) updatePending(target.id, { deliveryGreeting: finalGreeting });
        addLog('info', `已从简历中心招呼语自动选用（匹配度 ${fallback.score}）`);
      }
    }
    if (!finalGreeting) { message.warning('请先填写求职招呼语，再确认沟通'); return; }
    const next = rerankPending(pending.map((p) => (p.id === id ? { ...p, deliveryGreeting: finalGreeting, status: 'approved' as const, approvedAt: p.approvedAt || Date.now() } : p)));
    setPending(next);
    addLog('info', '已确认沟通，岗位进入投递队列（等待「一键投递」）');
    preferIdRef.current = id;
  };

  const onApproveAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (!waiting.length) { message.info('没有待确认的岗位'); return; }
    const next = rerankPending(pending.map((p) => (p.status === 'pending' ? { ...p, status: 'approved' as const, approvedAt: Date.now() } : p)));
    setPending(next);
    addLog('success', `已批准 ${waiting.length} 个岗位进入投递队列（等待「一键投递」）`);
  };

  const onRejectAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (!waiting.length) { message.info('没有待确认的岗位'); return; }
    setPending(pending.map((p) => (p.status === 'pending' ? { ...p, status: 'ignored' as const } : p)));
    addLog('info', `已忽略 ${waiting.length} 个岗位`);
    recomputeStats();
  };

  const onRetry = (id: string) => {
    const item = pending.find((p) => p.id === id);
    if (item?.riskBlocked) { message.warning('该岗位曾触发平台风控拦截（验证/封禁），禁止重试，请人工核对'); return; }
    updatePending(id, { status: 'pending', retryCount: (item?.retryCount || 0) + 1, error: '', riskBlocked: false });
    addLog('info', '已重置该岗位，可重新分析/投递');
  };

  const onIgnore = (id: string) => updatePending(id, { status: 'ignored' });
  const onSkip = (id: string) => updatePending(id, { status: 'skipped' });

  const onRevert = (id: string) => {
    const next = rerankPending(pending.map((p) => (p.id === id ? { ...p, status: 'pending' as const } : p)));
    setPending(next);
    addLog('info', '已撤回岗位，返回待确认队列');
  };

  const onOneClickDeliver = () => {
    const { next, count } = promoteApprovedToQueue(pending);
    if (!count) { message.info('没有已批准、等待投递的岗位'); return; }
    setPending(next);
    addLog('success', `已将 ${count} 个已批准岗位加入投递中队列，开始投递`);
    if (!running) setAutoAssist(true);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onRetryAllFailed = () => {
    const retryable = pending.filter((p) => p.status === 'failed' && !p.riskBlocked);
    if (!retryable.length) { message.info('没有可重试的失败任务'); return; }
    setPending(pending.map((p) => (p.status === 'failed' && !p.riskBlocked ? { ...p, status: 'approved_queue' as const, retryCount: (p.retryCount || 0) + 1, error: '', riskBlocked: false, approvedAt: Date.now() } : p)));
    addLog('info', `已重新投递 ${retryable.length} 个失败任务`);
    recomputeStats();
    startDelivery();
  };

  const pauseAssist = (reason: string) => {
    visualActiveRef.current = false;
    setVisualCollecting(false);
    setVisualPaused(false);
    setAutoAssist(false);
    setActiveId(null);
    setApplyStage(null);
    addLog('warn', reason);
  };

  const paceDelivery = async (): Promise<boolean> => {
    const cfg = useSettingsStore.getState().config;
    if (isLockedOut(cfg)) {
      pauseAssist(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟），已暂停投递，请勿重复启动以免升级封禁`);
      return false;
    }
    const cap = effectiveDailyCap(cfg);
    const sentToday = dailySentCount(useDataStore.getState().pending);
    if (sentToday >= cap) {
      pauseAssist(`今日已投递 ${sentToday} 条，达到安全上限 ${cap} 条，投递已暂停（避免账号受限）`);
      return false;
    }
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacerRef.current.budget !== pacerMax) pacerRef.current = new ActionPacer(pacerMax);
    await pacerRef.current.waitForSlot();
    const baseSec = Math.max(Number(cfg.betweenJobsSeconds) || SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
    const gapMs = humanDelayMs(baseSec * 1000, 0.35);
    const elapsed = Date.now() - lastDeliveryAt.current;
    const wait = Math.max(0, gapMs - elapsed);
    if (wait > 0) await sleep(wait);
    lastDeliveryAt.current = Date.now();
    return true;
  };

  // ===== 岗位入库（去重 -> 活跃度/猎头/城市过滤 -> AI 分析 -> 入队）=====
  const ingestJob = useCallback(async (job: any): Promise<boolean> => {
    const url = String(job?.url || '').trim();
    const jobId = String(job?.jobId || url.match(/job_detail\/([^/.?#]+)/)?.[1] || '').trim();
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const profile = data.profile;
    if (!profile) return false;
    if (data.pending.some((p) => p.job?.url === url || (jobId && p.job?.jobId === jobId))) return false;
    const hrFilter = cfg.hrActivityFilter || 'any';
    if (hrFilter !== 'any' && !meetsHrActivityFilter(job?.hrActive, hrFilter)) return false;
    if (cfg.excludeHeadhunters && job?.isHeadhunter) {
      addLog('info', `跳过「${job?.title || '岗位'}」（猎头岗位）`);
      return false;
    }
    if (isLocationExcluded(job?.location, cfg)) {
      addLog('info', `跳过「${job?.title || '岗位'}」（所在地命中城市反选排除规则）`);
      return false;
    }
    const bl = isCompanyExcluded(job, cfg);
    if (bl.excluded) {
      addLog('info', `跳过「${job?.title || '岗位'}」（${bl.reason}）`);
      return false;
    }
    const imFilterC = cfg.interviewModeFilter || 'any';
    if (imFilterC !== 'any') {
      const modeC = detectInterviewMode(job);
      if (modeC !== 'unknown' && modeC !== imFilterC) {
        addLog('info', `跳过「${job?.title || '岗位'}」（面试方式与设定冲突）`);
        return false;
      }
    }
    const meta: JobMeta = { ...job, url, jobId, interviewMode: detectInterviewMode(job) };
    try {
      const customGreetingPrompt = useDataStore.getState().greetingPrompt;
      const analysis = await analyzeJob(meta, profile, data.resumeText, cfg, cfg.model, customGreetingPrompt || undefined);
      if (analysis.decision === 'reject' || analysis.score < (cfg.minScore || 0)) {
        addLog('info', `跳过「${meta.title}」（评分 ${analysis.score}，${analysis.decision === 'reject' ? '不推荐' : '低于最低分'}）`);
        return false;
      }
      const runId = `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      const newItem = makePendingItem(meta, analysis, analysis.greeting, runId);
      addPendingItem(newItem);
      addLog('success', `已加入「${meta.title}」（AI ${analysis.score} 分）`);
      return true;
    } catch (err: any) {
      addLog('error', `分析失败「${meta.title}」：${err?.message || err}`);
      return false;
    }
  }, [addPendingItem, addLog]);

  // 提取纯 encryptJobId（对齐旧 webview.cjs 口径）
  const extractEncryptJobId = useCallback((job: JobMeta): string => {
    let jid = String(job.jobId || '').trim();
    const kv = jid.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
    if (kv) jid = kv[1];
    jid = jid.replace(/\.html$/i, '').trim();
    if (jid && !/^https?:/i.test(jid)) return jid;
    const m = String(job.url || '').match(/job_detail\/([^/?#.]+)/i);
    return m ? m[1].replace(/\.html$/i, '') : '';
  }, []);

  // ===== 统一风控处理（API 投递码 / DOM 兜底 risk 事件共用）=====
  const handleRisk = useCallback((code: number | null | undefined, rawMessage: string) => {
    const signal = classifyRiskCode(code);
    const msg = String(rawMessage || signal?.message || '检测到平台风控信号');
    const severity = signal?.severity || 'challenge';
    const cooldownMs = signal?.cooldownMs ?? SAFETY_LIMITS.DEFAULT_COOLDOWN_MS;
    if (activeId) {
      updatePending(activeId, { status: 'failed', error: msg, retryable: signal?.retryable === true, riskBlocked: severity === 'banned' });
    }
    addLog(severity === 'banned' || severity === 'challenge' ? 'error' : 'warn', `风控拦截：${msg}`);
    setApplyStage(null);
    recomputeStats();
    if (severity === 'banned') {
      useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + cooldownMs });
      pauseAssist(`${msg}。已强制暂停并进入冷却 ${Math.ceil(cooldownMs / 60000)} 分钟，请人工处理，切勿重复重试以免升级封禁。`);
    } else if (severity === 'rate_limited') {
      useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + cooldownMs });
      pauseAssist(`${msg}。已暂停并进入退避冷却 ${Math.ceil(cooldownMs / 60000)} 分钟，之后可重新投递。`);
    } else {
      pauseAssist(`${msg}。已暂停投递：若右侧浏览器出现安全验证，请人工完成后再点"重新投递"。`);
    }
  }, [activeId, updatePending, addLog, recomputeStats, pauseAssist]);

  // ===== 投递成功处理（API / DOM 兜底共用）=====
  const handleDelivered = useCallback((candidateId: string, tabId?: string) => {
    updatePending(candidateId, { status: 'sent', error: '', sentAt: Date.now() });
    const c = useDataStore.getState().pending.find((p) => p.id === candidateId);
    addLog('success', `投递成功：${c?.job?.title || ''}（${c?.job?.company || ''}）`);
    setApplyStage(null);
    recomputeStats();
    const cfg = useSettingsStore.getState().config;
    if (cfg.requireSingleJobValidation && !cfg.singleJobValidationCompletedAt) {
      useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
      pauseAssist('首次投递成功，已暂停投递：请核对右侧沟通对象、文字气泡与附件，确认无误后再启动');
      return;
    }
    if (tabId) webviewApi.current?.closeTab(tabId);
    activeTabRef.current = null;
    if (useAppStore.getState().autoAssist) requestRunNext();
  }, [updatePending, addLog, recomputeStats, pauseAssist]);

  // ===== 可视化采集（对齐 job-claw-main：逐卡片滚动 + 高亮 + 点击展开详情）=====
  // 采集进度回传（collect-progress）：更新实时状态面板；phase=done 时入库
  const handleCollectProgress = useCallback((data: any) => {
    // P09：写入缓冲，rAF 节流一次 setVisualItem（合并同一动画帧内的多条进度）
    visualItemBufRef.current = {
      index: Number(data?.index ?? 0),
      total: Number(data?.total ?? 0),
      title: String(data?.title || ''),
      company: String(data?.company || ''),
      status: String(data?.status || ''),
      phase: String(data?.phase || ''),
    };
    if (visualsRafRef.current == null) {
      visualsRafRef.current = requestAnimationFrame(() => {
        visualsRafRef.current = null;
        setVisualItem({ ...visualItemBufRef.current });
      });
    }
    if (data?.phase === 'done' && data?.job) {
      void ingestJob(data.job);
    }
  }, [ingestJob]);

  // 采集完成回传（collect-done）：累计处理数并唤醒本轮导航循环，进入下一个搜索组合
  const handleCollectDone = useCallback((data: any) => {
    const n = Number(data?.processed) || 0;
    if (n > 0) visualProcessedRef.current += n;
    const finish = collectDoneResolve.current;
    if (finish) { collectDoneResolve.current = null; finish(); }
  }, []);

  // 单标签内启动可视化采集，返回由 collect-done 回传 resolve 的 Promise（带超时兜底）
  const visualCollectInTab = useCallback((tabId: string, opts: any): Promise<void> => {
    return new Promise((resolve) => {
      let done = false;
      let timer: any;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (collectDoneResolve.current === finish) collectDoneResolve.current = null;
        resolve();
      };
      collectDoneResolve.current = finish;
      webviewApi.current?.sendInTab(tabId, 'visual-collect', opts);
      const settleMs = Math.max(400, Number(opts.settleMs) || 1200);
      const timeoutMs = Math.min(600000, 30000 + 60 * (settleMs * 2.6));
      timer = setTimeout(() => { if (visualActiveRef.current) finish(); }, timeoutMs);
    });
  }, []);

  // 运行时控制：暂停 / 继续 / 停止 / 调速
  const controlCollect = useCallback((action: 'pause' | 'resume' | 'stop' | 'speed', settleMs?: number) => {
    const tabId = visualTabRef.current;
    if (tabId && webviewApi.current?.hasTab(tabId)) {
      webviewApi.current?.sendInTab(tabId, 'collect-control', action === 'speed' ? { action, settleMs } : { action });
    }
    if (action === 'pause') setVisualPaused(true);
    else if (action === 'resume') setVisualPaused(false);
    else if (action === 'stop') {
      visualActiveRef.current = false;
      setVisualCollecting(false);
      setVisualPaused(false);
    }
  }, []);

  // 可视化采集的可中断等待（每 300ms 检查一次，停止后尽快退出）
  const visualWait = async (ms: number) => {
    const step = 300;
    let waited = 0;
    while (waited < ms && visualActiveRef.current) {
      await sleep(step);
      waited += step;
    }
  };

  const runVisualCollect = async () => {
    if (visualActiveRef.current) return;
    if (!ensureBossLogin()) return;
    const cfg0 = useSettingsStore.getState().config;
    if (isLockedOut(cfg0)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg0) / 60000)} 分钟），暂不能采集`);
      return;
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); return; }
    await loadBossCityCodes();
    const queue = buildSearchQueue(directionPlan, config);
    if (!queue.length) { message.warning('没有可搜索的方向/条件，请先确认投递方向并设置城市/求职类型'); return; }

    const unresolvedCities = [...new Set(queue.map((q) => q.location).filter(Boolean))] as string[];
    const badCities = unresolvedCities.filter((loc) => !resolveCityCode(loc));
    if (badCities.length) {
      addLog('warn', `以下目标城市无法识别，将按 BOSS 当前定位城市搜索（请在「设置-求职条件」核对城市名）：${badCities.join('、')}`);
    }

    visualActiveRef.current = true;
    setVisualCollecting(true);
    setVisualPaused(false);
    setVisualItem({ index: 0, total: 0, title: '', company: '', status: '准备中', phase: '' });
    visualProcessedRef.current = 0;

    // 可视化采集固定使用第一个主标签（滚动/点击全程可见，不随用户切换标签而漂移）
    const collectTabId = webviewApi.current?.getFirstTabId?.() || webviewApi.current?.getActiveTabId?.();
    visualTabRef.current = collectTabId || '';
    if (!collectTabId) {
      visualActiveRef.current = false;
      setVisualCollecting(false);
      message.warning('没有可用标签页，无法启动可视化采集');
      return;
    }

    const collectSpeedMs = Math.max(400, Number(config.collectSpeedMs) || 1200);
    const waitTabReady = async (tabId: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (webviewApi.current?.isPreloadReady?.(tabId)) return true;
        await sleep(200);
      }
      return false;
    };

    addLog('info', `开始可视化采集：共 ${queue.length} 个搜索组合，逐岗位平滑滚动 + 高亮 + 点击展开详情`);
    for (const item of queue) {
      if (!visualActiveRef.current) break;
      addLog('info', `可视化采集「${item.keyword}」· ${item.location || '全国'} · ${item.employmentType || '不限'}`);
      let tabId = collectTabId;
      if (!webviewApi.current?.hasTab(tabId)) {
        const t = webviewApi.current?.getFirstTabId?.() || webviewApi.current?.getActiveTabId?.();
        if (!t) break;
        tabId = t;
        visualTabRef.current = tabId;
      }
      // 先跳转到搜索页链接，等 preload 就绪 + 页面渲染完成
      webviewApi.current?.loadURLInTab(tabId, item.url);
      const ready = await waitTabReady(tabId, 8000);
      if (!ready) { addLog('warn', `「${item.keyword}」搜索页加载超时，跳过该组合`); continue; }
      await visualWait(2500);
      if (!visualActiveRef.current) break;
      await visualCollectInTab(tabId, { settleMs: collectSpeedMs });
      if (!visualActiveRef.current) break;
      await visualWait(800);
    }
    const wasStopped = !visualActiveRef.current;
    const processed = visualProcessedRef.current;
    visualActiveRef.current = false;
    visualTabRef.current = '';
    setVisualCollecting(false);
    setVisualPaused(false);
    setVisualItem((v) => ({ ...v, status: '', phase: '' }));
    recomputeStats();
    addLog(wasStopped ? 'warn' : 'success', `可视化采集${wasStopped ? '已停止' : '完成'}：共处理 ${processed} 个岗位（已按条件过滤入库）`);
    if (useAppStore.getState().autoAssist) requestRunNext();
  };

  // ===== Camoufox 隐身采集（可选增强，保留）=====
  const runCamoufoxCollect = async () => {
    if (cfxActiveRef.current) return;
    const cfg0 = useSettingsStore.getState().config;
    const cfx0 = cfg0.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };
    if (!cfx0.enabled) { message.warning('请在「设置 → Camoufox 隐身引擎」启用后再使用'); return; }
    if (isLockedOut(cfg0)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg0) / 60000)} 分钟），暂不能隐身采集`);
      return;
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return; }
    if (!directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); return; }
    const st = await camoufoxStatus();
    if (!st.ready) { message.warning('Camoufox 引擎未就绪：' + (st.message || '请到设置页检测并安装 camoufox')); return; }
    await loadBossCityCodes();
    const queue = buildSearchQueue(directionPlan, config);
    if (!queue.length) { message.warning('没有可搜索的方向/条件，请先确认投递方向并设置城市/求职类型'); return; }

    cfxActiveRef.current = true;
    setCfxCollecting(true);
    let collectedCount = 0;
    let lastCode: number | null = null;
    addLog('info', `开始 Camoufox 隐身采集：共 ${queue.length} 个搜索组合（指纹伪装：${cfx0.os}，页数：${cfx0.pages}）`);
    for (const item of queue) {
      if (!cfxActiveRef.current) break;
      const cityCode = resolveCityCode(item.location) || '100010000';
      addLog('info', `隐身搜索「${item.keyword}」· ${item.location || '全国'} · ${item.employmentType || '不限'}`);
      try {
        const result = await camoufoxSearch(item.keyword, cityCode, cfx0.pages || 1, cfx0.os);
        if (result.ok && result.jobs?.length) {
          let added = 0;
          for (const j of result.jobs) {
            if (!cfxActiveRef.current) break;
            const ingested = await ingestJob(camoufoxJobToMeta(j));
            if (ingested) added += 1;
            await sleep(600 + Math.random() * 900);
          }
          collectedCount += added;
          addLog('success', `「${item.keyword}」隐身搜索到 ${result.jobs.length} 个岗位，入库 ${added} 个`);
        } else {
          lastCode = result.code ?? null;
          if (isCamoufoxStopCode(lastCode)) {
            addLog('error', `隐身采集命中风控码 ${lastCode}：${result.message || ''}。立即停止并进入冷却，请人工处理。`);
            useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + SAFETY_LIMITS.DEFAULT_COOLDOWN_MS });
            break;
          }
          if (isCamoufoxEnvCode(lastCode)) {
            addLog('error', `隐身采集命中环境异常码 ${lastCode}：${result.message || ''}。请先到「设置 → Camoufox 隐身引擎」扫码登录后再试。`);
            break;
          }
          addLog('warn', `隐身搜索「${item.keyword}」返回空：${result.message || result.error || '无岗位'}`);
        }
      } catch (e: any) {
        addLog('error', `隐身搜索「${item.keyword}」失败：${e?.message || e}`);
        if (isCamoufoxStopCode(lastCode)) break;
      }
      if (cfxActiveRef.current) await sleep(1500 + Math.random() * 1000);
    }
    cfxActiveRef.current = false;
    setCfxCollecting(false);
    recomputeStats();
    addLog(collectedCount > 0 ? 'success' : 'info', `Camoufox 隐身采集结束：共入库 ${collectedCount} 个岗位`);
    if (useAppStore.getState().autoAssist) requestRunNext();
  };

  const camoufoxJobToMeta = (j: CamoufoxJob): JobMeta => ({
    title: j.title,
    company: j.company,
    salary: j.salary,
    location: j.location,
    description: j.description,
    url: j.url,
    jobId: j.jobId,
    skills: Array.isArray(j.skills) ? j.skills : [],
    labels: Array.isArray(j.labels) ? j.labels : [],
    recruiterName: j.recruiterName || '',
    publishTime: '',
  });

  const startCollect = () => {
    if (config.camoufox?.enabled) runCamoufoxCollect();
    else runVisualCollect();
  };

  const stopAllCollect = () => {
    controlCollect('stop');
    cfxActiveRef.current = false;
    setCfxCollecting(false);
    addLog('warn', '已停止采集');
  };

  /** P01：经互斥守卫调度 runNext，所有入口统一走此函数避免并发重叠投递 */
  function requestRunNext() {
    if (runNextLock.current) { runNextQueued.current = true; return; }
    runNextLock.current = true;
    runNextQueued.current = false;
    void (async () => {
      try {
        await runNextRef.current();
      } finally {
        runNextLock.current = false;
        if (runNextQueued.current) {
          runNextQueued.current = false;
          requestRunNext();
        }
      }
    })();
  }

  const runNext = async () => {
    const ranked = rerankPending(useDataStore.getState().pending);
    const candidate =
      (preferIdRef.current && ranked.find((p) => p.id === preferIdRef.current && p.status === 'approved_queue' && !isDeliveryClaimed(p.id))) ||
      ranked.find((p) => p.status === 'approved_queue' && !isDeliveryClaimed(p.id));
    if (candidate) preferIdRef.current = null;
    if (!candidate) {
      if (visualActiveRef.current || cfxActiveRef.current) return;
      if (useSettingsStore.getState().config.executionMode === 'auto' && !searchTriggered.current) {
        searchTriggered.current = true;
        addLog('info', '投递队列为空，开始自动采集岗位');
        startCollect();
        return;
      }
      addLog('info', '队列已空，投递结束');
      setRunning(false);
      setAutoAssist(false);
      return;
    }
    setActiveId(candidate.id);
    setApplyStage('queued');
    addLog('info', `按匹配优先级投递：${candidate.job?.title || '岗位'}（AI ${candidate.analysis?.score || 0} 分）`);
    const url = String(candidate.job?.url || '').trim();
    if (!url) { pauseAssist('岗位缺少详情链接，无法投递'); return; }

    const ok = await paceDelivery();
    if (!ok) return;

    const sendCfg = useSettingsStore.getState().config;
    const cfx0 = sendCfg.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };

    // ===== 通道 1：Camoufox 隐身投递（可选，设置「优先走隐身通道」时）=====
    if (cfx0.enabled && cfx0.prefer) {
      const liveCandidate = useDataStore.getState().pending.find((p) => p.id === candidate.id);
      const greeting = String(liveCandidate?.deliveryGreeting || liveCandidate?.analysis?.greeting || candidate.deliveryGreeting || candidate.analysis?.greeting || '').trim();
      if (!greeting) { pauseAssist('招呼语为空，无法通过 Camoufox 投递，请补充后再试'); return; }
      const jobId = extractEncryptJobId(candidate.job);
      if (!jobId) { pauseAssist('岗位缺少 jobId，无法通过 Camoufox 投递'); return; }
      try {
        setApplyStage('open_job');
        addLog('info', `通过 Camoufox 隐身通道投递：${candidate.job?.title || '岗位'}`);
        const st = await camoufoxStatus();
        if (!st.ready) { pauseAssist('Camoufox 引擎未就绪：' + (st.message || '请到设置页检测')); return; }
        setApplyStage('send_message');
        // 共享占位锁：若该岗位正被后台「自动沟通」投递，则工作台跳过（交给认领方）
        if (!claimDelivery(candidate.id)) {
          addLog('warn', `岗位正由后台「自动沟通」投递，工作台已跳过：${candidate.job?.title || '岗位'}`);
          setApplyStage(null);
          recomputeStats();
          if (useAppStore.getState().autoAssist) requestRunNext();
          return;
        }
        let cfxResult: any;
        try {
          cfxResult = await camoufoxSend(jobId, greeting, cfx0.os);
        } finally {
          releaseDelivery(candidate.id);
        }
        const result = cfxResult;
        if (result.ok && result.sent) {
          handleDelivered(candidate.id);
          return;
        }
        const code = result.code ?? null;
        const msg = result.message || result.error || '投递失败';
        if (isCamoufoxStopCode(code)) {
          updatePending(candidate.id, { status: 'failed', error: msg, retryable: false, riskBlocked: true });
          addLog('error', `Camoufox 投递命中风控码 ${code}：${msg}。立即暂停并进入冷却，请人工处理，切勿重复重试。`);
          useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + SAFETY_LIMITS.DEFAULT_COOLDOWN_MS });
          setApplyStage(null);
          recomputeStats();
          pauseAssist(`${msg}。已强制暂停并进入冷却，请人工核对处理。`);
          return;
        }
        updatePending(candidate.id, { status: 'failed', error: msg });
        addLog('error', `Camoufox 投递失败：${candidate.job?.title || ''}（${msg}）`);
        setApplyStage(null);
        recomputeStats();
        pauseAssist('投递已暂停：Camoufox 投递失败，请人工核对后重试');
        return;
      } catch (e: any) {
        updatePending(candidate.id, { status: 'failed', error: String(e?.message || e) });
        addLog('error', `Camoufox 投递异常：${e?.message || e}`);
        setApplyStage(null);
        recomputeStats();
        pauseAssist('投递已暂停：Camoufox 投递异常，请人工核对后重试');
        return;
      }
    }

    // ===== 投递主通道：BOSS 官方 friend/add.json 接口（去掉沟通窗口 DOM 环节）=====
    const liveCandidate = useDataStore.getState().pending.find((p) => p.id === candidate.id);
    let finalGreeting = String(liveCandidate?.deliveryGreeting || liveCandidate?.analysis?.greeting || candidate.deliveryGreeting || candidate.analysis?.greeting || '').trim();
    if (!finalGreeting) {
      const fallbackGreetings = useDataStore.getState().greetings || [];
      finalGreeting = String(fallbackGreetings[0] || '').trim();
      if (finalGreeting && liveCandidate) updatePending(liveCandidate.id, { deliveryGreeting: finalGreeting });
    }
    if (!finalGreeting) { pauseAssist('招呼语为空，无法投递，请补充后再试'); return; }

    const encryptJobId = extractEncryptJobId(candidate.job);
    if (!encryptJobId) {
      updatePending(candidate.id, { status: 'failed', error: '岗位缺少 jobId，无法通过官方接口投递', retryable: false });
      addLog('error', `投递失败：${candidate.job?.title || ''}（岗位缺少 jobId）`);
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      return;
    }

    const apiTabId = webviewApi.current?.getFirstTabId?.() || webviewApi.current?.getActiveTabId?.();
    if (!apiTabId) {
      updatePending(candidate.id, { status: 'failed', error: '没有可用标签页执行官方接口投递', retryable: true });
      addLog('error', `投递失败：${candidate.job?.title || ''}（没有可用标签页）`);
      setApplyStage(null);
      recomputeStats();
      pauseAssist('投递已暂停：没有可用标签页执行官方接口投递');
      return;
    }

    // 补全招聘方 ID（job/card.json）
    let encryptBossId = String(candidate.job?.encryptUserId || '').trim();
    if (!encryptBossId) {
      const card = await webviewApi.current?.bossApi('jobCard', { encryptJobId }, apiTabId);
      if (card && card.code === 0 && card.data?.zpData?.encryptUserId) {
        encryptBossId = String(card.data.zpData.encryptUserId);
      }
    }

    setApplyStage('open_job');
    addLog('info', `通过 BOSS 官方接口投递：${candidate.job?.title || '岗位'}`);
    // 共享占位锁：与后台「自动沟通」互斥，避免对同一岗位重复投递
    if (!claimDelivery(candidate.id)) {
      addLog('warn', `岗位正由后台「自动沟通」投递，工作台已跳过：${candidate.job?.title || '岗位'}`);
      updatePending(candidate.id, { status: 'approved' }); // 交回后台「自动沟通」（approved 归它处理）
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      return;
    }
    let friendAddResult: any;
    try {
      friendAddResult = await webviewApi.current?.bossApi('friendAdd', { encryptJobId, encryptBossId, greeting: finalGreeting }, apiTabId);
    } finally {
      releaseDelivery(candidate.id);
    }
    const result = friendAddResult;
    if (result && !result.error && result.code === 0) {
      addLog('success', `friend/add 接口返回成功：${candidate.job?.title || ''}`);
      handleDelivered(candidate.id);
      return;
    }
    if (result && !result.error && FRIEND_ADD_RISK_CODES[result.code]) {
      handleRisk(FRIEND_ADD_RISK_CODES[result.code], result.data?.riskCodeMessage || result.data?.message || '');
      return;
    }
    // 未知码 / 网络异常：直接标记失败（可重试），不再走 DOM 沟通窗口
    const errMsg = result?.error
      ? `官方接口请求异常：${result.error}`
      : `官方接口返回未知码 ${result?.code ?? ''}（${result?.data?.message || ''}）`;
    updatePending(candidate.id, { status: 'failed', error: errMsg, retryable: true });
    addLog('error', `投递失败：${candidate.job?.title || ''}（${errMsg}）`);
    setApplyStage(null);
    recomputeStats();
    if (useAppStore.getState().autoAssist) {
      addLog('warn', '继续投递队列中的下一个岗位');
      requestRunNext();
    } else {
      addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
    }
  };

  useEffect(() => { runNextRef.current = runNext; });

  useEffect(() => { loadBossCityCodes().catch(() => {}); }, []);

  useEffect(() => {
    if (running) requestRunNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // ===== 沟通阶段卡住看门狗 =====
  useEffect(() => {
    if (commStuckTimerRef.current) { clearTimeout(commStuckTimerRef.current); commStuckTimerRef.current = null; }
    if (!running || !autoAssist || !activeId) return;
    if (!applyStage || !COMM_PHASE_STAGES.includes(applyStage)) return;
    const stuckId = activeId;
    const item = useDataStore.getState().pending.find((p) => p.id === stuckId);
    const title = item?.job?.title || '岗位';
    const sec = Math.max(10, Number(useSettingsStore.getState().config.commStuckTimeoutSec) || 60);
    addLog('info', `已进入沟通阶段「${taskStageMeta(applyStage).label}」，看门狗启动：若 ${sec} 秒内无进展将跳过该岗位转投下一个`);
    commStuckTimerRef.current = setTimeout(() => {
      const cur = useDataStore.getState().pending.find((p) => p.id === stuckId);
      if (!cur || cur.status !== 'approved_queue') return;
      updatePending(stuckId, { status: 'failed', error: `沟通阶段卡住超过 ${sec} 秒（未进入投递），已跳过该岗位转投下一个`, retryable: true });
      addLog('warn', `沟通卡住超时（>${sec}s），跳过该岗位并继续下一个：${title}`);
      setApplyStage(null);
      recomputeStats();
      if (activeTabRef.current) {
        webviewApi.current?.closeTab(activeTabRef.current);
        activeTabRef.current = null;
      }
      if (useAppStore.getState().autoAssist) requestRunNext();
    }, sec * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyStage, running, autoAssist, activeId]);

  // ===== webview 回传的投递阶段（apply-stage，DOM 兜底投递用）=====
  const handleApplyStage = (stage: string, data: any = {}, tabId?: string) => {
    if (stage === 'log') { addLog('info', String(data?.message || '')); return; }
    const current = useDataStore.getState();
    const active = current.pending.find((p) => p.id === activeId);
    if (!activeId || !active) return;

    if (stage === 'risk') {
      handleRisk(data?.code, data?.message || '');
      return;
    }
    if (stage === 'failed') {
      const error = String(data.error || '投递失败');
      if (data.external === true) {
        updatePending(activeId, { status: 'skipped', error });
        addLog('warn', `已跳过：${active?.job?.title || ''}（${error}）`);
        setApplyStage(null);
        recomputeStats();
        if (running) requestRunNext();
        return;
      }
      updatePending(activeId, { status: 'failed', error });
      addLog('error', `投递失败：${active?.job?.title || ''}（${error}）`);
      setApplyStage(null);
      recomputeStats();
      if (activeTabRef.current) {
        webviewApi.current?.closeTab(activeTabRef.current);
        activeTabRef.current = null;
      }
      if (useAppStore.getState().autoAssist) {
        addLog('warn', '继续投递队列中的下一个岗位');
        requestRunNext();
      } else {
        addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
      }
      return;
    }
    if (stage === 'verify_result') {
      handleDelivered(activeId, tabId);
      return;
    }
    if (TRACKED_STAGES.includes(stage as TaskStage)) {
      setApplyStage(stage as TaskStage);
      const meta = taskStageMeta(stage as TaskStage);
      addLog('info', `${active?.job?.title || '岗位'}：${meta.label}`);
      return;
    }
  };

  const activeItem = pending.find((p) => p.id === activeId) || null;
  const currentPhase = applyStage ? stageToPhase(applyStage) : null;

  const deliveryTasks = useMemo(() => {
    const list: { p: PendingItem; stage: TaskStage; label: string; progress: number }[] = [];
    for (const p of pending) {
      if (p.status === 'approved_queue') {
        const stage: TaskStage = p.id === activeId && applyStage ? applyStage : 'queued';
        const meta = taskStageMeta(stage);
        list.push({ p, stage, label: meta.label, progress: meta.progress });
      } else if (p.status === 'pending') {
        const meta = taskStageMeta('waiting_review');
        list.push({ p, stage: 'waiting_review', label: meta.label, progress: meta.progress });
      } else if (p.status === 'sent') {
        const meta = taskStageMeta('success');
        list.push({ p, stage: 'success', label: meta.label, progress: meta.progress });
      } else if (p.status === 'failed') {
        const meta = taskStageMeta('failed');
        list.push({ p, stage: 'failed', label: meta.label, progress: meta.progress });
      }
    }
    const rank = (t: { p: PendingItem; stage: TaskStage }) => {
      if (t.p.id === activeId) return 0;
      if (t.p.status === 'pending') return 1;
      if (t.p.status === 'approved_queue') return 2;
      if (t.p.status === 'sent') return 3;
      return 4;
    };
    list.sort((a, b) => rank(a) - rank(b) || Number(b.p.approvedAt || b.p.createdAt || 0) - Number(a.p.approvedAt || a.p.createdAt || 0));
    return list;
  }, [pending, activeId, applyStage]);

  const deliveryQueuedCount = deliveryTasks.filter((t) => t.p.status === 'approved_queue' && t.p.id !== activeId).length;
  const deliveryPendingCount = deliveryTasks.filter((t) => t.p.status === 'pending').length;
  const deliverySentCount = deliveryTasks.filter((t) => t.p.status === 'sent').length;
  const deliveryFailedCount = deliveryTasks.filter((t) => t.p.status === 'failed').length;
  const deliveryApprovedCount = pending.filter((p) => p.status === 'approved').length;

  const isHiddenStatus = (status: string) => status === 'ignored' || status === 'skipped';
  const rankedAll = useMemo(() => rerankPending(pending), [pending]);
  const ranked = useMemo(() => {
    const base = filter === 'all' ? rankedAll : rankedAll.filter((p) => p.status === filter);
    return showIgnored ? base : base.filter((p) => !isHiddenStatus(p.status));
  }, [rankedAll, filter, showIgnored]);

  const visibleAllCount = showIgnored ? pending.length : pending.filter((p) => !isHiddenStatus(p.status)).length;
  const WB_FILTERS = [
    { key: 'all', label: `全部 ${visibleAllCount}` },
    { key: 'pending', label: `待确认 ${pending.filter((p) => p.status === 'pending').length}` },
    { key: 'approved', label: `待投 ${pending.filter((p) => p.status === 'approved').length}` },
    { key: 'approved_queue', label: `投递中 ${pending.filter((p) => p.status === 'approved_queue').length}` },
    { key: 'sent', label: `已投 ${pending.filter((p) => p.status === 'sent').length}` },
    { key: 'failed', label: `失败 ${pending.filter((p) => p.status === 'failed').length}` },
  ];

  const hrActiveTag = (p: PendingItem) => {
    const hr = String(p.job?.hrActive || '').trim();
    if (!hr) return null;
    const online = /在线|刚刚活跃/.test(hr);
    return <Tooltip title={`HR 活跃度（页面识别）：${hr}`}><Tag color={online ? 'green' : 'orange'} style={{ margin: 0 }}>{online ? 'HR 在线' : hr.slice(0, 12)}</Tag></Tooltip>;
  };

  const interviewModeTag = (p: PendingItem) => {
    const mode = p.job?.interviewMode;
    if (mode !== 'online' && mode !== 'offline') return null;
    const isOnline = mode === 'online';
    return <Tooltip title={`面试方式（页面识别）：${isOnline ? '线上' : '线下'}`}><Tag color={isOnline ? 'blue' : 'purple'} style={{ margin: 0 }}>{isOnline ? '线上面试' : '线下面试'}</Tag></Tooltip>;
  };

  return (
    <div className="workbench">
      <div className="workbench-center">
        <Card size="small" className="wb-progress-card" title="岗位进度"
          extra={
            <Space size={8}>
              {visualCollecting || cfxCollecting ? (
                <Button size="small" danger icon={<StopOutlined />} onClick={stopAllCollect}>停止采集</Button>
              ) : (
                <Button size="small" type="primary" icon={<SearchOutlined />} onClick={() => { startCollect(); }}>
                  {config.camoufox?.enabled ? '隐身采集' : '搜索采集'}
                </Button>
              )}
            </Space>
          }
          styles={{ body: { padding: 12 } }}>
          <Steps size="small" current={activeItem && currentPhase ? currentPhase.index : -1} items={PHASE_LABELS.map((label) => ({ title: label }))} />

          <div className="wb-progress-stats">
            <div className={'wb-stat' + ((visualCollecting || cfxCollecting) ? ' is-on' : '')}>
              <span className="wb-stat-num">{(visualCollecting || cfxCollecting) ? '●' : '0'}</span>
              <span className="wb-stat-label">搜索中</span>
            </div>
            <div className={'wb-stat' + (deliveryPendingCount ? ' is-on' : '')}>
              <span className="wb-stat-num">{deliveryPendingCount}</span>
              <span className="wb-stat-label">确认队列</span>
            </div>
            <div className={'wb-stat' + (deliveryApprovedCount ? ' is-on' : '')}>
              <span className="wb-stat-num">{deliveryApprovedCount}</span>
              <span className="wb-stat-label">投递队列</span>
            </div>
            <div className={'wb-stat' + (deliveryQueuedCount ? ' is-on' : '')}>
              <span className="wb-stat-num">{deliveryQueuedCount}</span>
              <span className="wb-stat-label">投递中</span>
            </div>
            <div className={'wb-stat' + (deliverySentCount ? ' is-on' : '')}>
              <span className="wb-stat-num">{deliverySentCount}</span>
              <span className="wb-stat-label">已投递</span>
            </div>
            <div className={'wb-stat' + (deliveryFailedCount ? ' is-on' : '')}>
              <span className="wb-stat-num">{deliveryFailedCount}</span>
              <span className="wb-stat-label">失败</span>
            </div>
          </div>

          <div className="delivery-summary" style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
              {deliveryTasks.length > 0
                ? [deliveryQueuedCount && `${deliveryQueuedCount} 个投递中`, deliveryPendingCount && `${deliveryPendingCount} 个确认队列待处理`, deliveryApprovedCount && `${deliveryApprovedCount} 个投递队列待投递`, deliverySentCount && `${deliverySentCount} 个已投递`, deliveryFailedCount && `${deliveryFailedCount} 个失败`].filter(Boolean).join('，') + '。'
                : (visualCollecting || cfxCollecting)
                  ? '正在逐岗位滚动采集，结果将自动加入下方列表…'
                  : '暂无进行中的任务。启动「搜索采集」或开始投递后，这里会实时显示流水线进度。'}
            </Text>
          </div>

          {deliveryFailedCount > 0 && (
            <div style={{ marginTop: 8 }}>
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetryAllFailed}>全部重试失败任务</Button>
            </div>
          )}

          {/* 可视化采集进度（逐岗位滚动 + 高亮 + 点击展开，实时展示，可暂停/继续） */}
          {(visualCollecting || cfxCollecting) && (
            <div className="visual-progress-inline" style={{ marginTop: 10, padding: '8px 12px', background: 'var(--hover-bg)', borderRadius: 8, border: '1px dashed var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Progress
                  size="small"
                  percent={visualItem.total ? Math.round((visualItem.index / visualItem.total) * 100) : 0}
                  style={{ flex: 1 }}
                  strokeColor={{ from: '#13b5ac', to: '#078A83' }}
                />
                <Text style={{ fontSize: 12, flex: '0 0 auto' }}>
                  {visualItem.index || visualItem.total
                    ? `${visualItem.index}/${visualItem.total}`
                    : '准备中…'} {visualItem.title}{visualItem.company ? ` · ${visualItem.company}` : ''}
                </Text>
                <Tag
                  style={{ margin: 0 }}
                  color={
                    visualItem.status === '完成' ? 'green' :
                    visualItem.status === '滚动中' ? 'blue' :
                    visualItem.status === '点击中' ? 'cyan' : 'default'
                  }
                >
                  {cfxCollecting ? '隐身采集中' : (visualItem.status || '准备中')}
                </Tag>
                {visualCollecting && (
                  <Space size={4}>
                    <Button size="small" icon={visualPaused ? <CaretRightOutlined /> : <PauseOutlined />}
                      onClick={() => controlCollect(visualPaused ? 'resume' : 'pause')}>
                      {visualPaused ? '继续' : '暂停'}
                    </Button>
                  </Space>
                )}
              </div>
            </div>
          )}

          {!visualCollecting && !cfxCollecting && !activeItem && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无进行中的岗位" style={{ marginTop: 8 }} />
          )}
          {activeItem && (
            <div className="delivery-task-list">
              <div key={activeItem.id} className={'delivery-task is-' + activeItem.status + ' is-active'}>
                <div className="delivery-task-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="delivery-task-title">{cleanTitle(activeItem.job?.title, activeItem.job?.salary)}</div>
                    <div className="delivery-task-sub">{formatMetaLine(activeItem.job?.company, activeItem.job?.location, activeItem.job?.salary) || '岗位信息处理中'}</div>
                  </div>
                  <Tag color="processing" style={{ margin: 0, flex: '0 0 auto' }}>{currentPhase ? currentPhase.label : '投递中'}</Tag>
                </div>
                <Progress percent={currentPhase ? currentPhase.progress : 0} size="small" strokeColor={{ from: '#13b5ac', to: '#078A83' }} status="active" />
                <div className="delivery-task-meta">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {currentPhase ? currentPhase.label : '准备中'} · {currentPhase ? currentPhase.progress : 0}%
                    {activeItem.retryCount ? ` · 已重试 ${activeItem.retryCount} 次` : ''}
                  </Text>
                </div>
                {activeItem.error && <div className="job-error">⚠ {activeItem.error}</div>}
                <div className="delivery-task-actions delivery-task-actions--single">
                  <Button size="small" icon={<EyeOutlined />} onClick={() => activeItem.job?.url && webviewApi.current?.openInNewTab(activeItem.job.url, activeItem.job?.title)}>打开岗位</Button>
                  <span className="action-spacer" />
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => pauseAssist('用户手动暂停当前投递')}>暂停投递</Button>
                </div>
              </div>
            </div>
          )}
        </Card>

        <div className="wb-filter-section">
          <Segmented
            block
            size="small"
            value={filter}
            onChange={(val) => setFilter(val as string)}
            options={WB_FILTERS.map((f) => ({ value: f.key, label: f.label }))}
          />
          <div className="wb-filter-toolbar">
            <div className="wb-filter-toolbar__left">
              <Checkbox checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)}>显示已忽略/跳过</Checkbox>
            </div>
            <div className="wb-filter-toolbar__right">
              <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={onOneClickDeliver} disabled={!pending.some((p) => p.status === 'approved')}>一键投递</Button>
              <Button size="small" icon={<CheckOutlined />} onClick={onApproveAll}>批量确认</Button>
              <Button size="small" onClick={onRejectAll}>全部忽略</Button>
            </div>
          </div>
        </div>
        <div className="wb-sort-hint">
          <InfoCircleOutlined className="wb-sort-hint__icon" />
          <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.4 }}>
            待确认岗位按 AI 匹配分从高到低排列；确认沟通前可直接修改求职招呼语。
          </Text>
        </div>
        <div className="wb-jobs">
          {ranked.length === 0 ? (
            <div className="soft-block" style={{ padding: '40px 20px', textAlign: 'center' }}>
              <Empty description="暂无任务。在右侧浏览器打开岗位后点「加入任务」" />
            </div>
          ) : (
            <>
              {(jobsExpanded ? ranked : ranked.slice(0, 5)).map((p: PendingItem) => {
                const chip = scoreChip(p.analysis?.score);
                const st = STATUS_TAG[p.status] || { color: 'default', label: p.status };
                const isPending = p.status === 'pending';
                const isExpanded = expandedIds.has(p.id);
                const metaLine = formatMetaLine(p.job?.company, p.job?.location, p.job?.salary, p.job?.url);
                return (
                  <div key={p.id} className={'job-card ' + jobCardStatus(p) + (p.id === activeId ? ' is-active' : '')}>
                    <div className="job-header" role="button" tabIndex={0} aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(p.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(p.id); } }}>
                      <div className="job-header-main">
                        <div className="job-title-row">
                          <div className="job-title">{cleanTitle(p.job?.title, p.job?.salary)}</div>
                          <div className="job-header-badges">
                            {p.priorityRank != null && <span className="score-rank">#{p.priorityRank}</span>}
                            {chip.cls && <span className={'score-chip ' + chip.cls}>{chip.text}</span>}
                            <button className="job-expand-btn" type="button" title={isExpanded ? '收起' : '展开'} onClick={(e) => { e.stopPropagation(); toggleExpanded(p.id); }}>
                              {isExpanded ? <DownOutlined /> : <RightOutlined />}
                            </button>
                          </div>
                        </div>
                        <div className="job-company">{metaLine}</div>
                        <div className="job-meta">
                          {p.analysis && (
                            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                              {p.analysis.decision === 'recommend' ? '推荐' : p.analysis.decision === 'cautious' ? '谨慎' : '不推荐'}
                            </span>
                          )}
                          {hrActiveTag(p)}
                          {interviewModeTag(p)}
                        </div>
                      </div>
                      <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto' }}>{st.label}</Tag>
                    </div>
                    {isExpanded && (
                      <div className="job-body" onClick={(e) => e.stopPropagation()}>
                        {p.analysis?.reason && <div className="job-reason">{p.analysis.reason}</div>}
                        {p.deliveryGreeting || p.analysis?.greeting ? (
                          <div className="job-greeting-editor">
                            <div className="job-greeting-label">{isPending ? '将以求职者身份发送，可直接修改' : '已生成的招呼语，可编辑后重新使用'}</div>
                            <Input.TextArea
                              value={p.deliveryGreeting || p.analysis?.greeting || ''}
                              onChange={(e) => updatePending(p.id, { deliveryGreeting: e.target.value })}
                              autoSize={{ minRows: 3, maxRows: 8 }}
                              placeholder="请输入你希望发送给招聘方的求职招呼语"
                              style={{ fontSize: 12, lineHeight: 1.65 }}
                            />
                          </div>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12, padding: '4px 0' }}>暂无招呼语</Text>
                        )}
                      </div>
                    )}
                    {p.error && <div className="job-error">⚠ {p.error}</div>}
                    <div className="job-actions">
                      {isPending ? (
                        <>
                          <div className="job-actions-right">
                            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApprove(p.id)}>确认沟通</Button>
                          </div>
                          <div className="job-actions-left">
                            <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && webviewApi.current?.openInNewTab(p.job.url, p.job?.title)}>打开</Button>
                            <Button size="small" onClick={() => onIgnore(p.id)}>忽略</Button>
                          </div>
                        </>
                      ) : p.status === 'approved' ? (
                        <>
                          <div className="job-actions-right">
                            <Button size="small" icon={<UndoOutlined />} onClick={() => onRevert(p.id)}>撤回</Button>
                          </div>
                          <div className="job-actions-left">
                            <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && webviewApi.current?.openInNewTab(p.job.url, p.job?.title)}>打开</Button>
                            <Button size="small" onClick={() => onIgnore(p.id)}>忽略</Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="job-actions-left">
                            {p.status === 'sent' ? (
                              <Button size="small" type="primary" icon={<CheckOutlined />} disabled>已投递</Button>
                            ) : (
                              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApprove(p.id)}>批准</Button>
                            )}
                            <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(p.id)} disabled={p.status === 'sent'}>重试</Button>
                          </div>
                          <div className="job-actions-right">
                            <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && webviewApi.current?.openInNewTab(p.job.url, p.job?.title)}>打开</Button>
                            <Button size="small" onClick={() => onIgnore(p.id)} disabled={p.status === 'sent'}>忽略</Button>
                            <Button size="small" onClick={() => onSkip(p.id)} disabled={p.status === 'sent'}>跳过</Button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {ranked.length > 5 && (
                <div className="job-expand-bar">
                  <Button size="small" type="link" onClick={() => setJobsExpanded((v) => !v)}>
                    {jobsExpanded ? '收起' : `展开其余 ${ranked.length - 5} 个岗位`}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <LogStream />
      </div>

      <div className="workbench-right">
        <BrowserView
          onNavigate={setNav}
          onJoinTask={onJoinTask}
          onJobExtracted={handleJobExtracted}
          onApplyStage={handleApplyStage}
          onLoginState={handleLoginState}
          onCollectProgress={handleCollectProgress}
          onCollectDone={handleCollectDone}
          apiRef={webviewApi}
        />
      </div>
    </div>
  );
}
