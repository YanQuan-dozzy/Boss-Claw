// 本地数据文件载荷（issue #10 / docs/存储迁移方案.md）
// 渲染侧序列化后交给主进程 <userData>/queue/，主进程只校验结构、不解释业务字段。
// 文件本身是自描述的：出问题时用户可直接打开看，也能据此手工核对。
//
// P3（2026-11-17）：
//   · 队列改为 per-item（items/<sha1(id)>.json）+ index.json，日常写入只提交变化条目；
//   · resumeText / resumeFileName / imageResumes 一并迁出 localStorage（resume.json）。
// 因此 v2 载荷同时承载「全量快照」（导入/备份/迁移）与「增量补丁」（日常自动保存）。
import type { ImageResume, PendingItem, QualifiedJobExport } from './types';

export const QUEUE_PAYLOAD_VERSION = 2;

/** 简历数据（从 localStorage 迁出，写 <userData>/queue/resume.json） */
export interface QueueResumePayload {
  resumeText: string;
  resumeFileName?: string;
  imageResumes?: ImageResume[];
  resumeUpdatedAt?: number;
}

/** 全量载荷：导入 / 恢复备份 / 一次性迁移 / 导出快照 */
export interface QueueFilePayload extends Partial<QueueResumePayload> {
  version: typeof QUEUE_PAYLOAD_VERSION;
  /** 单调递增写入序号：主进程拒绝比已落盘值更小的迟到包 */
  seq: number;
  updatedAt: number;
  pending: PendingItem[];
  qualifiedExports: Record<string, QualifiedJobExport[]>;
  /** 由 localStorage 一次性迁移而来时标记来源（排查用） */
  migratedFrom?: 'localstorage';
}

/**
 * 增量补丁：日常自动保存只提交变化的部分。
 * - upserts：新增 / 内容变化的条目（未变化的不传）；
 * - deletes：被移除的条目 id；
 * - order：展示顺序（仅在顺序变化时传；不传则主进程保留旧顺序并追加新条目）；
 * - qualifiedExports / resume：仅在对应内容变化时传。
 */
export interface QueuePatchPayload {
  version: typeof QUEUE_PAYLOAD_VERSION;
  seq: number;
  updatedAt: number;
  upserts?: PendingItem[];
  deletes?: string[];
  order?: string[];
  qualifiedExports?: Record<string, QualifiedJobExport[]>;
  resume?: QueueResumePayload;
  /** 全量替换（导入/恢复）：清掉不在新集合里的条目文件 */
  reset?: boolean;
}
