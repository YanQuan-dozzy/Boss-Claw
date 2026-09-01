// 早中晚分批投递调度助手
// 仅在全自动模式（executionMode='auto'）且 config.batchDelivery.enabled 时生效。
// 逻辑：
//   - 将一天划分为早 / 午 / 晚 3 个连续时段窗口：
//       早间 = morningTime → noonTime
//       午间 = noonTime → eveningTime
//       晚间 = eveningTime → 次日 00:00
//   - 当前时刻落在哪个窗口内，则该窗口为「活跃时段」；在第一个最早时段之前无活跃时段。
//   - 每个时段设有本次投递配额 counts.XXX，配额按当天该窗口内 sentAt 命中数统计；
//     配额为 0 时视为该时段不限量（仍受每日 / 每分钟安全上限约束）。

import type { AppConfig, PendingItem } from './types';

export type BatchSlotId = 'morning' | 'noon' | 'evening';

export const BATCH_SLOT_IDS: BatchSlotId[] = ['morning', 'noon', 'evening'];

export const BATCH_SLOT_LABELS: Record<BatchSlotId, string> = {
  morning: '早间',
  noon: '午间',
  evening: '晚间',
};

export interface ActiveBatchSlot {
  id: BatchSlotId;
  label: string;
  /** 时段起始时间对应的当日分钟数（0-1439） */
  startMinutes: number;
  /** 下一时段起始分钟数（晚间为 1440，即次日 00:00） */
  nextMinutes: number;
  /** 本时段本次投递配额 */
  quota: number;
  /** 本时段剩余可投数量（>=0） */
  remaining: number;
}

/** 解析 'HH:mm' 为当日分钟数；非法输入回退 0 */
export function timeToMinutes(t: string): number {
  const m = String(t || '').match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return 0;
  return h * 60 + min;
}

/** Date → 当日分钟数（0-1439） */
export function toMinutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function slotStart(config: AppConfig, id: BatchSlotId): number {
  const b = config.batchDelivery;
  switch (id) {
    case 'morning':
      return timeToMinutes(b.morningTime);
    case 'noon':
      return timeToMinutes(b.noonTime);
    case 'evening':
      return timeToMinutes(b.eveningTime);
  }
}

function slotQuota(config: AppConfig, id: BatchSlotId): number {
  return Math.max(0, Number(config.batchDelivery.counts?.[id]) || 0);
}

/** 统计当前时段窗口内已成功投递数量（以 sentAt 命中窗口为准） */
function countSentInSlot(
  pending: PendingItem[],
  slotStartMin: number,
  slotNextMin: number,
  now: number
): number {
  const n = new Date(now);
  const dayStart = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const start = dayStart + slotStartMin * 60_000;
  const end = dayStart + slotNextMin * 60_000;
  return (pending || []).filter(
    (p) => p.status === 'sent' && p.sentAt && p.sentAt >= start && p.sentAt < end
  ).length;
}

/**
 * 计算当前活跃时段；未启用分批、或当前时刻不在任何时段窗口内时返回 null。
 * pending 用于统计当前时段已投数量，决定 remaining 配额余量。
 */
export function activeBatchSlot(
  config: AppConfig,
  now: number,
  pending: PendingItem[]
): ActiveBatchSlot | null {
  const b = config.batchDelivery;
  if (!b?.enabled) return null;

  const nowMin = toMinutesOfDay(new Date(now));
  const morning = slotStart(config, 'morning');
  const noon = slotStart(config, 'noon');
  const evening = slotStart(config, 'evening');

  let active: { id: BatchSlotId; startMin: number; nextMin: number };
  if (nowMin < morning) {
    return null; // 早间时段尚未开始
  } else if (nowMin < noon) {
    active = { id: 'morning', startMin: morning, nextMin: noon };
  } else if (nowMin < evening) {
    active = { id: 'noon', startMin: noon, nextMin: evening };
  } else {
    active = { id: 'evening', startMin: evening, nextMin: 1440 };
  }

  const quota = slotQuota(config, active.id);
  const sentInSlot =
    quota > 0 ? countSentInSlot(pending, active.startMin, active.nextMin, now) : 0;

  return {
    id: active.id,
    label: BATCH_SLOT_LABELS[active.id],
    startMinutes: active.startMin,
    nextMinutes: active.nextMin,
    quota,
    remaining: quota > 0 ? Math.max(0, quota - sentInSlot) : Infinity,
  };
}