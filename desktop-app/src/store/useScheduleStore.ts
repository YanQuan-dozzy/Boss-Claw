// 定时任务模块 store（Zustand persist → localStorage，纳入本地备份 BACKUP_KEYS）
// 支持三类动作：定时投递(deliver) / 定时采集(collect) / 定时备份(backup)。
// - deliver 支持限定「平台范围 platforms」（空=全部已启用平台）与「本次触发投递上限 limitPerRun」
//   （0=不限，仍受冷却/每日上限/首条验收等安全规则约束）——由引擎 start(scope) 消费。
// - collect 通过 collectRequest 请求（可携带目标平台）交由常驻的工作台组件消费触发采集。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { JobPlatform } from '@/lib/bossclaw/types';

export type ScheduleAction = 'deliver' | 'collect' | 'backup';

export interface ScheduleEntry {
  id: string;
  name: string;
  action: ScheduleAction;
  /** 'HH:mm'，仅触发时刻（分）匹配且未在本分钟触发过 */
  time: string;
  /** 0=周日 … 6=周六；空数组=每天 */
  daysOfWeek: number[];
  enabled: boolean;
  /**
   * 目标平台（deliver/collect 生效）：空/缺省 = 该动作当前全部已启用平台；
   * 指定后仅处理所选平台（deliver 由引擎过滤；collect 由工作台按序逐个采集）。
   */
  platforms?: JobPlatform[];
  /**
   * 本次触发的批量投递上限（仅 deliver 生效）：>0 表示单轮最多成功沟通 N 条即结束本次触发；
   * 0/缺省 = 不限（跑完当前队列或触达冷却/每日上限等安全规则为止）。
   */
  limitPerRun?: number;
  /** 最近一次触发的"目标分钟" epoch（用于去重，防同一分钟重复触发） */
  lastRunStamp: number;
}

/** 定时采集请求（调度器置位，常驻 Workbench 消费后清除）。platforms 空/缺省 = 全部已启用平台。 */
export interface CollectRequest {
  platforms?: JobPlatform[];
}

interface ScheduleState {
  entries: ScheduleEntry[];
  /** 待执行的采集请求（调度器置位，Workbench 消费后清除） */
  collectRequest: CollectRequest | null;
  addEntry: (e: Omit<ScheduleEntry, 'id' | 'lastRunStamp'>) => ScheduleEntry;
  updateEntry: (id: string, patch: Partial<ScheduleEntry>) => void;
  removeEntry: (id: string) => void;
  toggleEntry: (id: string, enabled: boolean) => void;
  markRun: (id: string, stamp: number) => void;
  setCollectRequest: (r: CollectRequest | null) => void;
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useScheduleStore = create<ScheduleState>()(
  persist(
    (set) => ({
      entries: [],
      collectRequest: null,
      addEntry: (e) => {
        const entry: ScheduleEntry = { ...e, id: uid(), lastRunStamp: 0 };
        set((s) => ({ entries: [...s.entries, entry] }));
        return entry;
      },
      updateEntry: (id, patch) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
      removeEntry: (id) => set((s) => ({ entries: s.entries.filter((x) => x.id !== id) })),
      toggleEntry: (id, enabled) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, enabled } : x)) })),
      markRun: (id, stamp) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, lastRunStamp: stamp } : x)) })),
      setCollectRequest: (r) => set({ collectRequest: r }),
    }),
    { name: 'bossclaw-schedule', storage: createSafePersistStorage() }
  )
);
