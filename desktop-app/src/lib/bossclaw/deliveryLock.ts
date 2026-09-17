// 共享「投递中」占位锁：避免 后台自动沟通(useAutoChatStore) 与 工作台「一键投递」(Workbench runNext)
// 对同一个岗位同时投递（重复发打招呼语）。两个引擎在开始投递前都先认领(id)：
//   - claim 成功 → 本引擎处理，完成后 release；
//   - claim 失败 → 该岗位正被另一方认领，跳过（交给认领方）。
// 关键：认领与释放只在「真正发起投递」期间持有（浏览器/API 调用窗口），处理结果的收尾不需占锁。
// 多平台适配：认领键带平台前缀，避免不同平台岗位 id 撞车。
// 键构造统一收敛到 lockKey()（曾因 claim/release/isClaimed 三段各写一遍、个别调用点漏传平台，
// 导致非 BOSS 岗位两个引擎使用不同键域而重复投递 —— 见审查 P2-01）。调用点应一律显式传平台。
const inFlight = new Set<string>();

function lockKey(id: string, platform?: string): string {
  if (platform == null || platform === '') {
    if (import.meta.env?.DEV) console.warn('[deliveryLock] 未传 platform，使用裸 id 键（仅 BOSS 语义正确）');
    return id;
  }
  return platform !== 'boss' ? `${platform}:${id}` : id;
}

/** 认领岗位 id（platform 必传；不同平台独立锁域）；返回 true 表示认领成功（此前未被他人认领）。 */
export function claimDelivery(id: string, platform?: string): boolean {
  const key = lockKey(id, platform);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** 该岗位是否正被任一引擎认领投递中。 */
export function isDeliveryClaimed(id: string, platform?: string): boolean {
  const key = lockKey(id, platform);
  return inFlight.has(key);
}

/** 释放岗位 id（投递已结束）；platform 须与 claim 时一致。 */
export function releaseDelivery(id: string, platform?: string): void {
  const key = lockKey(id, platform);
  inFlight.delete(key);
}