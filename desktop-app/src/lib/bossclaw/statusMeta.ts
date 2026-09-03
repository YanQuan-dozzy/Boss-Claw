// 岗位卡状态展示的共享映射（工作台 / 任务进度共用，避免重复定义）
import type { PendingItem } from './types';

// 岗位卡状态色条映射
export function jobCardStatus(p: PendingItem): string {
  if (p.status === 'sent') return 'st-sent';
  if (p.status === 'opened') return 'st-opened';
  if (p.status === 'failed') return 'st-failed';
  if (p.status === 'skipped' || p.status === 'ignored') return 'st-ignored';
  if (p.status === 'approved' || p.status === 'approved_queue') return 'st-approved';
  if (p.status === 'rejected') return 'st-rejected'; // P23：补 rejected
  if (p.status === 'pending') return 'st-pending';   // P23：补 pending
  return '';
}

// AI 评分徽标：按分数段返回样式类与文案
export function scoreChip(score: number | undefined): { cls: string; text: string } {
  if (score === undefined) return { cls: '', text: '' };
  if (score >= 70) return { cls: 'high', text: String(score) };
  if (score >= 40) return { cls: 'mid', text: String(score) };
  return { cls: 'low', text: String(score) };
}
