// BossClaw 数据模型类型定义
// 对齐 job-claw-main 的运行时数据结构

export type ExecutionMode = 'review' | 'auto';

// 预设提供商：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟 / 自定义
// （硅基流动、火山方舟参考 AI-BossJob 的多模型接入，均为 OpenAI 兼容端点）
export type ModelProvider = 'openai' | 'deepseek' | 'qwen' | 'zhipu' | 'siliconflow' | 'volces' | 'custom';

// HR 活跃度过滤：由用户在设置中指定（确定性规则，非 AI 判断），用于跳过长期不活跃的岗位
// 7 级口径对齐 AI-BossJob（在线/刚刚活跃/今日活跃/3日内活跃/本周活跃/本月活跃/半年前活跃）
export type HrActivityFilter = 'any' | 'month' | 'week' | '3days' | 'today' | 'justActive' | 'online';

// 面试方式筛选：由用户在设置中指定（确定性规则，非 AI 判断），用于排除与设定冲突的面试方式岗位
// 3 选 1：不限 / 仅线上 / 仅线下（与用户需求的「AI 筛选组件：选择不限或者单个」对齐）
export type InterviewModeFilter = 'any' | 'online' | 'offline';

// 图片简历（对齐 AI-BossJob 的 imageResumes）：本地 base64 图片，首次沟通后自动打包发送
export interface ImageResume {
  id: string;
  /** 文件名（用于展示与智能匹配） */
  name: string;
  /** base64 dataURL（如 data:image/jpeg;base64,...） */
  data: string;
  /** 上传时间戳 */
  createdAt: number;
}

