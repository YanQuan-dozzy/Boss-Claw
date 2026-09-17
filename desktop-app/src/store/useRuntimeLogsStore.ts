// 运行时日志 store（P2-05：logs / chatLogs 从 bossclaw-data 拆出的独立持久化）
// ---------------------------------------------------------
// 背景：日志是高频写入的运行时产物（批量沟通/采集/投递每个阶段都 addChatLog / addLog），
// 与简历/画像/岗位等业务数据同存一个 key（bossclaw-data）时，日志暴涨会连带整包反复序列化
// （每次 flush 都是把含 base64 图片简历/160K 简历文本/双 500 条日志的整包 stringify），
// 且配额降级「丢日志」实质是「整包重写一个无日志版本」，业务数据反复受到牵连。
//
// 拆分成独立小键后的效果：
//  - bossclaw-data 的 flush 不再携带日志体积；
//  - 日志键自身超限时只需丢弃该键（persistSafe 直接 removeItem），不碰任何业务数据；
//  - 日志本就是运行时产物，重启即重新累积，与简历/画像的持久化语义本就不同。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export interface LogEntry {
  time: number;
  level: LogLevel;
  msg: string;
}

export type ChatLogStage =
  | 'open_chat'
  | 'greeting'
  | 'confirm'
  | 'resume'
  | 'ai_reply'
  | 'risk'
  | 'system'
  | 'verify_chat_target'
  | 'skip';

export interface ChatLogEntry {
  id: string;
  time: number;
  level: LogLevel | 'stage';
  stage?: ChatLogStage;
  jobId?: string;
  jobTitle?: string;
  company?: string;
  msg: string;
  greetingPreview?: string;
  errorDetail?: string;
  method?: string;
}

interface RuntimeLogsState {
  /** 常规执行日志（上限 500 条） */
  logs: LogEntry[];
  /** 沟通专属日志（上限 500 条，含 greetingPreview / errorDetail 长文本） */
  chatLogs: ChatLogEntry[];
  addLog: (level: LogLevel, msg: string) => void;
  clearLogs: () => void;
  addChatLog: (entry: Omit<ChatLogEntry, 'id' | 'time'> & { id?: string; time?: number }) => void;
  clearChatLogs: () => void;
}

export const useRuntimeLogsStore = create<RuntimeLogsState>()(
  persist(
    (set) => ({
      logs: [],
      chatLogs: [],

      addLog: (level, msg) => set((s) => ({ logs: [...s.logs, { time: Date.now(), level, msg }].slice(-500) })),
      clearLogs: () => set({ logs: [] }),
      addChatLog: (entry) =>
        set((s) => ({
          chatLogs: [
            ...s.chatLogs,
            {
              id: entry.id || `clog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              time: entry.time || Date.now(),
              level: entry.level || 'info',
              stage: entry.stage || 'system',
              jobId: entry.jobId,
              jobTitle: entry.jobTitle,
              company: entry.company,
              msg: entry.msg,
              greetingPreview: entry.greetingPreview,
              errorDetail: entry.errorDetail,
              method: entry.method,
            },
          ].slice(-500),
        })),
      clearChatLogs: () => set({ chatLogs: [] }),
    }),
    {
      // P2-05：独立小键承载运行时日志；storage.ts 登记表标为「不导出、不备份、清空时清除」。
      // 该键自身超限时 persistSafe 直接丢整个键（日志为运行时产物，重启即重新累积），不牵连业务数据。
      name: 'bossclaw-runtime-logs',
      storage: createSafePersistStorage(),
    }
  )
);