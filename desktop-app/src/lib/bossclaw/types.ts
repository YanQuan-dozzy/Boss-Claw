// BossClaw 数据模型类型定义
// 对齐 job-claw-main 的运行时数据结构

// 岗位适配档位（类型定义在 fitLevel.ts，与档位→分数/决策的映射放在一起，便于离线回归测试）。
// 这里只做 type-only 引用，编译期擦除，不构成运行时循环依赖。
import type { FitLevel } from './fitLevel';

export type ExecutionMode = 'review' | 'auto';

// 招聘平台（多平台适配：BOSS 基础上新增 猎聘 / 智联招聘 / 前程无忧 51Job）
export type JobPlatform = 'boss' | 'liepin' | 'zhaopin' | 'job51';

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
  /** （已废弃，仅作旧数据兼容读取）已迁移到 platforms[k].dailyTarget（按平台独立每日目标） */
  dailyTarget: number;
  discoveryLimit: number;
  aiLimit: number;
  /** 推荐岗位分：岗位综合评分 ≥ 该值判为「推荐」档（recommend），默认 75 */
  minScore: number;
  /** 最低入队分：评分低于该值的岗位不进入工作台队列（0 = 不限，仅拦「不推荐」硬伤岗位），默认 60 */
  minQueueScore: number;
  /** 采集 AI 分析并发上限（1-8，默认 3）：搜索采集对 analyzeJob 做有界并发，防止视觉采集 fire-and-forget 造成无界 LLM 调用堆积 */
  analysisConcurrency?: number;
  targetLocations: string[];
  /** 城市反选：排除的省份 / 直辖市 / 自治区（简名，如 浙江 / 广东 / 北京） */
  excludedProvinces: string[];
  /** 城市反选：排除的城市（如 杭州 / 深圳），子串命中即排除 */
  excludedCities: string[];
  /** 公司黑名单：不想投的公司名（如 腾讯科技），双向子串命中即排除（不依赖 AI 判断） */
  excludedCompanies: string[];
  /** 招聘方（HR）黑名单：不想沟通的招聘方姓名（如 王老师），子串命中即排除（不依赖 AI 判断） */
  excludedRecruiters: string[];
  /** 岗位描述排除关键字（如 出差 / 驻场 / 长期外派）：岗位标题/卡片文本/描述任一命中即排除（确定性过滤，不依赖 AI 判断） */
  excludedJobDescKeywords: string[];
  employmentTypes: string[];
  experiences: string[];
  degrees: string[];
  salary: string;
  /** 公司规模筛选（单选，BOSS scale 参数：0-20人=301 / 20-99人=302 / 100-499人=303 / 500-999人=304 / 1000-9999人=305 / 10000人以上=306；不限=不附加过滤） */
  companyScale: string;
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
  /**
   * 最低日薪（元/天，确定性硬约束，非 AI 判断）：把岗位任意薪资口径（月/日/时）
   * 折算到「元/天」后，低于该值即判定为硬拦截（reject，不进入投递队列）。
   * 0（默认）= 不限，任何日薪都放行；设为 100 即「日薪 < 100 元/天」的岗位（如 50 元/天）被排除。
   */
  minSalaryPerDay: number;
  /** 是否排除猎头岗位（对齐 AI-BossJob 的 excludeHeadhunters） */
  excludeHeadhunters: boolean;
  /** 搜索采集时是否自动下拉加载更多岗位卡片（BOSS 列表为无限滚动，默认开启以收集更多岗位） */
  listAutoScroll: boolean;
  /** 自动下拉最大轮数：每轮滚到底并等待新卡片出现，连续无新卡片即停止；0 视为使用默认 12 轮 */
  listScrollRounds: number;
  /** 可视化采集滚动间隔（毫秒，每步 settleMs），越大越慢越像人工 */
  collectSpeedMs: number;
  /**
   * 搜索页加载等待上限（毫秒）：每次采集切换搜索组合后，等待「preload 就绪 + 加载遮罩消失」的最长时间，
   * 超时则重载重试一次、仍失败才跳过该组合。默认 30000（BOSS 搜索页较重，旧实现仅 8s 易整组跳过）。
   */
  collectPageTimeoutMs: number;
  /** 断点续采起始序号：0 表示从头；>0 表示跳过前 N 个岗位（已入库岗位会自动去重跳过） */
  collectResumeIndex: number;
  /**
   * 无关键字采集（随机岗位推荐）：开启后采集队列**不再附加 query（关键词）**，
   * 只保留用户已设置的城市 / 求职类型 / 经验 / 学历 / 薪资 / 公司规模等筛选，
   * 由平台按「账号内已完善的求职意向」返回推荐岗位，避免同一关键词反复重试时拿到大量重复岗位。
   * 使用前提：需先在 BOSS 直聘（网页 / App）内完善在线简历与求职意向，否则返回岗位可能不相关。
   */
  collectWithoutKeyword: boolean;
  /** 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 默认不限；本机 1000 兜底防失控）。0 表示不限 */
  maxJobsPerRun: number;
  /**
   * （已废弃，仅作旧数据兼容读取）曾为单日投递硬上限。
   * 已迁移为「按平台适配」：每平台实际上限 = min(该平台每日目标 platforms[k].dailyTarget, 平台侧上限, 150)，
   * 见 safety.ts effectiveDailyCapFor。本字段不再参与强制执行。
   */
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
   * 启用中的招聘平台（多平台适配）：默认仅 boss；liepin/zhaopin/job51 需在设置页手动启用。
   * 搜索采集与投递按启用平台分流（未启用的平台不出现在工作台搜索选择器中）。
   *
   * `priority`：平台投递顺序（数字越小越靠前；同 status 的 pending 排序时 BOSS=1
   *   优先于猎聘=2 ……）。后台引擎会按此顺序"先跑完一个平台全部 approved 任务再切下一个"。
   * 默认 BOSS=1, liepin=2, zhaopin=3, job51=4；用户可在「设置 → 招聘平台」用上下按钮调整。
   *
   * `dailyTarget`：本平台每日投递目标（0 表示不限，仍受平台侧上限与 SAFETY_LIMITS.MAX_SAFE_DAILY 双重收窄）。
   * 按平台独立配置（多平台同时启用时，每个平台各自跑自己的额度）；每平台「上限」随之适配：
   *   min(该平台每日目标, 平台侧上限(如智联 ~100/日), MAX_SAFE_DAILY=150)。
   * 用户可在「设置 → 招聘平台」每个平台卡片中调整。取代原先顶层 AppConfig.dailyTarget / maxDailySent
   * （后两者已废弃，仅作旧数据兼容读取）。
   */
  platforms: Record<JobPlatform, { enabled: boolean; priority: number; dailyTarget: number }>;
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
}

