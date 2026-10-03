/**
 * activityWindow.ts —— 活跃时段与批次休息（**唯一权威**）
 *
 * ===== 为什么需要它（服务端视角）=====
 * 指纹可以靠 JS 补丁掩盖，但**操作时间戳是账号维度的长期统计**，掩盖不了：
 *   - 真人不会 24 小时不间断投递（必须有睡眠时段）
 *   - 真人不会每天精确在同一个分钟开始、同一个分钟结束
 *   - 真人不会连续投递上百个岗位而不中断休息
 * 这三类「作息异常」在服务端的统计里比任何单个指纹特征都显眼，且**无法靠补丁伪装** ——
 * 只能靠真实地把作业时间约束成人类作息。
 *
 * ===== 唯一权威（AGENTS.md §1）=====
 * 所有节流落点都必须走本模块：`shouldPauseForActiveHours` / `batchRestDelayMs`。
 * **禁止**在调用方另写一套时间判断（否则口径漂移，且两处不一致会产生新的可识别特征）。
 *
 * ===== 设计要点 =====
 * 1. **每日抖动按日期确定性生成** —— 不能用 `Math.random()`：同一分钟内多次判断必须得到同一结果，
 *    否则「是否在活跃时段」会自相矛盾。这里用 `YYYYMMDD` 做种子的确定性哈希。
 * 2. 支持跨午夜时段（如 22:00–06:00）。
 * 3. 纯函数、零依赖、可离线单测（见 scripts/activity-window-regression.mjs）。
 */

export interface ActiveHoursConfig {
  /** 是否启用活跃时段限制 */
  enabled: boolean;
  /** 每日开始小时（0-23） */
  startHour: number;
  /** 每日结束小时（0-23，可小于 startHour 表示跨午夜） */
  endHour: number;
  /** 每日边界抖动（分钟）：避免「每天精确 8:00 开始 / 23:00 结束」这种机器特征 */
  jitterMinutes: number;
}

export interface BatchRestConfig {
  /** 是否启用批次休息 */
  enabled: boolean;
  /** 连续投递多少个岗位后触发一次长休息 */
  everyNJobs: number;
  /** 长休息时长下限（分钟） */
  minMinutes: number;
  /** 长休息时长上限（分钟） */
  maxMinutes: number;
}

/** 默认值（与 defaults.ts 保持一致；此处导出便于回归单测直接引用） */
export const DEFAULT_ACTIVE_HOURS: ActiveHoursConfig = {
  enabled: true,
  startHour: 8,
  endHour: 23,
  jitterMinutes: 25,
};

export const DEFAULT_BATCH_REST: BatchRestConfig = {
  enabled: true,
  everyNJobs: 15,
  minMinutes: 8,
  maxMinutes: 15,
};

