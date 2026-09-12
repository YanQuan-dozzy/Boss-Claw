import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
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
  QualifiedJobExport,
} from '@/lib/bossclaw/types';
import { DEFAULT_STATS, DEFAULT_PROFILE, DEFAULT_PROFILE_DRAFT, DEFAULT_DIRECTION_PLAN, today } from '@/lib/bossclaw/defaults';

/** 达标岗位本地缓存上限：最多保留最近 N 天（按日期分组）的达标岗位数据，超出自动清理更早几天的数据，防止 localStorage 撑爆。
 *  实测按每天约 460 个达标岗位、叠加图片简历+导入文件后，保留 7 天（≈3200 条）仍能把整 store 稳定在 5MB 配额约 60% 以内；90 天会随累计溢出。 */
const MAX_QUALIFIED_CACHE_DAYS = 7;

/** 裁剪达标岗位缓存：日期键多于上限时，删除最早（更久之前）的日期分组 */
function pruneQualifiedCache(records: Record<string, QualifiedJobExport[]>, maxDays: number): Record<string, QualifiedJobExport[]> {
  const keys = Object.keys(records);
  if (keys.length <= maxDays) return records;
  // 日期键为 YYYY-MM-DD，字典序即时间序，升序后最前面的是最早几天
  const sorted = keys.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const toDrop = keys.length - maxDays;
  const dropSet = new Set(sorted.slice(0, toDrop));
  const pruned: Record<string, QualifiedJobExport[]> = {};
  for (const k of sorted) {
    if (!dropSet.has(k)) pruned[k] = records[k];
  }
  return pruned;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export interface LogEntry {
  time: number;
  level: LogLevel;
  msg: string;
}

export type ChatLogStage = 'open_chat' | 'greeting' | 'confirm' | 'resume' | 'ai_reply' | 'risk' | 'system' | 'verify_chat_target' | 'skip';

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
  /** AI 生成的求职打招呼语（持久化）：定制简历「存入打招呼语」写入，工作台岗位沟通可选用（无招呼语时兜底） */
  greetings: string[];
  /** 简历中心「打招呼语提示词」输入框内容（持久化）。
   *  生成时的提示词来源优先级：① skill（greetings 技能，含用户自定义技能）→ ② 本输入框内容 → ③ 都不满足则本地规则。 */
  greetingPrompt: string;
  /** 沟通信息（持久化）：用户自行填写的面试时间/到岗时间等真实信息，AI 跟聊回复 HR 时引用；留空则维持原回复行为 */
  communicationInfo: string;
  profile: Profile | null;
  profileDraft: ProfileDraft | null;
  directionPlan: DirectionPlan | null;
  pending: PendingItem[];
  taskRuns: TaskRun[];
  stats: Stats;
  logs: LogEntry[];
  chatLogs: ChatLogEntry[];
  /** 达标岗位导出记录（持久化）：按「日期 → 该日已导出的达标岗位」累积，用于当天内去重 */
  qualifiedExports: Record<string, QualifiedJobExport[]>;

  setResumeText: (text: string, fileName?: string) => void;
  setResumeImage: (dataUrl: string | null) => void;
  setImageResumes: (items: ImageResume[]) => void;
  addImageResume: (item: ImageResume) => void;
  removeImageResume: (id: string) => void;
  setGreetings: (items: string[]) => void;
  setGreetingPrompt: (prompt: string) => void;
  setCommunicationInfo: (info: string) => void;
  setProfile: (p: Profile | null) => void;
  setProfileDraft: (d: ProfileDraft | null) => void;
  setDirectionPlan: (p: DirectionPlan | null) => void;

  addPendingItem: (item: PendingItem) => void;
  updatePending: (id: string, patch: Partial<PendingItem>) => void;
  setPending: (items: PendingItem[]) => void;

  upsertTaskRun: (run: TaskRun) => void;
  updateTaskRun: (id: string, patch: Partial<TaskRun>) => void;
  setTaskRuns: (runs: TaskRun[]) => void;
  /** 删除单条任务（仅移除该卡片，不动其它任务与岗位记录） */
  removeTaskRun: (id: string) => void;
  /** 追加某日的达标岗位导出记录（用于当天内去重累积） */
  mergeQualifiedExports: (date: string, items: QualifiedJobExport[]) => void;

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
      communicationInfo: '',
      profile: DEFAULT_PROFILE,
      profileDraft: DEFAULT_PROFILE_DRAFT,
      directionPlan: DEFAULT_DIRECTION_PLAN,
      pending: [],
      taskRuns: [],
      stats: DEFAULT_STATS,
      logs: [],
      chatLogs: [],
      qualifiedExports: {},

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
      setCommunicationInfo: (info) => set({ communicationInfo: String(info || '') }),
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
      removeTaskRun: (id) => set((s) => ({ taskRuns: s.taskRuns.filter((r) => r.id !== id) })),
      mergeQualifiedExports: (date, items) =>
        set((s) => {
          const next = { ...s.qualifiedExports, [date]: items };
          return { qualifiedExports: pruneQualifiedCache(next, MAX_QUALIFIED_CACHE_DAYS) };
        }),

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
        const next = {
          ...stats,
          sent,
          skipped,
          failed,
          pending: pendingCount,
          discovered: pending.length,
          analyzed,
        };
        // P08：计数未变化时跳过 set，避免无条件 persist 对整个数据包（含 base64 图片简历）重复序列化
        if (
          stats.sent === next.sent &&
          stats.skipped === next.skipped &&
          stats.failed === next.failed &&
          stats.pending === next.pending &&
          stats.discovered === next.discovered &&
          stats.analyzed === next.analyzed
        ) {
          return;
        }
        set({ stats: next });
      },
      resetDailyStats: () => set({ stats: { ...DEFAULT_STATS, date: today() } }),
    }),
    {
      name: 'bossclaw-data',
      // P30：防抖 + 容错持久化。批量引擎/网络卡顿时 addChatLog 高频触发全量 set，
      // 原 persist 每次都会同步序列化整个 store（含 base64 图片简历/双 500 条日志/160K 简历文本），
      // 大对象 stringify + localStorage 写盘会把渲染进程主线程卡死（点击无反应/应用退出）。
      // 改用防抖合批（短窗口内多次 set 只写一次）+ 配额超限降级（丢运行时日志不丢业务状态）。
      storage: createSafePersistStorage(),
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
