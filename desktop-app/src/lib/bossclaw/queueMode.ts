// 队列存储模式（issue #10 / docs/存储迁移方案.md）
// ---------------------------------------------------------
// 独立成极小模块，是为了避免「useDataStore ⇄ queueRepo」的循环依赖：
//   · useDataStore.partialize 需要同步判断「队列是否已迁到文件」；
//   · queueRepo 需要在迁移失败 / 环境变量回滚时关闭文件模式。
//
// 判定依据（全部同步可得，必须在 store 首次写盘前就绪）：
//   1. preload 暴露了 queueLoad（说明是桌面端，且 IPC 通道已就位）；
//   2. preload 的 queueStoreMode 不是 'localstorage'（用户/维护者显式回滚）。
// 纯浏览器预览（无 window.electron）恒为 false —— 退回旧 localStorage 路径，不引入文件依赖。
let fileMode =
  typeof window !== 'undefined' &&
  Boolean(window.electron?.queueLoad) &&
  window.electron?.queueStoreMode !== 'localstorage';

/** 桌面端且 preload 已暴露队列 IPC（浏览器预览为 false） */
export function queueFileAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electron?.queueLoad);
}

/** 当前是否处于「队列写主进程文件」模式 */
export function isQueueFileMode(): boolean {
  return fileMode;
}

/** 迁移失败 / 回滚开关命中时关闭文件模式（此后 partialize 重新把队列留在 localStorage） */
export function setQueueFileMode(on: boolean): void {
  fileMode = Boolean(on);
}
