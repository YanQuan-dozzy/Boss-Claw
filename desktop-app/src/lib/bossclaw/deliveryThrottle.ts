// 账号级投递节流单例 —— 跨「工作台一键投递」与「自动沟通批量发送」两套引擎共享。
//
// 背景（审查 #73）：两套引擎可以同时运行（它们只按岗位用 deliveryLock 互斥，处理的状态集不同），
// 而原先各自持有一份 `ActionPacer` 与批次休息计数，导致：
//   ① 账号级「每分钟动作上限」实际翻倍 —— 两侧各按 maxActionsPerMinute 放行；
//   ② 「每连续 N 个岗位休息一次」的间隔翻倍 —— 批次休息保护被稀释一半。
// 这两者都应是**账号级唯一权威**，故收敛为本模块的进程级单例（模块级变量，随页面进程生命周期，
// 与既有实现一致）。
//
// ⚠️ 任何引擎都不得再自行 `new ActionPacer(...)` —— 那会重新分裂出私有实例，本模块即失效。
import { ActionPacer, SAFETY_LIMITS } from './safety';

let pacer: ActionPacer = new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
let deliveredCount = 0;

/**
 * 取共享限速器；预算按当前设置同步，并**夹在 SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE 硬上限内**
 * （审查 #22：原两个消费点只夹了下限，用户把「每分动作」调到 9~15 即可越过项目自定的防封号硬上限）。
 */
export function sharedPacer(perMinute?: number): ActionPacer {
  const budget = Math.min(
    SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE,
    Math.max(1, Number(perMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE),
  );
  if (pacer.budget !== budget) pacer = new ActionPacer(budget);
  return pacer;
}

/** 自上次批次休息以来的**账号级**连续投递数（跨引擎累计）。 */
export function deliveredSinceRest(): number {
  return deliveredCount;
}

/** 记录一次成功投递动作，返回累计值（批次休息判定用）。 */
export function markDelivered(): number {
  deliveredCount += 1;
  return deliveredCount;
}

/**
 * 批次休息完成后归零。
 * 注意：**不要在「某引擎起跑」时调用** —— 计数是跨引擎的账号级累计，任一引擎起跑都清零会把
 * 另一引擎已累计的进度抹掉（原实现「每轮重置」在双引擎并行下必然互相踩）。
 */
export function resetDeliveredSinceRest(): void {
  deliveredCount = 0;
}
