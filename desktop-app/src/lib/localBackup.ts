// 本地数据备份（localStorage 为主存储 + 周期脏检查写盘）
// ---------------------------------------------------------
// 口径：localStorage 维持主存储；每 BACKUP_INTERVAL_MS（5 分钟）把关键 persist 键打成一个
// bundle 写到所选备份目录的 bossclaw-local-backup.json。采用「脏检查」：JSON 序列化与上次
// 快照相同则不重写文件；仅内容变化才覆盖。localStorage 缺失/被清空时，从该文件回签恢复。
// 覆盖数据：登录/简历等持久化内容、日志信息（logs/chatLogs）、采集与投递的岗位信息（pending/taskRuns）。
//
// 性能（修复 5 分钟自动备份卡顿）：
//   1) 快路径：多数心跳周期内数据并无变化，但旧实现每次仍要 getItem 全部大键 + JSON.stringify
//      整包做脏检查 —— MB 级数据同步序列化占用渲染主线程，表现为「每到 5 分钟就卡一下」。
//      现利用 persistSafe 的写哨兵（persistDirtyEpoch）：自上次成功写盘后所有 key 均无新写入
//      → 内容必然未变，O(1) 直接返回（零收集/序列化/IPC/写盘）。每 FULL_CHECK_EVERY 次跳过
//      后强制一次全量复核，兜底绕过 persist 的直写（导入/恢复/清空等）。
//   2) IPC 直传文本：备份文件内容 = '{"updatedAt":..,"keys":..}'，由渲染层拼好 keys 片段直传
//      主进程写盘 —— 避免整个 bundle 对象经结构化克隆传输 + 主进程二次 JSON.stringify。
//   3) 主进程写盘改异步原子写（tmp+rename），不再用 writeFileSync 阻塞主进程事件循环。
//   4) 心跳触发重收集前让出主线程（requestIdleCallback / setTimeout 兜底），不与用户交互撞车。
import { electronApi } from './electronApi';
import { persistDirtyEpoch, discardPendingPersistWrites } from './persistSafe';
import { BACKUP_KEYS } from './storage'; // P2-03：备份键清单收敛到 storage.ts 登记表，不再单独维护

export const BACKUP_INTERVAL_MS = 300_000; // 5 分钟

/** 快路径连续跳过多少次后，强制做一次全量复核（兜底 persist 之外对 localStorage 的直写） */
const FULL_CHECK_EVERY = 4;

export interface BackupBundle {
  updatedAt: number;
  keys: Record<string, string | null>;
}

// 最近一次备份包的序列化字符串（内存脏检查基准）
let lastBackupJson: string | null = null;
// 上次成功写盘时各 persist key 的写代数快照（null=尚未建立基线，首备必执行）
let baselineEpochs: Map<string, number> | null = null;
// 快路径连续跳过计数（满 FULL_CHECK_EVERY 强制全量复核）
let skipChecks = 0;
let started = false;

/** 解析当前备份目录（无 Electron 或失败返回空） */
export async function getBackupDir(): Promise<string> {
  try {
    return await electronApi.backup.dir();
  } catch {
    return '';
  }
}

/** 收集 localStorage 中各 persist 键的值，组装备份包 */
export function gatherBundle(): BackupBundle {
  const keys: Record<string, string | null> = {};
  for (const k of BACKUP_KEYS) {
    try {
      keys[k] = typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null;
    } catch {
      keys[k] = null;
    }
  }
  return { updatedAt: Date.now(), keys };
}

/**
 * 执行一次「脏检查」写盘：仅比较各 persist 键的实际内容（排除 updatedAt 时间戳），
 * 内容未变化则不重写文件。某键无 Electron API（纯浏览器预览）时静默跳过。
 * 返回 { wrote:boolean }，wrote 表示本次是否真的写了文件（内容有变化）。
 *
 * 快路径：自上次成功写盘后所有 key 均无 persist 新写入 → 内容必然未变，直接零开销返回；
 * 每 FULL_CHECK_EVERY 次快路径跳过后强制一次全量复核（兜底 persist 之外对 localStorage 的直写）。
 * force=true（设置页「立即备份」）跳过全部快路径与复核计数，始终全量执行。
 */
