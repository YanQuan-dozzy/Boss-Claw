// 定时任务模块 store（Zustand persist → localStorage，纳入本地备份 BACKUP_KEYS）
// 支持三类动作：定时投递(deliver) / 定时采集(collect) / 定时备份(backup)。
// collect 通过 collectRequested 标志交由常驻的工作台组件消费触发采集。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  /** 最近一次触发的"目标分钟" epoch（用于去重，防同一分钟重复触发） */
  lastRunStamp: number;
}

interface ScheduleState {
  entries: ScheduleEntry[];
  /** 待执行的采集请求标志（调度器置位，Workbench 消费后清除） */
  collectRequested: boolean;
  addEntry: (e: Omit<ScheduleEntry, 'id' | 'lastRunStamp'>) => ScheduleEntry;
  updateEntry: (id: string, patch: Partial<ScheduleEntry>) => void;
  removeEntry: (id: string) => void;
  toggleEntry: (id: string, enabled: boolean) => void;
  markRun: (id: string, stamp: number) => void;
  setCollectRequested: (v: boolean) => void;
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useScheduleStore = create<ScheduleState>()(
  persist(
    (set) => ({
      entries: [],
      collectRequested: false,
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
      setCollectRequested: (v) => set({ collectRequested: v }),
    }),
    { name: 'bossclaw-schedule' }
  )
);