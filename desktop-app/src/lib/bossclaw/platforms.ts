// BossClaw 平台注册层 —— 驱动多平台（BOSS直聘 / 猎聘 / 智联招聘 / 前程无忧 51Job）
// 数据模型、投递语义、外部网申检测、阶段标签映射统一在此收口。
// 口径来源：GitHub 调研 get_jobs(loks666, 8.3k★) / Auto-JobHunter(jolie-z) / AgentMesh-JobAgent，
// 对齐 AGENTS.md 安全不变量：外部网申跳过、未确认不计成功、不绕过验证码。
import type { JobPlatform, TaskStage } from './types';

export type { JobPlatform } from './types';

/** 投递动作语义：boss=聊天文字气泡；liepin=App 预设招呼语自动发送；zhaopin/job51=投递简历按钮 */
export type DeliveryKind = 'chat' | 'greetAuto' | 'resume';

export interface PlatformMeta {
  id: JobPlatform;
  /** 展示名 */
  label: string;
  /** 域名（hostname 匹配用，含后缀 .com） */
  domain: string;
  homeUrl: string;
  loginUrl: string;
  deliveryKind: DeliveryKind;
  /** 外部网申 / 第三方跳转岗位的按钮文本（命中即跳过，安全不变量） */
  externalApplyHints: string[];
  /** 各平台阶段标签覆盖（未覆盖项回退 BOSS 通用口径） */
  stageLabels: Partial<Record<TaskStage, string>>;
  /** 平台侧投递/搜索限制提示（设置页展示） */
  dailyHint?: string;
  /**
   * 岗位卡片 chip 配色（与 score-chip/dim-chip 同风格的统一 chip）。
   * key 取自 PLATFORM_CHIP_PALETTE；新增平台只需在这里加一行即可。
   */
  chipKey: 'brand' | 'blue' | 'orange' | 'purple';
}

/** 岗位卡片平台 chip 配色（与现有 score-chip / dim-chip 风格一致：背景 12% 透明 + 文本深色） */
export const PLATFORM_CHIP_PALETTE: Record<PlatformMeta['chipKey'], { bg: string; fg: string }> = {
  brand: { bg: 'rgba(13, 148, 136, 0.12)', fg: '#0D9488' },   // BOSS 直聘：品牌绿
  blue: { bg: 'rgba(37, 99, 235, 0.12)', fg: '#2563EB' },     // 智联招聘：蓝色
  orange: { bg: 'rgba(234, 88, 12, 0.12)', fg: '#EA580C' },   // 猎聘：橙色
  purple: { bg: 'rgba(139, 92, 246, 0.14)', fg: '#7C3AED' },  // 前程无忧 51Job：紫色
};

