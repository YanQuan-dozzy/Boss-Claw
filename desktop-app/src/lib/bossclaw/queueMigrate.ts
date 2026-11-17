// 一次性迁移：把 bossclaw-data 里的队列 / 简历迁到 <userData>/queue/
// 依据 docs/存储迁移方案.md §3 / §7 P3 —— 顺序必须是「先写文件 → 读回校验 → 再剥离 localStorage」，
// 任何一步失败都保持 localStorage 原样并退回旧路径，绝不做「两边各写一半」。
//
// 两个迁移各自幂等、可独立重试：
//   · 队列（pending / qualifiedExports）→ v1 起就存在，标记 bossclaw-queue-migration-v1；
//   · 简历（resumeText / resumeFileName / imageResumes）→ P3 新增，标记 bossclaw-resume-migration-v1。
// 分开的原因是老用户已经打过队列标记，若共用标记会被直接跳过、简历永远迁不出去。
import { electronApi } from '@/lib/electronApi';
import { reportExternalFailure } from '@/lib/persistSafe';
import { isQueueFileMode, setQueueFileMode } from './queueMode';
import { QUEUE_PAYLOAD_VERSION, type QueueFilePayload } from './queueTypes';
import type { ImageResume, PendingItem, QualifiedJobExport } from './types';

/** 队列迁移完成标记（localStorage 内） */
const QUEUE_MARKER = 'bossclaw-queue-migration-v1';
/** 简历迁移完成标记（P3）；与队列标记分开，保证老用户也会迁 */
const RESUME_MARKER = 'bossclaw-resume-migration-v1';
/** 旧版业务数据所在键（persist 中间件格式：{ state, version }） */
const LEGACY_DATA_KEY = 'bossclaw-data';

function hasMarker(key: string): boolean {
  try {
    return Boolean(localStorage.getItem(key));
  } catch {
    return false;
  }
}

function setMarker(key: string) {
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {
    /* 标记写不进去只会导致下次重复进入迁移分支，下面的文件判空会拦住重复写入 */
  }
}

interface LegacyState {
  pending: PendingItem[];
  qualifiedExports: Record<string, QualifiedJobExport[]>;
  resumeText?: string;
  resumeFileName?: string;
  imageResumes?: ImageResume[];
  hasQueue: boolean;
  hasResume: boolean;
}

function readLegacyState(): LegacyState | null {
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
  const resumeText = typeof state.resumeText === 'string' ? state.resumeText : '';
  const resumeFileName = typeof state.resumeFileName === 'string' ? state.resumeFileName : '';
  const imageResumes = Array.isArray(state.imageResumes) ? (state.imageResumes as ImageResume[]) : [];
  return {
    pending,
    qualifiedExports,
    resumeText,
    resumeFileName,
    imageResumes,
    hasQueue: pending.length > 0 || Object.keys(qualifiedExports).length > 0,
    hasResume: resumeText.trim().length > 0 || imageResumes.length > 0,
  };
}

