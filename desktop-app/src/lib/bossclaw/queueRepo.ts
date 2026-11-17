// 本地数据文件仓储（渲染侧封送）—— issue #10 / docs/存储迁移方案.md
// ---------------------------------------------------------------------
// 负责把 pending / qualifiedExports / resumeText / imageResumes 的落盘从 localStorage
// 搬到 <userData>/queue/：
//   · hydrateQueue：启动时读回文件并交给 store；
//   · startQueueAutoSave：订阅 store，800ms 防抖 + 单飞串行写；
//   · flushQueueNow：备份/导出/退出前的强制落盘；
//   · importQueueData / clearQueueStore：导入、恢复、清空等一次性操作；
//   · getQueueSnapshotText：同步全量快照（导出与本地备份直接复用）。
//
// P3（2026-11-17）写入粒度：日常保存不再 stringify 整包，而是按条目对象引用做 diff，
// 只提交「新增/变化条目 + 删除 id + 顺序变化 + resume 变化」。未变化的条目对象在
// zustand 的不可变更新中保持同一引用，因此 diff 是 O(n) 引用比较，不深比较、不复制全量。
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
import { QUEUE_PAYLOAD_VERSION, type QueueFilePayload, type QueuePatchPayload } from './queueTypes';
import type { ImageResume, PendingItem, QualifiedJobExport } from './types';

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
let stopAutoSave: (() => void) | null = null;

// ===== 增量 diff 基准（P3）=====
// pending 的每次更新都是不可变替换：未变化的条目保持同一对象引用，
// 因此「引用不同」等价于「内容变化」，无需深比较。
let lastWrittenById = new Map<string, PendingItem>();
let lastOrderKey = '';
let lastQualifiedRef: Record<string, QualifiedJobExport[]> | null = null;
let lastResumeText: string | null = null;
let lastResumeFileName: string | null = null;
let lastImageResumes: ImageResume[] | null = null;

function currentState() {
  return useDataStore.getState();
}

function idOf(p: PendingItem): string {
  return String(p?.id ?? '');
}

interface BuiltPatch {
  text: string;
  patch: QueuePatchPayload;
}

/** 按对象引用 diff 当前 store 与「上次成功落盘」的基准；无变化返回 null */
function buildPatch(): BuiltPatch | null {
  const st = currentState();
  const pending = Array.isArray(st.pending) ? st.pending : [];
  const upserts: PendingItem[] = [];
  const seen = new Set<string>();
  for (const p of pending) {
    const id = idOf(p);
    if (!id) continue;
    seen.add(id);
    if (lastWrittenById.get(id) !== p) upserts.push(p);
  }
  const deletes: string[] = [];
  for (const id of lastWrittenById.keys()) {
    if (!seen.has(id)) deletes.push(id);
  }

  const orderIds = pending.map(idOf).filter(Boolean);
  const orderKey = orderIds.join('\u0001');
  const order = orderKey !== lastOrderKey ? orderIds : undefined;

  const qualifiedExports = (st.qualifiedExports ?? {}) as Record<string, QualifiedJobExport[]>;
  const qualifiedChanged = qualifiedExports !== lastQualifiedRef;

  const resumeChanged =
    (st.resumeText ?? '') !== (lastResumeText ?? '') ||
    (st.resumeFileName ?? '') !== (lastResumeFileName ?? '') ||
    (st.imageResumes ?? []) !== (lastImageResumes ?? []);

  if (!upserts.length && !deletes.length && !order && !qualifiedChanged && !resumeChanged) return null;

  const patch: QueuePatchPayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq: seq + 1,
    updatedAt: Date.now(),
    upserts,
    deletes,
    order,
    qualifiedExports: qualifiedChanged ? qualifiedExports : undefined,
    resume: resumeChanged
      ? {
          resumeText: st.resumeText ?? '',
          resumeFileName: st.resumeFileName ?? '',
          imageResumes: st.imageResumes ?? [],
        }
      : undefined,
  };
  let text: string;
  try {
    text = JSON.stringify(patch);
  } catch {
    return null;
  }
  return { text, patch };
}

function applyPatchBaseline(patch: QueuePatchPayload): void {
  for (const p of patch.upserts || []) lastWrittenById.set(idOf(p), p);
  for (const id of patch.deletes || []) lastWrittenById.delete(id);
  if (patch.order) lastOrderKey = patch.order.join('\u0001');
  if (patch.qualifiedExports !== undefined) lastQualifiedRef = patch.qualifiedExports;
  if (patch.resume) {
    lastResumeText = patch.resume.resumeText ?? '';
    lastResumeFileName = patch.resume.resumeFileName ?? '';
    lastImageResumes = patch.resume.imageResumes ?? [];
  }
}

