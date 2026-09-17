import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { Button, Card, Empty, Progress, Tag, Typography, message, Segmented, Tooltip, Space, Input, Select, Alert } from 'antd';
import {
  CheckOutlined, ReloadOutlined, EyeOutlined, SearchOutlined,
  StopOutlined, UndoOutlined, ThunderboltOutlined,
  PauseOutlined, CaretRightOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import { useDataStore, type LogLevel } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAppStore } from '@/store/useAppStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import BrowserView, { NavInfo, WebviewApi } from '@/components/BrowserView';
import PlatformChip from '@/components/PlatformChip';
import { ChevronDown } from '@/components/ChevronDown';
import { LogConsole } from '@/components/LogConsole';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { analyzeJob, resolveQueueMinScore } from '@/lib/bossclaw/matching';
import { fitLevelLabel } from '@/lib/bossclaw/fitLevel';
import { isLocationExcluded } from '@/lib/bossclaw/locationFilter';
import { isCompanyExcluded } from '@/lib/bossclaw/companyFilter';
import { isJdKeywordExcluded } from '@/lib/bossclaw/jdKeywordFilter';
import { makePendingItem, jobUrlKey } from '@/store/useDataStore';
import { checkBossLogin } from '@/lib/bossLogin';
import { stageToPhase, taskStageMetaFor } from '@/lib/bossclaw/taskState';
import { jobCardStatus, scoreChip } from '@/lib/bossclaw/statusMeta';
import { formatMetaLine, cleanTitle, decodeSalaryDigits } from '@/lib/bossclaw/jobDisplay';
import { meetsHrActivityFilter, HR_ACTIVITY_FILTER_LABEL } from '@/lib/bossclaw/hrActivity';
import { detectInterviewMode } from '@/lib/bossclaw/interviewMode';
import { detectWorkSchedule } from '@/lib/bossclaw/workSchedule';
import { buildSearchQueue } from '@/lib/bossclaw/searchUrl';
import { buildPlatformSearchQueue, describePlatformCriteria, type PlatformSearchQueueItem } from '@/lib/bossclaw/platformUrls';
import { collectFaultScope, platformEnabled, platformLabel, sortedEnabledPlatforms, type JobPlatform } from '@/lib/bossclaw/platforms';
import {
  ActionPacer, effectiveDailyCapFor, dailySentCountFor, isLockedOut,
  cooldownRemaining, classifyRiskCode, humanDelayMs, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { resolveCityCode, loadBossCityCodes } from '@/lib/bossclaw/searchUrl';
import { camoufoxSearch, camoufoxSend, camoufoxStatus, isCamoufoxStopCode, isCamoufoxEnvCode, type CamoufoxJob } from '@/lib/bossclaw/camoufox';
import { claimDelivery, isDeliveryClaimed, releaseDelivery } from '@/lib/bossclaw/deliveryLock';
import type { JobMeta, PendingItem, TaskRun, TaskStage } from '@/lib/bossclaw/types';
import { useAutoChatStore } from '@/store/useAutoChatStore';
import { createAnalysisQueue, type AnalysisQueueStats } from '@/lib/bossclaw/analysisQueue';

const { Text } = Typography;

// 与任务状态机对应的可跟踪阶段（webview DOM 兜底投递会回传这些阶段）
const TRACKED_STAGES: TaskStage[] = [
  'queued', 'open_job', 'open_chat', 'verify_chat_target',
  'fill_message', 'send_message', 'verify_message', 'send_resume', 'verify_result',
];

// 「沟通」阶段包含的跟踪阶段：进入这些阶段后若超过阈值无进展，则跳过当前岗位转投下一个
const COMM_PHASE_STAGES: TaskStage[] = ['open_job', 'open_chat', 'verify_chat_target'];

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待确认' },
  approved_queue: { color: 'cyan', label: '投递中' },
  approved: { color: 'blue', label: '待投递' },
  failed: { color: 'red', label: '失败' },
  sent: { color: 'green', label: '已投递' },
  skipped: { color: 'default', label: '已跳过' },
  ignored: { color: 'default', label: '已忽略' },
};

const isJobListUrl = (url: string): boolean => {
  try {
    const p = new URL(url).pathname;
    return /^\/web\/geek\/jobs?\/?$/i.test(p) && !/\/job_detail\//i.test(p);
  } catch {
    return false;
  }
};

// 详情页判定：URL 命中岗位详情格式（job_detail 等）一律视为单个岗位，放行「加入任务」，
// 即便 webview 返回的 listCardCount>1（详情页「相关推荐」区块的卡片会被误统计）也不拦截。
const isJobDetailUrl = (url: string): boolean => /job_detail|jobdetail|\/job\/\d+/i.test(String(url || ''));

