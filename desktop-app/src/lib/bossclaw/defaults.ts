import type { AppConfig, Profile, ProfileDraft, DirectionPlan, Stats, Workflow } from './types';
import { PLATFORM_DEFAULT_DAILY_TARGET } from './platforms';
import { PROVIDER_DEFAULTS, DEFAULT_PROVIDER, DEFAULT_MODEL_NAME } from './providerPresets';

// 对齐 job-claw-main\source\src\common.js 的 DEFAULTS
export const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'review',
  // 每日投递目标已迁移到各平台 platforms[k].dailyTarget（多平台独立配额）
  // 每日目标默认值按平台适配：BOSS/猎聘/51Job=120，智联=100（贴合其平台侧 ~100/日 上限）；
  // 顶层字段仅作兼容读取，最终由 merge 函数下放到 platforms
  dailyTarget: 120,
  // 每日上限（maxDailySent）亦已改为「按平台适配」：每平台实际上限 = min(该平台每日目标, 平台侧上限, MAX_SAFE_DAILY=150)，
  // 见 safety.ts effectiveDailyCapFor。顶层字段保留仅为兼容旧数据读取，不再作为全局强制上限使用。
  maxDailySent: 120,
  discoveryLimit: 0,
  aiLimit: 0,
  // 推荐岗位分：≥ 该分判为「推荐」档（可放心投递）
  minScore: 75,
  // 最低入队分：低于该分的岗位不入队（0 = 不限，仅拦「不推荐」硬伤岗位）。
  // 取代旧实现中写死的 60 分入队底线（旧值即 60，升级后行为不变）。
  minQueueScore: 60,
  // 采集 AI 分析并发上限（1-8）：有界并发控制，避免采集突发堆积无界 LLM 调用
  analysisConcurrency: 3,
  targetLocations: [],
  // 城市反选（默认不排除任何省份/城市）
  excludedProvinces: [],
  excludedCities: [],
  // 公司 / 招聘方黑名单（默认空：不屏蔽任何公司与 HR）
  excludedCompanies: [],
  excludedRecruiters: [],
  // 岗位描述排除关键字（默认空：不排除任何岗位描述）
  excludedJobDescKeywords: [],
  employmentTypes: ['不限'],
  experiences: [],
  degrees: [],
  salary: '不限',
  // 公司规模筛选：默认不限（不附加 scale 过滤）
  companyScale: '不限',
  sendResumeImage: true,
  sendOnlineResume: false,
  betweenJobsSeconds: 20,
  attachmentDelaySeconds: 4,
  // 沟通阶段卡住超时（秒）：默认 60s（1 分钟，09-16 由 180s 收紧）。
  // 投递常「立即沟通/继续沟通」整页跳转聊天页，聊天窗口渲染慢时留给它时间；
  // 180s 过长会让「点击未生效」的岗位白等 3 分钟才跳过，观感上像卡死，故收敛到 1 分钟。
  commStuckTimeoutSec: 60,
  requireSingleJobValidation: true,
  singleJobValidationCompletedAt: 0,
  hrActivityFilter: 'any',
  // 面试方式筛选（对齐用户需求：仅线上/仅线下时排除冲突岗位，默认不限）
  interviewModeFilter: 'any',
  // 最低薪资筛选单位：'day'（按日薪）| 'month'（按月薪）
  minSalaryMode: 'day',
  // 最低日薪（元/天，确定性硬约束）：0 = 不限；>0 时岗位折算日薪低于该值即硬性排除（如 50 元/天的不合理岗位）
  minSalaryPerDay: 0,
  // 最低月薪（K元/月，确定性硬约束，支持 1 位小数）：0 = 不限；>0 时岗位折算月薪低于该值即硬性排除（如 8 或 8.5 K元/月）
  minSalaryPerMonth: 0,
  // 猎头过滤（对齐 AI-BossJob 的 excludeHeadhunters，默认关闭）
  excludeHeadhunters: false,
  // 搜索采集自动下拉加载更多岗位（默认开启，解决「收集太少」问题）
  listAutoScroll: true,
  listScrollRounds: 12,
  // 可视化采集节奏（可调，越大越慢越像人工）
  collectSpeedMs: 1500,
  // 搜索页加载等待上限：BOSS 搜索页含骨架屏/重定向/无限列表首屏，给足 30s 再判定超时（旧值 8s 常整组跳过）
  collectPageTimeoutMs: 30000,
  collectResumeIndex: 0,
  // 无关键字采集（随机岗位推荐）：默认关闭。开启后采集 URL 只去掉 query（关键词），
  // 保留城市 / 求职类型 / 经验 / 学历 / 薪资 / 公司规模等用户设置，由平台按账号内的求职意向返回推荐岗位。
  collectWithoutKeyword: false,
  // 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 默认不限；本机 1000 兜底防失控）
  maxJobsPerRun: 1000,
  // 防封号默认值（对齐 SAFETY_LIMITS，用户可调低；maxDailySent 顶层字段见上方说明，实际按平台适配）
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
  // 招聘平台启用（多平台适配）：默认仅 BOSS；猎聘/智联/51Job 需设置页手动启用。
  // priority：投递顺序（数字小=靠前）；BOSS=1, liepin=2, zhaopin=3, job51=4。
  // 用户可在设置页通过上下按钮调整；调整后 rerankPending 排序时按此顺序消费，
  // 实现「完成一个平台全部任务再切下一个平台」。
  platforms: {
    // dailyTarget：每平台每日投递目标（多平台独立配额；0 表示不限，受 MAX_SAFE_DAILY=150 与平台侧上限双重约束）。
    // 默认值按平台适配（PLATFORM_DEFAULT_DAILY_TARGET）：BOSS/猎聘/51Job=120，智联=100（贴合平台侧 ~100/日 上限）
    boss: { enabled: true, priority: 1, dailyTarget: PLATFORM_DEFAULT_DAILY_TARGET.boss },
    liepin: { enabled: false, priority: 2, dailyTarget: PLATFORM_DEFAULT_DAILY_TARGET.liepin },
    zhaopin: { enabled: false, priority: 3, dailyTarget: PLATFORM_DEFAULT_DAILY_TARGET.zhaopin },
    job51: { enabled: false, priority: 4, dailyTarget: PLATFORM_DEFAULT_DAILY_TARGET.job51 },
  },
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
    // P1-10：默认模型名/端点由 providerPresets.ts 单源提供，勿再手写模型名（改一处即可）
    provider: DEFAULT_PROVIDER,
    baseUrl: PROVIDER_DEFAULTS[DEFAULT_PROVIDER].baseUrl,
    apiKey: '',
    // 默认模型名来自 providerPresets.ts（= DeepSeek-V4.1-Flash，原 deepseek-v4-flash 已退役为别名，
    // 第三方网关会 400）；`deepseek-v4-pro` = DeepSeek-V4-Pro-0813。
    model: DEFAULT_MODEL_NAME,
    temperature: 0.1,
    // 思考强度默认关闭：保持原有「直接产出结构化 JSON」的行为不变（思考模式下 temperature 失效、
    // 且思维链会额外消耗输出 token）。用户可在设置页显式开启，能力判定见 thinkingCapability.ts。
    thinking: { enabled: false, effort: 'high' },
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
