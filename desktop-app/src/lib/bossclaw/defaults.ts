import type { AppConfig, Profile, ProfileDraft, DirectionPlan, Stats, Workflow } from './types';

// 对齐 job-claw-main\source\src\common.js 的 DEFAULTS
export const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'review',
  dailyTarget: 120,
  discoveryLimit: 0,
  aiLimit: 0,
  minScore: 75,
  targetLocations: [],
  // 城市反选（默认不排除任何省份/城市）
  excludedProvinces: [],
  excludedCities: [],
  // 公司 / 招聘方黑名单（默认空：不屏蔽任何公司与 HR）
  excludedCompanies: [],
  excludedRecruiters: [],
  employmentTypes: ['不限'],
  experiences: [],
  degrees: [],
  salary: '不限',
  sendResumeImage: true,
  sendOnlineResume: false,
  betweenJobsSeconds: 20,
  attachmentDelaySeconds: 4,
  // 沟通阶段卡住超时（秒）：默认 60s；投递卡在「沟通」阶段（打开岗位/沟通窗口/核对）超过该时长无进展则跳过转投下一个
  commStuckTimeoutSec: 60,
  requireSingleJobValidation: true,
  singleJobValidationCompletedAt: 0,
  hrActivityFilter: 'any',
  // 面试方式筛选（对齐用户需求：仅线上/仅线下时排除冲突岗位，默认不限）
  interviewModeFilter: 'any',
  // 猎头过滤（对齐 AI-BossJob 的 excludeHeadhunters，默认关闭）
  excludeHeadhunters: false,
  // 搜索采集自动下拉加载更多岗位（默认开启，解决「收集太少」问题）
  listAutoScroll: true,
  listScrollRounds: 12,
  // 可视化采集节奏（可调，越大越慢越像人工）
  collectSpeedMs: 1500,
  collectResumeIndex: 0,
  // 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 默认不限；本机 1000 兜底防失控）
  maxJobsPerRun: 1000,
  // 防封号默认值（对齐 SAFETY_LIMITS，用户可调低）
  maxDailySent: 120,
  maxActionsPerMinute: 6,
  autoCooldownMinutes: 30,
  pausedUntil: 0,
  // 内置浏览器：闲置超过 5 分钟的后台标签页自动关闭（当前激活标签不关闭，至少保留一个标签页）
  autoCloseIdleTabs: true,
  idleCloseMinutes: 5,
  // 隐身引擎：默认 webview（Electron <webview>，与 webview.cjs 协同）；
  // 用户可在设置页「隐身引擎」一项中切换到 cloak（CloakBrowser 隐身浏览器）或 camoufox
  // （Camoufox 隐身引擎，可选增强），两者均为可选增强，不绕过验证码/账户验证。
  engineMode: 'webview',
  // Camoufox 隐身引擎子配置（os / pages / prefer 与 engineMode='camoufox' 共用）；
  // 启用标志在设置页由 engineMode 切换时联动翻转（workbench 仍以本 enabled 作为
  // 「隐身通道是否启用」的功能开关判据）。
  camoufox: {
    enabled: false,
    os: 'windows',
    pages: 1,
    prefer: false,
  },
  model: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 0.1,
  },
};

export const DEFAULT_PROFILE: Profile | null = null;
export const DEFAULT_PROFILE_DRAFT: ProfileDraft | null = null;
export const DEFAULT_DIRECTION_PLAN: DirectionPlan | null = null;

export const DEFAULT_STATS: Stats = {
  date: '',
  sent: 0,
  discovered: 0,
  analyzed: 0,
  pending: 0,
  failed: 0,
  skipped: 0,
  replied: 0,
  interviews: 0,
};

export const DEFAULT_WORKFLOW: Workflow = {
  running: false,
  paused: true,
  phase: 'idle',
  statusText: '未开始',
  tasks: [],
  taskIndex: 0,
  cardIndex: 0,
  processedKeys: [],
  retries: 0,
  currentJob: null,
  returnUrl: '',
  returnScrollY: 0,
  pendingApplyId: null,
  activeRunId: null,
};

export const today = () => new Date().toISOString().slice(0, 10);

export const uniq = (items: (string | undefined | null)[] = []) =>
  [...new Set(items.filter(Boolean))] as string[];

export const list = (value: string | string[]) =>
  (Array.isArray(value) ? value : String(value || '').split(/[，,\n]/))
    .map((item) => item.trim())
    .filter(Boolean);

export const safeClone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