// 归一化岗位链接：详情页 URL 去掉 query（如 ?securityId=...）与 hash，统一为 …/job_detail/xxx.html 形式，
// 供「加入任务」守卫与入库使用（避免带 securityId 的完整链接干扰判定与投递）。
const normalizeJobUrl = (url: string): string => {
  const s = String(url || '');
  return isJobDetailUrl(s) ? s.split(/[?#]/)[0] : s;
};

// ===== 采集 → 任务进度 联动 =====
// 采集按「搜索组合（方向 × 关键词 × 城市 × 求职类型）」逐条执行，每条对应「任务进度」页一张任务卡片。
// 任务 id 由「平台 + 组合内容」稳定派生：同一组合重复采集只更新同一条任务，不会无限堆卡片；
// 前缀 cr_ 用于把「采集任务」与「基于投递方向新建的任务」区分开（两者共用 taskRuns 数据源）。
const COLLECT_RUN_PREFIX = 'cr_';
const collectRunId = (platform: JobPlatform, item: { keyword?: string; location?: string; employmentType?: string }): string =>
  `${COLLECT_RUN_PREFIX}${platform}_${[item.keyword, item.location, item.employmentType]
    .map((v) => String(v || '').trim().toLowerCase())
    .join('_')}`;
const isCollectRunId = (id: string): boolean => String(id || '').startsWith(COLLECT_RUN_PREFIX);

/**
 * 定向采集过滤（「任务进度」页点「开始/继续」重跑单个搜索组合时使用）：
 * runIds 为空/缺省 = 原样返回（整批采集）；否则只保留 runId 命中项。
 */
const filterQueueByRunIds = <T extends { keyword?: string; location?: string; employmentType?: string }>(
  platform: JobPlatform,
  queue: T[],
  runIds?: string[]
): T[] => {
  if (!runIds?.length) return queue;
  const wanted = new Set(runIds);
  return queue.filter((item) => wanted.has(collectRunId(platform, item)));
};

/** 从定向 runId 反推目标平台（runId 形如 cr_<platform>_…，平台名不含下划线，parts[1] 即平台）。 */
const KNOWN_PLATFORMS: JobPlatform[] = ['boss', 'liepin', 'zhaopin', 'job51'];
const platformsFromRunIds = (runIds: string[]): JobPlatform[] => {
  const found = new Set<JobPlatform>();
  for (const id of runIds) {
    const p = String(id).split('_')[1] as JobPlatform;
    if (KNOWN_PLATFORMS.includes(p)) found.add(p);
  }
  return [...found];
};

// ===== 无关键字采集（随机岗位推荐）展示与提醒口径 =====
// 该模式由「设置 → 搜索采集范围控制 → 无关键字采集」开启：采集 URL 只去掉 query（关键词），
// 城市 / 求职类型 / 经验 / 学历 / 薪资 / 公司规模仍按用户设置保留，岗位由平台按账号内的求职意向推荐。
const RANDOM_KEYWORD_LABEL = '随机推荐';
/** 日志 / 提示中统一的关键词口径：空关键词不显示为空引号，而显示「随机推荐」 */
const keywordLabel = (keyword?: string): string => String(keyword || '').trim() || RANDOM_KEYWORD_LABEL;
/** 无关键字采集前置提醒（该模式下每次启动采集都会记一条日志，并在岗位进度卡内常驻显示） */
const NO_KEYWORD_SETUP_REMINDER =
  '无关键字采集：岗位由平台按你账号内的求职意向推荐，请先在 BOSS 直聘（网页 / App）内完善在线简历与求职意向，否则可能采到不相关岗位或空结果';
/** BOSS 在线简历 / 求职意向页（提醒条上的直达入口） */
const BOSS_RESUME_URL = 'https://www.zhipin.com/web/geek/resume';

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
  // 采集任务联动：与「任务进度」页共用 taskRuns（采集时写入，任务进度页实时出现卡片）
  const taskRuns = useDataStore((s) => s.taskRuns);
  const upsertTaskRun = useDataStore((s) => s.upsertTaskRun);
  const updateTaskRun = useDataStore((s) => s.updateTaskRun);
  const config = useSettingsStore((s) => s.config);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const bossLoggedIn = useAppStore((s) => s.bossLoggedIn);
  const browserLoginRequest = useAppStore((s) => s.browserLoginRequest);
  const clearBrowserLogin = useAppStore((s) => s.clearBrowserLogin);
  const setRoute = useAppStore((s) => s.setRoute);
  const directionPlan = useDataStore((s) => s.directionPlan);
  // 定时任务「采集」请求（调度器置位，常驻本组件消费后清除；携带目标平台）
  const collectRequest = useScheduleStore((s) => s.collectRequest);
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
  const activeTabRef = useRef<string | null>(null);
  const commStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BOSS DOM 投递结果等待槽：runNext 打开岗位下发 start-apply 后挂起，等 handleApplyStage 回写终态
  // （verify_result→success / risk / failed / external→skip），避免 fire-and-forget 造成 runNext 反复重入与日志重复。
  const domWaitRef = useRef<((mode: 'success' | 'risk' | 'failed' | 'skip' | 'timeout' | 'continue_chat', payload: any, tabId?: string) => void) | null>(null);
  // 最近一次记录的投递阶段（用于进度日志去重：同一阶段反复回传时只记一条，避免刷屏）
  const lastApplyStageRef = useRef<TaskStage | ''>('');
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
  // 每批采集是否已打过「列表就绪」日志（webview 对每个搜索组合/重试都会发 list-ready，只取首个，避免刷屏）
  const collectListReadyLoggedRef = useRef(false);
  // 本次会话已处理过的岗位 URL（无论入库还是被跳过），避免同一卡片被采集循环重复 analyze/打重复日志
  const ingestedSeenRef = useRef<Set<string>>(new Set());
  // 可视化采集：该平台未登录 / 登录态已失效（由页内 loginWallDetected() 回传 login-required）。
  // 属「平台级」故障 —— 只收口本平台本批剩余搜索组合，其余平台照常采集（与 collectFaultScope 口径一致）。
  const visualLoginBlockedRef = useRef('');
  // 采集岗位福利后台补全（对齐「加入任务」同源 card.json welfareList），异步执行不阻塞采集循环
  const enrichWelfareRef = useRef<(id: string, job: JobMeta) => void>(() => {});
  // 采集 AI 分析有界并发队列：可视化采集对每张卡片 fire-and-forget 调 ingestJob，而单次
  // analyzeJob（LLM 评分）常需 10-45s，远慢于采集滚动节奏（默认 1.5s/卡），且 LLM 缓存只对
  // 「完全相同 key」去重、不同岗位不可合并 → 不控并发会无界堆积 LLM 请求（易触发上游限流）。
  // 这里把突发放进受控队列（默认并发 3，config.analysisConcurrency 可调，1-8），
  // 并订阅计数供 UI 展示「分析中 / 排队中」；手动「加入任务」路径有 P02 单解析锁，不经过此队列。
  const analysisQueueRef = useRef<ReturnType<typeof createAnalysisQueue> | null>(null);
  const [analysisStats, setAnalysisStats] = useState<AnalysisQueueStats>({ running: 0, queued: 0 });
  useEffect(() => {
    const cfg = useSettingsStore.getState().config;
    const q = createAnalysisQueue(Number(cfg.analysisConcurrency) || 3);
    analysisQueueRef.current = q;
    const off = q.onChange(setAnalysisStats);
    return () => {
      off();
      q.dispose();
      analysisQueueRef.current = null;
    };
  }, []);
  // 跳过日志合并：连续同因跳过只打一条，切换原因时再补「同类跳过 ×N」，避免刷屏
  const lastSkipLogRef = useRef<{ msg: string; count: number } | null>(null);
  const flushLastSkipLog = () => {
    const cur = lastSkipLogRef.current;
    if (!cur) return;
    if (cur.count > 1) addLog('info', `${cur.msg}（同因跳过 ×${cur.count}）`);
    lastSkipLogRef.current = null;
  };
  const addSkipLogOnce = useCallback((level: LogLevel, msg: string) => {
    const cur = lastSkipLogRef.current;
    if (cur && cur.msg === msg) { cur.count += 1; return; }
    flushLastSkipLog();
    lastSkipLogRef.current = { msg, count: 1 };
    addLog(level, msg);
  }, [addLog]);

  // ===== Camoufox 隐身采集（可选增强）=====
  const [cfxCollecting, setCfxCollecting] = useState(false);
  const cfxActiveRef = useRef(false);

  // ===== 多平台适配：当前搜索/采集平台（多选；至少保留一个；仅显示已启用平台，按平台优先级排序）=====
  const enabledPlatforms = useMemo<JobPlatform[]>(() => sortedEnabledPlatforms(config), [config]);
  const [searchPlatforms, setSearchPlatforms] = useState<JobPlatform[]>(() => {
    const enabled = sortedEnabledPlatforms(config);
    return enabled.length ? [enabled[0]] : ['boss'];
  });
  // 用户全部取消/所选平台全部被禁用时，自动回填第一个已启用平台，保证至少有一个
  const handleSearchPlatformsChange = useCallback((vals: JobPlatform[]) => {
    if (!vals.length) {
      const first = sortedEnabledPlatforms(config)[0];
      if (first) {
        message.info(`至少选择一个平台，已自动回填到「${platformLabel(first)}」`);
        setSearchPlatforms([first]);
      } else {
        setSearchPlatforms([]);
      }
      return;
    }
    setSearchPlatforms(vals);
  }, [config]);
  useEffect(() => {
    // 设置页关闭了某些平台 → 从已选项里剔除失效项
    const filtered = searchPlatforms.filter((p) => platformEnabled(config, p));
    if (filtered.length !== searchPlatforms.length) {
      if (filtered.length === 0) {
        const first = sortedEnabledPlatforms(config)[0];
        setSearchPlatforms(first ? [first] : []);
      } else {
        setSearchPlatforms(filtered);
      }
    }
  }, [config, searchPlatforms]);

  // ===== 防封号：限速器 + 投递节奏 =====
  const pacerRef = useRef<ActionPacer>(new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE));
  const lastDeliveryAt = useRef(0);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  useEffect(() => { recomputeStats(); }, [pending, recomputeStats]);

  // P09：卸载时取消未执行的 rAF，避免卸载后 setState
  useEffect(() => () => {
    if (visualsRafRef.current != null) cancelAnimationFrame(visualsRafRef.current);
  }, []);

  const ensureBossLogin = async (): Promise<boolean> => {
    let v = useAppStore.getState().bossLoggedIn;
    if (v !== true) {
      // 权威复核：缓存态可能因「DOM 误报 / 启动时序」停留在 false，现场重读 wt2 cookie 再定
      try { v = await checkBossLogin(); useAppStore.getState().setBossLoggedIn(v); } catch { v = false; }
    }
    if (v) return true;
    message.warning(v === false ? '请先在右侧浏览器登录 BOSS 直聘，未登录不能启动' : '正在检测 BOSS 登录状态，请稍候再试');
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

  // 页面级登录态实时回传（配合 App.tsx 的 wt2 cookie 权威检测，登录后立即感知）。
  // 注意：页内 DOM 选择器检测在列表页/加载中/安全验证等场景会误报 false，而权威检测是主进程读 wt2 cookie（每 10s 心跳）。
  // 因此这里**只允许升级到「已登录」**，绝不因页内误报把权威已确认的 true 降回 false（降回由 App/现场复核负责）。
  const handleLoginState = useCallback((data: any) => {
    if (data && data.loggedIn === true) {
      if (useAppStore.getState().bossLoggedIn !== true) useAppStore.getState().setBossLoggedIn(true);
    }
  }, []);

  const onJoinTask = async (info: { url: string; title: string }) => {
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return; }
    const cleanUrl = normalizeJobUrl(info.url);
    if (isJobListUrl(cleanUrl)) {
      message.warning('当前是岗位列表页（含多个岗位）。请点击具体岗位进入详情页后，再点「加入任务」加入单个岗位');
      return;
    }
    // 同链接查重：记录已入队的同岗位（供解析后原地刷新或跳过重复，不直接早退，
    // 以便「已入队但信息错误」的旧卡能用本次权威解析数据自愈）
    const dupId = cleanUrl ? useDataStore.getState().pending.find((p) => jobUrlKey(p.job) === cleanUrl.toLowerCase())?.id : undefined;
    // P02：拒绝并发点击（一次只允许一个岗位解析在途），并清理上一次兜底定时器
    if (extractLock.current) {
      message.warning('正在解析上一个岗位，请稍候再点「加入任务」');
      return;
    }
    if (extractTimer.current) { clearTimeout(extractTimer.current); extractTimer.current = null; }
    extractLock.current = true;
    const seq = ++extractSeq.current;
    addLog('info', `请求解析岗位：${cleanUrl}`);
    let job: JobMeta;
    try {
      job = await new Promise<JobMeta>((resolve) => {
        pendingExtract.current = { resolve, seq };
        // 必须发给「当前激活标签」（与 info.url 所在标签一致）：send() 默认只发主/采集标签，
        // 若用户在多标签里于 detail 标签打开岗位，主标签会停留在其它页面，导致抓到错误岗位（如把本页抓成别的岗位）。
        const api = webviewApi.current;
        const tabId = api?.getActiveTabId?.() || api?.getMainTabId?.() || '';
        if (api?.sendInTab && tabId) api.sendInTab(tabId, 'extract-job');
        else api?.send('extract-job');
        extractTimer.current = setTimeout(() => {
          if (pendingExtract.current && pendingExtract.current.seq === seq) {
            pendingExtract.current.resolve({ url: cleanUrl, title: info.title || '手动添加岗位', description: '' });
            pendingExtract.current = null;
            extractTimer.current = null;
          }
        }, 10000);
      });
    } finally {
      // 兜底：解析已结束（无论成功/超时），清掉可能残留的占位与定时器，并释放并发锁
      if (extractTimer.current) { clearTimeout(extractTimer.current); extractTimer.current = null; }
      if (pendingExtract.current && pendingExtract.current.seq === seq) pendingExtract.current = null;
      extractLock.current = false;
    }

    if (!isJobDetailUrl(cleanUrl) && ((job as any).isListPage || (job as any).listCardCount > 1)) {
      message.warning('当前是岗位列表页（含多个岗位）。请点击具体岗位进入详情页后，再点「加入任务」加入单个岗位');
      return;
    }
    // 归一后再入库：job.url 也可能带 securityId 等 query，统一精简为 …/job_detail/xxx.html
    job = { ...job, url: normalizeJobUrl(job.url || cleanUrl) };
    const runId = `task_${Date.now().toString(36)}`;
    // 同链接查重：已入队的同岗位对象（供「快路径跳过 + 自愈/刷新」共用，避免重复查找）
    const dup = dupId ? useDataStore.getState().pending.find((p) => p.id === dupId && jobUrlKey(p.job) === cleanUrl.toLowerCase()) : undefined;

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

    // 快路径：该岗位已入队，且旧卡完整、本次解析也完整且字段一致 → 立即提示已存在，
    // 跳过冗余的 AI 分析（避免重复消耗 LLM 调用与等待，也让「已存在」提醒即时可见）。
    if (dup) {
      const oldF = dup.job || {};
      if (
        oldF.title && oldF.company && oldF.location && oldF.salary
        && job.title && job.company && job.location && job.salary
        && oldF.title === job.title && oldF.company === job.company && oldF.salary === job.salary && oldF.location === job.location
      ) {
        message.info('该岗位已在队列中');
        addLog('info', '该岗位已在队列中，信息一致，跳过重复加入');
        recomputeStats();
        return;
      }
    }

    // 新岗位解析无任何有效元信息（公司/地点/薪资全缺，即「待补全」态）：不入队、明确提示。
    // 避免直接生成无法投递的「信息补全」卡（解析失败多为页面未加载完成/未登录/被风控拦截，页面正常后重试即可）。
    if (!dup && !job.company && !job.location && !job.salary) {
      const diag = (job as any).parseDiag || (job as any).error || '';
      message.warning('岗位信息解析不全（页面可能未加载完成或需先登录）。请确认已打开岗位详情页、页面加载完成后重新点「加入任务」');
      addLog('warn', `解析信息不全，未加入队列：${job.title || job.url}${diag ? `（${String(diag).slice(0, 220)}）` : ''}`);
      recomputeStats();
      return;
    }

    try {
      addLog('info', `AI 正在分析岗位：${job.title || job.url}`);
      const customGreetingPrompt = useDataStore.getState().greetingPrompt;
      const analysis = await analyzeJob(job, profile, useDataStore.getState().resumeText, config, config.model, customGreetingPrompt || undefined);
      const item = makePendingItem(job, analysis, analysis.greeting, runId);
      // 同链接查重+自愈：若该岗位已入队，绝不叠卡，且一律提醒「已在队列」。
      // 信息处置三原则：
      //  1) 本次解析不全（提取失败/10s 超时兜底/风控码）且旧卡完整 → 保留旧卡完整信息，绝不降级成「补全」；
      //  2) 旧卡「信息不全」（公司/地点/薪资任一缺失，即待补全态）且本次解析完整 → 用本次权威解析原地自愈补齐；
      //  3) 新旧都完整但字段不一致 → 以本次详情页权威解析刷新（避免旧卡信息不对却永不自愈）。
      if (dup) {
        const old = dup.job || {};
        const oldIncomplete = !old.title || !old.company || !old.location || !old.salary;
        const newIncomplete = !job.title || !job.company || !job.location || !job.salary;
        const fieldsSame = old.title === job.title && old.company === job.company && old.salary === job.salary && old.location === job.location;
        if (newIncomplete && !oldIncomplete) {
          // 新解析不全 + 旧卡完整：保留旧卡，仅提醒已存在（禁止把完整信息降级为补全）
          message.info('该岗位已在队列中');
          addLog('info', `该岗位已在队列中，保留原完整信息（本次解析信息不全，不覆盖）：${old.title || old.company || '岗位'}`);
          recomputeStats();
          return;
        }
        if (newIncomplete) {
          // 新旧都信息不全：不覆盖，仅提醒已存在（补全仍需重新「加入任务」等解析成功）
          message.info('该岗位已在队列中');
          addLog('info', '该岗位已在队列中（新旧解析均信息不全），跳过重复加入');
          recomputeStats();
          return;
        }
        if (oldIncomplete) {
          // 旧卡不全 + 本次解析完整：原地自愈补齐
          setPending(useDataStore.getState().pending.map((p) => (p.id === dup.id ? { ...p, job, analysis, deliveryGreeting: String(analysis.greeting || p.deliveryGreeting || '').trim() } : p)));
          message.success('该岗位已在队列中，已补齐公司/地点/薪资信息');
          addLog('info', `已补齐同链接旧卡信息：${job.title || ''}（原：${old.title || old.company || '未知'}）`);
          recomputeStats();
          return;
        }
        if (!fieldsSame) {
          // 新旧都完整但字段不一致：以本次详情页权威解析刷新
          setPending(useDataStore.getState().pending.map((p) => (p.id === dup.id ? { ...p, job, analysis, deliveryGreeting: String(analysis.greeting || p.deliveryGreeting || '').trim() } : p)));
          message.info('该岗位已在队列中，已刷新为最新信息');
          addLog('info', `已刷新同链接旧卡为网页权威信息：${job.title || ''}（原：${old.title || old.company || '未知'}）`);
          recomputeStats();
          return;
        }
        message.info('该岗位已在队列中');
        addLog('info', '该岗位已在队列中，信息一致，跳过重复加入');
        recomputeStats();
        return;
      }
      addPendingItem(item);
      const scoreSrc = analysis.scoreSource === 'local' ? '本地' : 'AI';
      addLog(analysis.decision === 'reject' ? 'warn' : 'success', `分析完成：${job.title || ''} ${scoreSrc}评分 ${analysis.score}（${analysis.decision === 'recommend' ? '推荐' : analysis.decision === 'cautious' ? '谨慎' : '不推荐'}）`);
    } catch (err: any) {
      // 分析失败但解析仍无有效元信息 → 不入队（与上面的「解析信息不全」拦截口径一致）
      if (!job.company && !job.location && !job.salary) {
        message.warning('岗位信息解析不全（页面可能未加载完成或需先登录）。请确认已打开岗位详情页后重新点「加入任务」');
        addLog('warn', `解析信息不全，未加入队列：${job.title || job.url}（${String((err as Error)?.message || err).slice(0, 160)}）`);
      } else {
        addPendingItem({ id: runId, runId, job, status: 'pending', createdAt: Date.now(), retryCount: 0, deliveryGreeting: '' });
        addLog('error', `岗位分析失败，已加入待处理：${err?.message || err}`);
      }
    }
    recomputeStats();
  };

  const startDelivery = () => { if (!running) setAutoAssist(true); };

  // 批准即入队（approved_queue = 「投递中」）：点「批准」直接进投递队列，不再经过
  // 「待投递」中间态、也不必再点一次「一键投递」。招呼语非空校验保持不变（无招呼语仍拒绝批准）。
  // 引擎启动策略：仅当投递引擎已在运行时新岗位自动排队；引擎停着时不擅自启动
  // （避免「随手批准一下」就把投递打开）。首次启动仍由用户点「开始投递」。
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
    const next = rerankPending(pending.map((p) => (p.id === id ? { ...p, deliveryGreeting: finalGreeting, status: 'approved_queue' as const, approvedAt: p.approvedAt || Date.now() } : p)), useSettingsStore.getState().config);
    setPending(next);
    addLog('info', '已批准并加入「投递中」队列，将按匹配分与平台优先级投递');
    // 只在引擎已运行时续跑；同时刻可能有多个岗位被批准，runNext 内部有重入锁（runNextLock/runNextQueued）
    if (useAppStore.getState().autoAssist) requestRunNext();
  };

  const onApproveAll = () => {
    const waiting = pending.filter((p) => p.status === 'pending');
    if (!waiting.length) { message.info('没有待确认的岗位'); return; }
    // 批量确认走同一口径：直接入队。逐个校验招呼语——无招呼语者**不入队**（保持待确认），
    // 与单个「批准」的「无招呼语则拒绝批准」一致，不做静默兜底。
    const noGreeting: string[] = [];
    const approvedIds = new Set(
      waiting
        .filter((p) => {
          const g = String(p.deliveryGreeting || p.analysis?.greeting || '').trim();
          if (!g) { noGreeting.push(p.job?.title || p.id); return false; }
          return true;
        })
        .map((p) => p.id)
    );
    if (!approvedIds.size) {
      message.warning('待确认岗位均无求职招呼语，请先补充后再批量确认');
      addLog('warn', `批量确认未执行：${noGreeting.length} 个岗位缺少招呼语`);
      return;
    }
    const next = rerankPending(
      pending.map((p) => (approvedIds.has(p.id) ? { ...p, status: 'approved_queue' as const, approvedAt: Date.now() } : p)),
      useSettingsStore.getState().config,
    );
    setPending(next);
    addLog('success', `已批量确认 ${approvedIds.size} 个岗位，进入「投递中」队列`);
    if (noGreeting.length) {
      message.warning(`${noGreeting.length} 个岗位因缺少招呼语未入队，仍留在「待确认」`);
      addLog('warn', `以下岗位缺少招呼语，未入队：${noGreeting.slice(0, 5).join('、')}${noGreeting.length > 5 ? ` 等 ${noGreeting.length} 个` : ''}`);
    }
    if (useAppStore.getState().autoAssist) requestRunNext();
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
    // 「撤回」只对队列中的岗位开放（approved_queue / approved）。终态（sent）已在下方拦截；
    // 其它状态（failed/skipped/ignored）不渲染该按钮，此处再兜一层防御性判断。
    const cur = useDataStore.getState().pending.find((p) => p.id === id);
    if (!cur) return;
    if (cur.status === 'sent') { message.warning('已投递的岗位无法撤回'); return; }
    if (cur.status !== 'approved_queue' && cur.status !== 'approved') {
      message.warning('仅「投递中 / 待投递」的岗位可以撤回');
      return;
    }
    // 撤回后引擎当前 activeId 可能正指向该岗位——一并释放 activeId/applyStage 并关闭本次
    // 投递标签，避免引擎继续对一个已退回「待确认」的岗位投递（状态与动作脱节）。
    const next = rerankPending(pending.map((p) => (p.id === id ? { ...p, status: 'pending' as const } : p)), useSettingsStore.getState().config);
    setPending(next);
    if (id === activeId) {
      setActiveId(null);
      setApplyStage(null);
      if (activeTabRef.current) {
        webviewApi.current?.closeTab(activeTabRef.current);
        activeTabRef.current = null;
      }
    }
    addLog('info', '已撤回岗位，退回「待确认」');
    recomputeStats();
    if (useAppStore.getState().autoAssist) requestRunNext();
  };

  // 兼容入口：现在「批准」已直接入队，正常情况下不会有 approved 残留。
  // 保留它用于两种情况：1) 老版本数据里遗留的 approved 岗位（升级后一次性清掉）；
  // 2) 未来若重新引入「先攒一批再统一投放」的两步用法。
  // 「一键投递」与「开始投递」口径统一（09-16）：
  // 批准即入队后，队列里的岗位本身就是 approved_queue，本按钮的职责是「把队列里的岗位立刻开投」。
  // 历史 bug：启用条件只看 approved —— 已确认入队的岗位全在「投递中」下，按钮恒为灰，
  // 用户以为坏了，只能去右侧浏览器工具栏找「开始投递」（另一个按钮、另一套条件）。
  // 现在两者语义对齐：本按钮 = 入队 + 启动引擎（引擎已在跑则无操作可做，故禁用）。
  const onOneClickDeliver = () => {
    const { next, count } = promoteApprovedToQueue(pending, useSettingsStore.getState().config);
    const queued = pending.filter((p) => p.status === 'approved_queue').length;
    if (!count && !queued) { message.info('队列里没有待投递的岗位'); return; }
    if (count) setPending(next);
    if (!running) setAutoAssist(true);
    addLog('success', count
      ? `已将 ${count} 个「待投递」岗位并入「投递中」队列，开始投递`
      : `队列中已有 ${queued} 个岗位，开始投递`);
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

  // ===== 投递节流：拆成「预检」+「间隔等待」两段 =====
  // 拆分动机（09-17 实测）：岗位间隔节流（betweenJobsSeconds，默认 20s）原本发生在**打开标签页之前**，
  // 而 BOSS 岗位详情页实际只需 ~0.7s 加载（diag：ATTACH → DOM-READY）。结果是每次投递前有 13~27s
  // 完全空转、界面毫无反应，用户感知为「打开新岗位很慢」。
  // 现在把间隔等待与「打开页面 + 等页面就绪」并行：页面立刻开始加载并显示，
  // **投递动作（点击立即沟通 / 发送招呼语）之间的时间间隔完全不变**，风控特征不变 —— 只是用原本空转的
  // 等待时间把加载盖掉。预检（冷却/每日上限）仍必须在打开页面之前，避免白开一个页面。

  /** 预检：冷却期 / 每日上限 / 限速器预算校准。纯检查，不做长等待。返回 false 表示已暂停（内部已 pauseAssist）。 */
  const precheckDelivery = (): boolean => {
    const cfg = useSettingsStore.getState().config;
    if (isLockedOut(cfg)) {
      pauseAssist(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟），已暂停投递，请勿重复启动以免升级封禁`);
      return false;
    }
    // 工作台「一键投递」只处理 BOSS 岗位 → 上限按 BOSS 平台独立适配
    // （effectiveDailyCapFor：min(该平台每日目标, 平台侧上限, MAX_SAFE_DAILY=150)）
    const cap = effectiveDailyCapFor(cfg, 'boss');
    const sentToday = dailySentCountFor(useDataStore.getState().pending, 'boss');
    if (sentToday >= cap) {
      pauseAssist(`今日 BOSS 已投递 ${sentToday} 条，达到该平台上限 ${cap} 条，投递已暂停（避免账号受限）`);
      return false;
    }
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacerRef.current.budget !== pacerMax) pacerRef.current = new ActionPacer(pacerMax);
    return true;
  };

  /**
   * 等待「限速器预算 + 岗位间隔」。
   * ⚠️ **三条投递路径都必须调用本函数**（BOSS DOM / 非 BOSS DOM / Camoufox）——它是唯一的
   * 岗位间隔落点，漏掉任何一条就等于该路径失去节流保护。BOSS DOM 路径把它与页面加载并行
   * （见 runNext 的 Promise.all），其余两条路径按串行等待。
   * ⚠️ 安全语义不变：等的仍是两次投递动作之间的间隔，`lastDeliveryAt` 仍在**即将执行投递动作时**刷新，
   * 因此点击/发送的时序与串行版本一致。**禁止**把它改成「不等」或缩短间隔。
   */
  const awaitDeliveryGap = async (): Promise<void> => {
    const cfg = useSettingsStore.getState().config;
    await pacerRef.current.waitForSlot();
    const baseSec = Math.max(Number(cfg.betweenJobsSeconds) || SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
    const gapMs = humanDelayMs(baseSec * 1000, 0.35);
    const elapsed = Date.now() - lastDeliveryAt.current;
    const wait = Math.max(0, gapMs - elapsed);
    if (wait > 0) {
      // 必须显式告知「在等什么、等多久」：岗位页现在是立刻打开的，若不说明，界面看起来就是「停住了」，
      // 用户容易以为卡死而手动重复点投递 —— 那才是真正会触发风控的高频操作。
      const waitSec = Math.ceil(wait / 1000);
      addLog('info', `为降低风控风险，本岗位将等待 ${waitSec} 秒后投递（岗位间隔约 ${Math.round(gapMs / 1000)}s，距上次投递已过 ${Math.round(elapsed / 1000)}s）。页面已在后台加载完成，期间请勿手动重复投递`);
      await sleep(wait);
      addLog('info', `等待结束（${waitSec}s），继续投递本岗位`);
    }
    lastDeliveryAt.current = Date.now();
  };

  // ===== 岗位入库（去重 -> 活跃度/猎头/城市过滤 -> AI 分析 -> 入队）=====
  const ingestJob = useCallback(async (job: any): Promise<boolean> => {
    const url = String(job?.url || '').trim();
    const jobId = String(job?.jobId || url.match(/job_detail\/([^/.?#]+)/)?.[1] || '').trim();
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const profile = data.profile;
    if (!profile) return false;
    // 同岗位判定键：归一化 URL（去 query/hash、小写）与 jobId（平台稳定标识）任一命中即视为同一岗位。
    // 与 store addPendingItem 的去重口径统一，避免同一岗位因 url 带参数/大小写差异而重复入队或重复分析。
    const normUrl = jobUrlKey({ url });
    if (
      data.pending.some(
        (p) =>
          (normUrl && jobUrlKey(p.job) === normUrl) ||
          (jobId && String(p.job?.jobId || '').trim().toLowerCase() === jobId.toLowerCase())
      )
    )
      return false;
    // 本次会话去重：同一岗位无论入库还是被过滤跳过，都不重复 analyze/打日志（采集滚动常重复扫到同一卡片）
    const seenKey = normUrl || jobId.toLowerCase();
    if (seenKey && ingestedSeenRef.current.has(seenKey)) return false;
    if (seenKey) ingestedSeenRef.current.add(seenKey);
    const hrFilter = cfg.hrActivityFilter || 'any';
    if (hrFilter !== 'any' && !meetsHrActivityFilter(job?.hrActive, hrFilter)) return false;
    if (cfg.excludeHeadhunters && job?.isHeadhunter) {
      addSkipLogOnce('info', `跳过「${job?.title || '岗位'}」（猎头岗位）`);
      return false;
    }
    if (isLocationExcluded(job?.location, cfg)) {
      addSkipLogOnce('info', `跳过「${job?.title || '岗位'}」（所在地命中城市反选排除规则）`);
      return false;
    }
    const bl = isCompanyExcluded(job, cfg);
    if (bl.excluded) {
      addSkipLogOnce('info', `跳过「${job?.title || '岗位'}」（${bl.reason}）`);
      return false;
    }
    const jd = isJdKeywordExcluded(job, cfg);
    if (jd.excluded) {
      addSkipLogOnce('info', `跳过「${job?.title || '岗位'}」（${jd.reason}）`);
      return false;
    }
    const imFilterC = cfg.interviewModeFilter || 'any';
    if (imFilterC !== 'any') {
      const modeC = detectInterviewMode(job);
      if (modeC !== 'unknown' && modeC !== imFilterC) {
        addSkipLogOnce('info', `跳过「${job?.title || '岗位'}」（面试方式与设定冲突）`);
        return false;
      }
    }
    const meta: JobMeta = { ...job, url, jobId, interviewMode: detectInterviewMode(job) };
    try {
      const customGreetingPrompt = useDataStore.getState().greetingPrompt;
      const analysis = await analyzeJob(meta, profile, data.resumeText, cfg, cfg.model, customGreetingPrompt || undefined);
      // 入库门槛：reject（硬伤 / 明确冲突）一律跳过；其余档位统一按「最低入队分」放行，
      // 门槛由设置页「硬性智能过滤 → 最低入队分」配置（config.minQueueScore，默认 60，0 = 不限）；
      // 不再写死 60 分底线——推荐岗位分（minScore）只决定「是否推荐」，入队资格由最低入队分决定。
      const queueMin = resolveQueueMinScore(cfg);
      if (analysis.decision === 'reject' || analysis.score < queueMin) {
        // 诊断增强：跳过时带出评分来源与拦截明细（reason / hardBlocks），
        // 让「很多正常岗位都是 35 分」这类误拒可立即定位到具体规则 / AI 判断，而非只有一个孤立数字。
        const hb = Array.isArray(analysis.hardBlocks) ? analysis.hardBlocks.filter(Boolean) : [];
        const why = hb.length
          ? `硬拦截：${hb.slice(0, 2).join('；')}`
          : String(analysis.reason || '').replace(/\s+/g, ' ').slice(0, 160);
        const diag = why ? `·原因：${why}` : '';
        addSkipLogOnce(
          'info',
          `跳过「${meta.title}」（${analysis.scoreSource === 'local' ? '本地' : 'AI'} ${analysis.score} 分，${analysis.decision === 'reject' ? '不推荐' : '未达入队门槛'}${diag}）`
        );
        return false;
      }
      flushLastSkipLog();
      const runId = `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      const newItem = makePendingItem(meta, analysis, analysis.greeting, runId);
      addPendingItem(newItem);
      // 采集福利对齐「加入任务」：DOM 标签/正文常拿不到五险一金（只在 meta/_jobInfo/API 中），
      // 后台用 card.json（与「加入任务」同源）补全 welfare，工作台绿标即可显示，不阻塞采集循环。
      enrichWelfareRef.current(newItem.id, meta);
      addLog('success', `已加入「${meta.title}」（${analysis.scoreSource === 'local' ? '本地' : 'AI'} ${analysis.score} 分）`);
      return true;
    } catch (err: any) {
      flushLastSkipLog();
      addLog('error', `分析失败「${meta.title}」：${err?.message || err}`);
      return false;
    }
  }, [addPendingItem, addLog, addSkipLogOnce]);

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

  // 采集岗位福利后台补全：仅当福利缺社保信号（五险/六险/三险/公积金）时，异步调 card.json（与「加入任务」同源）
  // 合并 welfareList（五险一金/年终奖等），让工作台绿标可显示；API 风控/网络失败静默降级为已提取内容。
  const enrichCollectedWelfare = useCallback(async (id: string, job: JobMeta) => {
    try {
      // 平台门禁：该补全走 BOSS 官方 card.json（boss-api 通道），非 BOSS 标签页**未注册该通道**
      // （webview.cjs 里 boss-api 仅在 PLATFORM==='boss' 时注册）→ 调用会空等到超时且拿不到数据。
      // 多平台采集放开后每个非 BOSS 岗位都会走到这里，必须在此短路。
      if ((job.platform || 'boss') !== 'boss') return;
      // 已有社保信号（五险/六险/三险/公积金）则无需补全（webview 采集兜底可能已合并）
      const cur0 = useDataStore.getState().pending.find((p) => p.id === id);
      if (!cur0) return;
      if ((cur0.job?.welfare || []).some((w) => /五险|六险|三险|公积金/.test(String(w)))) return;
      const jid = extractEncryptJobId(job);
      if (!jid) return;
      // 优先「当前激活标签」：采集福利补全紧跟采集循环，此刻激活标签即为采集该岗位的标签，
      // card.json 在该标签上下文中返回该岗位真实福利；兜底主标签（仅未激活任何标签时使用）。
      const tabId = webviewApi.current?.getActiveTabId?.() || webviewApi.current?.getFirstTabId?.();
      if (!tabId) return;
      const res = await webviewApi.current?.bossApi('jobCard', { encryptJobId: jid }, tabId);
      if (res && res.code === 0 && res.data?.zpData) {
        const wl = Array.isArray(res.data.zpData.welfareList) ? res.data.zpData.welfareList.map(String) : [];
        if (!wl.length) return;
        const target = useDataStore.getState().pending.find((p) => p.id === id);
        if (!target) return;
        const merged = [...new Set([...(target.job?.welfare || []), ...wl])].slice(0, 16);
        updatePending(id, { job: { ...target.job, welfare: merged } });
      }
    } catch { /* 风控/网络失败静默，保持采集已提取内容 */ }
  }, [extractEncryptJobId, updatePending]);
  enrichWelfareRef.current = enrichCollectedWelfare;

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
    // 标签页收尾必须在「首次验收暂停」分支之前完成：本条投递已终态成功，用于本次投递的标签页
    // 已无用途，留着只会占用标签配额并让 activeTabRef 悬挂指向已关闭/待回收的页。
    // 注意 tabId 与 activeTabRef 可能不是同一个页（API 路径用 res.tabId；DOM 路径 domTab 已写入
    // activeTabRef 且与 domResult.tabId 相同），故两者都关、并防御性判重避免重复关同一个。
    if (tabId) webviewApi.current?.closeTab(tabId);
    const owned = activeTabRef.current;
    if (owned && owned !== tabId) webviewApi.current?.closeTab(owned);
    activeTabRef.current = null;
    const cfg = useSettingsStore.getState().config;
    if (cfg.requireSingleJobValidation && !cfg.singleJobValidationCompletedAt) {
      useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
      // 安全不变量：首次投递成功后必须暂停验收（核对沟通对象/文字气泡/附件）。
      // pauseAssist 会 setAutoAssist(false) + setActiveId(null) + setApplyStage(null)，
      // 引擎自身不再续跑；但用户点「开始投递」重新启动时，useEffect([running]) 的
      // requestRunNext() 必须能继续——它依赖 activeTabRef 已被清空（否则会误关新标签页）。
      // 历史 bug：此处曾直接 return，跳过上面的标签收尾，导致 activeId/activeTabRef 悬挂、
      // 引擎停在已 sent 的岗位上无法推进（表现为「投递一个就要重新确认」）。
      pauseAssist('首次投递成功，已暂停投递：请核对右侧沟通对象、文字气泡与附件，确认无误后再启动');
      return;
    }
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
      // 采集逐卡产出不等分析：投进有界并发队列，杜绝无界并发 LLM 调用。
      // ingestJob 内部已 try/catch 兜底不会 reject，此处 catch 仅防队列自身异常产生 unhandledrejection。
      const q = analysisQueueRef.current;
      if (q) void q.enqueue(() => ingestJob(data.job)).catch(() => {});
      else void ingestJob(data.job);
    }
    // 关键诊断落日志（低频，不刷屏）：列表就绪 / 页面已加载完但选择器没命中 / 全选择器 0 命中
    if (data?.phase === 'list-ready') {
      // 每批只打一次：webview 对每个搜索组合 / 重试都会发 list-ready，同秒多条只记录第一条
      if (!collectListReadyLoggedRef.current) {
        collectListReadyLoggedRef.current = true;
        addLog('info', `列表就绪：${data?.total ?? 0} 个岗位卡片`);
      }
    } else if (data?.phase === 'list-selector-warn') {
      addLog('warn', `页面已加载完但未命中岗位卡片（列表选择器可能失效）：${String(data?.status || '').slice(0, 300)}`);
    } else if (data?.phase === 'no-cards-diag') {
      addLog('warn', `当前页未找到岗位卡片，DOM 诊断：${String(data?.status || '').slice(0, 300)}`);
    } else if (data?.phase === 'login-required') {
      // 平台未登录：记入 ref，采集主循环立即收口（不再对同一平台空跑剩余搜索组合）
      visualLoginBlockedRef.current = String(data?.status || '平台未登录或登录态已失效');
      addLog('warn', `可视化采集收口：${String(data?.status || '').slice(0, 200)}`);
    } else if (data?.phase === 'platform-mismatch') {
      // 仅诊断：preload 以页面 hostname 为权威，不一致说明标签选错了（不会静默采错平台）
      addLog('warn', `采集平台自检：${String(data?.status || '').slice(0, 200)}`);
    }
  }, [ingestJob, addLog]);

  // 采集完成回传（collect-done）：累计处理数并唤醒本轮导航循环，进入下一个搜索组合
  const handleCollectDone = useCallback(() => {
    // 不采用 webview 回传的 processed（卡片 key 去重不稳定，会虚高如"5181"）；
    // 「已处理」以 batch 内实际入库/入眼的唯一岗位数（ingestedSeenRef.size）为准，见 runVisualCollect。
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
      const listWaitMs = Math.max(5000, Number(opts.listTimeoutMs) || 30000);
      // 客户端兜底超时必须晚于页内「列表首屏等待 + 逐卡片采集」的自然结束点：
      // 旧公式只按 settleMs 线性估算，列表页更长时会在页内仍在采集时切走标签（跨组合串台）；
      // 现在把列表首屏等待与逐卡片节奏一并计入，并放宽到 15min 上限（仅作最后兜底）。
      const timeoutMs = Math.min(900000, listWaitMs + 120000 + 240 * settleMs);
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

  // 采集任务卡片写入（与「任务进度」页共用 taskRuns）：同 id 覆盖更新，createdAt 保留首次时间
  const markCollectRun = useCallback((runId: string, base: Partial<TaskRun>, patch: Partial<TaskRun>) => {
    const existing = useDataStore.getState().taskRuns.find((r) => r.id === runId);
    upsertTaskRun({
      id: runId,
      createdAt: existing?.createdAt || Date.now(),
      status: 'running',
      stage: 'queued',
      stageLabel: '等待开始',
      progress: 0,
      processed: 0,
      discovered: 0,
      analyzed: 0,
      failed: 0,
      attempts: 0,
      error: '',
      ...base,
      ...patch,
      updatedAt: Date.now(),
    } as unknown as TaskRun);
  }, [upsertTaskRun]);

  // 本轮采集结束后，把仍未收尾的采集任务标记为「已跳过」（用户停止时避免卡片停在“采集中”）
  const settleCollectRuns = useCallback((runIds: string[], label: string) => {
    for (const rid of runIds) {
      const cur = useDataStore.getState().taskRuns.find((r) => r.id === rid);
      if (cur && (cur.status === 'running' || cur.status === 'queued')) {
        updateTaskRun(rid, { status: 'skipped', stageLabel: label, updatedAt: Date.now() });
      }
    }
  }, [updateTaskRun]);

  /**
   * 可视化采集（内置浏览器 webview 链路，**已多平台化**）：
   *   BOSS    ：逐卡片滚动 + 高亮 + 点击展开内联详情 + 提取完整信息（原链路不变）
   *   其余平台：列表级采集（滚动 + 高亮，**不点击卡片**）—— 猎聘/智联/前程无忧的搜索页没有
   *             内联详情面板，点卡片会导航走；详情 JD 由 Camoufox 隐身采集链路补齐
   *             （见 webview.cjs::visualCollectListOnly 头注释）。
   * runIds 非空 = 「任务进度」页定向重新采集（仍按平台各自队列过滤）。
   */
  const runVisualCollect = async (platform: JobPlatform = 'boss', runIds?: string[]): Promise<CollectOutcome> => {
    if (visualActiveRef.current) return 'skip';
    ingestedSeenRef.current = new Set(); // 新一采集批重置去重，允许重新扫描
    collectListReadyLoggedRef.current = false; // 新一批重新记录首个「列表就绪」
    visualLoginBlockedRef.current = '';
    // BOSS 登录态由 wt2 cookie 判定（webview 与隐身引擎共用同一会话）；
    // 其余平台的登录态在各自标签页内，由页内 loginWallDetected() 判定后回传 login-required
    // —— 不能拿 BOSS cookie 口径去判断猎聘/智联/前程无忧（会误判成未登录而拒绝采集）。
    if (platform === 'boss' && !(await ensureBossLogin())) return 'skip';
    const cfg0 = useSettingsStore.getState().config;
    if (isLockedOut(cfg0)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg0) / 60000)} 分钟），暂不能采集`);
      return 'skip';
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return 'skip'; }
    // 无关键字采集不依赖「投递方向」（方向仅提供关键词），故该模式下不强制先确认方向
    if (!cfg0.collectWithoutKeyword && !directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); return 'skip'; }
    if (cfg0.collectWithoutKeyword) addLog('warn', NO_KEYWORD_SETUP_REMINDER);
    // 搜索队列按平台分源，两条通道口径统一：
    //   BOSS   → searchUrl.ts（官方筛选码 + 城市码表）
    //   其余平台 → platformUrls.ts（城市/薪资/关键词进 URL，基础求职条件同步拼接）—— 与隐身采集同一构建器
    if (platform === 'boss') await loadBossCityCodes();
    const queue = platform === 'boss'
      ? filterQueueByRunIds('boss', buildSearchQueue(directionPlan, config), runIds)
      : filterQueueByRunIds(platform, buildPlatformSearchQueue(platform, directionPlan, config), runIds);
    if (!queue.length) {
      if (runIds?.length) {
        // 定向重跑：该组合已不在当前搜索条件中（方向/关键词/城市/求职类型被改过）→ 收口卡片并说明原因
        for (const rid of runIds) {
          updateTaskRun(rid, {
            status: 'failed',
            stage: 'failed',
            stageLabel: '该组合已不在当前搜索条件中',
            error: '搜索方向 / 关键词 / 城市 / 求职类型已变更，请到「工作台 → 搜索采集」重新采集',
            updatedAt: Date.now(),
          });
        }
        addLog('warn', '定向重新采集失败：该搜索组合已不在当前搜索条件中');
        message.warning('该搜索组合已不在当前搜索条件中（方向/城市/求职类型可能已变更）');
      } else {
        message.warning('没有可搜索的方向/条件，请先确认投递方向并设置城市/求职类型');
      }
      return 'skip';
    }

    // BOSS 城市码校验（非 BOSS 平台的城市码由 platformUrls.ts 各自解析并直接进 URL，此处不适用）
    if (platform === 'boss') {
      const unresolvedCities = [...new Set(queue.map((q) => q.location).filter(Boolean))] as string[];
      const badCities = unresolvedCities.filter((loc) => !resolveCityCode(loc));
      if (badCities.length) {
        addLog('warn', `以下目标城市无法识别，将按 BOSS 当前定位城市搜索（请在「设置-求职条件」核对城市名）：${badCities.join('、')}`);
      }
    }

    visualActiveRef.current = true;
    setVisualCollecting(true);
    setVisualPaused(false);
    setVisualItem({ index: 0, total: 0, title: '', company: '', status: '准备中', phase: '' });

    // 采集标签选择（滚动/点击全程可见，不随用户切换标签而漂移）：
    //   BOSS   → 沿用「第一个主标签」（存量行为，不动）；
    //   其余平台 → 优先复用已有同平台标签，否则为该平台新建一个 main 标签。
    //   不能在 BOSS 标签页里导航到猎聘/智联：既污染 BOSS 标签，又把用户视线带走。
    let collectTabId = '';
    if (platform === 'boss') {
      collectTabId = webviewApi.current?.getFirstTabId?.() || webviewApi.current?.getActiveTabId?.() || '';
    } else {
      collectTabId = webviewApi.current?.findTabByPlatform?.(platform) || '';
      if (!collectTabId) {
        collectTabId = webviewApi.current?.openInNewTab?.(queue[0].url, `${platformLabel(platform)} · 采集`, 'main') || '';
        // 等新标签的 webview 挂载；后续 loadURLInTab + waitTabReady 仍会兜底
        if (collectTabId) await sleep(900);
      }
    }
    visualTabRef.current = collectTabId || '';
    if (!collectTabId) {
      visualActiveRef.current = false;
      setVisualCollecting(false);
      message.warning('没有可用标签页，无法启动可视化采集');
      return 'skip';
    }

    const collectSpeedMs = Math.max(400, Number(config.collectSpeedMs) || 1200);
    // 搜索页加载等待上限：可配置（设置 → 搜索采集范围控制），默认 30s。
    const pageTimeoutMs = Math.max(5000, Number(config.collectPageTimeoutMs) || 30000);
    // ===== 页面就绪判定（以「页面自身事实」为权威）=====
    // 旧口径只看宿主的加载遮罩状态机（导航事件 + 定时器）：事件序列一异常（重定向 / 子框架 /
    // 定时器被新导航顶掉）就会一直判定「加载中」，而页面其实早已可用（日志刷「加载中」但页面正常）。
    // 现改为：向页内发 page-status 探测，读 document.readyState / 岗位卡片命中数 / 正文长度；
    //   ① 探测能回（说明 preload 已就绪，IPC 不丢）且页面已可用 → 就绪；
    //   ② 遮罩状态只作参考，宽限 2s 后即使遮罩未收敛也按页面事实放行（并记一条诊断日志）。
    const probePage = async (tabId: string): Promise<any | null> => {
      try {
        const st = await webviewApi.current?.pageStatus?.(tabId);
        return st && !st.error ? st : null;
      } catch {
        return null;
      }
    };
    const pageUsable = (st: any): boolean =>
      Boolean(st && (
        Number(st.cards) > 0 ||
        String(st.readyState) === 'complete' ||
        String(st.readyState) === 'interactive' ||
        Number(st.bodyLen) > 1500
      ));
    const describePage = (st: any): string => st
      ? `readyState=${st.readyState}，卡片 ${st.cards}，正文 ${st.bodyLen} 字`
      : '页面探测无响应';

    const waitTabReady = async (tabId: string, timeoutMs: number, keyword: string): Promise<boolean> => {
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let lastNotice = 0;
      let st: any | null = null;
      while (Date.now() < deadline) {
        if (!visualActiveRef.current) return false;
        const preloadFlag = Boolean(webviewApi.current?.isPreloadReady?.(tabId));
        const overlay = Boolean(webviewApi.current?.isLoading?.(tabId));
        st = (await probePage(tabId)) || st;
        // 探测有响应 ⇒ preload 已就绪（比宿主的标记更可靠）
        const preloadOk = preloadFlag || Boolean(st);
        if (preloadOk && pageUsable(st)) {
          if (!overlay) {
            addLog('info', `「${keyword}」页面就绪（${describePage(st)}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
            return true;
          }
          // 页面已可用但遮罩状态未收敛：宽限 2s 后以页面事实为准放行
          if (Date.now() - startedAt > 2000) {
            addLog('info', `「${keyword}」页面就绪（${describePage(st)}）——加载遮罩状态未收敛，已按页面状态放行，不影响采集`);
            return true;
          }
        }
        if (Date.now() - lastNotice > 5000) {
          lastNotice = Date.now();
          const waited = Math.round((Date.now() - startedAt) / 1000);
          addLog('info', `「${keyword}」等待页面加载…（已 ${waited}s / 上限 ${Math.round(timeoutMs / 1000)}s；preload ${preloadOk ? '就绪' : '等待中'}，加载遮罩 ${overlay ? '显示中' : '已隐藏'}，${describePage(st)}）`);
        }
        await sleep(300);
      }
      return false;
    };

    addLog('info', `开始可视化采集（${platformLabel(platform)}）：共 ${queue.length} 个搜索组合，${platform === 'boss' ? '逐岗位平滑滚动 + 高亮 + 点击展开详情' : '列表级滚动 + 高亮（不点开详情，详情 JD 由隐身采集补齐）'}${cfg0.collectWithoutKeyword ? '（无关键字模式：链接不带 query，仅保留城市 / 求职类型等筛选）' : ''}`);
    // 本批采集任务的 runId（用于结束时把未收尾的卡片统一收口）
    const batchRunIds: string[] = [];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const item = queue[qi];
      if (!visualActiveRef.current) break;
      // 该平台未登录：后续搜索组合必然同样失败 → 立即收口（登录墙判定在页内完成，不靠猜）
      if (visualLoginBlockedRef.current) break;
      addLog('info', `可视化采集「${item.keyword}」· ${item.location || '全国'} · ${item.employmentType || '不限'}（${qi + 1}/${queue.length}）`);
      let tabId = collectTabId;
      if (!webviewApi.current?.hasTab(tabId)) {
        const t = webviewApi.current?.getFirstTabId?.() || webviewApi.current?.getActiveTabId?.();
        if (!t) break;
        tabId = t;
        visualTabRef.current = tabId;
      }

      // 采集任务卡片（写入 taskRuns → 「任务进度」页实时出现/更新对应卡片）
      const runId = collectRunId(platform, item);
      batchRunIds.push(runId);
      const baseRun: Partial<TaskRun> = {
        directionId: item.directionId,
        directionName: item.directionName || '采集',
        directionPriority: item.directionPriority ?? 0,
        directionScore: item.directionScore ?? 0,
        keyword: item.keyword,
        location: item.location,
        employmentType: item.employmentType,
      };
      const comboProgress = Math.round((qi / queue.length) * 100);
      markCollectRun(runId, baseRun, {
        status: 'running',
        stage: 'queued',
        stageLabel: `搜索页加载中（${qi + 1}/${queue.length}）`,
        progress: comboProgress,
      });

      // 先跳转到搜索页链接，等 preload 就绪 + 加载遮罩消失（页面真正可注入）
      webviewApi.current?.loadURLInTab(tabId, item.url);
      const kwLabel = keywordLabel(item.keyword);
      let ready = await waitTabReady(tabId, pageTimeoutMs, kwLabel);
      if (!ready && visualActiveRef.current) {
        // 首次等待超时：重载一次再等一轮（BOSS 偶发首屏挂起 / 重定向吞掉导航事件导致标记不翻转）
        addLog('warn', `「${kwLabel}」页面首次加载超时（${Math.round(pageTimeoutMs / 1000)}s），自动重载重试一次…`);
        webviewApi.current?.loadURLInTab(tabId, item.url);
        ready = await waitTabReady(tabId, pageTimeoutMs, kwLabel);
      }
      if (!ready) {
        if (!visualActiveRef.current) break;
        addLog('warn', `「${kwLabel}」搜索页加载超时（已重试；单次上限 ${Math.round(pageTimeoutMs / 1000)}s），跳过该组合。可在「设置 → 搜索采集范围控制 → 搜索页加载等待上限」继续调大`);
        markCollectRun(runId, baseRun, {
          status: 'failed',
          stage: 'failed',
          stageLabel: '搜索页加载超时',
          error: `搜索页加载超时（${Math.round(pageTimeoutMs / 1000)}s × 2 次）`,
          progress: Math.round(((qi + 1) / queue.length) * 100),
        });
        continue;
      }
      await visualWait(2500);
      if (!visualActiveRef.current) break;

      const before = ingestedSeenRef.current.size;
      markCollectRun(runId, baseRun, {
        status: 'running',
        stage: 'queued',
        stageLabel: `采集中（${qi + 1}/${queue.length}）`,
        progress: comboProgress,
      });
      // 列表首屏等待上限同步跟随「搜索页加载等待上限」，避免页面已就绪但列表仍在渲染时被提前判空
      // 接入设置约束：listAutoScroll（是否自动下拉加载更多，false=只采首屏可见卡）、
      //   listScrollRounds（每批下拉轮数上限，0=滚到物理底部/连续空轮停止）、
      //   maxJobsPerRun（单次采集兜底上限，0 或缺失沿用 webview 内置 1000 防失控）。
      await visualCollectInTab(tabId, {
        settleMs: collectSpeedMs,
        listTimeoutMs: pageTimeoutMs,
        autoScroll: config.listAutoScroll !== false,
        scrollRounds: Number(config.listScrollRounds) > 0 ? Number(config.listScrollRounds) : 0,
        maxJobs: Math.max(1, Number(config.maxJobsPerRun) || 1000),
        // 平台自检用：preload 以页面 hostname 为权威，不一致时回传 platform-mismatch 诊断
        platform,
      });
      const got = Math.max(0, ingestedSeenRef.current.size - before);
      if (!visualActiveRef.current) break;
      markCollectRun(runId, baseRun, {
        status: 'success',
        stage: 'success',
        stageLabel: got > 0 ? `已完成，采集 ${got} 个岗位` : '已完成（无新增岗位）',
        processed: got,
        discovered: got,
        progress: Math.round(((qi + 1) / queue.length) * 100),
      });
      await visualWait(800);
    }
    const wasStopped = !visualActiveRef.current;
    // 用户停止：本批仍在「采集中」的采集任务收口为「已跳过」，避免任务进度页停留在进行中
    if (wasStopped) settleCollectRuns(batchRunIds, '已停止（未完成）');
    const processed = ingestedSeenRef.current.size;
    const loginBlocked = visualLoginBlockedRef.current;
    visualActiveRef.current = false;
    visualTabRef.current = '';
    setVisualCollecting(false);
    setVisualPaused(false);
    setVisualItem((v) => ({ ...v, status: '', phase: '' }));
    recomputeStats();
    addLog(
      wasStopped ? 'warn' : 'success',
      loginBlocked
        ? `可视化采集（${platformLabel(platform)}）未执行：${loginBlocked}`
        : `可视化采集${wasStopped ? '已停止' : '完成'}：共处理 ${processed} 个岗位（已按条件过滤入库）`
    );
    if (useAppStore.getState().autoAssist) requestRunNext();
    // 未登录属「平台级」故障：只跳过本平台，剩余平台继续（与 collectFaultScope 的平台级口径一致）
    return loginBlocked ? 'skip' : 'done';
  };

  // ===== Camoufox 隐身采集（可选增强，保留）——多平台：按 platform 参数走对应平台模块 =====
  /**
   * 采集单平台的续行信号（对齐 BossHunter `collection/orchestrator.py` 的平台级故障隔离）：
   *   'done'  正常跑完（含「无岗位」）→ 继续下一平台；
   *   'skip'  平台级不可用（未启用/未登录/冷却期/无可用组合）→ 跳过本平台，后续平台继续；
   *   'abort' 需要人工确认的阻断（风控 35/36、平台受限 32、环境异常 37/38）→ 整批队列中止。
   * 判定唯一入口 = platforms.ts 的 collectFaultScope()，勿在此硬编码码值。
   */
  type CollectOutcome = 'done' | 'skip' | 'abort';

  const runCamoufoxCollect = async (platform: JobPlatform = 'boss', runIds?: string[]): Promise<CollectOutcome> => {
    if (cfxActiveRef.current) return 'skip';
    ingestedSeenRef.current = new Set(); // 新一采集批重置去重，允许重新扫描
    const cfg0 = useSettingsStore.getState().config;
    const cfx0 = cfg0.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };
    if (!cfx0.enabled) { message.warning('请在「设置 → Camoufox 隐身引擎」启用后再使用'); return 'skip'; }
    if (isLockedOut(cfg0)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg0) / 60000)} 分钟），暂不能隐身采集`);
      return 'skip';
    }
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return 'skip'; }
    // 无关键字采集不依赖「投递方向」（方向仅提供关键词），故该模式下不强制先确认方向
    if (!cfg0.collectWithoutKeyword && !directionPlan?.confirmed) { message.warning('请先到「投递方向」确认方向'); return 'skip'; }
    if (cfg0.collectWithoutKeyword) addLog('warn', NO_KEYWORD_SETUP_REMINDER);
    const st = await camoufoxStatus(platform);
    if (!st.ready) { message.warning('Camoufox 引擎未就绪：' + (st.message || '请到设置页检测并安装 camoufox')); return 'skip'; }
    if (!st.engine?.loggedIn) {
      message.warning(`平台「${platformLabel(platform)}」未登录 Camoufox，请先到「设置 → 招聘平台」扫码登录后再采集`);
      // 登录墙属「当前平台」本地故障：其它平台登录态各自独立，不受影响（BossHunter orchestrator 口径）
      return 'skip';
    }
    if (platform === 'boss') await loadBossCityCodes();
    const queue = platform === 'boss'
      ? filterQueueByRunIds('boss', buildSearchQueue(directionPlan, config), runIds)
      : filterQueueByRunIds(platform, buildPlatformSearchQueue(platform, directionPlan, config), runIds);
    if (!queue.length) {
      if (runIds?.length) {
        for (const rid of runIds) {
          updateTaskRun(rid, {
            status: 'failed',
            stage: 'failed',
            stageLabel: '该组合已不在当前搜索条件中',
            error: '搜索方向 / 关键词 / 城市 / 求职类型已变更，请到「工作台 → 搜索采集」重新采集',
            updatedAt: Date.now(),
          });
        }
        addLog('warn', `定向重新采集失败（${platformLabel(platform)}）：该搜索组合已不在当前搜索条件中`);
        message.warning('该搜索组合已不在当前搜索条件中（方向/城市/求职类型可能已变更）');
      } else {
        message.warning('没有可搜索的方向/条件，请先确认投递方向并设置城市/求职类型');
      }
      return 'skip';
    }
    const pfLabel = platformLabel(platform);

    cfxActiveRef.current = true;
    setCfxCollecting(true);
    let collectedCount = 0;
    let lastCode: number | null = null;
    // 队列级阻断标记：一旦命中风控/环境异常，本平台收尾后整批队列必须中止（不再跑后续平台）
    let queueAborted = false;
    // 定向重新采集（runIds 非空）语义 = 用户明确要求重跑该组合 → 忽略断点续采强制重采
    const forceRecheck = Boolean(runIds?.length);
    addLog('info', `开始 Camoufox 隐身采集（${pfLabel}）：共 ${queue.length} 个搜索组合（指纹伪装：${cfx0.os}，页数：${cfx0.pages}）${cfg0.collectWithoutKeyword ? '（无关键字模式：链接不带关键词，仅保留城市等筛选）' : ''}`);
    const cfxRunIds: string[] = [];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const item = queue[qi];
      if (!cfxActiveRef.current) break;
      const cityCode = platform === 'boss' ? (resolveCityCode(item.location) || '100010000') : String(item.location || '全国');
      // 非 BOSS 平台：城市/薪资/关键词在 URL 里，其余「基础求职条件」（学历/经验/公司规模/求职类型）
      // 随 criteria 下发，由 Python 侧 platform filters 翻译成本平台筛选参数。
      // （BOSS 队列项来自 searchUrl.ts，不含 criteria —— 故按 platform 收窄类型）
      const itemCriteria = platform === 'boss' ? undefined : (item as PlatformSearchQueueItem).criteria;
      const criteriaNote = platform === 'boss' ? '' : describePlatformCriteria(itemCriteria);
      addLog('info', `隐身搜索（${pfLabel}）「${item.keyword}」· ${item.location || '全国'} · ${item.employmentType || '不限'}（${qi + 1}/${queue.length}）${criteriaNote ? ` · 基础求职条件：${criteriaNote}` : ''}`);
      // 采集任务卡片（与「任务进度」页共用 taskRuns）
      const runId = collectRunId(platform, item);
      cfxRunIds.push(runId);
      const baseRun: Partial<TaskRun> = {
        directionId: item.directionId,
        directionName: item.directionName || '采集',
        directionPriority: item.directionPriority ?? 0,
        directionScore: item.directionScore ?? 0,
        keyword: item.keyword,
        location: item.location,
        employmentType: item.employmentType,
      };
      const comboProgress = Math.round((qi / queue.length) * 100);
      markCollectRun(runId, baseRun, {
        status: 'running',
        stage: 'queued',
        stageLabel: `隐身采集中（${qi + 1}/${queue.length}）`,
        progress: comboProgress,
      });
      lastCode = null; // 每组重置：故障范围判定与 catch 兜底只看本组结果，避免沿用上一组残留码
      try {
        const result = await camoufoxSearch(item.keyword, cityCode, cfx0.pages || 1, cfx0.os, platform, itemCriteria, forceRecheck);
        if (result.skipped) {
          // 断点续采命中：既非失败、也非「无岗位」，单独记账便于用户理解「为什么没采」
          addLog('info', `「${keywordLabel(item.keyword)}」跳过本次采集：${result.message || '近期已采过（断点续采）'}`);
          markCollectRun(runId, baseRun, {
            status: 'success',
            stage: 'success',
            stageLabel: '断点续采跳过（近期已采过）',
            progress: Math.round(((qi + 1) / queue.length) * 100),
          });
        } else if (result.ok && result.jobs?.length) {
          let added = 0;
          for (const j of result.jobs) {
            if (!cfxActiveRef.current) break;
            const ingested = await ingestJob(camoufoxJobToMeta(j, platform));
            if (ingested) added += 1;
            await sleep(600 + Math.random() * 900);
          }
          collectedCount += added;
          addLog('success', `「${keywordLabel(item.keyword)}」隐身搜索到 ${result.jobs.length} 个岗位，入库 ${added} 个`);
          markCollectRun(runId, baseRun, {
            status: 'success',
            stage: 'success',
            stageLabel: `已完成，入库 ${added} 个岗位`,
            processed: added,
            discovered: added,
            progress: Math.round(((qi + 1) / queue.length) * 100),
          });
        } else {
          lastCode = result.code ?? null;
          const errMsg = result.message || result.error || '无岗位';
          // 故障影响范围：队列级（风控/受限/环境异常）→ 本平台收尾后整批中止；
          // 平台级（未登录/单次动作失败）→ 只收尾本平台，后续平台继续。
          if (collectFaultScope(lastCode) === 'queue') queueAborted = true;
          if (isCamoufoxStopCode(lastCode)) {
            addLog('error', `隐身采集命中风控码 ${lastCode}：${result.message || ''}。立即停止并进入冷却，请人工处理。`);
            useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + SAFETY_LIMITS.DEFAULT_COOLDOWN_MS });
            markCollectRun(runId, baseRun, {
              status: 'failed', stage: 'failed', stageLabel: `风控码 ${lastCode}`, error: errMsg,
              progress: Math.round(((qi + 1) / queue.length) * 100),
            });
            break;
          }
          if (isCamoufoxEnvCode(lastCode)) {
            addLog('error', `隐身采集命中环境异常码 ${lastCode}：${result.message || ''}。请先到「设置 → Camoufox 隐身引擎」扫码登录后再试。`);
            markCollectRun(runId, baseRun, {
              status: 'failed', stage: 'failed', stageLabel: `环境异常码 ${lastCode}`, error: errMsg,
              progress: Math.round(((qi + 1) / queue.length) * 100),
            });
            break;
          }
          addLog('warn', `隐身搜索「${keywordLabel(item.keyword)}」返回空：${errMsg}`);
          markCollectRun(runId, baseRun, {
            status: 'success', stage: 'success', stageLabel: `已完成（无岗位：${errMsg.slice(0, 20)}）`,
            progress: Math.round(((qi + 1) / queue.length) * 100),
          });
        }
      } catch (e: any) {
        addLog('error', `隐身搜索「${keywordLabel(item.keyword)}」失败：${e?.message || e}`);
        markCollectRun(runId, baseRun, {
          status: 'failed', stage: 'failed', stageLabel: '隐身搜索失败', error: String(e?.message || e),
          progress: Math.round(((qi + 1) / queue.length) * 100),
        });
        if (isCamoufoxStopCode(lastCode)) { queueAborted = true; break; }
      }
      if (cfxActiveRef.current) await sleep(1500 + Math.random() * 1000);
    }
    // 用户停止 / 风控中断：未收尾的采集任务统一收口为「已跳过」
    settleCollectRuns(cfxRunIds, '已停止（未完成）');
    cfxActiveRef.current = false;
    setCfxCollecting(false);
    recomputeStats();
    addLog(collectedCount > 0 ? 'success' : 'info', `Camoufox 隐身采集结束（${pfLabel}）：共入库 ${collectedCount} 个岗位`);
    if (useAppStore.getState().autoAssist) requestRunNext();
    // 队列级阻断 → 上报 'abort'，由整批采集循环决定是否继续剩余平台
    return queueAborted ? 'abort' : 'done';
  };

  const camoufoxJobToMeta = (j: CamoufoxJob, platform: JobPlatform = 'boss'): JobMeta => ({
    platform,
    title: j.title,
    company: j.company,
    salary: decodeSalaryDigits(j.salary),
    location: j.location,
    description: j.description,
    url: j.url,
    jobId: j.jobId,
    skills: Array.isArray(j.skills) ? j.skills : [],
    labels: Array.isArray(j.labels) ? j.labels : [],
    welfare: Array.isArray(j.welfare) ? j.welfare : [],
    recruiterName: j.recruiterName || '',
    publishTime: '',
  });

  /** 按指定平台执行一次采集（等待完成），返回本平台对整批队列的续行信号。
   *
   * 引擎选择（**全平台统一语义**）：
   *   camoufox.enabled → Camoufox 隐身引擎通道（列表 + 详情 JD + 词级断点续采）
   *   否则             → 内置浏览器 webview 可视化采集（BOSS 详情级 / 其余平台列表级）
   * 历史行为是「非 BOSS 只能走 Camoufox」（当时 webview 链路只有 BOSS 选择器）；2026-09-15
   * webview 多平台化后放开闸门 —— 未安装 Camoufox 内核也能采集非 BOSS 平台（列表级）。
   * runIds 非空时只重跑这些搜索组合（「任务进度」页「开始/继续」的定向采集，忽略断点续采）。 */
  const runCollectFor = async (platform: JobPlatform, runIds?: string[]): Promise<CollectOutcome> => {
    if (config.camoufox?.enabled) return runCamoufoxCollect(platform, runIds);
    return runVisualCollect(platform, runIds);
  };

  /** 手动「搜索采集」入口：按当前所选平台串行采集（不等待，引擎常驻执行） */
  const startCollect = () => {
    // 至少一个平台：UI 已兜底回填，此处再做一次防御性检查
    const targets = searchPlatforms.length
      ? searchPlatforms
      : (sortedEnabledPlatforms(config)[0] ? [sortedEnabledPlatforms(config)[0]] : []);
    if (!targets.length) { message.warning('请先在「设置 → 招聘平台」启用至少一个招聘平台'); return; }
    if (targets.length > 1) {
      addLog('info', `手动串行采集（${targets.map((p) => platformLabel(p)).join(' → ')}）`);
    }
    void (async () => {
      for (const pf of targets) {
        // 中途有手动采集介入则不再启动剩余平台（各引擎入口自带 busy 防御）
        if (visualActiveRef.current || cfxActiveRef.current) break;
        let outcome: CollectOutcome = 'done';
        try {
          outcome = await runCollectFor(pf);
        } catch (e) {
          addLog('error', `采集平台「${platformLabel(pf)}」执行失败：${String((e as Error)?.message || e)}`);
        }
        // 队列级阻断（风控/受限/环境异常）：不再继续剩余平台，交人工确认后再采（BossHunter orchestrator 口径）
        if (outcome === 'abort') {
          addLog('warn', `采集批次已中止：平台「${platformLabel(pf)}」触发需人工确认的阻断，剩余平台不再继续`);
          break;
        }
      }
    })();
  };

  const stopAllCollect = () => {
    controlCollect('stop');
    cfxActiveRef.current = false;
    setCfxCollecting(false);
    addLog('warn', '已停止采集');
  };

  // 定时任务「采集」触发：消费 collectRequest 调用本组件采集入口（跨页可触发，因本组件常驻挂载）。
  // 目标平台：任务圈定（req.platforms）→ 逐一采集；未圈定 → 当前全部已启用平台。
  // 采集请求消费：来源两类 —— ①定时任务（platforms，整批采集）；②「任务进度」页「开始/继续」（runIds，定向重跑单组合）。
  useEffect(() => {
    if (!collectRequest) return;
    const runIdsAll = collectRequest.runIds?.length ? collectRequest.runIds : undefined;
    // 防御：已有采集在进行中则不叠加，仅清除请求（下个周期到点会再次触发）
    if (visualActiveRef.current || cfxActiveRef.current) {
      if (runIdsAll) {
        // 定向请求被拒：收口卡片，避免长期停在「已加入采集队列」
        for (const rid of runIdsAll) {
          updateTaskRun(rid, { status: 'skipped', stageLabel: '采集执行中，请稍后重试', updatedAt: Date.now() });
        }
        message.warning('已有采集正在执行，请稍后再试');
      }
      useScheduleStore.getState().setCollectRequest(null);
      return;
    }
    useScheduleStore.getState().setCollectRequest(null);
    // 定向请求：目标平台由 runId 前缀反推（避免误跑到其它平台的完整队列）
    const targets = runIdsAll
      ? platformsFromRunIds(runIdsAll)
      : collectRequest.platforms?.length
        ? collectRequest.platforms
        : sortedEnabledPlatforms(config);
    if (!targets.length) return;
    addLog(
      'info',
      runIdsAll
        ? `按任务定向重新采集（平台：${targets.map((p) => platformLabel(p)).join('/')}，组合 ${runIdsAll.length} 个）`
        : `定时任务触发搜索采集（平台：${targets.map((p) => platformLabel(p)).join('/')}）`
    );
    void (async () => {
      for (const pf of targets) {
        // 中途有手动采集介入则不再启动剩余平台（各引擎入口自带 busy 防御）
        if (visualActiveRef.current || cfxActiveRef.current) break;
        // 只把属于该平台的 runId 传下去（空数组会被视为「整批」，故此处必须过滤）
        const ids = runIdsAll?.filter((id) => String(id).split('_')[1] === pf);
        let outcome: CollectOutcome = 'done';
        try {
          outcome = await runCollectFor(pf, ids);
        } catch (e) {
          addLog('error', `采集平台「${platformLabel(pf)}」执行失败：${String((e as Error)?.message || e)}`);
        }
        // 队列级阻断：定时采集同样整批中止，避免在风控/受限状态下继续打其它平台
        if (outcome === 'abort') {
          addLog('warn', `定时采集已中止：平台「${platformLabel(pf)}」触发需人工确认的阻断，剩余平台不再继续`);
          break;
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectRequest, config.camoufox?.enabled]);

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
    // 多平台适配：投递覆盖全部平台——BOSS 走 webview 官方接口；猎聘/智联/51Job
    // 分别新建对应平台标签页做 DOM 投递（见下方平台分派分支）。
    // 投递顺序完全由 rerankPending 决定（状态组 → 平台优先级 → priorityScore → AI 分 → 入队时间），
    // 不再记忆「最近点击批准的那个」：原 preferIdRef 是单值 ref，连点多个批准只会记最后一个，
    // 反而让先批准的被无理由后置，属于伪优先级，已移除。
    const ranked = rerankPending(useDataStore.getState().pending, useSettingsStore.getState().config);
    const candidate = ranked.find((p) => p.status === 'approved_queue' && !isDeliveryClaimed(p.id, p.job?.platform));
    if (!candidate) {
      if (visualActiveRef.current || cfxActiveRef.current) return;
      if (useSettingsStore.getState().config.executionMode === 'auto' && !searchTriggered.current) {
        searchTriggered.current = true;
        addLog('info', '没有待投递的岗位，先自动采集一批岗位');
        startCollect();
        return;
      }
      addLog('info', '队列已空，投递结束');
      setRunning(false);
      setAutoAssist(false);
      return;
    }
    setActiveId(candidate.id);
    lastApplyStageRef.current = '';
    setApplyStage('queued');
    addLog('info', `按匹配优先级投递：${candidate.job?.title || '岗位'}（AI ${candidate.analysis?.score || 0} 分）`);
    const url = String(candidate.job?.url || '').trim();
    if (!url) { pauseAssist('岗位缺少详情链接，无法投递'); return; }

    // 预检（冷却/每日上限）：不通过就别白开页面。
    // 岗位间隔节流不在这里等 —— 已挪到打开标签页之后，与页面加载并行（见下方 Promise.all）。
    if (!precheckDelivery()) return;

    const sendCfg = useSettingsStore.getState().config;
    const cfx0 = sendCfg.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };

    // ===== 非 BOSS 平台投递：不同平台新建标签页做 DOM 投递（猎聘/智联/51Job）=====
    const pf = String(candidate.job?.platform || 'boss') as JobPlatform;
    if (pf && pf !== 'boss') {
      if (!claimDelivery(candidate.id, pf)) {
        addLog('warn', `岗位正由后台「自动沟通」投递，工作台已跳过：${candidate.job?.title || '岗位'}`);
        // 不降级状态：该岗位是 approved_queue（「投递中」），只是本轮投递权被后台占用。
        // 历史 bug：此处曾写 status:'approved' 把它打回「待投递」，造成状态机倒流
        // （approved_queue → approved）——用户看到的就是「按钮从已批准状态撤回」。
        // 正确做法：保持队列态，本轮让给后台；后台跑完（sent/failed）后状态自有其归属，
        // 若仍未投递则后续 runNext 会重新参与竞争，无需在此改写状态。
        setApplyStage(null);
        recomputeStats();
        if (useAppStore.getState().autoAssist) requestRunNext();
        return;
      }
      setApplyStage('open_job');
      addLog('info', `通过「${platformLabel(pf)}」新标签页投递：${candidate.job?.title || '岗位'}`);
      let r: any;
      try {
        // 非 BOSS 路径的 platformApply 内部自行「打开标签页 + 下发投递」，无法把加载与节流拆开并行，
        // 因此与串行版本保持一致：先等满岗位间隔再执行（安全语义优先于观感）。
        await awaitDeliveryGap();
        r = await webviewApi.current?.platformApply(url, pf, candidate.job);
      } catch (e) {
        r = { ok: false, stage: 'failed', error: String((e as Error)?.message || e) };
      } finally {
        releaseDelivery(candidate.id, pf); // 锁绝不泄漏
      }
      const res = r || {};
      const nTitle = candidate.job?.title || '岗位';
      if (res.ok && res.stage === 'success') {
        handleDelivered(candidate.id, res.tabId);
        return;
      }
      if (res.external) {
        updatePending(candidate.id, { status: 'skipped', error: res.message || '外部网申岗位，跳过' });
        addLog('warn', `已跳过外部网申岗位：${nTitle}`);
        if (res.tabId) webviewApi.current?.closeTab(res.tabId);
        setApplyStage(null); recomputeStats();
        if (useAppStore.getState().autoAssist) requestRunNext();
        return;
      }
      if (res.stage === 'stop') {
        updatePending(candidate.id, { status: 'skipped', error: res.message || '该平台今日投递已达上限' });
        addLog('warn', `跳过：${nTitle}（${res.message || '该平台今日投递已达上限'}）`);
        if (res.tabId) webviewApi.current?.closeTab(res.tabId);
        setApplyStage(null); recomputeStats();
        if (useAppStore.getState().autoAssist) requestRunNext();
        return;
      }
      if (res.stage === 'risk') {
        handleRisk(res.code, res.message || ''); // 保留标签供人工核对
        return;
      }
      const errMsg = res.error || res.message || '投递失败';
      updatePending(candidate.id, { status: 'failed', error: errMsg });
      addLog('error', `投递失败：${nTitle}（${errMsg}）`);
      if (res.tabId) webviewApi.current?.closeTab(res.tabId);
      setApplyStage(null); recomputeStats();
      if (useAppStore.getState().autoAssist) {
        addLog('warn', '继续投递下一个岗位');
        requestRunNext();
      } else {
        addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
      }
      return;
    }

    // ===== 通道 1：Camoufox 隐身投递（可选，设置「优先走隐身通道」时；仅 BOSS）=====
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
          // Camoufox 路径没有可并行的页面加载（发送在独立进程内完成），
          // 因此与串行版本一致：先等满岗位间隔再发送。
          await awaitDeliveryGap();
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
        // 「已建立会话」= 该岗位已与 HR 沟通过（继续沟通入口）：不再按新投递判失败，
        // 移入「自动沟通」队列（status=opened，AutoChat 接管），不占用今日投递名额。
        if (/已建立会话|已沟通|继续沟通/.test(msg)) {
          updatePending(candidate.id, { status: 'opened', error: '已建立会话，移入自动沟通队列' });
          addLog('warn', `检测到「继续沟通」（已建立会话），已移入自动沟通队列：${candidate.job?.title || '岗位'}`);
          setApplyStage(null);
          recomputeStats();
          if (useAppStore.getState().autoAssist) requestRunNext();
          return;
        }
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

    // ===== BOSS 投递：直接走内置浏览器真实 DOM 沟通投递（对齐 job-claw-main）=====
    // 不先调 /friend/add.json 官方接口——该接口常因缺少必要参数返回 code 1；DOM 沟通投递自带
    // 文字气泡确认 / 外部网申跳过 / 风控即停，安全性与人工操作口径都更贴合。
    const liveCandidate = useDataStore.getState().pending.find((p) => p.id === candidate.id);
    let finalGreeting = String(liveCandidate?.deliveryGreeting || liveCandidate?.analysis?.greeting || candidate.deliveryGreeting || candidate.analysis?.greeting || '').trim();
    if (!finalGreeting) {
      const fallbackGreetings = useDataStore.getState().greetings || [];
      finalGreeting = String(fallbackGreetings[0] || '').trim();
      if (finalGreeting && liveCandidate) updatePending(liveCandidate.id, { deliveryGreeting: finalGreeting });
    }
    if (!finalGreeting) { pauseAssist('招呼语为空，无法投递，请补充后再试'); return; }

    // 共享占位锁：与后台「自动沟通」互斥，避免对同一岗位重复投递
    if (!claimDelivery(candidate.id)) {
      addLog('warn', `岗位正由后台「自动沟通」投递，工作台已跳过：${candidate.job?.title || '岗位'}`);
      // 同前一处：不把它降级回 approved（approved_queue → approved 是状态机倒流，
      // 界面上表现为「已批准被撤回」）。保持队列态，本轮让给后台即可。
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      return;
    }

    const domTab = webviewApi.current?.openInNewTab(url, candidate.job?.title || '岗位', 'detail');
    if (!domTab) {
      releaseDelivery(candidate.id);
      updatePending(candidate.id, { status: 'failed', error: '无法打开新标签页做 DOM 投递', retryable: true });
      addLog('error', `投递失败：${candidate.job?.title || ''}（无法打开新标签页做 DOM 投递）`);
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      else addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
      return;
    }
    activeTabRef.current = domTab;
    setApplyStage('open_job');
    addLog('info', `已在新标签页打开岗位，开始真实沟通投递：${candidate.job?.title || '岗位'}`);

    // 单线性等待 DOM 投递终态：runNext 在此挂起，终态由 handleApplyStage 回写 domWaitRef，
    // 避免 fire-and-forget 造成 runNext 反复重入、打开多个标签页并重复刷日志。
    const domTitle = candidate.job?.title || '岗位';
    let domResult: { mode: 'success' | 'risk' | 'failed' | 'skip' | 'timeout' | 'continue_chat'; payload: any; tabId?: string } = { mode: 'failed', payload: { error: 'DOM 沟通投递未返回终态' } };
    try {
      domResult = await new Promise<typeof domResult>((resolve) => {
        let timerRef: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const settle = (mode: any, payload: any, tabId?: string) => {
          if (settled) return;
          settled = true;
          if (timerRef) clearTimeout(timerRef);
          resolve({ mode, payload, tabId });
        };
        // 兜底超时：先于看门狗（commStuckTimeoutSec，默认 60s）收敛，避免与超时看门狗双重处理
        const stuckSec = Math.max(30, Number(useSettingsStore.getState().config.commStuckTimeoutSec) || 60);
        timerRef = setTimeout(() => settle('timeout', { error: `DOM 沟通投递超时（${stuckSec - 5}s），已跳过该岗位` }), (stuckSec - 5) * 1000);
        domWaitRef.current = settle;
        // 页面加载（waitDomReady）与投递节奏（awaitDeliveryGap）并行，随后才下发 start-apply（domApply）。
        const payload = { job: candidate.job, greeting: finalGreeting };
        const sendOnce = () => webviewApi.current?.sendInTab?.(domTab, 'start-apply', payload);
        const isChatUrl = (u: string) => /app\.zhipin\.com/i.test(u) || /(\/web\/geek\/chat|\/chat(?:\/|\?|$))/i.test(u);
        void (async () => {
          // 页面就绪探测：与「岗位间隔节流」并行执行（见下方 Promise.all）。
          // 「可用」以 IPC 探针（pageStatus 往返成功）为权威：BOSS 岗位页常因长轮询/慢子资源让
          // isLoading 长期为 true（did-stop-loading 迟迟不到），若仅等 isPreloadReady && !isLoading
          // 会把「点击立即沟通」拖死满 25s（日志表现为打开岗位 → 打开沟通窗口间隔一条看门狗）。
          const waitDomReady = async (): Promise<void> => {
            const domDeadline = Date.now() + 25000;
            let lastProbeAt = 0;
            while (Date.now() < domDeadline) {
              // 快速路径（原逻辑）：preload 就绪且不再 loading 直接视为可用
              if (webviewApi.current?.isPreloadReady?.(domTab) && !webviewApi.current?.isLoading?.(domTab)) return;
              // 兜底路径：preload 就绪标记 / loading 标志被卡住时，用 pageStatus 探针实测页面可用性。
              // 探针节拍 1500ms → 600ms（09-17）：实测「页面已 DOM-READY（~0.7s）」到「下发 start-apply」
              // 之间会白等 3~5s（探针要等满一个节拍才问一次），压缩节拍后这段时间基本消失。
              if (Date.now() - lastProbeAt >= 600) {
                lastProbeAt = Date.now();
                try {
                  const st = await webviewApi.current?.pageStatus?.(domTab);
                  if (st && !st.error) return;
                } catch {}
              }
              await sleep(250);
            }
          };
          // 并行：页面加载（通常 <1s） + 岗位间隔节流（13~27s）。
          // 串行版本是「先等节流 → 再开页面」，用户要盯着空转的十几秒；并行后页面几乎立刻打开，
          // 而 start-apply（点击立即沟通）仍要等节流结束才下发 —— 投递动作的时序完全不变。
          await Promise.all([awaitDeliveryGap(), waitDomReady()]);
          if (!webviewApi.current) return;
          sendOnce();
          // 「继续沟通/立即沟通」的沟通入口常整页跳转到聊天页（app.zhipin.com / /web/geek/chat），导航会使 preload 重注入、
          // 原 domApply 被中断 → 只发了 BOSS 系统招呼而 AI 招呼没写进去。检测到已跳到聊天页且新 preload 就绪后，
          // 重发一次 start-apply 补写 AI 招呼语（变通）。仅当 URL 命中聊天页才重发；job_detail 就地开窗不重发，避免重复发送。
          // 检测窗口放宽到与投递看门狗一致（最长约 3 分钟），覆盖聊天窗口渲染慢的情形。
          const detectDeadline = Date.now() + Math.max(60000, (stuckSec - 10) * 1000);
          let reSent = false;
          while (Date.now() < detectDeadline && !reSent) {
            let u = '';
            try { u = String((await webviewApi.current?.pageStatus?.(domTab))?.url || ''); } catch { u = ''; }
            if (isChatUrl(u)) {
              const d2 = Date.now() + 6000;
              while (Date.now() < d2) {
                if (webviewApi.current?.isPreloadReady?.(domTab) && !webviewApi.current?.isLoading?.(domTab)) break;
                await sleep(300);
              }
              sendOnce();
              reSent = true;
              break;
            }
            await sleep(1200);
          }
        })();
      });
    } finally {
      domWaitRef.current = null;
      releaseDelivery(candidate.id);
    }

    if (domResult.mode === 'success') {
      handleDelivered(candidate.id, domResult.tabId);
      return;
    }
    if (domResult.mode === 'risk') {
      // 保留标签供人工完成安全验证
      handleRisk(domResult.payload?.code, domResult.payload?.message || '');
      return;
    }
    if (domResult.mode === 'skip') {
      const msg = String(domResult.payload?.error || '外部网申岗位，跳过');
      updatePending(candidate.id, { status: 'skipped', error: msg });
      addLog('warn', `已跳过外部网申岗位：${domTitle}（${msg}）`);
      if (activeTabRef.current) { webviewApi.current?.closeTab(activeTabRef.current); activeTabRef.current = null; }
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      return;
    }
    if (domResult.mode === 'continue_chat') {
      // 「继续沟通」入口：该岗位已与 HR 建立过会话（此前已沟通过/已投递过），
      // 不再按新投递发招呼语并计成功——移入「自动沟通」队列（status=opened，AutoChat 接管），
      // 并从工作台投递队列移除（防重复投递同一 HR、不占用今日投递名额）。
      updatePending(candidate.id, { status: 'opened', error: '' });
      addLog('warn', `${domTitle}：检测到「继续沟通」（已建立会话），已移入自动沟通队列`);
      if (activeTabRef.current) { webviewApi.current?.closeTab(activeTabRef.current); activeTabRef.current = null; }
      setApplyStage(null);
      recomputeStats();
      if (useAppStore.getState().autoAssist) requestRunNext();
      return;
    }
    // failed / timeout
    const errMsg = String(domResult.payload?.error || 'DOM 沟通投递失败');
    updatePending(candidate.id, { status: 'failed', error: errMsg, retryable: true });
    addLog('error', `投递失败：${domTitle}（${errMsg}）`);
    if (activeTabRef.current) { webviewApi.current?.closeTab(activeTabRef.current); activeTabRef.current = null; }
    setApplyStage(null);
    recomputeStats();
    if (useAppStore.getState().autoAssist) {
      addLog('warn', '继续投递下一个岗位');
      requestRunNext();
    } else {
      addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
    }
  };

  useEffect(() => { runNextRef.current = runNext; });

  useEffect(() => { loadBossCityCodes().catch(() => {}); }, []);

  // 响应设置页「扫码登录」请求：在工作台 webview 新建标签页打开对应平台登录页
  useEffect(() => {
    if (!browserLoginRequest || !webviewApi.current) return;
    const { platform, loginUrl } = browserLoginRequest;
    const label = platformLabel(platform);
    try {
      const tabId = webviewApi.current.openInNewTab(loginUrl, `${label}登录`, 'main');
      if (tabId) addLog('info', `已打开 ${label} 登录页，请在内置浏览器中完成登录`);
    } finally {
      clearBrowserLogin();
    }
  }, [browserLoginRequest, clearBrowserLogin, addLog]);

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
    addLog('info', `已进入沟通阶段「${taskStageMetaFor(item?.job?.platform, applyStage).label}」，看门狗启动：若 ${sec} 秒内无进展将跳过该岗位转投下一个`);
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
    // 诊断日志（stage:'log'）不驱动状态机，放行且不受跨标签守卫影响，便于排查外来标签的串台。
    if (stage === 'log') { addLog('info', String(data?.message || '')); return; }
    const current = useDataStore.getState();
    const active = current.pending.find((p) => p.id === activeId);
    if (!activeId || !active) return;
    // 跨标签防串台：只有「本次投递所用标签页」回传的阶段才驱动当前岗位的状态机。
    // 历史现象：上一个岗位超时/失败后其标签页虽有 closeTab，但关闭是异步的，在途回传仍会到达；
    // 这些外来事件会被当成当前岗位的进度（日志里冒出上一个岗位的标题，甚至把阶段写错）。
    // 同一次投递内整页跳转（job_detail → 聊天页）tabId 不变，故正常流程不受影响。
    if (tabId && activeTabRef.current && tabId !== activeTabRef.current) return;

    if (stage === 'risk') {
      if (domWaitRef.current) { domWaitRef.current('risk', { code: data?.code, message: data?.message || '' }, tabId); return; }
      handleRisk(data?.code, data?.message || '');
      return;
    }
    if (stage === 'continue_chat') {
      // 「继续沟通」入口：该岗位已与 HR 建立过会话（此前已沟通过/已投递过），
      // 不再按新投递发招呼语并计成功——移入「自动沟通」队列（status=opened，AutoChat 接管），
      // 并从工作台投递队列移除（防重复投递同一 HR、不占用今日投递名额）。
      if (domWaitRef.current) { domWaitRef.current('continue_chat', {}, tabId); return; }
      updatePending(activeId, { status: 'opened', error: '' });
      addLog('warn', `${active?.job?.title || '岗位'}：检测到「继续沟通」（已建立会话），已移入自动沟通队列`);
      setApplyStage(null);
      recomputeStats();
      if (activeTabRef.current) {
        webviewApi.current?.closeTab(activeTabRef.current);
        activeTabRef.current = null;
      }
      if (useAppStore.getState().autoAssist) {
        addLog('warn', '继续投递下一个岗位');
        requestRunNext();
      } else {
        addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
      }
      return;
    }
    if (stage === 'failed') {
      const error = String(data.error || '投递失败');
      if (data.external === true) {
        if (domWaitRef.current) { domWaitRef.current('skip', { error }, tabId); return; }
        updatePending(activeId, { status: 'skipped', error });
        addLog('warn', `已跳过：${active?.job?.title || ''}（${error}）`);
        setApplyStage(null);
        recomputeStats();
        if (running) requestRunNext();
        return;
      }
      // 有 DOM 等待槽在途（工作台 BOSS 直投）→ 只回写终态，状态/日志由 runNext 统一处理（去重）
      if (domWaitRef.current) { domWaitRef.current('failed', { error }, tabId); return; }
      updatePending(activeId, { status: 'failed', error });
      addLog('error', `投递失败：${active?.job?.title || ''}（${error}）`);
      setApplyStage(null);
      recomputeStats();
      if (activeTabRef.current) {
        webviewApi.current?.closeTab(activeTabRef.current);
        activeTabRef.current = null;
      }
      if (useAppStore.getState().autoAssist) {
        addLog('warn', '继续投递下一个岗位');
        requestRunNext();
      } else {
        addLog('warn', '投递引擎未运行，已暂停。请人工核对后启动投递。');
      }
      return;
    }
    if (stage === 'verify_result') {
      if (domWaitRef.current) { domWaitRef.current('success', {}, tabId); return; }
      handleDelivered(activeId, tabId);
      return;
    }
    if (TRACKED_STAGES.includes(stage as TaskStage)) {
      setApplyStage(stage as TaskStage);
      // 进度日志去重：同一阶段反复回传（如聊天窗口渲染慢/重绘导致的重复 open_chat/fill）只记一条
      if (lastApplyStageRef.current !== stage) {
        lastApplyStageRef.current = stage as TaskStage;
        const meta = taskStageMetaFor(active?.job?.platform, stage as TaskStage);
        addLog('info', `${active?.job?.title || '岗位'}：${meta.label}`);
      }
      return;
    }
  };

  const activeItem = pending.find((p) => p.id === activeId) || null;
  const currentPhase = applyStage ? stageToPhase(applyStage) : null;

  // ===== 侧边栏底部「当前动作」状态（与 StatusBar 的 OpenClaw 连接状态区分开）=====
  // chatRunning 作为重跑触发器：自动沟通停止后，若工作台仍在运行则恢复工作台文本
  const chatRunning = useAutoChatStore((s) => s.chatRunning);
  useEffect(() => {
    let action: string | null = null;
    if (cfxCollecting) action = '正在隐身搜集岗位信息';
    else if (visualCollecting) action = '正在搜集岗位信息';
    else if (running && applyStage) {
      const label = taskStageMetaFor(activeItem?.job?.platform, applyStage).label;
      if (COMM_PHASE_STAGES.includes(applyStage)) action = `正在自动沟通：${label}`;
      else action = `正在投递：${label}`;
    } else if (running) action = '投递引擎运行中';
    else action = null;

    const store = useAppStore.getState();
    if (action) store.setCurrentAction('workbench', action);
    else store.clearCurrentAction('workbench');
  }, [cfxCollecting, visualCollecting, running, applyStage, activeItem, chatRunning]);

  const deliveryTasks = useMemo(() => {
    const list: { p: PendingItem; stage: TaskStage; label: string; progress: number }[] = [];
    for (const p of pending) {
      const pf = p.job?.platform;
      if (p.status === 'approved_queue') {
        const stage: TaskStage = p.id === activeId && applyStage ? applyStage : 'queued';
        const meta = taskStageMetaFor(pf, stage);
        list.push({ p, stage, label: meta.label, progress: meta.progress });
      } else if (p.status === 'pending') {
        const meta = taskStageMetaFor(pf, 'waiting_review');
        list.push({ p, stage: 'waiting_review', label: meta.label, progress: meta.progress });
      } else if (p.status === 'sent') {
        const meta = taskStageMetaFor(pf, 'success');
        list.push({ p, stage: 'success', label: meta.label, progress: meta.progress });
      } else if (p.status === 'failed') {
        const meta = taskStageMetaFor(pf, 'failed');
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
  // 「一键投递」可点条件 = 队列里还有可投递的岗位（「待投递」或已入队的「投递中」）。
  // 与右侧「开始投递」口径统一，避免批准即入队后本按钮长期置灰（详见 onOneClickDeliver 注释）。
  const deliverableCount = pending.filter((p) => p.status === 'approved' || p.status === 'approved_queue').length;
  const collecting = visualCollecting || cfxCollecting;

  // 采集任务概览（与「任务进度」页共用 taskRuns，用于卡片内联动展示）
  const collectRuns = useMemo(() => taskRuns.filter((t) => isCollectRunId(t.id)), [taskRuns]);
  const collectRunActive = collectRuns.filter((t) => t.status === 'running').length;
  const collectRunDone = collectRuns.filter((t) => t.status === 'success').length;
  const collectRunFailed = collectRuns.filter((t) => t.status === 'failed').length;

  // 分区统计（去重口径，互不重叠，合计=下方岗位列表总数）：
  //   搜索中 = 正在采集；待确认 = 待人工确认岗位；待投递 = 已确认等待投递；投递中 = 投递流程进行中；已完成 = 投递成功；失败 = 投递失败
  const statSearching = collecting ? 1 : 0;
  const statToConfirm = deliveryPendingCount;
  const statToDeliver = deliveryApprovedCount;
  const statDelivering = deliveryQueuedCount + (activeItem && applyStage ? 1 : 0);
  const statDone = deliverySentCount;
  const statFailed = deliveryFailedCount;

  const isHiddenStatus = (status: string) => status === 'ignored' || status === 'skipped';
  const rankedAll = useMemo(() => rerankPending(pending, config), [pending, config]);
  // 「全部」只展示**尚未投递**的岗位：已投递（sent）不混入总览，避免队列越用越长。
  // 已投递数据完整保留在 pending 中，仍可通过「已投递」标签单独查看（见下方 ranked 分支）。
  const activeAll = useMemo(() => rankedAll.filter((p) => p.status !== 'sent'), [rankedAll]);
  // 「全部」走 activeAll（排除 sent）；选具体标签时走全量 rankedAll，保证「已投递」标签能正常筛出内容。
  const ranked = useMemo(() => {
    const base = filter === 'all' ? activeAll : rankedAll.filter((p) => p.status === filter);
    return showIgnored ? base : base.filter((p) => !isHiddenStatus(p.status));
  }, [activeAll, rankedAll, filter, showIgnored]);

  // 标签数字与各自列表同源：全部 = 未投递总数；其余 = 对应状态总数（含已投递）
  const visibleAllCount = showIgnored ? activeAll.length : activeAll.filter((p) => !isHiddenStatus(p.status)).length;
  const WB_FILTERS = [
    { key: 'all', label: `全部 ${visibleAllCount}` },
    { key: 'pending', label: `待确认 ${pending.filter((p) => p.status === 'pending').length}` },
    { key: 'approved', label: `待投递 ${pending.filter((p) => p.status === 'approved').length}` },
    { key: 'approved_queue', label: `投递中 ${pending.filter((p) => p.status === 'approved_queue').length}` },
    { key: 'sent', label: `已投递 ${pending.filter((p) => p.status === 'sent').length}` },
    { key: 'failed', label: `失败 ${pending.filter((p) => p.status === 'failed').length}` },
  ];

  const welfareTag = (p: PendingItem) => {
    // 候选文本 = 已存的福利标签 + JD 描述 + 卡片文本 + 标题。
    // 即使 welfare 因旧数据/采集缺失为空，也能据持久化的 description 现场推导蓝绿黄标签。
    const corpus = [
      ...(Array.isArray(p.job?.welfare) ? p.job.welfare : []),
      p.job?.description,
      p.job?.cardText,
      p.job?.title,
      p.job?.hrActive,
    ]
      .filter(Boolean)
      .join(' ');
    if (!corpus.trim()) return null;
    const hit = (pairs: Array<readonly [string, RegExp]>) =>
      Array.from(new Set(pairs.filter(([, re]) => re.test(corpus)).map(([label]) => label)));
    // 工作时间按性质分色：双休=绿（好）、大小周/轮休=蓝（中性）、单休=黄（警示）。
    const workGood = hit([
      ['双休', /双休|周末双休|做五休二|朝九晚五|周末休息|8小时工作制|五天制/],
    ]);
    const workMid = hit([
      ['大小周', /大小周|双单休/],
      ['轮休', /轮休/],
    ]);
    const workBad = hit([
      ['单休', /单休|做六休一|六天制/],
    ]);
    // 双休等工作制度再叠加 detectWorkSchedule 权威识别（词表覆盖 做五休二/大小休/单双休/每周N天 等
    // 更广措辞），保证只要有工作制度信号就展示、绝不因去重/截断被删掉（与「任务进度」页同口径）。
    const wSchedule = detectWorkSchedule(p.job);
    if (wSchedule.detected) {
      if (/^双休$/.test(wSchedule.label)) { if (!workGood.includes('双休')) workGood.push('双休'); }
      else if (/^大小周$/.test(wSchedule.label)) { if (!workMid.includes('大小周')) workMid.push('大小周'); }
      else if (/^单休$/.test(wSchedule.label)) { if (!workBad.includes('单休')) workBad.push('单休'); }
    }
    // 社保保障与薪酬：细致区分「五险一金」与「五险」——五险一金 = 社保 + 公积金（绿标、强保障）；
    // 仅有「五险」（无公积金）保障弱一档，单独用警示色展示并注明，绝不与五险一金混淆。
    // 同时避免「五险一金」因 /[五5]险/ 被误标成两个标签（五险一金 已含五险，不并列展示）。
    const insRaw = hit([
      ['六险二金', /六险二金|九险二金/],
      ['六险一金', /六险一金/],
      ['五险一金', /五险一金/],
      ['三险一金', /三险一金/],
      ['住房公积金', /住房公积金/],
      ['公积金', /公积金/],
      ['补充医疗', /补充医疗|补充商业保险/],
      ['补充养老', /补充养老|企业年金/],
      ['五险', /[五5]险/],
    ]);
    const hasFullIns = insRaw.some((l) => /六险二金|六险一金|五险一金|三险一金/.test(l));
    const hasFullFund = insRaw.includes('住房公积金');
    const hasAnyFund = insRaw.some((l) => /住房公积金|公积金/.test(l));
    const benefit = [
      // 五险单独走 insuranceOnly 警示；「公积金」仅在出现完整「住房公积金」时不再并列
      ...insRaw.filter((l) => l !== '五险').filter((l) => !(hasFullFund && l === '公积金')),
      ...hit([
        ['多薪', /(?:13|14|15|16)薪|年底双薪|十三薪/],
        ['年终奖', /年终奖/],
      ]),
    ].slice(0, 3);
    // 仅有「五险」（未含一金/公积金项）→ 独立警示：与五险一金作细致区分
    const insuranceOnly = !hasFullIns && !hasAnyFund && insRaw.includes('五险') ? ['五险'] : [];
    // 警示项（潜在陷阱关键字，黄标）：弹性工作/工时、高提成、有责无责底薪、期权画饼、收费、岗位包装、
    // 以及加班文化 / 末位淘汰 / 试用期不缴社保 / 长期出差驻场 / 无薪实习 / 就业歧视等（发散覆盖常见用工风险）。
    const trap = hit([
      ['弹性工作', /弹性工作|弹性工时|弹性上下班|不定时工作制|不固定工时/],
      ['高提成', /高提成|上不封顶/],
      ['底薪加提成', /底薪\s*[加和]?\s*提成|底薪提成/],
      ['有责底薪', /有责底薪/],
      ['无责底薪', /无责底薪/],
      ['期权', /期权|股权激励/],
      ['分红', /项目分红|事业合伙人|分红/],
      ['收费/押金', /押金|培训费|岗前培训|服装费|保证金|实训|先交|先付费/],
      ['试岗', /无薪试岗|试岗/],
      ['管培生', /管培生/],
      ['储备干部', /储备干部/],
      ['保录/直签', /保录|直签/],
      ['抗压/吃苦', /抗压能力强|能吃苦耐劳/],
      ['无偿加班', /无偿加班|加班文化|强制加班|经常加班|加班较多|加班严重|加班多/],
      ['狼性/末位淘汰', /狼性文化|末位淘汰|末尾淘汰/],
      ['试用期不缴社保', /试用期不缴|试用期无社保|不缴社保|转正才缴/],
      ['长期试用期', /试用期\s*(?:[6-9]\d*|1[0-9]|一年|1年|半年)\s*个?月?/],
      ['长期出差/驻场', /长期出差|频繁出差|出差频繁|驻场/],
      ['无薪实习', /无薪实习|无工资实习|不给实习工资/],
      ['就业歧视', /限男性|限女性|限35岁|已婚已育优先|未婚未育优先/],
    ]);
    if (!workGood.length && !workMid.length && !workBad.length && !benefit.length && !trap.length && !insuranceOnly.length) return null;
    return (
      <>
        {workGood.length > 0 && (
          <Tooltip title={`工作时间（双休/标准工时）`}>
            <span className="job-info-chip job-info-chip--green">{workGood.join('、')}</span>
          </Tooltip>
        )}
        {workMid.length > 0 && (
          <Tooltip title={`工作时间（大小周/轮休，较累）`}>
            <span className="job-info-chip job-info-chip--blue">{workMid.join('、')}</span>
          </Tooltip>
        )}
        {workBad.length > 0 && (
          <Tooltip title={`⚠ 单休/做六休一，需综合薪资评估`}>
            <span className="job-info-chip job-info-chip--amber">{workBad.join('、')}</span>
          </Tooltip>
        )}
        {benefit.length > 0 && (
          <Tooltip title={`好信号：${benefit.join('、')}——正规社保/薪酬保障，可作为优先沟通的参考`}>
            <span className="job-info-chip job-info-chip--green">{benefit.join('、')}</span>
          </Tooltip>
        )}
        {insuranceOnly.length > 0 && (
          <Tooltip title={`「五险」未含「一金」（缺住房公积金）：保障弱于「五险一金」，沟通时建议确认公积金缴纳情况`}>
            <span className="job-info-chip job-info-chip--amber">{insuranceOnly.join('、')}（无公积金）</span>
          </Tooltip>
        )}
        {trap.length > 0 && (
          <Tooltip title={`⚠ 命中求职陷阱关键字：${trap.join('、')}。多为弹性打卡、低底薪高提成、画饼期权、收费培训、无偿加班或试用期不缴社保等，需仔细核实薪资结构、用工方式与合同条款`}>
            <span className="job-info-chip job-info-chip--amber">{trap.join('、')}</span>
          </Tooltip>
        )}
      </>
    );
  };

  const interviewModeTag = (p: PendingItem) => {
    const mode = p.job?.interviewMode;
    if (mode !== 'online' && mode !== 'offline') return null;
    const isOnline = mode === 'online';
    return (
      <Tooltip title={`面试方式（页面识别）：${isOnline ? '线上' : '线下'}`}>
        <span className={`job-info-chip ${isOnline ? 'job-info-chip--blue' : 'job-info-chip--purple'}`}>
          {isOnline ? '线上面试' : '线下面试'}
        </span>
      </Tooltip>
    );
  };

  // 正在进行的采集任务文案（岗位信息行展示 + 超长时 tooltip 全文）
  const visualInfoText = `${
    visualItem.index || visualItem.total ? `${visualItem.index}/${visualItem.total}` : '准备中…'
  }${visualItem.title ? ` ${visualItem.title}` : ''}${visualItem.company ? ` · ${visualItem.company}` : ''}`;

  return (
    <div className="workbench">
      <div className="workbench-center">
        <Card size="small" className="wb-progress-card" title="岗位进度"
          extra={
            <Space size={6} wrap={false} style={{ flexShrink: 0 }}>
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 140, maxWidth: 200 }}
                maxTagCount="responsive"
                value={searchPlatforms}
                onChange={handleSearchPlatformsChange}
                options={enabledPlatforms.map((p) => ({ value: p, label: platformLabel(p) }))}
                placeholder="选择采集平台"
              />
              {visualCollecting || cfxCollecting ? (
                <Button size="small" danger icon={<StopOutlined />} onClick={stopAllCollect}>停止</Button>
              ) : (
                <Button size="small" type="primary" icon={<SearchOutlined />} onClick={() => { startCollect(); }}>
                  {searchPlatforms.length > 1
                    ? `采集 ${searchPlatforms.length} 平台`
                    : (searchPlatforms[0] === 'boss' && config.camoufox?.enabled ? '隐身采集' : '搜索采集')}
                </Button>
              )}
            </Space>
          }
          styles={{ body: { padding: 12 } }}>
          <div className="wb-progress-stats">
            <div className={'wb-stat' + (statSearching ? ' is-on' : '')}>
              <span className="wb-stat-num">{collecting ? '●' : '0'}</span>
              <span className="wb-stat-label">搜索中</span>
            </div>
            <div className={'wb-stat' + (statToConfirm ? ' is-on' : '')}>
              <span className="wb-stat-num">{statToConfirm}</span>
              <span className="wb-stat-label">待确认</span>
            </div>
            <div className={'wb-stat' + (statToDeliver ? ' is-on' : '')}>
              <span className="wb-stat-num">{statToDeliver}</span>
              <span className="wb-stat-label">待投递</span>
            </div>
            <div className={'wb-stat' + (statDelivering ? ' is-on' : '')}>
              <span className="wb-stat-num">{statDelivering}</span>
              <span className="wb-stat-label">投递中</span>
            </div>
            <div className={'wb-stat' + (statDone ? ' is-on' : '')}>
              <span className="wb-stat-num">{statDone}</span>
              <span className="wb-stat-label">已完成</span>
            </div>
            <div className={'wb-stat' + (statFailed ? ' is-on' : '')}>
              <span className="wb-stat-num">{statFailed}</span>
              <span className="wb-stat-label">失败</span>
            </div>
          </div>

          {/* 无关键字采集（随机岗位推荐）前置提醒：岗位完全由平台按账号内的求职意向推荐，
              资料未完善会采到不相关岗位，故在卡片内常驻提醒并提供直达在线简历入口 */}
          {config.collectWithoutKeyword && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 10, padding: '6px 10px', background: '#fff' }}
              message={
                <span style={{ fontSize: 12 }}>
                  无关键字采集：岗位按账号内求职意向推荐，请先完善在线简历与求职意向。
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: 0, marginLeft: 4, fontSize: 12 }}
                    onClick={() => webviewApi.current?.openInNewTab(BOSS_RESUME_URL, 'BOSS 在线简历')}
                  >
                    去完善
                  </Button>
                </span>
              }
            />
          )}

          <div className="delivery-summary" style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
              {deliveryTasks.length > 0
                ? [
                    statDelivering && `投递中 ${statDelivering} 个`,
                    statToConfirm && `待确认 ${statToConfirm} 个`,
                    statToDeliver && `待投递 ${statToDeliver} 个`,
                    statDone && `已完成 ${statDone} 个`,
                    statFailed && `失败 ${statFailed} 个`,
                  ].filter(Boolean).join(' · ') + '，可在下方列表查看详情。'
                : collecting
                  ? `正在逐个读取岗位信息，结果会自动加入下方列表…${analysisStats.running || analysisStats.queued ? ` 当前 AI 分析 ${analysisStats.running} 个，排队 ${analysisStats.queued} 个。` : ''}`
                  : '还没有进行中的岗位。点「搜索采集」按投递方向采集岗位，或在右侧浏览器打开岗位后点「加入任务」，进度会实时显示在这里。'}
            </Text>
          </div>

          {collectRuns.length > 0 && (
            <div
              className="wb-collect-tasks"
              style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <Tag
                color={collectRunActive ? 'processing' : collectRunFailed ? 'error' : 'success'}
                style={{ margin: 0 }}
              >
                采集任务 {collectRunActive ? `进行中 ${collectRunActive}` : collectRunFailed ? `失败 ${collectRunFailed}` : '已完成'}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {collectRuns.length} 个搜索组合 · 已完成 {collectRunDone} · 失败 {collectRunFailed}
              </Text>
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setRoute('tasks')}>
                查看任务进度
              </Button>
            </div>
          )}

          {deliveryFailedCount > 0 && (
            <div style={{ marginTop: 8 }}>
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetryAllFailed}>全部重试失败任务</Button>
            </div>
          )}

          {/* 可视化采集进度（逐岗位滚动 + 高亮 + 点击展开，实时展示，可暂停/继续）
              —— 两行展示：第一行岗位信息（超长省略不溢出），第二行进度条 + 操作按钮 */}
          {(visualCollecting || cfxCollecting) && (
            <div className="visual-progress-inline" style={{ marginTop: 10, padding: '8px 12px', background: 'var(--hover-bg)', borderRadius: 8, border: '1px dashed var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Text
                  title={visualInfoText}
                  style={{
                    flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: '18px',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {visualInfoText}
                </Text>
                <Tag
                  style={{ margin: 0, flex: '0 0 auto' }}
                  color={
                    visualItem.status === '完成' ? 'green' :
                    visualItem.status === '滚动中' ? 'blue' :
                    visualItem.status === '点击中' ? 'cyan' : 'default'
                  }
                >
                  {cfxCollecting ? '隐身在搜' : (visualItem.status || '准备中')}
                </Tag>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, minWidth: 0 }}>
                <Progress
                  size="small"
                  percent={visualItem.total ? Math.round((visualItem.index / visualItem.total) * 100) : 0}
                  style={{ flex: '1 1 0', minWidth: 0, margin: 0 }}
                  strokeColor={{ from: '#13b5ac', to: '#078A83' }}
                />
                {visualCollecting && (
                  <Button
                    size="small"
                    style={{ flex: '0 0 auto' }}
                    icon={visualPaused ? <CaretRightOutlined /> : <PauseOutlined />}
                    onClick={() => controlCollect(visualPaused ? 'resume' : 'pause')}
                  >
                    {visualPaused ? '继续' : '暂停'}
                  </Button>
                )}
              </div>
            </div>
          )}

          {!visualCollecting && !cfxCollecting && !activeItem && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={deliveryTasks.length > 0 ? '没有正在投递的岗位' : '还没有岗位，先「搜索采集」或「加入任务」'}
              style={{ marginTop: 8 }}
            />
          )}          {activeItem && (
            <div className="delivery-task-list">
              <div key={activeItem.id} className={'delivery-task is-' + activeItem.status + ' is-active'}>
                <div className="delivery-task-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="delivery-task-title">{cleanTitle(activeItem.job?.title, activeItem.job?.salary)}</div>
                    <div className="delivery-task-sub">
                      <PlatformChip platform={activeItem.job?.platform} />
                      {formatMetaLine(activeItem.job?.company, activeItem.job?.location, activeItem.job?.salary) || '岗位信息处理中'}
                    </div>
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
            <button
              type="button"
              className={`wb-ignored-toggle${showIgnored ? ' is-on' : ''}`}
              aria-pressed={showIgnored}
              onClick={() => setShowIgnored((v) => !v)}
            >
              <span className="wb-ignored-toggle__text">显示已忽略/跳过</span>
              <span className="wb-ignored-toggle__switch" aria-hidden>
                <span className="wb-ignored-toggle__knob" />
              </span>
            </button>
            <div className="wb-filter-toolbar__right">
              <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={onOneClickDeliver} disabled={!deliverableCount || running} title={running ? '投递引擎已在运行' : '把队列里已确认的岗位立刻开始投递（与右侧「开始投递」同一引擎开关）'}>一键投递</Button>
              <Button size="small" icon={<CheckOutlined />} onClick={onApproveAll}>批量确认</Button>
              <Button size="small" onClick={onRejectAll}>全部忽略</Button>
            </div>
          </div>
        </div>
        <div className="wb-sort-hint">
          <InfoCircleOutlined className="wb-sort-hint__icon" />
          <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.4 }}>
            待确认岗位按 AI 匹配分从高到低排列；点「确认」即加入「投递中」队列，确认前可先修改求职招呼语（招呼语为空则无法确认）。
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
                // 元信息行只展示真实解析到的「公司 · 地点 · 薪资」；缺字段时整行不渲染，绝不显示占位/裸链接占位，
                // 投递/招呼语依赖这些真实字段（见 overlay 权威解析），缺失即视为旧卡，需重新「加入任务」触发自愈补齐。
                const metaLine = formatMetaLine(p.job?.company, p.job?.location, p.job?.salary);
                return (
                  <div key={p.id} className={'job-card ' + jobCardStatus(p) + (p.id === activeId ? ' is-active' : '')}>
                    <div className="job-header" role="button" tabIndex={0} aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(p.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(p.id); } }}>
                      <div className="job-header-main">
                        <div className="job-title-row">
                          <div className="job-title">
                            <PlatformChip platform={p.job?.platform} compact />
                            {cleanTitle(p.job?.title, p.job?.salary)}
                          </div>
                          <div className="job-header-badges">
                            {p.priorityRank != null && <span className="score-rank">#{p.priorityRank}</span>}
                            {chip.cls && <span className={'score-chip ' + chip.cls}>{chip.text}</span>}
                            <button className="job-expand-btn" type="button" title={isExpanded ? '收起' : '展开'} onClick={(e) => { e.stopPropagation(); toggleExpanded(p.id); }}>
                              <ChevronDown rotate={isExpanded ? 0 : -90} size={11} />
                            </button>
                          </div>
                        </div>
                        {metaLine ? (
                          <div className="job-company">{metaLine}</div>
                        ) : (
                          <div className="job-company" style={{ color: '#999', fontSize: 12 }}>
                            ⚠ 信息待补全：重新「加入任务」可补齐公司/地点/薪资
                            {(p.job as any)?.parseDiag && (
                              <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>诊断:{(p.job as any).parseDiag}</span>
                            )}
                          </div>
                        )}
                        <div className="job-meta job-meta--wb">
                          {/* 首个标签 = AI 四种匹配度（档位：推荐/匹配/谨慎/不推荐，由 AI 四层整体裁决生成）；
                              旧数据缺 fitLevel 时降级为决策徽标（推荐/谨慎/不推荐），避免两枚「推荐」重复展示 */}
                          {p.analysis && (
                            <>
                              {p.analysis.fitLevel ? (
                                <span className="job-fit-tag">{fitLevelLabel(p.analysis.fitLevel)}</span>
                              ) : (
                                <span className={`job-decision job-decision--${
                                  p.analysis.decision === 'recommend' ? 'recommend'
                                    : p.analysis.decision === 'cautious' ? 'cautious' : 'reject'
                                }`}>
                                  {p.analysis.decision === 'recommend' ? '推荐' : p.analysis.decision === 'cautious' ? '谨慎' : '不推荐'}
                                </span>
                              )}
                            </>
                          )}
                          {welfareTag(p)}
                          {interviewModeTag(p)}
                        </div>
                      </div>
                      <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto' }}>{st.label}</Tag>
                    </div>
                    {isExpanded && (
                      <div className="job-body" onClick={(e) => e.stopPropagation()}>
                        {p.analysis?.reason && <div className="job-reason">{p.analysis.reason}</div>}
                        {p.analysis?.aiNote && <div className="job-ainote">{p.analysis.aiNote}</div>}
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
                        // ===== 待确认：唯一可「确认沟通」的态（无招呼语会被 onApprove 拒绝）=====
                        <>
                          <div className="job-actions-right">
                            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApprove(p.id)}>确认沟通</Button>
                          </div>
                          <div className="job-actions-left">
                            <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && webviewApi.current?.openInNewTab(p.job.url, p.job?.title)}>打开</Button>
                            <Button size="small" onClick={() => onIgnore(p.id)}>忽略</Button>
                          </div>
                        </>
                      ) : p.status === 'approved_queue' || p.status === 'approved' ? (
                        // ===== 已确认入队（投递中）/ 历史遗留待投递：只能「撤回」退回待确认 =====
                        // 09-16：批准即入队后 approved_queue 是常态。此前该态落入下面的兜底分支，
                        // 显示「批准 / 重试」（语义错位：已确认的岗位还让人再点一次批准，点重试则被打回待确认），
                        // 与 pending 卡的「确认沟通」不构成对称动作 —— 现统一为「撤回」。
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
                        // ===== 终态：已投递 / 失败 / 已跳过等 =====
                        <>
                          <div className="job-actions-left">
                            {p.status === 'sent' ? (
                              <Button size="small" type="primary" icon={<CheckOutlined />} disabled>已投递</Button>
                            ) : (
                              // 失败等非终态：允许重新投递（回到投递队列）。
                              // 不再叫「批准」——该岗位已确认过，此时只是重跑投递，叫「重试」才不会
                              // 与待确认卡的「确认沟通」混淆（用户反馈：已确认的岗位还显示「批准」很怪）。
                              <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => onRetry(p.id)}>重试</Button>
                            )}
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
          overlaySuppressed={visualCollecting}
        />
      </div>
    </div>
  );
}
