import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DirectionPlan,
  PendingItem,
  Profile,
  ProfileDraft,
  Stats,
  TaskRun,
  JobMeta,
  JobAnalysis,
  ImageResume,
} from '@/lib/bossclaw/types';
import { DEFAULT_STATS, DEFAULT_PROFILE, DEFAULT_PROFILE_DRAFT, DEFAULT_DIRECTION_PLAN, today } from '@/lib/bossclaw/defaults';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export interface LogEntry {
  time: number;
  level: LogLevel;
  msg: string;
}

export type ChatLogStage = 'open_chat' | 'greeting' | 'confirm' | 'resume' | 'ai_reply' | 'risk' | 'system';

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

interface DataState {
  resumeText: string;
  resumeFileName: string;
  resumeImage: string | null; // dataURL，非持久化
  /** 图片简历（base64，持久化）：首次沟通后自动打包发送 */
  imageResumes: ImageResume[];
  /** AI 生成的求职打招呼语（持久化）：简历中心生成后写入，工作台岗位沟通可选用 */
  greetings: string[];
  /** 用户自定义打招呼语提示词（持久化）：留空则使用系统默认提示词；用于驱动岗位分析中的打招呼语生成与简历中心的4条招呼语生成 */
  greetingPrompt: string;
  profile: Profile | null;
  profileDraft: ProfileDraft | null;
  directionPlan: DirectionPlan | null;
  pending: PendingItem[];
  taskRuns: TaskRun[];
  stats: Stats;
  logs: LogEntry[];
  chatLogs: ChatLogEntry[];

  setResumeText: (text: string, fileName?: string) => void;
  setResumeImage: (dataUrl: string | null) => void;
  setImageResumes: (items: ImageResume[]) => void;
  addImageResume: (item: ImageResume) => void;
  removeImageResume: (id: string) => void;
  setGreetings: (items: string[]) => void;
  setGreetingPrompt: (prompt: string) => void;
  setProfile: (p: Profile | null) => void;
  setProfileDraft: (d: ProfileDraft | null) => void;
  setDirectionPlan: (p: DirectionPlan | null) => void;

  addPendingItem: (item: PendingItem) => void;
  updatePending: (id: string, patch: Partial<PendingItem>) => void;
  setPending: (items: PendingItem[]) => void;

  upsertTaskRun: (run: TaskRun) => void;
  updateTaskRun: (id: string, patch: Partial<TaskRun>) => void;
  setTaskRuns: (runs: TaskRun[]) => void;

  addLog: (level: LogLevel, msg: string) => void;
  clearLogs: () => void;
  addChatLog: (entry: Omit<ChatLogEntry, 'id' | 'time'> & { id?: string; time?: number }) => void;
  clearChatLogs: () => void;
  recomputeStats: () => void;
  resetDailyStats: () => void;
}

export const useDataStore = create<DataState>()(
  persist(
    (set, get) => ({
      resumeText: '',
      resumeFileName: '',
      resumeImage: null,
      imageResumes: [],
      greetings: [],
      greetingPrompt: '',
      profile: DEFAULT_PROFILE,
      profileDraft: DEFAULT_PROFILE_DRAFT,
      directionPlan: DEFAULT_DIRECTION_PLAN,
      pending: [],
      taskRuns: [],
      stats: DEFAULT_STATS,
      logs: [],
      chatLogs: [],

      setResumeText: (text, fileName) =>
        set((s) => {
          // 本地存储容量保护（借鉴 AI-BossJob 的自动截断降级方案）：
          // 简历原文过长时截断保存，避免撑爆 localStorage（约 5MB 配额）
          const MAX_RESUME_CHARS = 160_000;
          const raw = String(text || '');
          const stored = raw.length > MAX_RESUME_CHARS ? raw.slice(0, MAX_RESUME_CHARS) : raw;
          return {
            resumeText: stored,
            resumeFileName: fileName ?? s.resumeFileName,
          };
        }),
      setResumeImage: (dataUrl) => set({ resumeImage: dataUrl }),
      setImageResumes: (items) => set({ imageResumes: items }),
      addImageResume: (item) => set((s) => ({ imageResumes: [...s.imageResumes, item] })),
      removeImageResume: (id) => set((s) => ({ imageResumes: s.imageResumes.filter((r) => r.id !== id) })),
      setGreetings: (items) => set({ greetings: Array.isArray(items) ? items.filter((g) => String(g || '').trim().length >= 8) : [] }),
      setGreetingPrompt: (prompt) => set({ greetingPrompt: String(prompt || '').trim() }),
      setProfile: (p) => set({ profile: p }),
      setProfileDraft: (d) => set({ profileDraft: d }),
      setDirectionPlan: (p) => set({ directionPlan: p }),

      addPendingItem: (item) => set((s) => ({ pending: [item, ...s.pending] })),
      updatePending: (id, patch) =>
        set((s) => ({ pending: s.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      setPending: (items) => set({ pending: items }),

      upsertTaskRun: (run) =>
        set((s) => {
          const exists = s.taskRuns.some((r) => r.id === run.id);
          return { taskRuns: exists ? s.taskRuns.map((r) => (r.id === run.id ? { ...r, ...run } : r)) : [run, ...s.taskRuns] };
        }),
      updateTaskRun: (id, patch) =>
        set((s) => ({ taskRuns: s.taskRuns.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
      setTaskRuns: (runs) => set({ taskRuns: runs }),

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
      recomputeStats: () => {
        const { pending, stats } = get();
        // 单次遍历聚合，替代原先 6 次 filter
        let sent = 0;
        let skipped = 0;
        let failed = 0;
        let pendingCount = 0;
        let analyzed = 0;
        for (const p of pending) {
          if (p.status === 'sent') sent += 1;
          else if (p.status === 'skipped') skipped += 1;
          else if (p.status === 'failed') failed += 1;
          if (p.status === 'approved' || p.status === 'approved_queue' || p.status === 'pending') pendingCount += 1;
          if (p.analysis) analyzed += 1;
        }
        set({
          stats: {
            ...stats,
            sent,
            skipped,
            failed,
            pending: pendingCount,
            discovered: pending.length,
            analyzed,
          },
        });
      },
      resetDailyStats: () => set({ stats: { ...DEFAULT_STATS, date: today() } }),
    }),
    {
      name: 'bossclaw-data',
      partialize: (s) => {
        const { resumeImage, ...rest } = s;
        return rest as DataState;
      },
    }
  )
);

// 将"加入任务"封装为一步：分析 -> 生成 PendingItem -> 入队
export function makePendingItem(
  job: JobMeta,
  analysis: JobAnalysis,
  deliveryGreeting: string,
  runId: string
): PendingItem {
  return {
    id: runId,
    runId,
    job,
    analysis,
    deliveryGreeting: String(deliveryGreeting || analysis.greeting || '').trim(),
    status: 'pending',
    createdAt: Date.now(),
    retryCount: 0,
  };
}