function rewriteLegacy(patch: (state: Record<string, unknown>) => void): boolean {
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
    patch(parsed.state);
    localStorage.setItem(LEGACY_DATA_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

/** 从 bossclaw-data 中剥离队列字段（保留简历等其余键） */
function stripQueueFromLegacy(): boolean {
  return rewriteLegacy((state) => {
    delete state.pending;
    delete state.qualifiedExports;
  });
}

/** 从 bossclaw-data 中剥离简历字段（P3） */
function stripResumeFromLegacy(): boolean {
  return rewriteLegacy((state) => {
    delete state.resumeText;
    delete state.resumeFileName;
    delete state.imageResumes;
  });
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
 * 队列迁移（v1 起）。可重复调用：文件里已有队列或已打过标记时直接跳过。
 * 返回 migrated=true 表示「这次真的搬过去了」；skipped / error 都由调用方忽略即可（启动流程不阻断）。
 */
export async function migrateQueueFromLocalStorageIfNeeded(): Promise<{ migrated: boolean; skipped?: boolean; error?: string }> {
  if (!isQueueFileMode()) return { migrated: false, skipped: true };
  if (hasMarker(QUEUE_MARKER)) return { migrated: false, skipped: true };

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
    setMarker(QUEUE_MARKER);
    return { migrated: false, skipped: true };
  }

  const legacy = readLegacyState();
  if (!legacy || !legacy.hasQueue) {
    setMarker(QUEUE_MARKER);
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
  // 队列与简历同批迁出时，顺手把简历也写进文件，少一次全量重写
  if (legacy.hasResume) {
    payload.resumeText = legacy.resumeText || '';
    payload.resumeFileName = legacy.resumeFileName || '';
    payload.imageResumes = legacy.imageResumes || [];
  }
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
  setMarker(QUEUE_MARKER);
  if (legacy.hasResume) {
    // 同批写入的简历已经过读回校验（同一份 payload），可直接标记
    const resumeOk = backData && typeof backData.resumeText === 'string'
      && backData.resumeText === (legacy.resumeText || '');
    if (resumeOk) {
      stripResumeFromLegacy();
      setMarker(RESUME_MARKER);
    }
  }
  return { migrated: true };
}

/**
 * 简历迁移（P3）：老用户此前已迁过队列、简历仍留在 bossclaw-data 的情况。
 * 用当前文件里的 pending / qualifiedExports + 旧简历拼一份全量载荷重写一次，
 * 读回校验通过后再剥离 localStorage。
 */
export async function migrateResumeFromLocalStorageIfNeeded(): Promise<{ migrated: boolean; skipped?: boolean; error?: string }> {
  if (!isQueueFileMode()) return { migrated: false, skipped: true };
  if (hasMarker(RESUME_MARKER)) return { migrated: false, skipped: true };

  const legacy = readLegacyState();
  if (!legacy || !legacy.hasResume) {
    setMarker(RESUME_MARKER);
    return { migrated: false, skipped: true };
  }

  const loaded = await electronApi.queue.load();
  if (!loaded.ok) {
    setQueueFileMode(false);
    reportExternalFailure('bossclaw-queue-store', new Error(loaded.error || '简历迁移前读取文件失败'));
    return { migrated: false, error: loaded.error };
  }
  const existing = loaded.data as QueueFilePayload | null;
  // 文件里已有简历（例如队列迁移同批写入）：直接剥离 localStorage，不重复写
  if (existing && typeof existing.resumeText === 'string' && (existing.resumeText.trim() || (existing.imageResumes || []).length)) {
    stripResumeFromLegacy();
    setMarker(RESUME_MARKER);
    return { migrated: false, skipped: true };
  }

  const payload: QueueFilePayload = {
    version: QUEUE_PAYLOAD_VERSION,
    seq: Math.max(1, Number(existing?.seq) || 0) + 1,
    updatedAt: Date.now(),
    pending: Array.isArray(existing?.pending) ? existing.pending : [],
    qualifiedExports: existing?.qualifiedExports && typeof existing.qualifiedExports === 'object' ? existing.qualifiedExports : {},
    resumeText: legacy.resumeText || '',
    resumeFileName: legacy.resumeFileName || '',
    imageResumes: legacy.imageResumes || [],
    migratedFrom: 'localstorage',
  };
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    reportExternalFailure('bossclaw-queue-store', e instanceof Error ? e : new Error(String(e)));
    return { migrated: false, error: '简历数据序列化失败' };
  }
  const saved = await electronApi.queue.save(text, payload.seq);
  if (!saved.ok) {
    reportExternalFailure('bossclaw-queue-store', new Error(saved.error || '简历迁移写入失败'));
    return { migrated: false, error: saved.error };
  }
  const back = await electronApi.queue.load();
  const backData = back.data as QueueFilePayload | null;
  const verified = back.ok && backData && typeof backData.resumeText === 'string'
    && backData.resumeText === (legacy.resumeText || '')
    && (backData.imageResumes || []).length === (legacy.imageResumes || []).length;
  if (!verified) {
    reportExternalFailure('bossclaw-queue-store', new Error('简历迁移校验失败：读回内容与写入不一致'));
    return { migrated: false, error: '简历迁移校验失败' };
  }
  stripResumeFromLegacy();
  setMarker(RESUME_MARKER);
  return { migrated: true };
}
