// 渲染进程侧的模拟面试仓储封装。
//
// 职责边界：
//   · 会话文件的真实读写在主进程（electron/mockInterviewRepo.cjs），这里只做 IPC 封装与 seq 递增；
//   · 进程内没有持久化中间层：会话状态由 store 持有，每次变更调 saveSession 落盘；
//   · `seq` 单调递增，主进程拒绝比已落盘更小的写入（并发保存的迟到包会被丢弃，而不是覆盖新值）。
import { electronApi } from '@/lib/electronApi';
import type { MockIndexEntry, MockJobRef, MockSession } from './mockInterviewTypes';
import { MOCK_DEFAULT_CONFIG } from './mockInterviewTypes';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 生成会话 id（UUID 自带连字符，符合主进程 8–64 位白名单） */
export function newSessionId(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* 忽略，走下面的兜底 */
  }
  return `mi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(String(id || ''));
}

/** 新建配置态草稿（尚未写盘；点「生成题目」后才有第一条记录） */
export function createDraftSession(job: Partial<MockJobRef> = {}): MockSession {
  const now = Date.now();
  return {
    id: newSessionId(),
    version: 1,
    job: {
      jobId: job.jobId ?? null,
      jobTitle: String(job.jobTitle || '').trim(),
      company: String(job.company || '').trim(),
      jdText: String(job.jdText || '').trim(),
      capturedAt: Number(job.capturedAt) || now,
    },
    config: { ...MOCK_DEFAULT_CONFIG },
    status: 'draft',
    phase: 1,
    questions: [],
    attempts: [],
    currentQuestionId: null,
    pendingProbe: null,
    reverse: null,
    report: null,
    retry: null,
    seq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listMockSessions(): Promise<{ ok: boolean; sessions: MockIndexEntry[]; error?: string }> {
  return electronApi.mockInterview.list();
}

export async function readMockSession(id: string): Promise<{ ok: boolean; session?: MockSession; error?: string }> {
  if (!isValidSessionId(id)) return { ok: false, error: '会话 id 非法' };
  return electronApi.mockInterview.read(id);
}

/**
 * 落盘会话。
 * @param opts.immediate 关键字段（状态 / 报告 / 结束时间）变更时传 true，主进程会打断合并窗口立即写。
 */
export async function saveMockSession(
  session: MockSession,
  opts: { immediate?: boolean } = {},
): Promise<{ ok: boolean; stale?: boolean; error?: string }> {
  const next: MockSession = {
    ...session,
    seq: (Number(session.seq) || 0) + 1,
    updatedAt: Date.now(),
  };
  // 就地递增，保证同一会话后续保存的 seq 一定更大（调用方持有同一个对象）
  session.seq = next.seq;
  session.updatedAt = next.updatedAt;
  return electronApi.mockInterview.write(next, opts);
}

export async function deleteMockSession(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidSessionId(id)) return { ok: false, error: '会话 id 非法' };
  return electronApi.mockInterview.remove(id);
}

/** 清空面试记录 + 语音资源（设置页「清空全部数据」与栏②「清空全部面试记录」共用） */
export async function clearMockInterviewAll(): Promise<{ ok: boolean; error?: string }> {
  return electronApi.mockInterview.clear();
}

/** 只清面试记录，保留题库与音色（栏②的「清空面试记录」） */
export async function clearMockSessions(): Promise<{ ok: boolean; error?: string }> {
  return electronApi.mockInterview.clearSessions();
}

export async function exportMockSessions(): Promise<{
  ok: boolean;
  canceled?: boolean;
  filePath?: string;
  count?: number;
  error?: string;
}> {
  return electronApi.mockInterview.exportAll();
}

export async function mockInterviewUsage(): Promise<{ ok: boolean; count: number; bytes: number; error?: string }> {
  return electronApi.mockInterview.usage();
}

/** 字节数 → 人类可读（栏②目录占用展示） */
export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