export async function writeLocalBackup(force = false): Promise<{ wrote: boolean; error?: string }> {
  try {
    if (!electronApi.backup || !electronApi.backup.write) {
      return { wrote: false, error: 'backup API 不可用（仅 Electron 可用）' };
    }
    // 快路径：各 key 写代数与基线一致 → 无内容变化，零开销跳过（多数心跳命中，不再卡顿）
    if (!force && baselineEpochs) {
      const clean = BACKUP_KEYS.every((k) => persistDirtyEpoch(k) === (baselineEpochs?.get(k) ?? -1));
      if (clean) {
        skipChecks += 1;
        if (skipChecks < FULL_CHECK_EVERY) return { wrote: false };
        // 达到复核阈值：落到下方全量收集/比较（skipChecks 在真正执行后清零）
      }
    }
    skipChecks = 0;
    // P2-07：采集 bundle 的**同一时刻**快照各 key 写代数——基线必须锚定「采集时」而非「写盘后」。
    // 旧实现：写盘返回后才读 epoch，而写盘期间（T2→T4）可能已有新变更，导致该变更被误标为
    // 「已备份」（实际落盘的是旧值 V），下一轮快路径判定 clean 跳过 → 漏备份最多 4 个心跳周期。
    const epochSnapshot = new Map(BACKUP_KEYS.map((k) => [k, persistDirtyEpoch(k)]));
    const bundle = gatherBundle();
    // 脏检查以 keys 内容为准（updatedAt 每次变化，不能纳入比对，否则会每分钟重写文件）
    const keysJson = JSON.stringify(bundle.keys);
    if (!force && lastBackupJson && keysJson === lastBackupJson) {
      return { wrote: false };
    }
    // 直传文本：拼好的 '{"updatedAt":N,"keys":…}' 与旧 JSON.stringify(bundle) 字节一致（文件格式兼容），
    // 省去 bundle 对象经 IPC 结构化克隆与主进程二次序列化的开销。主进程负责最终落盘。
    const text = '{"updatedAt":' + bundle.updatedAt + ',"keys":' + keysJson + '}';
    const r = await electronApi.backup.write(text);
    if (!r.ok && !r.file) return { wrote: false, error: r.error || '写盘失败' };
    lastBackupJson = keysJson;
    // 采集时快照（写盘期间若有新变更，其 epoch > 快照 → 下一轮 clean=false → 正确触发重备份）
    baselineEpochs = epochSnapshot;
    return { wrote: true };
  } catch (e) {
    return { wrote: false, error: (e as Error).message };
  }
}

/**
 * 从本地备份文件恢复：各键写回 localStorage，返回是否成功恢复。
 * 仅当本地文件存在且包含可读 keys 时有效。
 */
export async function restoreFromLocalBackup(): Promise<{ restored: boolean; error?: string }> {
  try {
    const r = await electronApi.backup.read();
    if (!r.ok || !r.bundle || !r.bundle.keys) return { restored: false, error: r.error || '未找到本地备份文件' };
    // P30：恢复前丢弃 persist 防抖窗口内残留的待写值——否则恢复写回的 localStorage 会被
    // 窗口内旧状态在 reload 前的 pagehide flush 覆盖，造成「恢复无效」
    discardPendingPersistWrites();
    // 只统计「真正写回有效数据」的键：备份值非 null 且与 localStorage 现值不同（缺失/不一致）。
    // 全 null 备份、或各键与现状一致的备份都不算恢复成功——否则会谎报 restored，
    // 触发调用方整页 reload，落入「恢复→刷新→再恢复」的无限循环（首页假死）。
    let restoredCount = 0;
    for (const [k, v] of Object.entries(r.bundle.keys)) {
      try {
        if (v == null) {
          localStorage.removeItem(k); // 与备份一致：备份时该键缺失则删除
        } else if (localStorage.getItem(k) !== v) {
          localStorage.setItem(k, v);
          restoredCount += 1;
        }
      } catch {
        /* 单个键恢复失败忽略 */
      }
    }
    // 更新脏检查基准（以 keys 内容为准），避免恢复后立即误判重复写入
    try { lastBackupJson = JSON.stringify(r.bundle.keys); } catch {}
    // 恢复是绕过 persist 的直写：作废旧基线，令下次备份重建（避免快路径误判「无变化」跳过）
    baselineEpochs = null;
    skipChecks = 0;
    if (restoredCount > 0) return { restored: true };
    return { restored: false, error: '备份中无有效数据（各键为空或与现有数据一致）' };
  } catch (e) {
    return { restored: false, error: (e as Error).message };
  }
}

/** 删除本地备份文件（配合「清空全部数据」） */
export async function clearLocalBackup(): Promise<boolean> {
  lastBackupJson = null;
  baselineEpochs = null;
  skipChecks = 0;
  try {
    return await electronApi.backup.delete();
  } catch {
    return false;
  }
}

/**
 * 启动 5 分钟备份心跳（幂等）。启动后先执行一次初次写入（建立基线），之后每
 * BACKUP_INTERVAL_MS 触发一次。
 *
 * 卡顿修复：重收集会同步 getItem + 序列化（可能占用主线程数十~数百 ms），故心跳先让出主线程
 * —— 优先等浏览器空闲（requestIdleCallback），兜底 setTimeout，避免「每到整 5 分钟」与用户
 * 输入/滚动撞车造成的掉帧；配合 writeLocalBackup 内部的快路径，无变化周期实际零开销。
 */
export function startLocalBackup(): () => void {
  if (started) return () => {};
  started = true;
  /** 让出主线程后再执行重活：空闲回调优先，不可用时短延时兜底 */
  const deferToIdle = (fn: () => void) => {
    const ric = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => void }).requestIdleCallback : undefined;
    if (ric) ric(fn, { timeout: 1500 });
    else window.setTimeout(fn, 250);
  };
  deferToIdle(() => {
    void writeLocalBackup();
  });
  const timer = window.setInterval(() => {
    deferToIdle(() => {
      void writeLocalBackup();
    });
  }, BACKUP_INTERVAL_MS);
  return () => {
    started = false;
    window.clearInterval(timer);
  };
}