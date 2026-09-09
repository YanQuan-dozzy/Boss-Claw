// 安全持久化 storage（zustand persist 用）
// ---------------------------------------------------------
// 背景（P30）：网络卡顿/批量引擎高频写日志时，每个阶段都会 addChatLog/updatePending/…
// 这些 set() 会让 zustand persist 对「整个 bossclaw-data」做一次同步 JSON.stringify +
// localStorage.setItem（含 base64 图片简历 imageResumes、resumeText 16 万字符、双 500 条日志、
// pending 大数组，单次可达数百 KB~数 MB）。高频触发时渲染进程主线程被大对象序列化反复阻塞，
// 表现为界面点击无反应、甚至被系统判定无响应；localStorage 写满（5MB 配额）后 setItem 抛
// QuotaExceededError 还会沿调用链冒泡，拖垮正在运行的引擎/UI。
//
// 对策：
//   1) 写防抖：把短窗口内多次 set 合并成一次真实写盘（默认 250ms，突发日志风暴合批后
//      序列化次数降到约 4 次/秒，主线程不再被连续大 stringify 卡死）；
//   2) 容错降级：真实写盘失败（配额超限/隐私模式）不抛出——去掉最占空间的运行时日志字段
//      重试一次，仍失败则丢弃该次持久化并限频告警，绝不让存储异常冒泡进业务代码；
//   3) 退出兜底：pagehide / visibilitychange(hidden) 时同步 flush 待写数据，防抖窗口内
//      的状态（如刚发送成功的岗位）不会因关窗/切后台而丢失。
//
// 读取路径（getItem / 备份 gatherBundle / 导入导出）仍直连 localStorage，不受防抖影响。
//
// 契约对齐 zustand persist 的 PersistStorage<S>：
//   getItem(name) → { state, version } | null   （已 JSON 反序列化）
//   setItem(name, { state, version })            （内部负责 JSON.stringify，此处做防抖合批）
//   removeItem(name)

import type { PersistStorage, StorageValue } from 'zustand/middleware';

export interface SafeStorageOptions {
  /** 写盘合并窗口（毫秒）。突发集中写入时，窗口内多次 set 只触发一次真实 localStorage 写。 */
  debounceMs?: number;
  /** 用于取底层 Storage 的工厂（默认为 localStorage；便于测试注入） */
  getStorage?: () => Storage | null;
}

const warnOnceThrottled = (() => {
  let lastWarn = 0;
  return (msg: string) => {
    const now = Date.now();
    if (now - lastWarn < 30000) return; // 30s 限频，避免刷屏
    lastWarn = now;
    console.warn('[persist] ' + msg);
  };
})();

// 所有已创建的 storage 实例的「丢弃 pending」回调（供「清空数据 / 导入数据」前调用，
// 防止防抖窗口内残留的待写值在 reload 时被 flush 写回，导致清空/导入被旧数据覆盖）。
const discardCallbacks = new Set<() => void>();

/** 丢弃所有 storage 实例中尚未写盘的 pending（并取消其定时器）。清空/导入数据前必须调用。 */
export function discardPendingPersistWrites(): void {
  for (const fn of discardCallbacks) {
    try {
      fn();
    } catch {
      /* 忽略单实例异常 */
    }
  }
}

// ---- persist 写哨兵（本地备份「快路径」脏检查用）----
// zustand persist 在 store 状态每次变更后都会调用 storage.setItem（无论窗口内是否合批），
// 此处按 persist name 递增「写代数」。localBackup 心跳据此判断「某 key 自上次备份后是否被
// 写过」：全部未写 → 内容必然未变，可零开销跳过收集/序列化/IPC/写盘——否则每次 5 分钟心跳
// 都要把 MB 级 localStorage（日志/简历/任务数组）整体 getItem + stringify，白白占用渲染
// 主线程造成 UI 卡顿（无操作的空闲时段尤其明显）。
// 注意：跨实例共享（每个 store 独立调用 createSafePersistStorage()），故声明在模块级。
const persistWriteEpoch = new Map<string, number>();

/** 读取某 persist name 的写代数（从未写入为 0） */
export function persistDirtyEpoch(name: string): number {
  return persistWriteEpoch.get(name) ?? 0;
}

