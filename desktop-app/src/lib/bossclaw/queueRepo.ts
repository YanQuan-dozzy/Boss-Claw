// 岗位队列的文件仓储（渲染侧封送）—— issue #10 / docs/存储迁移方案.md
// ---------------------------------------------------------------------
// 负责把 pending / qualifiedExports 的落盘从 localStorage 搬到 <userData>/queue/queue-store.json：
//   · hydrateQueue：启动时读回文件并交给 store；
//   · startQueueAutoSave：订阅 store，800ms 防抖 + 单飞串行写（seq 单调递增）；
//   · flushQueueNow：备份/导出/退出前的强制落盘；
//   · importQueueData / clearQueueStore：导入、恢复、清空等一次性操作；
//   · getQueueSnapshotText：同步快照（导出与本地备份直接复用，避免各写一份序列化逻辑）。
//
// 失败一律走 persistSafe 的同一套状态机（状态栏红标 + 一键备份 + 去重提示），
// 与旧的 localStorage 写失败行为保持一致 —— 用户看到的是「本地存储异常」，而不是无声丢失。
import { electronApi } from '@/lib/electronApi';
import {
  clearExternalFailure,
  markPersistDirty,
  reportExternalFailure,
} from '@/lib/persistSafe';
import { useDataStore } from '@/store/useDataStore';
import { isQueueFileMode, queueFileAvailable } from './queueMode';
import { QUEUE_PAYLOAD_VERSION, type QueueFilePayload } from './queueTypes';
import type { PendingItem, QualifiedJobExport } from './types';

/** 与 localStorage 里的业务键区分开；导出/备份 bundle 内也用它当 key */
export const QUEUE_STORE_KEY = 'bossclaw-queue-store';
/** 与 localStorage 防抖保持一致：用户连续操作时只在停手 800ms 后写一次 */
const DEBOUNCE_MS = 800;
/** 写失败后的重试间隔（期间再有改动会立即重新排期） */
const RETRY_MS = 5000;

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let dirty = false;
/**
 * 清空后挂起：clearAllData 删完文件到 reload 之间还有几百毫秒，store 内存里仍是旧队列；
 * 若此时触发 pagehide flush，会把旧队列重新写回文件，等于「清空无效」。挂起后所有写入直接短路。
 */
let suspended = false;
let lastWrittenPending: PendingItem[] | null = null;
let lastWrittenQualified: Record<string, QualifiedJobExport[]> | null = null;
let stopAutoSave: (() => void) | null = null;

function currentState() {
  return useDataStore.getState();
}

function buildPayload(): QueueFilePayload {
  const st = currentState();
  return {
    version: QUEUE_PAYLOAD_VERSION,
    seq: seq + 1,
    updatedAt: Date.now(),
    pending: st.pending ?? [],
    qualifiedExports: st.qualifiedExports ?? {},
  };
}

/** 同步序列化当前队列（不推进 seq，只用于导出/备份快照） */
export function getQueueSnapshotText(): string {
  const st = currentState();
  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq,
    updatedAt: Date.now(),
    pending: st.pending ?? [],
    qualifiedExports: st.qualifiedExports ?? {},
  };
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({
      version: QUEUE_PAYLOAD_VERSION,
      seq,
      updatedAt: Date.now(),
      pending: [],
      qualifiedExports: {},
    });
  }
}

function reportSaveFailure(err: unknown) {
  reportExternalFailure(QUEUE_STORE_KEY, err instanceof Error ? err : new Error(String(err)));
}

function schedule(delay = DEBOUNCE_MS) {
  if (!isQueueFileMode() || suspended) return;
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    void doSave();
  }, delay);
}

async function doSave() {
  if (!isQueueFileMode() || suspended) return;
  if (inFlight) {
    // 单飞：上一笔还在写，只标记 dirty，等它完成后用「最新状态」再写一次
    dirty = true;
    return;
  }
  const payload = buildPayload();
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    reportSaveFailure(e);
    return;
  }
  const pendingRef = payload.pending;
  const qualifiedRef = payload.qualifiedExports;
  inFlight = true;
  dirty = false;
  try {
    const r = await electronApi.queue.save(text, payload.seq);
    if (r.ok) {
      seq = payload.seq;
      lastWrittenPending = pendingRef;
      lastWrittenQualified = qualifiedRef;
      clearExternalFailure(QUEUE_STORE_KEY);
      // 让本地备份的「干净快照」判断能感知队列变化
      markPersistDirty(QUEUE_STORE_KEY);
    } else {
      reportSaveFailure(new Error(r.error || '队列文件写入失败'));
      schedule(RETRY_MS);
    }
  } catch (e) {
    reportSaveFailure(e);
    schedule(RETRY_MS);
  } finally {
    inFlight = false;
    if (dirty) {
      dirty = false;
      schedule(0);
    }
  }
}

/**
 * 启动水合：读回队列文件（主进程已处理 .bak 回退）。
 * 返回 hasData 便于调用方决定是否要从本地备份回签。
 */
