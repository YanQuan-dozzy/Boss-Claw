// 本地数据备份（localStorage 为主存储 + 周期脏检查写盘）
// ---------------------------------------------------------
// 口径：localStorage 维持主存储；每 BACKUP_INTERVAL_MS（5 分钟）把关键 persist 键打成一个
// bundle 写到所选备份目录的 bossclaw-local-backup.json。采用「脏检查」：JSON 序列化与上次
// 快照相同则不重写文件；仅内容变化才覆盖。localStorage 缺失/被清空时，从该文件回签恢复。
// 覆盖数据：登录/简历等持久化内容、日志信息（logs/chatLogs）、采集与投递的岗位信息（pending/taskRuns）。
import { electronApi } from './electronApi';

export const BACKUP_INTERVAL_MS = 300_000; // 5 分钟

// 需要纳入本地备份的 persist 键（与各 store 的 persist name 一致）
export const BACKUP_KEYS = ['bossclaw-app', 'bossclaw-settings-v2', 'bossclaw-data', 'bossclaw-schedule'] as const;

export interface BackupBundle {
  updatedAt: number;
  keys: Record<string, string | null>;
}

// 最近一次备份包的序列化字符串（内存脏检查基准）
let lastBackupJson: string | null = null;
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
 */
export async function writeLocalBackup(force = false): Promise<{ wrote: boolean; error?: string }> {
  try {
    if (!electronApi.backup || !electronApi.backup.write) {
      return { wrote: false, error: 'backup API 不可用（仅 Electron 可用）' };
    }
    const bundle = gatherBundle();
    // 脏检查以 keys 内容为准（updatedAt 每次变化，不能纳入比对，否则会每分钟重写文件）
    const keysJson = JSON.stringify(bundle.keys);
    if (!force && lastBackupJson && keysJson === lastBackupJson) {
      return { wrote: false };
    }
    const r = await electronApi.backup.write(bundle);
    if (!r.ok && !r.file) return { wrote: false, error: r.error || '写盘失败' };
    lastBackupJson = keysJson;
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
    for (const [k, v] of Object.entries(r.bundle.keys)) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* 单个键恢复失败忽略 */
      }
    }
    // 更新脏检查基准（以 keys 内容为准），避免恢复后立即误判重复写入
    try { lastBackupJson = JSON.stringify(r.bundle.keys); } catch {}
    return { restored: true };
  } catch (e) {
    return { restored: false, error: (e as Error).message };
  }
}

/** 删除本地备份文件（配合「清空全部数据」） */
export async function clearLocalBackup(): Promise<boolean> {
  lastBackupJson = null;
  try {
    return await electronApi.backup.delete();
  } catch {
    return false;
  }
}

/**
 * 启动 5 分钟备份心跳（幂等）。立即执行一次初次写入，之后每 BACKUP_INTERVAL_MS 触发一次。
 */
export function startLocalBackup(): () => void {
  if (started) return () => {};
  started = true;
  void writeLocalBackup();
  const timer = window.setInterval(() => {
    void writeLocalBackup();
  }, BACKUP_INTERVAL_MS);
  return () => {
    started = false;
    window.clearInterval(timer);
  };
}