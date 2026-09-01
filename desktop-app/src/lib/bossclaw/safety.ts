// BossClaw 风控感知模块 —— 对齐《REVERSE_ENGINEERING.md》中 BOSS 直聘的风控链路，
// 并严格遵守《AGENTS.md 安全不变量》：只做「主动降频、遇险即停、绝不绕过」。
//
// 核心结论（源自逆向分析，用于防封号而非对抗）：
//  - 封号升级链路：高频请求 → 限速(1006) → 滑块验证(35) → 账户异常(36) → 封禁(32)
//  - 36/32 之后继续重试会升级封禁等级；1006 应立即退避而非重试
//  - 平台限速阈值约 30 次/分钟，自动化必须远低于此并加入人类化抖动
//
// 本模块只提供「检测 + 降频 + 冷却 + 上限」等防御性能力，
// 不包含任何指纹伪装、验证码绕过、代理池、账号轮换、反检测逻辑。

import type { AppConfig, PendingItem } from './types';

// ===== 风险严重级别 =====
export type RiskSeverity = 'login' | 'rate_limited' | 'challenge' | 'env' | 'banned';

export interface RiskSignal {
  severity: RiskSeverity;
  /** BOSS 错误码（31/32/35/36/37/1006/5002-5004），无则为 undefined */
  code?: number;
  message: string;
  /** 是否必须人工介入 */
  requireHuman: boolean;
  /** 是否允许自动重试 */
  retryable: boolean;
  /** 建议冷却时长（毫秒） */
  cooldownMs: number;
}

// ===== 安全上限（默认值，可被用户调低但不可被轻易突破） =====
export const SAFETY_LIMITS = {
  /** 单日投递硬上限：超过则强制暂停（dailyTarget 的封顶保护）。按用户要求保持 150 不变 */
  MAX_SAFE_DAILY: 150,
  /** 每分钟动作硬上限：远低于平台约 30 次/分钟 的阈值 */
  MAX_ACTIONS_PER_MINUTE: 8,
  /** 岗位间隔最小秒数（人类化抖动的基数下限） */
  MIN_BETWEEN_JOBS_MS: 15_000,
  /** 触发风控后的默认冷却时长 */
  DEFAULT_COOLDOWN_MS: 30 * 60 * 1000,
  /** 限速（1006）后的默认退避冷却 */
  RATE_LIMIT_COOLDOWN_MS: 10 * 60 * 1000,
} as const;

// ===== 错误码 → 风险信号 =====
const CODE_MAP: Record<number, Omit<RiskSignal, 'code'>> = {
  // 未登录 / 会话失效
  31: { severity: 'login', message: '登录已失效，请重新登录 BOSS 直聘', requireHuman: true, retryable: false, cooldownMs: 0 },
  // 账户封禁
  32: { severity: 'banned', message: '账户已被限制/封禁，请立即停止自动化操作', requireHuman: true, retryable: false, cooldownMs: SAFETY_LIMITS.DEFAULT_COOLDOWN_MS * 4 },
  // 需要滑块/点选安全验证
  35: { severity: 'challenge', message: '需要安全验证（滑块/点选），请人工完成验证', requireHuman: true, retryable: false, cooldownMs: SAFETY_LIMITS.DEFAULT_COOLDOWN_MS },
  // 账户异常（风险评分高，需人工验证）
  36: { severity: 'challenge', message: '账户异常，需人工验证，切勿重复重试以免升级封禁', requireHuman: true, retryable: false, cooldownMs: SAFETY_LIMITS.DEFAULT_COOLDOWN_MS * 2 },
  // 环境异常（检测到异常环境/指纹）
  37: { severity: 'env', message: '检测到环境异常，已暂停，请人工核对', requireHuman: true, retryable: false, cooldownMs: SAFETY_LIMITS.DEFAULT_COOLDOWN_MS },
  // 环境异常未登录（隐身引擎仅 Camoufox 原生内核；未登录的自动化环境可能返回 38）
  38: { severity: 'env', message: '环境异常：请先完成隐身引擎扫码登录后再搜索/投递', requireHuman: true, retryable: false, cooldownMs: SAFETY_LIMITS.DEFAULT_COOLDOWN_MS },
  // 限速（请求频率超阈值）
  1006: { severity: 'rate_limited', message: '请求过于频繁，已被限速，进入退避冷却', requireHuman: false, retryable: true, cooldownMs: SAFETY_LIMITS.RATE_LIMIT_COOLDOWN_MS },
  // 服务端错误
  5002: { severity: 'env', message: '服务端异常(5002)，稍后重试', requireHuman: false, retryable: true, cooldownMs: SAFETY_LIMITS.RATE_LIMIT_COOLDOWN_MS },
  5003: { severity: 'env', message: '服务端异常(5003)，稍后重试', requireHuman: false, retryable: true, cooldownMs: SAFETY_LIMITS.RATE_LIMIT_COOLDOWN_MS },
  5004: { severity: 'env', message: '服务端异常(5004)，稍后重试', requireHuman: false, retryable: true, cooldownMs: SAFETY_LIMITS.RATE_LIMIT_COOLDOWN_MS },
};