/** 真实写盘（尽力而为，绝不抛出）。首次失败会剥离运行时日志字段抢救业务状态。 */
function writeWithFallback(store: Storage, name: string, value: StorageValue<unknown>): boolean {
  const payload = () => {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };
  let json = payload();
  if (json == null) return false;
  try {
    store.setItem(name, json);
    return true;
  } catch (err) {
    // 第一次失败：剥离最占空间的运行时字段（chatLogs/logs——重启后仍从内存/再生成恢复）后重试
    try {
      const st = value.state as { chatLogs?: unknown[]; logs?: unknown[]; [k: string]: unknown } | undefined;
      if (st) {
        delete st.chatLogs;
        delete st.logs;
        json = payload();
      }
      if (json == null) return false;
      store.setItem(name, json);
      warnOnceThrottled(`localStorage 配额告警：${name} 过大，已降级为不持久化运行时日志（chatLogs/logs）`);
      return true;
    } catch {
      warnOnceThrottled(`localStorage 写入失败（${String((err as Error)?.message || err)}），本次持久化已丢弃`);
      return false;
    }
  }
}

/**
 * 创建「防抖 + 容错」的 zustand persist storage。
 * 用法：persist(config, { ..., storage: createSafePersistStorage() })
 */
export function createSafePersistStorage<S = unknown>(options: SafeStorageOptions = {}): PersistStorage<S> {
  const { debounceMs = 250 } = options;
  const read = (): Storage | null => {
    try {
      if (options.getStorage) return options.getStorage();
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  };

  // 待写缓冲：name -> 序列化后的完整 StorageValue 对象。写盘前合并同一 key 的最新值。
  const pending = new Map<string, StorageValue<unknown>>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const store = read();
    const batch = Array.from(pending.entries());
    pending.clear();
    if (!store) return; // 无可用存储：静默丢弃（内存态不受影响）
    for (const [name, value] of batch) {
      if (writeWithFallback(store, name, value)) {
        // 防抖合批后在此刻才真正写盘 → 内容确实变化 → 递增写哨兵，
        // 否则备份若在「set 之后 / flush 之前」采集到旧值，落盘的新值会被快路径误判跳过而漏备
        persistWriteEpoch.set(name, (persistWriteEpoch.get(name) ?? 0) + 1);
      }
    }
  };

  const scheduleFlush = (): void => {
    if (timer) return; // 已有一个窗口在排，等待其触发（届时把窗口内最新值一次写掉）
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, debounceMs);
  };

  // 退出/隐藏兜底：确保防抖窗口内的数据尽快落盘（关窗/切后台不丢最近状态）。
  const flushListener = () => flushNow();
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushListener);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
  }

  // 注册「丢弃 pending」回调：清空数据/导入数据/恢复备份前调用，防止防抖窗口内残留的
  // 待写值在 reload 时被 flush 写回，覆盖刚清空/刚导入/刚恢复的内容。
  // （模块级 Set 随页面进程自然销毁，无需手动清理。）
  const discard = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };
  discardCallbacks.add(discard);

  return {
    getItem: (name: string): StorageValue<S> | null => {
      const store = read();
      if (!store) return null;
      try {
        const raw = store.getItem(name);
        if (raw == null) return null;
        const parsed = JSON.parse(raw) as StorageValue<S>;
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null; // 数据损坏视为无（上层 merge 会用默认值兜底）
      }
    },
    setItem: (name: string, value: StorageValue<S>): void => {
      persistWriteEpoch.set(name, (persistWriteEpoch.get(name) ?? 0) + 1); // 写哨兵递增（备份快路径）
      // 仅登记 + 防抖合批，真正的序列化与写盘延后到 flushNow（主线程不再被大 stringify 卡住）
      pending.set(name, value as StorageValue<unknown>);
      scheduleFlush();
    },
    removeItem: (name: string): void => {
      persistWriteEpoch.set(name, (persistWriteEpoch.get(name) ?? 0) + 1); // 删除同样是「内容变化」
      pending.delete(name);
      const store = read();
      if (store) {
        try {
          store.removeItem(name);
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}