const CLAMP = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 取当日键（YYYYMMDD 整数），用于生成确定性日种子 */
function dayKey(now: number): number {
  const d = new Date(now);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 确定性伪随机（0<=x<1）：同一天同一 salt 恒定，跨天变化 */
export function dayRandom(now: number, salt = 0): number {
  let x = (dayKey(now) ^ (salt * 0x9e3779b1)) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return (x % 100000) / 100000;
}

/** 规范化配置（缺字段/越界一律兜底，避免旧配置读取时崩溃） */
export function normalizeActiveHours(cfg?: Partial<ActiveHoursConfig> | null): ActiveHoursConfig {
  const c = cfg || {};
  return {
    enabled: c.enabled !== false,
    startHour: CLAMP(Math.round(Number(c.startHour ?? DEFAULT_ACTIVE_HOURS.startHour)), 0, 23),
    endHour: CLAMP(Math.round(Number(c.endHour ?? DEFAULT_ACTIVE_HOURS.endHour)), 0, 23),
    jitterMinutes: CLAMP(Math.round(Number(c.jitterMinutes ?? DEFAULT_ACTIVE_HOURS.jitterMinutes)), 0, 120),
  };
}

export function normalizeBatchRest(cfg?: Partial<BatchRestConfig> | null): BatchRestConfig {
  const c = cfg || {};
  const minM = CLAMP(Math.round(Number(c.minMinutes ?? DEFAULT_BATCH_REST.minMinutes)), 1, 240);
  const maxM = CLAMP(Math.round(Number(c.maxMinutes ?? DEFAULT_BATCH_REST.maxMinutes)), minM, 240);
  return {
    enabled: c.enabled !== false,
    everyNJobs: CLAMP(Math.round(Number(c.everyNJobs ?? DEFAULT_BATCH_REST.everyNJobs)), 3, 200),
    minMinutes: minM,
    maxMinutes: maxM,
  };
}

/**
 * 当日活跃窗口（毫秒时间戳区间，含当日抖动）。
 * 跨午夜时段（endHour < startHour）返回的 endMs 落在次日。
 */
export function resolveActiveWindow(cfgInput: Partial<ActiveHoursConfig> | null | undefined, now = Date.now()): { startMs: number; endMs: number } {
  const cfg = normalizeActiveHours(cfgInput);
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const jitter = cfg.jitterMinutes * 60_000;
  // 抖动分别作用于 start / end，用不同 salt 保证两者独立
  const startOffset = Math.round((dayRandom(now, 1) * 2 - 1) * jitter);
  const endOffset = Math.round((dayRandom(now, 2) * 2 - 1) * jitter);
  const startMs = startOfDay + cfg.startHour * 3600_000 + startOffset;
  let endMs = startOfDay + cfg.endHour * 3600_000 + endOffset;
  // 跨午夜：结束时刻落在开始之后（次日）
  if (cfg.endHour <= cfg.startHour) endMs += 24 * 3600_000;
  return { startMs, endMs };
}

/** 当前是否处于活跃时段（未启用时恒为 true） */
export function isWithinActiveWindow(cfgInput: Partial<ActiveHoursConfig> | null | undefined, now = Date.now()): boolean {
  const cfg = normalizeActiveHours(cfgInput);
  if (!cfg.enabled) return true;
  const w = resolveActiveWindow(cfg, now);
  if (now >= w.startMs && now <= w.endMs) return true;
  // 跨午夜场景：now 可能落在「昨天开始、今天结束」的窗口内
  const prev = resolveActiveWindow(cfg, now - 24 * 3600_000);
  return now >= prev.startMs && now <= prev.endMs;
}

/** 下一个活跃窗口的起点（毫秒时间戳） */
export function nextActiveStartMs(cfgInput: Partial<ActiveHoursConfig> | null | undefined, now = Date.now()): number {
  const cfg = normalizeActiveHours(cfgInput);
  if (!cfg.enabled) return now;
  const today = resolveActiveWindow(cfg, now);
  if (now < today.startMs) return today.startMs;
  return resolveActiveWindow(cfg, now + 24 * 3600_000).startMs;
}

/** 人类可读的活跃窗口描述（用于日志/提示），如「08:12–23:07」 */
export function formatActiveWindow(cfgInput: Partial<ActiveHoursConfig> | null | undefined, now = Date.now()): string {
  const w = resolveActiveWindow(cfgInput, now);
  const f = (ms: number) => {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  return f(w.startMs) + '–' + f(w.endMs);
}

/** 人类可读的剩余时间（用于提示），如「6 小时 12 分」 */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}

export interface DeliveryGate {
  /** 是否允许继续投递 */
  ok: boolean;
  /** 不允许时的原因（用于日志） */
  reason?: string;
  /** 下一个允许投递的时刻（ok=false 时给出），便于界面提示「何时恢复」 */
  nextAllowedAt?: number;
}

/**
 * 投递闸门：**同步**判断当前是否应当中止本轮投递。
 * 用于「不能等待」的场景（如非活跃时段要等 6 小时，只能中止并提示，不能阻塞界面）。
 *
 * @param activeHours 活跃时段配置
 * @param pausedUntil 现有冷却锁截止时间戳（safety.ts 的 config.pausedUntil）
 */
export function checkDeliveryGate(
  activeHours: Partial<ActiveHoursConfig> | null | undefined,
  pausedUntil: number,
  now = Date.now(),
): DeliveryGate {
  if (!isWithinActiveWindow(activeHours, now)) {
    return {
      ok: false,
      reason: '当前不在活跃时段（' + formatActiveWindow(activeHours, now) + '），已暂停投递以模拟真人作息',
      nextAllowedAt: nextActiveStartMs(activeHours, now),
    };
  }
  if (Number(pausedUntil) > now) {
    return { ok: false, reason: '处于风控冷却期', nextAllowedAt: Number(pausedUntil) };
  }
  return { ok: true };
}

/**
 * 批次休息延迟（毫秒）：第 N 次投递前若命中批次边界，返回需要长休息的时长；否则 0。
 *
 * @param sentCount 本轮已连续投递的数量（调用方每次投递前 +1 后传入）
 */
export function batchRestDelayMs(
  cfgInput: Partial<BatchRestConfig> | null | undefined,
  sentCount: number,
): number {
  const cfg = normalizeBatchRest(cfgInput);
  if (!cfg.enabled) return 0;
  const n = Math.max(0, Math.floor(Number(sentCount) || 0));
  if (n === 0 || n % cfg.everyNJobs !== 0) return 0;
  const span = cfg.maxMinutes - cfg.minMinutes;
  // 休息时长也带随机（非确定性，每次休息本就该不同；但同一批次只算一次，不会反复变化）
  const minutes = cfg.minMinutes + Math.round(Math.random() * span);
  return minutes * 60_000;
}
