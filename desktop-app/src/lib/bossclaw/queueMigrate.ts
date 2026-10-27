// 一次性迁移：把 bossclaw-data 里的队列迁到 <userData>/queue/queue-store.json
// 依据 docs/存储迁移方案.md §3 —— 顺序必须是「先写文件 → 读回校验 → 再剥离 localStorage」，
// 任何一步失败都保持 localStorage 原样并退回旧路径，绝不做「两边各写一半」。
import { electronApi } from '@/lib/electronApi';
import { reportExternalFailure } from '@/lib/persistSafe';
import { isQueueFileMode, setQueueFileMode } from './queueMode';
import { QUEUE_PAYLOAD_VERSION, type QueueFilePayload } from './queueTypes';
import type { PendingItem, QualifiedJobExport } from './types';

/** 迁移完成标记（localStorage 内）；存在即表示这台机器已完成 v1 迁移 */
const MIGRATION_MARKER = 'bossclaw-queue-migration-v1';
/** 旧版业务数据所在键（persist 中间件格式：{ state, version }） */
const LEGACY_DATA_KEY = 'bossclaw-data';

function setMarker() {
  try {
    localStorage.setItem(MIGRATION_MARKER, String(Date.now()));
  } catch {
    /* 标记写不进去只会导致下次重复进入迁移分支，下面的文件判空会拦住重复写入 */
  }
}

function readLegacyQueue(): { pending: PendingItem[]; qualifiedExports: Record<string, QualifiedJobExport[]> } | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_DATA_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: { state?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
  } catch {
    return null;
  }
  const state = parsed?.state;
  if (!state) return null;
  const pending = Array.isArray(state.pending) ? (state.pending as PendingItem[]) : [];
  const qualifiedExports =
    state.qualifiedExports && typeof state.qualifiedExports === 'object'
      ? (state.qualifiedExports as Record<string, QualifiedJobExport[]>)
      : {};
  return { pending, qualifiedExports };
}

/** 从 bossclaw-data 中剥离队列字段（保留其余键：设置、简历、统计等） */
function stripQueueFromLegacy(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_DATA_KEY);
  } catch {
    return false;
  }
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number };
    if (!parsed?.state) return true;
    delete parsed.state.pending;
    delete parsed.state.qualifiedExports;
    localStorage.setItem(LEGACY_DATA_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

function sameIds(a: PendingItem[], b: PendingItem[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((x) => String(x?.id ?? '')));
  return b.every((x) => ids.has(String(x?.id ?? '')));
}

function isEmptyQueue(pending: PendingItem[], qualifiedExports: Record<string, QualifiedJobExport[]>): boolean {
  return pending.length === 0 && Object.keys(qualifiedExports).length === 0;
}

/**
 * 执行迁移。可重复调用：文件里已有队列或已打过标记时直接跳过。
 * 返回 migrated=true 表示「这次真的搬过去了」；skipped / error 都由调用方忽略即可（启动流程不阻断）。
 */
export async function migrateQueueFromLocalStorageIfNeeded(): Promise<{ migrated: boolean; skipped?: boolean; error?: string }> {
  if (!isQueueFileMode()) return { migrated: false, skipped: true };
  let marked = false;
  try {
    marked = Boolean(localStorage.getItem(MIGRATION_MARKER));
  } catch {
    /* 读不到标记按未迁移处理，下面会以文件内容判空 */
  }
  if (marked) return { migrated: false, skipped: true };

  const loaded = await electronApi.queue.load();
  if (!loaded.ok) {
    // 连文件都读不了：本会话退回旧路径，队列继续留在 localStorage，等下次启动再试
    setQueueFileMode(false);
    reportExternalFailure('bossclaw-queue-store', new Error(loaded.error || '迁移前读取队列文件失败'));
    return { migrated: false, error: loaded.error };
  }
  const existing = loaded.data as QueueFilePayload | null;
  if (existing && !isEmptyQueue(Array.isArray(existing.pending) ? existing.pending : [], existing.qualifiedExports || {})) {
    // 文件里已有数据（例如上次写完但标记没落下的极窄窗口）：不覆盖，只补标记
    setMarker();
    return { migrated: false, skipped: true };
  }

  const legacy = readLegacyQueue();
  if (!legacy || isEmptyQueue(legacy.pending, legacy.qualifiedExports)) {
    setMarker();
    return { migrated: false, skipped: true };
  }

  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq: 1,
    updatedAt: Date.now(),
    pending: legacy.pending,
    qualifiedExports: legacy.qualifiedExports,
    migratedFrom: 'localstorage',
  };
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    reportExternalFailure('bossclaw-queue-store', e instanceof Error ? e : new Error(String(e)));
    setQueueFileMode(false);
    return { migrated: false, error: '队列数据序列化失败' };
  }

  const saved = await electronApi.queue.save(text, 1, { migrationSnapshot: true });
  if (!saved.ok) {
    // 写失败：localStorage 保持原样，本会话退回旧路径（partialize 会继续保留队列字段）
    setQueueFileMode(false);
    reportExternalFailure('bossclaw-queue-store', new Error(saved.error || '队列迁移写入失败'));
    return { migrated: false, error: saved.error };
  }

  // 读回校验：条数与 id 集合都一致才算成功
  const back = await electronApi.queue.load();
  const backData = back.data as QueueFilePayload | null;
  const verified =
    back.ok &&
    backData &&
    sameIds(legacy.pending, Array.isArray(backData.pending) ? backData.pending : []) &&
    Object.keys(legacy.qualifiedExports).length === Object.keys(backData.qualifiedExports || {}).length;
  if (!verified) {
    // 文件可疑：不剥离 localStorage，退回旧路径（文件内容保留供排查）
    setQueueFileMode(false);
    reportExternalFailure('bossclaw-queue-store', new Error('队列迁移校验失败：读回条数与写入不一致'));
    return { migrated: false, error: '迁移校验失败' };
  }

  // 校验通过后才剥离；剥离失败（配额）不影响文件里的数据，partialize 下次也会补上
  stripQueueFromLegacy();
  setMarker();
  return { migrated: true };
}
