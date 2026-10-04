// 防封号硬限值 —— **叶子模块（零依赖）**。
//
// 为什么单独成模块：`platforms.ts::platformDailyCap()` 需要这些值做封顶，而 `safety.ts` 又
// import `platforms.ts`（effectiveDailyCapFor / platformEnabled）。若 platforms.ts 反向 import
// safety.ts 就会形成**循环依赖**；把常量下沉到本叶子模块即可解耦。
// `safety.ts` 仍 re-export `SAFETY_LIMITS`，因此既有 `from './safety'` 的导入路径全部不变。
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
