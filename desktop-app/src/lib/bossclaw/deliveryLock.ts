// 共享「投递中」占位锁：避免 后台自动沟通(useAutoChatStore) 与 工作台「一键投递」(Workbench runNext)
// 对同一个岗位同时投递（重复发打招呼语）。两个引擎在开始投递前都先认领(id)：
//   - claim 成功 → 本引擎处理，完成后 release；
//   - claim 失败 → 该岗位正被另一方认领，跳过（交给认领方）。
// 关键：认领与释放只在「真正发起投递」期间持有（浏览器/API 调用窗口），处理结果的收尾不需占锁。
// 多平台适配：认领键带平台前缀，避免不同平台岗位 id 撞车。
const inFlight = new Set<string>();

/** 认领岗位 id（platform 可选；不同平台独立锁域）；返回 true 表示认领成功（此前未被他人认领）。 */
export function claimDelivery(id: string, platform?: string): boolean {
  const key = platform && platform !== 'boss' ? `${platform}:${id}` : id;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** 该岗位是否正被任一引擎认领投递中。 */
export function isDeliveryClaimed(id: string, platform?: string): boolean {
  const key = platform && platform !== 'boss' ? `${platform}:${id}` : id;
  return inFlight.has(key);
}

/** 释放岗位 id（投递已结束）。 */
export function releaseDelivery(id: string, platform?: string): void {
  const key = platform && platform !== 'boss' ? `${platform}:${id}` : id;
  inFlight.delete(key);
}