/** 同步序列化当前全量数据（不推进 seq，只用于导出/备份快照） */
export function getQueueSnapshotText(): string {
  const st = currentState();
  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq,
    updatedAt: Date.now(),
    pending: st.pending ?? [],
    qualifiedExports: st.qualifiedExports ?? {},
    resumeText: st.resumeText ?? '',
    resumeFileName: st.resumeFileName ?? '',
    imageResumes: st.imageResumes ?? [],
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
      resumeText: '',
      resumeFileName: '',
      imageResumes: [],
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
  const built = buildPatch();
  if (!built) return;
  inFlight = true;
  dirty = false;
  try {
    const r = await electronApi.queue.savePatch(built.text, built.patch.seq);
    if (r.ok) {
      // stale 也视为成功：说明更新的 seq 已落盘，本次基准可以推进
      seq = Math.max(seq, built.patch.seq);
      applyPatchBaseline(built.patch);
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

/** 用水合结果重建 diff 基准（必须是读回的对象引用，后续 store 更新才能正确 diff） */
function resetBaseline(
  pending: PendingItem[],
  qualifiedExports: Record<string, QualifiedJobExport[]>,
  resume?: { resumeText?: string; resumeFileName?: string; imageResumes?: ImageResume[] } | null,
): void {
  lastWrittenById = new Map();
  for (const p of pending) {
    const id = idOf(p);
    if (id) lastWrittenById.set(id, p);
  }
  lastOrderKey = pending.map(idOf).filter(Boolean).join('\u0001');
  lastQualifiedRef = qualifiedExports;
  // 文件里没有 resume 字段（旧版队列文件 / 简历迁移失败）时基准置 null：
  // 这样下一次任意 store 变更都会把「内存里的简历」补写进文件，避免 partialize
  // 先从 localStorage 剥掉简历、文件里又没有，造成不可逆丢失。
  lastResumeText = resume && typeof resume.resumeText === 'string' ? resume.resumeText : null;
  lastResumeFileName = resume && typeof resume.resumeFileName === 'string' ? resume.resumeFileName : null;
  lastImageResumes = resume && Array.isArray(resume.imageResumes) ? resume.imageResumes : null;
}

/**
 * 启动水合：读回本地数据文件（主进程已处理索引 / 条目 / .bak 回退与旧版迁移）。
 * 返回 hasData 便于调用方决定是否要从本地备份回签。
 */
export async function hydrateQueue(): Promise<{
  ok: boolean;
  hasData: boolean;
  pending: PendingItem[];
  qualifiedExports: Record<string, QualifiedJobExport[]>;
  resumeText?: string;
  resumeFileName?: string;
  imageResumes?: ImageResume[];
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
    resetBaseline([], {});
    return { ok: true, hasData: false, ...empty, recovered: r.recovered };
  }
  const pending = Array.isArray(data.pending) ? data.pending : [];
  const qualifiedExports =
    data.qualifiedExports && typeof data.qualifiedExports === 'object' ? data.qualifiedExports : {};
  const resume = {
    resumeText: typeof data.resumeText === 'string' ? data.resumeText : undefined,
    resumeFileName: typeof data.resumeFileName === 'string' ? data.resumeFileName : undefined,
    imageResumes: Array.isArray(data.imageResumes) ? data.imageResumes : undefined,
  };
  seq = Math.max(seq, Number(data.seq) || 0);
  resetBaseline(pending, qualifiedExports, resume);
  clearExternalFailure(QUEUE_STORE_KEY);
  return {
    ok: true,
    hasData: pending.length > 0 || Object.keys(qualifiedExports).length > 0 || typeof resume.resumeText === 'string',
    pending,
    qualifiedExports,
    ...resume,
    recovered: r.recovered,
  };
}

/** 订阅 store 变化并开始防抖写盘（须在水合完成后调用，避免把「读回来的同一份数据」立刻再写一遍） */
export function startQueueAutoSave(): void {
  if (!isQueueFileMode() || suspended || stopAutoSave) return;
  const unsub = useDataStore.subscribe((s, prev) => {
    if (
      s.pending === prev.pending &&
      s.qualifiedExports === prev.qualifiedExports &&
      s.resumeText === prev.resumeText &&
      s.resumeFileName === prev.resumeFileName &&
      s.imageResumes === prev.imageResumes
    ) return;
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

/** 强制落盘：清掉等待中的防抖，把尚未落盘的变化写下去（无变化则零开销返回） */
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
  await doSave();
}

/** 导入/恢复：校验外部全量文本后整体替换（seq 用本地序号推进，避免与旧文件比大小被拒） */
export async function importQueueData(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!isQueueFileMode()) return { ok: false, error: '当前不是队列文件模式' };
  let parsed: Partial<QueueFilePayload>;
  try {
    parsed = JSON.parse(text) as Partial<QueueFilePayload>;
  } catch {
    return { ok: false, error: '队列数据结构非法（不是合法 JSON）' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pending)) {
    return { ok: false, error: '队列数据缺少 pending 数组' };
  }
  const qualifiedExports =
    parsed.qualifiedExports && typeof parsed.qualifiedExports === 'object' ? parsed.qualifiedExports : {};
  const st = currentState();
  // 旧备份（v1 队列 + bossclaw-data 里的简历）没有 resume 字段时，用 store 当前值补齐，
  // 保证导入后 resume.json 与用户眼前的简历一致。
  const resumeText = typeof parsed.resumeText === 'string' ? parsed.resumeText : (st.resumeText ?? '');
  const resumeFileName = typeof parsed.resumeFileName === 'string' ? parsed.resumeFileName : (st.resumeFileName ?? '');
  const imageResumes = Array.isArray(parsed.imageResumes) ? parsed.imageResumes : (st.imageResumes ?? []);
  const nextSeq = seq + 1;
  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq: nextSeq,
    updatedAt: Date.now(),
    pending: parsed.pending,
    qualifiedExports,
    resumeText,
    resumeFileName,
    imageResumes,
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
  resetBaseline(payload.pending, qualifiedExports, { resumeText, resumeFileName, imageResumes });
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

/** 清空本地数据文件（清空前先丢弃在途/待写，避免清空后又被防抖写回来） */
export async function clearQueueStore(): Promise<void> {
  // 清空即挂起：停止订阅、丢弃待写，之后（到 reload 前的 pagehide flush）不再产生任何写入
  suspended = true;
  stopAutoSave?.();
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  dirty = false;
  lastWrittenById = new Map();
  lastOrderKey = '';
  lastQualifiedRef = null;
  lastResumeText = null;
  lastResumeFileName = null;
  lastImageResumes = null;
  seq = 0;
  if (!isQueueFileMode()) return;
  const r = await electronApi.queue.clear();
  if (!r.ok) reportSaveFailure(new Error(r.error || '队列文件清空失败'));
}