export const PLATFORM_META: Record<JobPlatform, PlatformMeta> = {
  boss: {
    id: 'boss',
    label: 'BOSS直聘',
    domain: 'zhipin.com',
    homeUrl: 'https://www.zhipin.com',
    loginUrl: 'https://www.zhipin.com/web/user/?ka=header-login',
    deliveryKind: 'chat',
    externalApplyHints: [
      '立即网申', '去网申', '前往网申', '立即申请', '去申请',
      '申请职位', '立即投递', '投递简历', '前往申请',
    ],
    stageLabels: {},
    chipKey: 'brand',
  },
  liepin: {
    id: 'liepin',
    label: '猎聘',
    domain: 'liepin.com',
    homeUrl: 'https://www.liepin.com',
    loginUrl: 'https://www.liepin.com/login/',
    deliveryKind: 'greetAuto',
    // 猎聘投递=点「聊一聊」即沟通，无网申概念（聊一聊不跳第三方）
    externalApplyHints: ['立即网申', '去网申', '前往申请', '申请职位'],
    stageLabels: {
      open_chat: '打开沟通窗口',
      opened: '已打开沟通窗口',
      verify_chat_target: '核对招聘方',
      fill_message: '等待平台打招呼',
      send_message: '平台自动打招呼',
      verify_message: '确认已打招呼',
      send_resume: '发送简历附件',
      verify_result: '确认沟通结果',
      success: '沟通成功',
    },
    dailyHint: '打招呼由猎聘 App 预设文案自动发送，需先在猎聘 App 设置招呼语',
    chipKey: 'orange',
  },
  zhaopin: {
    id: 'zhaopin',
    label: '智联招聘',
    domain: 'zhaopin.com',
    homeUrl: 'https://www.zhaopin.com',
    loginUrl: 'https://passport.zhaopin.com/login',
    deliveryKind: 'resume',
    // 智联投递=站内「投递」按钮；第三方外链岗位需跳过
    externalApplyHints: ['立即网申', '去网申', '前往申请', '查看详情并投递', '前往企业官网'],
    stageLabels: {
      open_chat: '打开岗位',
      opened: '已打开岗位',
      verify_chat_target: '核对岗位与公司',
      fill_message: '准备投递简历',
      send_message: '投递简历',
      verify_message: '确认投递结果',
      send_resume: '补充发送附件',
      verify_result: '确认投递结果',
      success: '投递成功',
    },
    dailyHint: '智联平台侧每日约 100 次投递上限，接近上限时自动停止',
    chipKey: 'blue',
  },
  job51: {
    id: 'job51',
    label: '前程无忧',
    domain: '51job.com',
    homeUrl: 'https://we.51job.com',
    loginUrl: 'https://we.51job.com/pc/login',
    deliveryKind: 'resume',
    externalApplyHints: ['立即网申', '去网申', '前往申请', '查看详情并投递', '前往企业官网'],
    stageLabels: {
      open_chat: '打开岗位',
      opened: '已打开岗位',
      verify_chat_target: '核对岗位与公司',
      fill_message: '准备投递简历',
      send_message: '投递简历',
      verify_message: '确认投递结果',
      send_resume: '补充发送附件',
      verify_result: '确认投递结果',
      success: '投递成功',
    },
    dailyHint: '前程无忧投递动作=「批量投递」+ 成功数量确认',
    chipKey: 'purple',
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORM_META) as JobPlatform[];

/**
 * 各平台每日投递「硬上限」（平台侧约束，超过会被平台限流/风控）：
 * 智联简历投递平台侧约 100 次/日（来源：docs/使用注意事项.md「平台限制」），其余平台无明确侧限，
 * 回退到全局防封号上限 SAFETY_LIMITS.MAX_SAFE_DAILY=150。上限按「适配各个平台数字」逐平台收窄。
 */
export const PLATFORM_DAILY_CAPS: Partial<Record<JobPlatform, number>> = {
  zhaopin: 100,
};

/**
 * 各平台「每日投递目标」默认值（0 表示不设限，仍受 PLATFORM_DAILY_CAPS / MAX_SAFE_DAILY 收窄）：
 * BOSS/猎聘/前程无忧 120（沿用原全局默认），智联 100（贴合其平台侧 ~100/日 上限）。
 * defaults.ts 的 DEFAULT_CONFIG.platforms 与本常量保持同源。
 */
export const PLATFORM_DEFAULT_DAILY_TARGET: Record<JobPlatform, number> = {
  boss: 120,
  liepin: 120,
  zhaopin: 100,
  job51: 120,
};

/** 平台每日投递上限展示用（最小收窄后值）：无平台侧限制的平台 = MAX_SAFE_DAILY(150) */
export function platformDailyCap(platform: JobPlatform): number {
  const side = PLATFORM_DAILY_CAPS[platform];
  const cap = side && side > 0 ? side : 150; // 150 = SAFETY_LIMITS.MAX_SAFE_DAILY（见 safety.ts）
  return Math.max(1, Math.min(cap, 150));
}

/** 按 URL hostname 解析平台（未知域名回退 boss，保持存量兼容） */
export function resolvePlatform(url?: string | null): JobPlatform {
  const u = String(url || '');
  let host = '';
  try {
    host = new URL(u, 'https://localhost').hostname.toLowerCase();
  } catch {
    host = (u.split('/')[2] || '').toLowerCase();
  }
  for (const id of PLATFORM_IDS) {
    if (host.endsWith(PLATFORM_META[id].domain)) return id;
  }
  return 'boss';
}

/** 取平台展示名（未知平台回退 BOSS） */
export function platformLabel(platform?: JobPlatform | null): string {
  const p = platform && PLATFORM_META[platform] ? platform : 'boss';
  return PLATFORM_META[p].label;
}

/** 平台默认投递优先级（数字越小越靠前；同 status 的 pending 排序时 BOSS=1 优先于猎聘=2 …）。 */
export const DEFAULT_PLATFORM_PRIORITY: Record<JobPlatform, number> = {
  boss: 1,
  liepin: 2,
  zhaopin: 3,
  job51: 4,
};

/** 平台是否启用（设置配置；未知平台默认 BOSS 视为启用） */
export function platformEnabled(config: { platforms?: Record<JobPlatform, { enabled?: boolean; priority?: number }> } | null | undefined, platform: JobPlatform): boolean {
  const p = config?.platforms?.[platform];
  if (!p) return platform === 'boss';
  return p.enabled !== false;
}

/** 平台投递优先级（数字越小越靠前；未设置/无效值回退到 DEFAULT_PLATFORM_PRIORITY）。 */
export function platformPriority(
  config: { platforms?: Record<JobPlatform, { enabled?: boolean; priority?: number }> } | null | undefined,
  platform: JobPlatform,
): number {
  const p = config?.platforms?.[platform];
  const v = Number(p?.priority);
  if (Number.isFinite(v) && v > 0) return v;
  return DEFAULT_PLATFORM_PRIORITY[platform] ?? 99;
}

/**
 * 按「平台优先级升序」返回当前已启用的平台列表（数字小=靠前）。
 * 用于：
 *   - 工作台搜索选择器下拉项的排序；
 *   - 「自动沟通」批次消费时按 P1 → P2 → P3 → P4 顺序处理（见 rerankPending 排序逻辑）。
 * 平台未启用则不出现；并列优先级时按 DEFAULT_PLATFORM_PRIORITY 决出稳定次序。
 */
export function sortedEnabledPlatforms(
  config: { platforms?: Record<JobPlatform, { enabled?: boolean; priority?: number }> } | null | undefined,
): JobPlatform[] {
  const enabled = PLATFORM_IDS.filter((p) => platformEnabled(config, p));
  return enabled.slice().sort((a, b) => {
    const pa = platformPriority(config, a);
    const pb = platformPriority(config, b);
    if (pa !== pb) return pa - pb;
    return DEFAULT_PLATFORM_PRIORITY[a] - DEFAULT_PLATFORM_PRIORITY[b];
  });
}

/** 外部网申文本检测（安全不变量：命中即跳过）——按平台口径 */
export function isExternalApplyText(text: string, platform: JobPlatform = 'boss'): boolean {
  const t = String(text || '').replace(/\s+/g, '');
  const meta = PLATFORM_META[platform] || PLATFORM_META.boss;
  return meta.externalApplyHints.some((h) => t.includes(h.replace(/\s+/g, '')));
}

/** 按平台取阶段标签（未覆盖回退原始标签） */
export function platformStageLabel(platform: JobPlatform | undefined | null, stage: TaskStage, fallback: string): string {
  if (platform && PLATFORM_META[platform]) {
    const overridden = PLATFORM_META[platform].stageLabels[stage];
    if (overridden) return overridden;
  }
  return fallback;
}