export interface AppConfig {
  executionMode: ExecutionMode;
  dailyTarget: number;
  discoveryLimit: number;
  aiLimit: number;
  minScore: number;
  targetLocations: string[];
  /** 城市反选：排除的省份 / 直辖市 / 自治区（简名，如 浙江 / 广东 / 北京） */
  excludedProvinces: string[];
  /** 城市反选：排除的城市（如 杭州 / 深圳），子串命中即排除 */
  excludedCities: string[];
  /** 公司黑名单：不想投的公司名（如 腾讯科技），双向子串命中即排除（不依赖 AI 判断） */
  excludedCompanies: string[];
  /** 招聘方（HR）黑名单：不想沟通的招聘方姓名（如 王老师），子串命中即排除（不依赖 AI 判断） */
  excludedRecruiters: string[];
  employmentTypes: string[];
  experiences: string[];
  degrees: string[];
  salary: string;
  sendResumeImage: boolean;
  sendOnlineResume: boolean;
  betweenJobsSeconds: number;
  attachmentDelaySeconds: number;
  /** 沟通阶段卡住超时（秒）：投递进入「沟通」阶段（打开岗位/打开沟通窗口/核对 HR 与岗位）超过该时长且无进展时，跳过当前岗位转投下一个 */
  commStuckTimeoutSec: number;
  requireSingleJobValidation: boolean;
  singleJobValidationCompletedAt: number;
  hrActivityFilter: HrActivityFilter;
  /** 面试方式筛选：不限 / 仅线上 / 仅线下（确定性规则，非 AI 判断） */
  interviewModeFilter: InterviewModeFilter;
  /** 是否排除猎头岗位（对齐 AI-BossJob 的 excludeHeadhunters） */
  excludeHeadhunters: boolean;
  /** 搜索采集时是否自动下拉加载更多岗位卡片（BOSS 列表为无限滚动，默认开启以收集更多岗位） */
  listAutoScroll: boolean;
  /** 自动下拉最大轮数：每轮滚到底并等待新卡片出现，连续无新卡片即停止；0 视为使用默认 12 轮 */
  listScrollRounds: number;
  /** 可视化采集滚动间隔（毫秒，每步 settleMs），越大越慢越像人工 */
  collectSpeedMs: number;
  /** 断点续采起始序号：0 表示从头；>0 表示跳过前 N 个岗位（已入库岗位会自动去重跳过） */
  collectResumeIndex: number;
  /** 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 默认不限；本机 1000 兜底防失控）。0 表示不限 */
  maxJobsPerRun: number;
  /** 单日投递硬上限（防封号），超过即暂停；受 SAFETY_LIMITS.MAX_SAFE_DAILY 封顶 */
  maxDailySent: number;
  /** 每分钟动作上限（防封号），远低于平台限速阈值 */
  maxActionsPerMinute: number;
  /** 触发风控/连续失败后的冷却时长（分钟） */
  autoCooldownMinutes: number;
  /** 冷却锁截止时间戳（毫秒）；> now 表示处于冷却期，自动辅助不可启动 */
  pausedUntil: number;
  /** 内置浏览器：是否自动关闭闲置（未被激活/导航）超过阈值的后台标签页 */
  autoCloseIdleTabs: boolean;
  /** 内置浏览器闲置标签自动关闭的阈值（分钟），仅当 autoCloseIdleTabs 为 true 时生效 */
  idleCloseMinutes: number;
  /**
   * 内置浏览器 / 隐身引擎模式（统一三选一）：
   *   - 'webview'（默认）：Electron <webview>，原 Boss-claw 路径，与 webview.cjs 预加载协同
   *   - 'cloak'：CloakBrowser 隐身浏览器（Node + Playwright），多 Page + 持久 profile，
   *     用于降低 BOSS 直聘反检测概率（仅作可选增强，不绕过验证码/账户验证）
   *   - 'camoufox'：Camoufox 隐身引擎（Python 桥，仅 Camoufox 原生内核可用；实测 BOSS
   *     对 Playwright 驱动的系统 Chrome/Edge 返回空壳页，故本地浏览器不可复用），
   *     同样不绕过验证码/账户验证。
   * 切换后需要刷新工作台才能生效；cloak / camoufox 模式下 webviewTag 仍开启以便回退。
   * 注：'camoufox' 与下方 camoufox.enabled 在设置层互相同步；Workbench 仍以 camoufox.enabled
   * 作为「隐身通道是否启用」的功能开关判据，本字段是其语义入口。
   */
  engineMode: 'webview' | 'cloak' | 'camoufox';
  /**
   * Camoufox 隐身引擎（可选增强，来自 boss-auto-job-main 的方案）：
   * C++ 级 Firefox 指纹伪装 + humanize 类人行为，用于降低「正常操作被误判为机器人（code 37）」的概率。
   * 仅作为可选通道；不绕过验证码/账户验证（code 35/36/32 仍立即停止交人工）。
   */
  camoufox: {
    /** 是否启用 Camoufox 隐身引擎（设置页开关；未安装 camoufox 时自动禁用） */
    enabled: boolean;
    /** 指纹伪装的操作系统（windows / macos / linux），默认 windows（与国内求职者真实环境一致） */
    os: string;
    /** 隐身搜索页数（1-5），默认 1 */
    pages: number;
    /** 隐身搜索/发送时是否强制走 Camoufox（true）或仅在 webview 失败时兜底（false） */
    prefer: boolean;
  };
  model: {
    provider: ModelProvider;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
  /**
   * 早中晚分批投递：仅在全自动模式（executionMode='auto'）时生效。
   * 开启后，自动投递引擎只会在 早 / 午 / 晚 三个时段窗口内投递，
   * 每个时段最多投递 counts.对应字段 条（0 表示该时段不限量），
   * 避免集中在一次批量投递触发平台风控。
   */
  batchDelivery: {
    /** 是否启用分批投递 */
    enabled: boolean;
    /** 早间时段开始时间 'HH:mm'（早间窗口 = morningTime → noonTime） */
    morningTime: string;
    /** 午间时段开始时间 'HH:mm'（午间窗口 = noonTime → eveningTime） */
    noonTime: string;
    /** 晚间时段开始时间 'HH:mm'（晚间窗口 = eveningTime → 次日 00:00） */
    eveningTime: string;
    /** 每个时段本次投递配额（0 表示不设该时段限量） */
    counts: { morning: number; noon: number; evening: number };
  };
}

export interface ProfileFacts {
  education: string[];
  experiences: string[];
  projects: string[];
  skills: string[];
  certificates: string[];
}

export interface PrimaryDirection {
  name: string;
  confidence: number;
  evidence: string[];
}

export interface HardConstraints {
  locations: string[];
  employmentTypes: string[];
  salary: string;
  experience: string;
  degree: string;
}

export interface ProfileGeneration {
  mode: string;
  label: string;
  aiStatus: string;
  warning?: string;
  technicalReason?: string;
  generatedAt?: number;
}

export interface Profile {
  facts: ProfileFacts;
  primaryDirections: PrimaryDirection[];
  secondaryDirections: string[];
  searchKeywords: string[];
  hardConstraints: HardConstraints;
  excludeDirections: string[];
  summary: string;
  generation?: ProfileGeneration;
  editedAt?: number;
}

export interface ProfileDraft {
  summary: string;
  primaryDirections: string[];
  searchKeywords: string[];
  skills: string[];
  locations: string[];
  employmentTypes: string[];
  experience: string;
  degree: string;
  salary: string;
  excludeDirections: string[];
  source: string;
  updatedAt: number;
}

export interface DirectionItem {
  id: string;
  source: 'profile' | 'custom';
  custom: boolean;
  sourceName: string;
  name: string;
  enabled: boolean;
  priority: number;
  score: number;
  reason: string;
  matchedSkills: string[];
  gaps: string[];
  keywords: string[];
  updatedAt: number;
}

export interface DirectionPlan {
  version: number;
  items: DirectionItem[];
  confirmed: boolean;
  updatedAt: number;
  appliedAt: number;
  profileSignature: string;
}

export type Decision = 'recommend' | 'cautious' | 'reject';

/**
 * 匹配维度分解（本地确定性计算，可解释；AI 分缺失时作为兜底、存在时用于校准展示）。
 * 对齐 ai-job-search 的多维评估 + Agentic-Career-Assistant 的可解释评分。
 */
export interface MatchDimensions {
  /** 技能匹配 0-100（画像技能在 JD 中的加权命中率）；信息不足为 null */
  skill: number | null;
  /** 方向匹配 0-100（岗位标题/描述 vs 画像方向/搜索词） */
  direction: number | null;
  /** 地点匹配 0-100（岗位地点 vs 目标城市） */
  location: number | null;
  /** 薪资匹配 0-100（JD 薪资 vs 期望薪资） */
  salary: number | null;
  /** 学历匹配 0-100（JD 要求 vs 画像学历） */
  education: number | null;
  /** 经验匹配 0-100（JD 要求 vs 画像经验） */
  experience: number | null;
  /** 本地加权综合分 0-100（null 维度剔除后重归一化） */
  overall: number | null;
  /** 维度计算确定程度（0-1），用于 AI 分校准的置信度 */
  confidence: number;
}

export interface JobAnalysis {
  score: number;
  decision: Decision;
  hardBlocks: string[];
  matchedEvidence: string[];
  gaps: string[];
  risks: string[];
  reason: string;
  greeting: string;
  /** 本地确定性维度分解（可解释匹配；analyzeJob 计算后附加） */
  dimensions?: MatchDimensions;
}

export interface JobMeta {
  title?: string;
  company?: string;
  salary?: string;
  location?: string;
  publishTime?: string;
  applicationMode?: string;
  cardText?: string;
  url?: string;
  jobId?: string;
  description?: string;
  /** HR 活跃度（BOSS 页面提取，如 在线 / 刚刚活跃 / 3日内活跃），仅用于展示与用户设定的活跃度过滤，不再作为 AI 判断依据 */
  hrActive?: string;
  /** 是否为猎头岗位（BOSS 页面标签识别，用于「排除猎头」过滤） */
  isHeadhunter?: boolean;
  /** 面试方式（从岗位标题/描述/卡片文本提取：线上/线下/未识别），用于「面试方式筛选」 */
  interviewMode?: 'online' | 'offline' | 'unknown';
  /** 招聘方姓名（BOSS 详情页识别，用于投递前核对沟通对象） */
  recruiterName?: string;
  /** 沟通窗口链接（含 conversationId 等 token） */
  chatUrl?: string;
  /** 招聘方加密用户 ID（BOSS 官方接口 encryptUserId，投递 friend/add.json 用） */
  encryptUserId?: string;
  /** 招聘方职位（BOSS 官方接口 bossTitle） */
  recruiterTitle?: string;
  [key: string]: unknown;
}

export type PendingStatus =
  | 'approved'
  | 'approved_queue'
  | 'pending'
  | 'failed'
  | 'opened'
  | 'sent'
  | 'skipped'
  | 'rejected'
  | 'ignored';

export interface PendingItem {
  id: string;
  runId?: string;
  job: JobMeta;
  analysis?: JobAnalysis;
  task?: unknown;
  deliveryGreeting: string;
  status: PendingStatus;
  createdAt: number;
  approvedAt?: number;
  priorityScore?: number;
  priorityRank?: number | null;
  retryCount?: number;
  error?: string;
  retryable?: boolean;
  /** 成功投递时间戳（用于单日投递上限统计） */
  sentAt?: number;
  /** 已打开沟通窗口时间戳（工作台「点击立即沟通」后、尚未发送文字） */
  openedAt?: number;
  /** 是否因风控（验证/封禁）被禁止重试 */
  riskBlocked?: boolean;
}

export type TaskStage =
  | 'discovered'
  | 'collect_detail'
  | 'ai_analyze'
  | 'ai_complete'
  | 'waiting_review'
  | 'queued'
  | 'retry_queued'
  | 'open_job'
  | 'open_chat'
  | 'opened'
  | 'verify_chat_target'
  | 'fill_message'
  | 'send_message'
  | 'verify_message'
  | 'send_resume'
  | 'verify_result'
  | 'success'
  | 'failed'
  | 'ignored'
  | 'skipped';

export interface TaskRun {
  id: string;
  pendingId?: string;
  job?: JobMeta;
  analysis?: JobAnalysis;
  searchTask?: unknown;
  directionId?: string;
  directionName?: string;
  directionPriority?: number;
  directionScore?: number;
  keyword?: string;
  location?: string;
  employmentType?: string;
  attempts?: number;
  processed?: number;
  discovered?: number;
  analyzed?: number;
  failed?: number;
  status: 'running' | 'success' | 'failed' | 'skipped' | 'ignored' | 'waiting_review' | 'queued' | 'pending';
  stage: TaskStage;
  progress: number;
  stageLabel: string;
  error?: string;
  retryable?: boolean;
  completedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface Stats {
  date: string;
  sent: number;
  discovered: number;
  analyzed: number;
  pending: number;
  failed: number;
  skipped: number;
  replied: number;
  interviews: number;
}

export interface Workflow {
  running: boolean;
  paused: boolean;
  phase: string;
  statusText: string;
  tasks: unknown[];
  taskIndex: number;
  cardIndex: number;
  processedKeys: string[];
  retries: number;
  currentJob: JobMeta | null;
  returnUrl: string;
  returnScrollY: number;
  pendingApplyId: string | null;
  activeRunId: string | null;
}
