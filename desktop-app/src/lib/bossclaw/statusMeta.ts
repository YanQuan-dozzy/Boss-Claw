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

/**
 * 岗位卡动作按钮的悬浮说明（工作台 / 任务进度共用一套文案）。
 * 口径：只说「点了会发生什么 / 有什么副作用」，不复述按钮名；
 * 「面试」是最容易被误认成「发起面试/约面」的动作，必须点明进的是模拟面试。
 */
export const JOB_ACTION_TIPS = {
  /** 工作台：内置浏览器新标签打开岗位详情 */
  openInApp: '在内置浏览器新标签页打开该岗位详情，可核对 JD 原文',
  /** 任务进度：交给系统默认浏览器打开 */
  openExternal: '在系统默认浏览器打开该岗位详情页',
  /** 模拟面试：带入该岗位 JD 与公司信息去练习，不会真的联系 HR */
  mockInterview: '进入模拟面试：自动带入该岗位的 JD 与公司信息，按该岗位出题练习（不会联系 HR、不影响投递）',
  ignore: '标记为已忽略并从列表隐藏，可在「显示已忽略/跳过」中查看并重试',
  skip: '标记为已跳过、不再进入投递队列，可在「显示已忽略/跳过」中查看并重试',
  retry: '重新放回「待确认」，可再次分析或投递',
  deleteSent: '删除这条已投递记录：仅移除本地记录，不影响平台上的实际投递',
} as const;
