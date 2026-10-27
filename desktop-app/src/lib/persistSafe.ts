// 安全持久化 storage（zustand persist 用）
// ---------------------------------------------------------
// 背景（P30）：网络卡顿/批量引擎高频写日志时，每个阶段都会 addChatLog/updatePending/…
// 这些 set() 会让 zustand persist 对「整个 bossclaw-data」做一次同步 JSON.stringify +
// localStorage.setItem（含 base64 图片简历 imageResumes、resumeText 16 万字符、双 500 条日志、
// pending 大数组，单次可达数百 KB~数 MB）。高频触发时渲染进程主线程被大对象序列化反复阻塞，
// 表现为界面点击无反应、甚至被系统判定无响应；localStorage 写满（实测单源上限
// 52,428,800 个 UTF-16 码元，见 storage.ts 的口径注释）后 setItem 抛
// QuotaExceededError 还会沿调用链冒泡，拖垮正在运行的引擎/UI。
//
// 对策：
//   1) 写防抖：把短窗口内多次 set 合并成一次真实写盘（默认 250ms，突发日志风暴合批后
//      序列化次数降到约 4 次/秒，主线程不再被连续大 stringify 卡死）；
//   2) 容错降级：真实写盘失败（配额超限/隐私模式）不抛出——运行时日志键（bossclaw-runtime-logs，
//      独立小键）直接丢弃整个键重试，业务键丢弃该次持久化并限频告警，绝不让存储异常冒泡进业务代码；
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

/** 非 zustand 的业务键成功直写后调用，使下一次本地备份能发现变更。 */
export function markPersistDirty(name: string): void {
  persistWriteEpoch.set(name, (persistWriteEpoch.get(name) ?? 0) + 1);
}

// ---- 持久化健康（issue #10：写失败不得静默）----
// 背景：配额写满后 writeWithFallback 按设计「丢弃本次持久化」并只做限频 console.warn——
// 界面毫无反馈，引擎照常跑、队列照常推进，落盘却停在配额耗尽的那一刻。用户重启后整个会话的
// 进度（队列、投递结果，连同一份 bossclaw-data 里的基础求职条件）回到旧快照，看起来像
// 「数据凭空回退了一天」。此处把失败登记成可订阅的健康状态（状态栏告警 + 设置页用量），
// 并保留「最后一次尝试写入」的完整值：localBackup 在失败期间改用内存态落备份，保证即便主存储
// 写不进，数据也能从备份文件回签。
export interface PersistFailureInfo {
  name: string;
  /** 最近一次失败原因（QuotaExceededError 等原始 message） */
  message: string;
  /** true = 配额类错误（存储写满 / 隐私模式无配额） */
  quota: boolean;
  /** 首次失败时间戳 */
  since: number;
  /** 最近一次失败时间戳 */
  at: number;
  /** 累计失败次数 */
  count: number;
}

const lastFailure = new Map<string, PersistFailureInfo>();
/** 各 persist 键「最后一次交给 setItem 的值」：写失败时它是唯一比 localStorage 更新的事实来源 */
const latestValue = new Map<string, StorageValue<unknown>>();
/** 失败通知（localBackup 用于失败即落盘） */
const failureListeners = new Set<(info: PersistFailureInfo) => void>();
/** 健康状态订阅（React useSyncExternalStore 用） */
const healthListeners = new Set<() => void>();
let healthVersion = 0;

function bumpHealth(): void {
  healthVersion += 1;
  for (const fn of healthListeners) {
    try {
      fn();
    } catch {
      /* 订阅方异常不影响写入路径 */
    }
  }
}

/** 订阅持久化健康变化（返回取消订阅函数） */
export function subscribePersistHealth(fn: () => void): () => void {
  healthListeners.add(fn);
  return () => healthListeners.delete(fn);
}

/** 健康状态版本号（useSyncExternalStore 的 getSnapshot，变化即代表健康状态有更新） */
export function getPersistHealthVersion(): number {
  return healthVersion;
}

/** 当前处于「写失败」状态的键（成功写入后自动清除） */
export function listPersistFailures(): PersistFailureInfo[] {
  return Array.from(lastFailure.values()).sort((a, b) => b.at - a.at);
}

/** 是否存在尚未恢复的写失败 */
export function hasPersistFailure(): boolean {
  return lastFailure.size > 0;
}

/** 查询单个键的写失败信息（未失败返回 null）——localBackup 据此决定是否改用内存态快照 */
export function persistFailureOf(name: string): PersistFailureInfo | null {
  return lastFailure.get(name) ?? null;
}

/**
 * 订阅「写失败」事件（每次失败都会通知；调用方需自行限频）。
 * 用于 persistSafe 自身无法承担的动作，例如立刻把内存态写进本地备份文件。
 */