/** 按错误码分类风险信号 */
export function classifyRiskCode(code: number | null | undefined): RiskSignal | null {
  if (code == null || !Number.isFinite(Number(code))) return null;
  const entry = CODE_MAP[Number(code)];
  if (!entry) return null;
  return { ...entry, code: Number(code) };
}

/** 按页面 URL 分类风险信号（403?code=32 / verify-slider / security-check 等重定向页） */
export function classifyRiskUrl(url: string): RiskSignal | null {
  const u = String(url || '');
  const m = u.match(/[?&]code=(\d+)/);
  if (m) return classifyRiskCode(Number(m[1]));
  if (/verify-slider|zpsecureflow\/captcha|passport\/zp\/verify/i.test(u)) {
    return classifyRiskCode(35);
  }
  if (/security-check/i.test(u)) {
    return classifyRiskCode(37);
  }
  return null;
}

/** 按页面文本分类风险信号（webview 回传的正文文本） */
export function classifyRiskText(text: string): RiskSignal | null {
  const t = String(text || '');
  if (/访问过于频繁|操作过于频繁|操作频繁|请求过于频繁|稍后再试/.test(t)) return classifyRiskCode(1006);
  if (/账号异常|账户异常|账号冻结|账户冻结|账号封禁|账户封禁|账号受限|违规行为/.test(t)) return classifyRiskCode(32);
  if (/安全验证|滑动验证|滑块验证|点选验证|图形验证|行为验证/.test(t)) return classifyRiskCode(35);
  if (/环境异常|检测到异常环境|非浏览器环境/.test(t)) return classifyRiskCode(37);
  if (/请先登录|登录已过期|重新登录|登录失效|会话失效/.test(t)) return classifyRiskCode(31);
  return null;
}

/** 综合检测（供 webview 或渲染层调用） */
export function detectRisk(input: { url?: string; text?: string; code?: number | null }): RiskSignal | null {
  if (input.code != null) {
    const byCode = classifyRiskCode(input.code);
    if (byCode) return byCode;
  }
  const byUrl = classifyRiskUrl(input.url || '');
  if (byUrl) return byUrl;
  return classifyRiskText(input.text || '');
}

// ===== 人类化延迟（抖动） =====
export function humanDelayMs(baseMs: number, jitterRatio = 0.35): number {
  const base = Math.max(500, Number(baseMs) || 0);
  const jitter = base * Math.max(0, Math.min(1, jitterRatio));
  return Math.round(base + (Math.random() * 2 - 1) * jitter);
}

export function humanDelay(baseMs: number, jitterRatio = 0.35): Promise<number> {
  const ms = humanDelayMs(baseMs, jitterRatio);
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms));
}

// ===== 滑动窗口限速器（每分钟动作预算） =====
export class ActionPacer {
  private timestamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  get budget(): number {
    return Math.max(1, this.maxPerMinute);
  }

  canAct(now = Date.now()): boolean {
    this.prune(now);
    return this.timestamps.length < this.budget;
  }

  /** 记录一次动作 */
  record(now = Date.now()): void {
    this.prune(now);
    this.timestamps.push(now);
  }

  /** 等待直到有空位，然后记录一次动作 */
  async waitForSlot(): Promise<void> {
    // 先抢占（若已有空位则不等待）
    if (this.canAct()) {
      this.record();
      return;
    }
    // 无空位：等最旧一次动作滑出窗口
    const oldest = this.timestamps[0];
    const wait = 60_000 - (Date.now() - oldest) + 300;
    await new Promise((r) => setTimeout(r, Math.max(300, wait)));
    this.record();
  }

  private prune(now: number): void {
    const windowStart = now - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);
  }
}

// ===== 每日投递上限 =====
function isSameDay(ts: number | null | undefined, now = Date.now()): boolean {
  if (!ts) return false;
  const d = new Date(ts);
  const n = new Date(now);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** 今日已成功投递数量（以 sentAt 为准） */
export function dailySentCount(pending: PendingItem[], now = Date.now()): number {
  return (pending || []).filter((p) => p.status === 'sent' && isSameDay(p.sentAt, now)).length;
}

/** 今日有效投递上限：min(用户设定 maxDailySent, 安全硬上限 MAX_SAFE_DAILY) */
export function effectiveDailyCap(config: AppConfig): number {
  const userCap = Number(config?.maxDailySent) || 0;
  const base = userCap > 0 ? userCap : SAFETY_LIMITS.MAX_SAFE_DAILY;
  return Math.max(1, Math.min(base, SAFETY_LIMITS.MAX_SAFE_DAILY));
}

/** 冷却锁：pausedUntil > now 表示处于冷却期，返回剩余毫秒 */
export function cooldownRemaining(config: AppConfig, now = Date.now()): number {
  const until = Number(config?.pausedUntil) || 0;
  return until > now ? until - now : 0;
}

export function isLockedOut(config: AppConfig, now = Date.now()): boolean {
  return cooldownRemaining(config, now) > 0;
}