export async function hydrateQueue(): Promise<{
  ok: boolean;
  hasData: boolean;
  pending: PendingItem[];
  qualifiedExports: Record<string, QualifiedJobExport[]>;
  recovered?: boolean;
  error?: string;
}> {
  const empty = { pending: [] as PendingItem[], qualifiedExports: {} as Record<string, QualifiedJobExport[]> };
  // 注意：这里**不**用 isQueueFileMode() 把关。回滚开关（BOSSCLAW_QUEUE_STORE=localstorage）
  // 只影响「写哪」（partialize / 自动落盘），读仍要读文件 —— 否则迁移后一旦回滚，
  // localStorage 里的队列已被剥离，界面会凭空清空。是否信任文件由迁移结果决定（见 main.tsx）。
  if (!queueFileAvailable()) return { ok: true, hasData: false, ...empty };
  const r = await electronApi.queue.load();
  if (!r.ok) {
    reportSaveFailure(new Error(r.error || '队列文件读取失败'));
    return { ok: false, hasData: false, ...empty, error: r.error };
  }
  const data = r.data as QueueFilePayload | null;
  if (!data) {
    return { ok: true, hasData: false, ...empty, recovered: r.recovered };
  }
  const pending = Array.isArray(data.pending) ? data.pending : [];
  const qualifiedExports =
    data.qualifiedExports && typeof data.qualifiedExports === 'object' ? data.qualifiedExports : {};
  seq = Math.max(seq, Number(data.seq) || 0);
  lastWrittenPending = pending;
  lastWrittenQualified = qualifiedExports;
  clearExternalFailure(QUEUE_STORE_KEY);
  return { ok: true, hasData: pending.length > 0 || Object.keys(qualifiedExports).length > 0, pending, qualifiedExports, recovered: r.recovered };
}

/** 订阅 store 变化并开始防抖写盘（须在水合完成后调用，避免把「读回来的同一份数据」立刻再写一遍） */
export function startQueueAutoSave(): void {
  if (!isQueueFileMode() || suspended || stopAutoSave) return;
  const unsub = useDataStore.subscribe((s, prev) => {
    if (s.pending === prev.pending && s.qualifiedExports === prev.qualifiedExports) return;
    dirty = true;
    schedule();
  });
  // 关窗/切后台时尽力补一笔（异步 IPC 可能来不及，主进程侧防抖窗口只丢最后 800ms）
  const onHide = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void flushQueueNow();
  };
  const onPageHide = () => void flushQueueNow();
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onHide);
  stopAutoSave = () => {
    unsub();
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onHide);
    stopAutoSave = null;
  };
}

/** 强制落盘：清掉等待中的防抖，把当前状态写下去（已与最近一次成功写入相同则跳过） */
export async function flushQueueNow(): Promise<void> {
  if (!isQueueFileMode() || suspended) return;
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  // 等待在途写入结束（最多 2s），再用最新状态兜底写一次
  for (let i = 0; i < 40 && inFlight; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const st = currentState();
  if (lastWrittenPending === (st.pending ?? null) && lastWrittenQualified === (st.qualifiedExports ?? null)) {
    return;
  }
  await doSave();
}

/** 导入/恢复：校验外部文本后写入文件（seq 用本地序号推进，避免与旧文件比大小被拒） */
export async function importQueueData(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!isQueueFileMode()) return { ok: false, error: '当前不是队列文件模式' };
  let parsed: QueueFilePayload;
  try {
    parsed = JSON.parse(text) as QueueFilePayload;
  } catch {
    return { ok: false, error: '队列数据结构非法（不是合法 JSON）' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pending)) {
    return { ok: false, error: '队列数据缺少 pending 数组' };
  }
  const qualifiedExports =
    parsed.qualifiedExports && typeof parsed.qualifiedExports === 'object' ? parsed.qualifiedExports : {};
  const nextSeq = seq + 1;
  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq: nextSeq,
    updatedAt: Date.now(),
    pending: parsed.pending,
    qualifiedExports,
  };
  let out: string;
  try {
    out = JSON.stringify(payload);
  } catch {
    return { ok: false, error: '队列数据无法序列化' };
  }
  const r = await electronApi.queue.save(out, nextSeq);
  if (!r.ok) {
    reportSaveFailure(new Error(r.error || '队列数据写入失败'));
    return { ok: false, error: r.error };
  }
  seq = nextSeq;
  lastWrittenPending = payload.pending;
  lastWrittenQualified = payload.qualifiedExports;
  markPersistDirty(QUEUE_STORE_KEY);
  clearExternalFailure(QUEUE_STORE_KEY);
  return { ok: true };
}

/** 队列文件不存在时，尝试从本地备份回签（对应旧的「无 localStorage 数据时从备份恢复」） */
export async function restoreQueueFromBackupIfEmpty(): Promise<boolean> {
  if (!isQueueFileMode()) return false;
  const r = await electronApi.backup.read();
  const text = r.bundle?.keys?.[QUEUE_STORE_KEY];
  if (typeof text !== 'string' || !text) return false;
  const w = await importQueueData(text);
  return w.ok;
}

/** 清空队列文件（清空前先丢弃在途/待写，避免清空后又被防抖写回来） */
export async function clearQueueStore(): Promise<void> {
  // 清空即挂起：停止订阅、丢弃待写，之后（到 reload 前的 pagehide flush）不再产生任何写入
  suspended = true;
  stopAutoSave?.();
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  dirty = false;
  lastWrittenPending = null;
  lastWrittenQualified = null;
  seq = 0;
  if (!isQueueFileMode()) return;
  const r = await electronApi.queue.clear();
  if (!r.ok) reportSaveFailure(new Error(r.error || '队列文件清空失败'));
}
