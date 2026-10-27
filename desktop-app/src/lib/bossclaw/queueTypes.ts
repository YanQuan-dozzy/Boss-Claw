// 岗位队列文件载荷（issue #10 / docs/存储迁移方案.md）
// 渲染侧序列化后交给主进程 <userData>/queue/queue-store.json，主进程只校验结构、不解释业务字段。
// 文件本身是自描述的：出问题时用户可直接打开看，也能据此手工核对。
import type { PendingItem, QualifiedJobExport } from './types';

export const QUEUE_PAYLOAD_VERSION = 1;

export interface QueueFilePayload {
  version: typeof QUEUE_PAYLOAD_VERSION;
  /** 单调递增写入序号：主进程拒绝比已落盘值更小的迟到包 */
  seq: number;
  updatedAt: number;
  pending: PendingItem[];
  qualifiedExports: Record<string, QualifiedJobExport[]>;
  /** 由 localStorage 一次性迁移而来时标记来源（排查用） */
  migratedFrom?: 'localstorage';
}