export interface ProfileFacts {
  education: string[];
  experiences: string[];
  projects: string[];
  skills: string[];
  certificates: string[];
  /**
   * 细粒度能力清单（用于投递方向缺口/匹配技能的精确比对）：
   * 把简历里的能力按「能力名 + 细分」展开，如 `数据库(PostgreSQL/MySQL)`、`SQL 调优`、
   * `索引设计`、`事务处理`、`pgvector 向量检索`。AI 画像生成时产出，本地规则兜底推导。
   */
  capabilities: string[];
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
 * AI 语义评估可用时，五个业务维度（skill/direction/salary/education/experience）
 * 与 overall 会被 AI 维度分覆盖（见 matching.ts mergeAiDimensions），location 恒为本地值。
 */
export interface MatchDimensions {
  /** 技能匹配 0-100（AI 语义评估优先，本地加权命中率兜底）；信息不足为 null */
  skill: number | null;
  /** 方向匹配 0-100（AI 语义评估优先，本地标题/描述命中兜底） */
  direction: number | null;
  /** 地点匹配 0-100（岗位地点 vs 目标城市；仅本地确定性计算，不进 AI 维度） */
  location: number | null;
  /** 薪资匹配 0-100（AI 以本地校准信息为口径评估，本地解析兜底） */
  salary: number | null;
  /** 学历匹配 0-100（AI 语义评估优先，本地学历对照兜底） */
  education: number | null;
  /** 经验匹配 0-100（AI 语义评估优先，本地年限比例兜底） */
  experience: number | null;
  /** 加权综合分 0-100（AI 语义五维加权，null 维度剔除后重归一化；AI 缺失时本地加权） */
  overall: number | null;
  /** 维度计算确定程度（0-1），用于 AI 分校准的置信度 */
  confidence: number;
}

/** AI 语义评估的每维评分依据（dimensionEvidence，与 dimensions 中五维一一对应；仅 AI 给出依据时存在） */
export interface MatchDimensionEvidence {
  skill?: string;
  direction?: string;
  salary?: string;
  education?: string;
  experience?: string;
}

export interface JobAnalysis {
  score: number;
  /**
   * 岗位适配档位（AI 四层整体裁决 + 技能维错位闸门的产物，见 lib/bossclaw/fitLevel.ts）：
   * strong=推荐（>80）/ match=匹配（65-80）/ cautious=谨慎（50-64）/ unfit=不推荐（<50）。
   * score 由档位映射得到（同一档内才允许微调，不跨档）；存量数据可能缺该字段，
   * 读取侧用 fitLevelFromScore(score) 兜底，UI 缺失时降级为不展示档位标签。
   */
  fitLevel?: FitLevel;
  decision: Decision;
  hardBlocks: string[];
  matchedEvidence: string[];
  gaps: string[];
  risks: string[];
  reason: string;
  greeting: string;
  /** 本地确定性维度分解（可解释匹配；analyzeJob 计算后附加） */
  dimensions?: MatchDimensions;
  /**
   * AI 语义评估的每维评分依据（与 dimensions 中的五维一一对应；仅 AI 评分且给出依据时存在，
   * 维度分本身在 dimensions 内，AI 缺失的维度已由本地同维兜底，此处只存 AI 原文依据）。
   */
  dimensionEvidence?: MatchDimensionEvidence;
  /**
   * 总分是否已由「AI 四层整体裁决分 + 维度加权分」融合（true 表示维度加权参与了总分档内微调；
   * 仅在 AI 语义维度可用时出现，纯本地兜底不置位）。
   */
  fusedWithDimensions?: boolean;
  /**
   * 评分来源（UI 提示口径：AI 计算优先，缺 AI 才回退本地）：
   * - 'ai'：AI 分析分有效（主导评分，本地六维作为校准依据）；
   * - 'local'：AI 未参与（返回缺 score 等），分数由本地确定性规则兜底。
   * 缺省（历史数据）按 'ai' 处理。
   */
  scoreSource?: 'ai' | 'local';
  /** AI 首次返回的 JSON 不完整，已通过二次补齐自动修复（内容仍来自 AI）。非降级，仅提示。 */
  aiNote?: string;
}

export interface JobMeta {
  /** 来源招聘平台（多平台适配）：默认 'boss'，存量数据视为 boss */
  platform?: JobPlatform;
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
  /**
   * 福利 / 工作制度标签（如「周末双休」「大小周」「六险一金」）。
   * 采集来源：BOSS job/card.json 的 welfareList 与详情页标签区。用于识别工作制度，
   * 决定日薪/时薪折算月薪的工作日基数（见 workSchedule.ts，双休 22 / 大小周 24 / 单休 26）。
   */
  welfare?: string[];
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
  /** HR 来消息后 AI 跟聊回复的成功时间戳（不计入单日投递上限统计；sentAt 仍为空表示仅回复未投递） */
  replySentAt?: number;
  /** 已打开沟通窗口时间戳（工作台「点击立即沟通」后、尚未发送文字） */
  openedAt?: number;
  /** 是否因风控（验证/封禁）被禁止重试 */
  riskBlocked?: boolean;
}

/** 达标岗位导出记录：从工作台队列收集评分≥最低分的岗位，按「日期 → 该日已导出的达标岗位」持久化。
 *  key 是岗位去重标识（jobId/url，缺失时回退 platform|公司|标题|地点），仅用于当天内去重。 */
export interface QualifiedJobExport {
  /** 岗位去重键（当天内去重依据） */
  key: string;
  minScore: number;
  score: number;
  decision: string;
  title: string;
  company: string;
  salary: string;
  location: string;
  url: string;
  platform: string;
  recruiterName: string;
  status: string;
  /** 加入队列时间戳 */
  createdAt: number;
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
