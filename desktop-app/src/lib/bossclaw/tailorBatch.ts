import type { JobMeta, PendingItem } from './types';
import type { TailorResult } from './jobAssistant';
import { buildTailorJobInput } from './tailorJob';
import { getErrorMessage } from './helpers';

export type TailorBatchStatus = 'queued' | 'running' | 'done' | 'local' | 'failed' | 'stopped' | 'filtered';
export interface TailorBatchItem extends ReturnType<typeof buildTailorJobInput> {
  id: string;
  status: TailorBatchStatus;
  result?: TailorResult;
  error?: string;
}

export function createTailorBatch(pending: PendingItem[], ids: string[]): TailorBatchItem[] {
  const byId = new Map(pending.map((p) => [p.id, p]));
  return [...new Set(ids)].flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ id, ...buildTailorJobInput(item.job), status: 'queued' as const }] : [];
  });
}

/** 串行处理；停止时保留当前结果和已完成项，失败不阻断后面的岗位。 */
export async function runTailorBatch(
  items: TailorBatchItem[],
  generate: (item: TailorBatchItem) => Promise<TailorResult>,
  options: {
    shouldStop: () => boolean;
    shouldSkip?: (item: TailorBatchItem) => string | undefined;
    onUpdate: (item: TailorBatchItem) => void;
    onResult: (item: TailorBatchItem & { result: TailorResult }) => void;
  }
): Promise<void> {
  for (const item of items) {
    if (item.result) continue;
    const excluded = options.shouldSkip?.(item);
    if (excluded) { options.onUpdate({ ...item, status: 'filtered', error: excluded }); continue; }
    if (options.shouldStop()) {
      options.onUpdate({ ...item, status: 'stopped', error: undefined });
      continue;
    }
    options.onUpdate({ ...item, status: 'running', error: undefined });
    try {
      if (!item.jobTitle.trim() || !item.jobDesc.trim()) throw new Error('岗位名称或要求为空，请补充岗位信息');
      const result = await generate(item);
      const completed = { ...item, status: result.method === 'ai' ? 'done' as const : 'local' as const, result, error: undefined };
      options.onResult(completed);
      options.onUpdate(completed);
    } catch (error) {
      options.onUpdate({ ...item, status: 'failed', error: getErrorMessage(error) });
    }
  }
}

export interface TailorHistoryItem {
  id: string;
  jobId?: string;
  company?: string;
  /** 完整生成输入；旧历史仅有标题与描述。 */
  job?: JobMeta;
  jobTitle: string;
  jobDesc: string;
  createdAt: number;
  result: TailorResult;
}

export const TAILOR_HISTORY_MAX = 200;

/** 同名但不同公司的岗位各自保存；同一岗位再次生成替换自己的旧记录。 */
export function upsertTailorHistory(history: TailorHistoryItem[], item: TailorHistoryItem): TailorHistoryItem[] {
  return [item, ...history.filter((h) => {
    if (item.jobId && h.jobId) return item.jobId !== h.jobId;
    return item.jobTitle !== h.jobTitle || item.jobDesc !== h.jobDesc || (item.company || '') !== (h.company || '');
  })].slice(0, TAILOR_HISTORY_MAX);
}

export function batchPdfFileName(name: string, jobTitle: string, company: string, index: number, now = new Date()): string {
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const stem = [String(index + 1).padStart(3, '0'), jobTitle, company, name, '定制简历', date]
    .filter(Boolean).join('-').replace(/[^\w\u4e00-\u9fa5()（）\-· ]/g, '-').replace(/-+/g, '-').slice(0, 110);
  return `${stem}.pdf`;
}
