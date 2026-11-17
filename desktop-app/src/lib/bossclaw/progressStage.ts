// lib/bossclaw/progressStage.ts —— 求职流程进展（P1-6）
//
// 为什么是「正交字段」而不是扩 PendingStatus 枚举：
//   全仓 40+ 处按 status 分支渲染 / 统计（STATUS_TAG / jobCardStatus / WAITING_STATUSES / 投递引擎），
//   往枚举里加值会静默架空这些分支。progressStage 只描述「HR 那边到哪一步」，
//   与「投递到哪一步」解耦：不改 status、不进投递队列、不影响排序与过滤，也不参与投递成功率。
//
// 写入口径：
//   · AI 跟聊识别到面试邀约 → interview_scheduled（只前进，不把已面试 / offer / 已拒绝改回约面）；
//   · HR 明确拒绝 → rejected_by_hr（终态，总是覆盖）；
//   · 其余阶段（已回复 / 已面试 / 已获 Offer）由用户手动标记 ——
//     模型无法可靠知道面试是否真的发生、offer 是否已发，自动推断会制造假进展。

import type { PendingItem, ProgressStage } from './types';
import { STATUS_COLORS } from '../../theme';

export interface ProgressStageMeta {
  key: ProgressStage;
  label: string;
  color: string;
  hint: string;
}

/** 展示元数据（统计页 / 岗位卡共用；顺序即展示顺序，从早到晚） */
export const PROGRESS_STAGE_META: readonly ProgressStageMeta[] = [
  { key: 'replied', label: '已回复', color: '#3B82F6', hint: 'HR 已回复消息（人工标记）' },
  { key: 'interview_scheduled', label: '已约面', color: '#06B6D4', hint: 'HR 邀约面试 / 正在确认时间（AI 跟聊自动识别，也可手动标记）' },
  { key: 'interviewed', label: '已面试', color: '#A78BFA', hint: '面试已完成（人工标记）' },
  { key: 'offer', label: '已获 Offer', color: STATUS_COLORS.success, hint: '已收到 Offer（人工标记）' },
  {
    key: 'rejected_by_hr',
    label: 'HR 已拒绝',
    color: STATUS_COLORS.danger,
    hint: 'HR 明确拒绝 / 流程终止（AI 跟聊自动识别，也可手动标记）',
  },
];

const STAGE_KEYS = new Set<string>(PROGRESS_STAGE_META.map((m) => m.key));

/** 归一化：只接受枚举内取值；历史 / 脏数据（含旧版本没有该字段）一律视为「未标记」 */
export function normalizeProgressStage(v: unknown): ProgressStage | null {
  const s = String(v ?? '').trim();
  return STAGE_KEYS.has(s) ? (s as ProgressStage) : null;
}

export function progressStageLabel(v: unknown): string {
  const s = normalizeProgressStage(v);
  if (!s) return '未标记';
  return PROGRESS_STAGE_META.find((m) => m.key === s)?.label || s;
}

/**
 * 面试邀约的自动推进结果；`null` = 不写。
 * 只前进不后退：已面试 / 已获 Offer / HR 已拒绝都比「约面」更靠后；
 * 已经是 interview_scheduled 时也不重复写（避免每轮跟聊都刷新 progressUpdatedAt）。
 */
export function nextStageOnInterview(current: unknown): ProgressStage | null {
  const cur = normalizeProgressStage(current);
  if (cur === null) return 'interview_scheduled';
  if (cur === 'replied') return 'interview_scheduled';
  return null;
}

export type ProgressStagePatch = Pick<PendingItem, 'progressStage' | 'progressUpdatedAt'>;

/** 手动标记 / 清除的统一 patch：清除时把更新时间一并清空，避免留下「未标记但有时间」的矛盾数据 */
export function progressStagePatch(next: ProgressStage | null): ProgressStagePatch {
  const stage = normalizeProgressStage(next);
  if (!stage) return { progressStage: undefined, progressUpdatedAt: undefined };
  return { progressStage: stage, progressUpdatedAt: Date.now() };
}