export function onPersistFailure(cb: (info: PersistFailureInfo) => void): () => void {
  failureListeners.add(cb);
  return () => failureListeners.delete(cb);
}

/**
 * 取某 persist 键「最后一次交给 setItem 的完整值」的序列化串（无记录返回 null）。
 * 只在主存储写失败时被 localBackup 调用——正常情况下它恒等于 localStorage 的内容。
 */
export function getLatestPersistSnapshot(name: string): string | null {
  const v = latestValue.get(name);
  if (!v) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** 判断错误是否为配额类（Chromium: QuotaExceededError / code 22 / Firefox: NS_ERROR_DOM_QUOTA_REACHED） */
function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string } | null;
  if (!e) return false;
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (e.code === 22 || e.code === 1014) return true;
  return /quota/i.test(String(e.message || ''));
}

function recordFailure(name: string, err: unknown): void {
  const now = Date.now();
  const prev = lastFailure.get(name);
  const info: PersistFailureInfo = {
    name,
    message: String((err as { message?: string })?.message || err),
    quota: isQuotaError(err),
    since: prev?.since ?? now,
    at: now,
    count: (prev?.count ?? 0) + 1,
  };
  lastFailure.set(name, info);
  bumpHealth();
  for (const fn of failureListeners) {
    try {
      fn(info);
    } catch {
      /* 忽略：备份失败不应反过来影响持久化路径 */
    }
  }
}

function clearFailure(name: string): void {
  if (!lastFailure.delete(name)) return;
  bumpHealth();
}

/** 真实写盘（尽力而为，绝不抛出）。写失败时按「键的类型」处置：运行时日志键直接丢弃（重启即重新累积），业务键丢弃该次持久化。 */
function writeWithFallback(store: Storage, name: string, value: StorageValue<unknown>): boolean {
  const payload = () => {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };
  let json = payload();
  if (json == null) {
    // 序列化失败同样是「落盘没跟上内存」，必须计入健康状态，否则用户永远看不到告警
    recordFailure(name, new Error('序列化失败（值中含不可序列化内容）'));
    return false;
  }
  try {
    store.setItem(name, json);
    // 成功即解除该键的失败标记（界面告警随之消失）
    clearFailure(name);
    return true;
  } catch (err) {
    // 第一次失败：按键的种类降级。P2-05 后日志已拆成独立小键（bossclaw-runtime-logs），
    // 业务键不再含 chatLogs/logs（旧版残留字段也不应再被剥离重写——那只会造成「内存仍持日志、
    // 落盘为无日志副本」的反复降级抖动）。日志键若仍写不进（极端长文本/配额告急），
    // 直接丢弃整个键：日志为运行时产物，重启即重新累积，绝不让存储异常冒泡进业务代码。
    try {
      const st = value.state as { chatLogs?: unknown[]; logs?: unknown[] } | undefined;
      if (st && (Array.isArray(st.chatLogs) || Array.isArray(st.logs))) {
        store.removeItem(name); // 丢弃日志键（不写空副本，避免内存与落盘不一致的反复降级）
        warnOnceThrottled(`localStorage 配额告警：${name} 过大，已放弃持久化运行时日志（重启后重新累积）`);
        return true;
      }
      recordFailure(name, err);
      warnOnceThrottled(`localStorage 写入失败（${name}：${String((err as Error)?.message || err)}），本次持久化已丢弃`);
      return false;
    } catch {
      recordFailure(name, err);
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
    // 审查 #28：**先判存储可用、再清 pending** —— 原顺序（先 clear 再判 store）在 localStorage
    // 不可用（隐私模式 / 存储被禁用 / 测试注入返回 null）时会把待写值直接从缓冲里抹掉：
    // 之后即便存储恢复可用，这些变更也再无机会落盘（静默丢写）。保留 pending 则可由下一次
    // set/flush 一并写出；缓冲体积受「每键保留最新值」约束，不会无限增长。
    if (!store) return;
    const batch = Array.from(pending.entries());
    pending.clear();
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
      // 同时保留最新值引用：写盘失败时 localBackup 用它落「内存态」备份（见 getLatestPersistSnapshot）
      latestValue.set(name, value as StorageValue<unknown>);
      pending.set(name, value as StorageValue<unknown>);
      scheduleFlush();
    },
    removeItem: (name: string): void => {
      persistWriteEpoch.set(name, (persistWriteEpoch.get(name) ?? 0) + 1); // 删除同样是「内容变化」
      pending.delete(name);
      latestValue.delete(name);
      const store = read();
      if (store) {
        try {
          store.removeItem(name);
          clearFailure(name); // 键已删除，此前的写失败不再成立
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}
