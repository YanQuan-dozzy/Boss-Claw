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

import type { AppConfig, JobPlatform, PendingItem } from './types';
import { PLATFORM_IDS, platformDailyCap, platformEnabled } from './platforms';
import { checkDeliveryGate } from './activityWindow';
import { SAFETY_LIMITS } from './limits';

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

// ===== 安全上限 =====
// 定义已下沉到**零依赖叶子模块** `limits.ts`（platforms.ts 也需引用它做封顶，若留在本文件会与
// platforms.ts 形成循环依赖）。此处 re-export，既有 `from './safety'` 的导入路径全部不变。
export { SAFETY_LIMITS };

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

  /**
   * 等待直到有空位，然后记录一次动作。
   *
   * ⚠️ 唤醒后必须**重新竞争**空位（审查 §四·23）：原实现「无空位 → 等最旧一次滑出窗口 → record()」
   * 在并发下会突破预算 —— N 个并发等待者会在同一时刻被唤醒，各自无条件 record()，
   * 于是这一分钟内的实际动作数可达 N×budget（限速器形同虚设，直冲平台限速阈值）。
   * 现在改为循环：每轮睡到「最旧时间戳滑出窗口」后重新 `canAct()` 判定，抢到空位才 record；
   * 没抢到（被其它等待者先占）就再算一次并继续等。每轮至少睡 300ms，不会空转。
   */
  async waitForSlot(): Promise<void> {
    // 先抢占（若已有空位则不等待）
    if (this.canAct()) {
      this.record();
      return;
    }
    // 无空位：等最旧一次动作滑出窗口（+随机抖动 0.3~1.2s，避免限速等待节奏完全一致被识别）。
    // 醒来后**不**无条件 record —— 重新竞争，只有拿到空位才算等成功。
    for (;;) {
      const oldest = this.timestamps[0] ?? Date.now();
      const wait = 60_000 - (Date.now() - oldest) + Math.round(300 + Math.random() * 900);
      await new Promise((r) => setTimeout(r, Math.max(300, wait)));
      if (this.canAct()) {
        this.record();
        return;
      }
    }
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

/**
 * 今日已成功投递数量（以 sentAt 为准，**统计全部平台**）。
 *
 * ⚠️ **不要用它做账号级额度判定**：账号级上限 `effectiveDailyCap` 只累加**已启用**平台的额度，
 * 而本函数把已关闭平台的今日投递也算进来 —— 两侧口径不对称，会导致「一个已关闭平台的昨日
 * 战绩压死今天所有平台」（见 `enabledSentCount` 的实测注释，审查 #23 后续 · 批次 13/14）。
 * 账号级判定请用 `enabledSentCount(config, pending)`；本函数仅供「全平台累计」类**展示/趋势**
 * 语义（如统计页趋势图按真实历史计，不区分启用与否）。
 */
export function dailySentCount(pending: PendingItem[], now = Date.now()): number {
  return (pending || []).filter((p) => p.status === 'sent' && isSameDay(p.sentAt, now)).length;
}

/** 今日某平台已成功投递数量（多平台适配：按 job.platform 分组，缺省视为 boss） */
export function dailySentCountFor(pending: PendingItem[], platform: JobPlatform, now = Date.now()): number {
  return (pending || []).filter(
    (p) => p.status === 'sent' && isSameDay(p.sentAt, now) && ((p.job?.platform ?? 'boss') === platform),
  ).length;
}

/**
 * 今日**已启用平台**的成功投递总数 —— 账号级上限的对称口径（审查 #23 后续 · 批次 13）。
 *
 * 为什么不能直接用 `dailySentCount`：账号级上限 `effectiveDailyCap` 只累加**已启用**平台的额度，
 * 若「已用」统计了全部平台（含已关闭的），则用户关闭某平台后其历史投递会**白占额度** ——
 * 实测：平台 B 投 150 条后关闭、仅启用 A（A 今日 0 条）→ 全量计数 150 ≥ cap 120 →
 * 对 A 的投递被 `daily-cap` 误拦（`break` 停掉整批），账号被一个「已经关掉的平台」卡死。
 *
 * 额度（分母）与用量（分子）必须同源：**都只看已启用平台**。
 */
export function enabledSentCount(config: AppConfig, pending: PendingItem[], now = Date.now()): number {
  return (pending || []).filter(
    (p) =>
      p.status === 'sent' &&
      isSameDay(p.sentAt, now) &&
      platformEnabled(config || ({} as AppConfig), (p.job?.platform ?? 'boss') as JobPlatform),
  ).length;
}

/** 某平台配置的每日投递目标（多平台独立配额；0 表示不设限，仍受平台侧上限/MAX_SAFE_DAILY 收窄） */
export function platformDailyTarget(config: AppConfig, platform: JobPlatform): number {
  return Math.max(0, Number(config?.platforms?.[platform]?.dailyTarget) || 0);
}

/**
 * 指定平台今日有效投递上限（「上限适配各个平台数字」的执行口径）：
 *   = min(该平台每日目标（0=不限时视为平台侧上限）, 平台侧上限（智联 100/日）, MAX_SAFE_DAILY=150)
 * 取代旧「全局 maxDailySent」：多平台同时启用时，每个平台各自跑自己的额度，互不挤占。
 */
export function effectiveDailyCapFor(config: AppConfig, platform: JobPlatform): number {
  const cap = platformDailyCap(platform); // 平台侧/安全上限收窄后的硬上限
  const target = platformDailyTarget(config, platform);
  if (target <= 0) return cap;
  return Math.max(1, Math.min(target, cap));
}

/**
 * 全局汇总上限 = 各「已启用」平台有效上限之和（用于汇总展示/兜底，如工作台首页目标、统计页）。
 * 仅启用 BOSS 时即 BOSS 自身的上限，与旧全局 maxDailySent 语义等价；
 * 多平台启用时这是合计值，单个平台的执行上限请用 effectiveDailyCapFor。
 */
export function effectiveDailyCap(config: AppConfig): number {
  const cfg = config || ({} as AppConfig);
  let sum = 0;
  let enabledAny = false;
  for (const p of PLATFORM_IDS) {
    if (platformEnabled(cfg, p)) {
      enabledAny = true;
      sum += effectiveDailyCapFor(cfg, p);
    }
  }
  if (enabledAny) return Math.max(1, sum);
  // 兜底：无任何启用平台时按全部平台合计（兼容旧配置缺失场景）
  return Math.max(1, PLATFORM_IDS.reduce((s, p) => s + effectiveDailyCapFor(cfg, p), 0));
}

/** 冷却锁：pausedUntil > now 表示处于冷却期，返回剩余毫秒 */
export function cooldownRemaining(config: AppConfig, now = Date.now()): number {
  const until = Number(config?.pausedUntil) || 0;
  return until > now ? until - now : 0;
}

export function isLockedOut(config: AppConfig, now = Date.now()): boolean {
  return cooldownRemaining(config, now) > 0;
}

// ===== 投递前置守卫（唯一权威，审查 #23）=====
export type DeliveryGuardKind = 'cooldown' | 'window' | 'daily-cap' | 'platform-cap';
export type DeliveryGuardResult = { ok: true } | { ok: false; kind: DeliveryGuardKind; msg: string };

/**
 * 投递前置守卫：冷却 / 活跃时段 / 账号每日上限 / 平台每日上限 —— **四条投递路径共用的唯一实现**。
 *
 * 为什么必须收敛到一处（审查 #23）：单条「沟通」（`useAutoChatStore.chatOne`）原先只做重入保护，
 * 冷却期、活跃时段外、已达当日上限时点单卡「沟通」仍会真实发送 —— 冷却/上限这类账号级保护
 * 对单岗位路径形同虚设。批量循环里的检查若在调用方各写一份，必然再次分叉，故下沉到本模块。
 *
 * 语义：**只做同步判定，不做任何等待**（非活跃时段可能还要等十几小时，阻塞界面不可接受；
 * 等待型节流由 deliveryThrottle 的 sharedPacer 负责）。调用方拿到 `ok:false` 后应「记录 msg +
 * 中止本轮/本次发送」，不要重试。
 *
 * @param config 当前配置（冷却 pausedUntil / 活跃时段 activeHours / 平台每日目标都在其中）
 * @param platform 本次要投递的岗位所属平台
 * @param pending 当前岗位池（按 sentAt 统计今日已投递数）
 */
export function checkDeliveryGuards(
  config: AppConfig,
  platform: JobPlatform,
  pending: PendingItem[],
): DeliveryGuardResult {
  const cfg = config || ({} as AppConfig);
  if (isLockedOut(cfg)) {
    return {
      ok: false,
      kind: 'cooldown',
      msg: `账号处于安全冷却期，沟通已暂停（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟）。点击「停止」后可稍后重试。`,
    };
  }
  const gate = checkDeliveryGate(cfg.activeHours, cfg.pausedUntil);
  if (!gate.ok) {
    const resumeAt = gate.nextAllowedAt ? new Date(gate.nextAllowedAt).toLocaleString('zh-CN') : '活跃时段开始后';
    return {
      ok: false,
      kind: 'window',
      msg: `${gate.reason}。预计 ${resumeAt} 自动恢复（可在「设置 → 自动沟通 → 防封号节奏限制」中调整或关闭）。`,
    };
  }
  // ⚠️ **顺序即语义，不可对调**（审查 #23 后续 · 批次 12）：
  // 平台级上限必须**先于**账号级判 —— 因为账号级是各启用平台的**合计**（`effectiveDailyCap`）。
  // 二者互含关系：
  //   · 单平台场景：账号级 == 平台级（合计即该平台），谁先判都等价；
  //   · 多平台场景：某平台先跑满自身额度时，账号级合计往往**尚未**触顶 —— 若账号级先判，
  //     此时会返回 `daily-cap`，而调用方对 `daily-cap` 的处理是 **break 整批**（终止整轮运行），
  //     于是「一个平台跑满」会**错误地停掉其它仍有额度的平台**；且 `platform-cap` 分支
  //     （调用方据此 `continue` 跳过该平台、转下一优先级平台）**永远不可达**，成为死代码。
  // 先判平台级 → 超限平台被单独跳过，其余平台继续；账号级作为最终总额兜底。
  const platformCap = effectiveDailyCapFor(cfg, platform);
  if (dailySentCountFor(pending, platform) >= platformCap) {
    return {
      ok: false,
      kind: 'platform-cap',
      msg: `平台 ${platform} 今日投递已达上限 ${platformCap} 条（可在「设置 → 招聘平台」调整每日目标）。`,
    };
  }
  // ⚠️ 账号级必须用 **enabledSentCount** 而非 `dailySentCount`（审查 #23 后续 · 批次 13）：
  // 账号级上限 `effectiveDailyCap` 只累加**已启用**平台的额度，因此「已用」也必须只统计
  // 已启用平台的投递 —— 两侧口径必须对称。若用 `dailySentCount`（统计**全部**平台的今日
  // 已投递），则用户**关闭某平台**后，该平台的历史投递仍被计入、却不贡献任何额度：
  //   实测（平台 B 投 150 条后关闭，仅启用 A 且 A 今日 0 条）→ `dailySentCount`=150 ≥ cap=120
  //   → 对 A 投递被 `daily-cap` **误拦**，A 明明一条没投也发不出去，且 `break` 会停掉整批。
  // 这正是「一个已关闭平台的昨日战绩，压死今天所有平台」的静默卡死。
  const cap = effectiveDailyCap(cfg);
  if (enabledSentCount(cfg, pending) >= cap) {
    return { ok: false, kind: 'daily-cap', msg: `今日沟通数已触及安全上限 ${cap} 条，沟通已暂停。` };
  }
  return { ok: true };
}

/**
 * 基础风控冷却时长（毫秒）—— 唯一权威。
 *
 * 背景（2026-10-03 修复）：设置页「风控冷却」的输入框绑的是 `config.autoCooldownMinutes`，
 * 但**全仓从未读取过该字段**，冷却恒为 `SAFETY_LIMITS.DEFAULT_COOLDOWN_MS`（30 分钟）——
 * 也就是说这个设置改了没有任何效果。本函数把它接上真线。
 *
 * 硬下限 5 分钟：冷却期是**保护性**的，不允许被调到接近关闭（用户把它设成 0/1 会让账号
 * 在命中风控后立刻继续作业，正是最危险的行为）。上限 720 分钟（12 小时）。
 */
export function baseCooldownMs(config: Pick<AppConfig, 'autoCooldownMinutes'> | null | undefined): number {
  const raw = Number(config?.autoCooldownMinutes);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : SAFETY_LIMITS.DEFAULT_COOLDOWN_MS / 60_000;
  return Math.min(720, Math.max(5, minutes)) * 60_000;
}

/**
 * 解析一次风控命中的**实际冷却时长**（毫秒）—— 唯一权威，所有冷却写入点都必须走它。
 *
 * 语义（**只放大、不缩短**）：
 *   · 无风险信号（未知码）→ 用基础冷却 `baseCooldownMs`；
 *   · 预设 `cooldownMs` 为 0（如未登录）→ 不进入冷却，保持原语义；
 *   · 其余：`max(预设, 预设 × 基础冷却 / 默认冷却)`。
 *     即基础冷却 ≤ 30 分钟时结果恒等于原始预设；> 30 分钟时按比例延长。
 *
 * 为什么不做「往下缩」：每个码的预设值都是按封号升级链路
 * （限速 1006 → 滑块 35 → 账户异常 36 → 封禁 32）标定的保护性时长，
 * 允许用户把它们调短，等于把「限速」推向「封禁」—— 这正是本软件的防御目标。
 * UI 侧相应把可调下限设为 30 分钟，避免出现「调了但看不出效果」的区间。
 *
 * 关键性质（回归脚本 scripts/cooldown-regression.mjs 守住）：
 *   1) `autoCooldownMinutes` = 30（默认）时，返回值与修复前**逐位一致**
 *      （32→120 分、36→60 分、35/37/38→30 分、1006/5002-5004→10 分、31→0）；
 *   2) 对基础冷却单调不减；
 *   3) 结果永不短于该码的原始预设。
 *
 * ⚠️ 曾有过的错误实现：按 severity 设「绝对下限表」。它会因为
 * `CODE_MAP` 里同一 severity 混着两种紧迫度（`env` 同时含 37/38 的 30 分 与
 * 5002-5004 的 10 分）而把 10 分钟**拉长**到 30 分钟 —— 属于「顺手改变了既有安全行为」，
 * 被回归脚本第 B 组当场拦住。**不要再用 severity 下限表。**
 */
export function resolveCooldownMs(
  config: Pick<AppConfig, 'autoCooldownMinutes'> | null | undefined,
  signal: RiskSignal | null | undefined,
): number {
  const base = baseCooldownMs(config);
  if (!signal) return base;
  const preset = Number(signal.cooldownMs) || 0;
  if (!preset) return 0;
  const scaled = (preset / SAFETY_LIMITS.DEFAULT_COOLDOWN_MS) * base;
  return Math.round(Math.max(preset, scaled));
}

/**
 * 把一次风控冷却**合并**进已有的 pausedUntil（单调不减，返回绝对时间戳）。
 *
 * 为什么必须有它：原实现 6 处冷却写入都是 `pausedUntil: Date.now() + resolveCooldownMs(...)`
 * 的**绝对覆盖**，没有任何与既有值的 max 合并。而投递引擎与 AI 跟聊监听可以并发运行 ——
 * 一方命中重码（如 32/36 → 120 分）后，另一方的在途请求返回轻码（如 1006 → 10 分）会**后写覆盖**，
 * 把已生效的保护时长砍短，直接击穿 resolveCooldownMs 所声明的「只放大不缩短」不变量。
 * **所有风控冷却写入必须走本函数（或 nextCooldownUntil），不得再写裸 `Date.now() + …`。**
 */
export function mergeCooldownUntil(existing: number, cooldownMs: number, now: number = Date.now()): number {
  const prev = Number(existing) || 0;
  const add = Number(cooldownMs) || 0;
  if (add <= 0) return prev; // 该码无冷却语义：保持既有冷却，绝不清零
  return Math.max(prev, now + add);
}

/** 由风险码解析冷却并合并进既有 pausedUntil —— 风控冷却写入的唯一入口。 */
export function nextCooldownUntil(
  config: Pick<AppConfig, 'autoCooldownMinutes' | 'pausedUntil'> | null | undefined,
  signal: RiskSignal | null | undefined,
  now: number = Date.now(),
): number {
  return mergeCooldownUntil(config?.pausedUntil ?? 0, resolveCooldownMs(config, signal), now);
}
