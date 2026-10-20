// 模拟面试会话状态（内存态 + 异步文件读写；**不用 persist**）
//
// 为什么不用 zustand persist：会话是「用户产出内容」而不是「应用状态」，
// 它的持久化在主进程文件里（<userData>/mock-interview/），persist 再存一份只会制造两份真相。
//
// 本 store 负责把「引擎（纯函数 + AI 调用）」与「页面交互」串起来：
//   startInterview → 生成阶段一
//   submitAnswer   → 主答 / 追问补答 → 本地规则或 AI 裁决 → 推进或追问
//   finishInterview→ 反问（可选）→ 批量评分 → 报告
//   retryQuestion  → 只重算该题的评分
import { create } from 'zustand';
import { useDataStore } from './useDataStore';
import { useSettingsStore } from './useSettingsStore';
import { indexSnapshot, recallCandidates } from './useBankStore';
import { classifyQuestion, type BankCandidate, type BankDirection } from '@/lib/bossclaw/mockInterviewBank';
import type { JobMeta } from '@/lib/bossclaw/types';
import {
  MOCK_DIFFICULTY_LABELS,
  MOCK_ROLE_LABELS,
  type MockDeliveryMetrics,
  type MockIndexEntry,
  type MockInterviewConfig,
  type MockJobRef,
  type MockQuestion,
  type MockReport,
  type MockSession,
} from '@/lib/bossclaw/mockInterviewTypes';
import {
  advance,
  aggregateReport,
  answerReverse,
  applyReportToAttempts,
  buildReport,
  canInject,
  generatePhase1,
  generatePhase2,
  latestAttempt,
  rescoreAnswer,
  rewriteAnswer,
  type MockEngineContext,
} from '@/lib/bossclaw/mockInterviewEngine';
import {
  clearMockInterviewAll,
  clearMockSessions,
  createDraftSession,
  deleteMockSession,
  exportMockSessions,
  listMockSessions,
  mockInterviewUsage,
  readMockSession,
  saveMockSession,
} from '@/lib/bossclaw/mockInterviewRepo';

// ===== 题库召回（P3）：本地 BM25 → 候选池拼进同一次出题调用 =====

interface BankRecallSummary {
  candidates: BankCandidate[];
  info: NonNullable<MockSession['flags']>['bankRecall'];
}

/** 从岗位 + 简历技能推断方向标签（内置库的分类是启发式的，所以只当过滤提示，召回内部会放宽） */
function bankDirectionsOf(jobTitle: string): BankDirection[] {
  const data = useDataStore.getState();
  const dirText = [
    jobTitle,
    ...((data.profile?.primaryDirections || []).map((d) => d.name).filter(Boolean) as string[]),
  ].join(' ');
  return classifyQuestion(dirText).directions.filter((d) => d !== 'general');
}

async function recallForSession(session: MockSession, excludeSourceIds: Set<string>): Promise<BankRecallSummary> {
  if (!session.config.bankEnabled) return { candidates: [], info: null };
  const data = useDataStore.getState();
  const res = await recallCandidates({
    jobTitle: session.job.jobTitle,
    roleLabel: MOCK_ROLE_LABELS[session.config.role],
    difficultyLabel: MOCK_DIFFICULTY_LABELS[session.config.difficulty],
    jdText: session.job.jdText,
    skills: (data.profile?.facts?.skills || []).slice(0, 12).map(String),
    directions: bankDirectionsOf(session.job.jobTitle) as BankDirection[],
    difficulty: session.config.difficulty,
    excludeIds: excludeSourceIds,
    topK: Number(session.config.recallTopK) || 20,
  });
  if (!res) return { candidates: [], info: null };
  return {
    candidates: res.candidates,
    info: {
      candidates: res.candidates.length,
      poolSize: res.poolSize,
      relaxed: res.relaxed,
      tookMs: res.tookMs,
    },
  };
}

/**
 * 采用题库题的，把该题的 keyPoints 作为本题 rubric 带进评分。
 * 只有用户导入/自建且填了要点的题才会走到这里；内置题一律「无要点」，不会凭空造出依据。
 */
function enrichFromBank(questions: MockQuestion[]): MockQuestion[] {
  const { docs } = indexSnapshot();
  if (!docs.size) return questions;
  return questions.map((q) => {
    if (!q.sourceQuestionId) return q;
    const bq = docs.get(q.sourceQuestionId);
    if (!bq) return q;
    const kp = (bq.keyPoints || []).slice(0, 6);
    if (!kp.length) return { ...q, keyPointsFrom: 'none', sourceBankId: bq.bankId || q.sourceBankId || null };
    return {
      ...q,
      keyPointsFrom: 'bank',
      sourceBankId: bq.bankId || q.sourceBankId || null,
      rubric: kp,
    };
  });
}

function countBankHits(questions: MockQuestion[]): number {
  return questions.filter((q) => Boolean(q.sourceQuestionId)).length;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从设置/简历 store 取引擎上下文（不把 config 复制进会话，避免密钥落进面试文件） */
function engineCtx(): MockEngineContext {
  const settings = useSettingsStore.getState();
  const data = useDataStore.getState();
  return {
    model: settings.config.model,
    resumeText: data.resumeText || '',
    profile: data.profile,
  };
}

function hasApiKey(): boolean {
  return Boolean(String(useSettingsStore.getState().config.model.apiKey || '').trim());
}

export type MockInterviewTab = 'interview' | 'bank';

interface MockInterviewState {
  list: MockIndexEntry[];
  usage: { count: number; bytes: number };
  session: MockSession | null;
  tab: MockInterviewTab;
  /** 正在执行的异步动作（空串 = 空闲）；UI 用它显示过渡文案与禁用按钮 */
  busy: '' | 'list' | 'recall' | 'phase1' | 'phase2' | 'advance' | 'report' | 'reverse' | 'rewrite' | 'rescore';
  error: string;
  notice: string;
  /** 最近一次改写结果（按题目 id），只存在内存，不写盘 */
  rewrites: Record<string, { text: string; gaps: string[]; blocked: boolean }>;

  refreshList: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  setTab: (t: MockInterviewTab) => void;
  clearError: () => void;
  clearNotice: () => void;

  newDraft: (job?: Partial<MockJobRef> & { jobMeta?: JobMeta }) => void;
  openSession: (id: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  exportAll: () => Promise<void>;

  updateJob: (patch: Partial<MockJobRef>) => void;
  updateConfig: (patch: Partial<MockInterviewConfig>) => void;

  startInterview: () => Promise<void>;
  beginAnswering: () => void;
  goReverse: () => Promise<void>;
  submitAnswer: (answer: string, durationMs?: number, delivery?: MockDeliveryMetrics) => Promise<void>;
  skipQuestion: () => Promise<void>;
  submitReverse: (question: string) => Promise<void>;
  finishInterview: () => Promise<void>;
  retryQuestion: (questionId: string) => void;
  rewriteCurrent: (questionId: string) => Promise<void>;
  backToConfig: () => void;
  discardSession: () => Promise<void>;
  clearAllData: () => Promise<void>;
}

export const useMockInterviewStore = create<MockInterviewState>()((set, get) => {
  /** 落盘（失败只提示，不打断作答——文件写不进去也不该让用户丢答案） */
  const persist = async (session: MockSession, immediate = false): Promise<void> => {
    set({ session });
    const r = await saveMockSession(session, { immediate });
    if (!r.ok && !r.stale) set({ error: `会话保存失败：${r.error || '未知错误'}` });
  };

  const ctxOf = () => engineCtx();

  /** 进入下一题；阶段结束则触发生成阶段二 / 反问 */
  const goNext = async (s: MockSession): Promise<void> => {
    const idx = s.currentQuestionId ? s.questions.findIndex((q) => q.id === s.currentQuestionId) : -1;
    const cur = idx >= 0 ? s.questions[idx] : null;
    const next = idx >= 0 ? s.questions[idx + 1] : undefined;

    if (next) {
      await persist({ ...s, currentQuestionId: next.id, pendingProbe: null, status: 'running' });
      return;
    }

    // 阶段一最后一道 → 生成阶段二；本地题兜底时直接进反问（阶段二不可用）
    if (cur && cur.phase === 1 && !s.flags?.localFallback) {
      set({ busy: 'phase2' });
      const planning: MockSession = { ...s, status: 'planning', pendingProbe: null };
      await persist(planning, true);
      try {
        // 阶段二再召回一次：此时已知阶段一用了哪些题，排除掉避免重复；查询串带上阶段一的回答关键词
        const used = new Set(
          planning.questions.map((q) => q.sourceQuestionId).filter((x): x is string => Boolean(x)),
        );
        const bank = await recallForSession(planning, used);
        const r = await generatePhase2(planning, ctxOf(), bank.candidates);
        if (!r.ok || !r.questions.length) throw new Error(r.error || '未返回深挖题');
        const planned = enrichFromBank(r.questions);
        const questions = [...planning.questions, ...planned];
        const first = planned[0];
        await persist(
          {
            ...planning,
            questions,
            currentQuestionId: first.id,
            status: 'running',
            phase: 2,
            flags: {
              ...planning.flags,
              bankRecall: planning.flags?.bankRecall
                ? { ...planning.flags.bankRecall, phase2Candidates: bank.info?.candidates || 0 }
                : null,
              bankHits: countBankHits(questions),
            },
          },
          true,
        );
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        // 不静默跳过：标注「本轮未能生成针对简历的深挖题」，用阶段一的题继续，直接进反问
        set({ error: `阶段二生成失败（${msg}）。可继续完成反问后查看报告。` });
        await persist(
          { ...planning, status: 'reverse', phase: 3, flags: { ...planning.flags, phase2Unavailable: true } },
          true,
        );
      } finally {
        set({ busy: '' });
      }
      return;
    }

    await persist({ ...s, status: 'reverse', phase: 3, pendingProbe: null }, true);
  };

  /** 把一次裁决结果落到 attempt，并按裁决推进 */
  const applyAdvance = async (
    s: MockSession,
    question: MockQuestion,
    attemptId: string,
    res: Awaited<ReturnType<typeof advance>>,
  ): Promise<void> => {
    let attempts = s.attempts.map((a) =>
      a.id === attemptId
        ? { ...a, evidenceState: res.evidenceState, evidenceSource: res.evidenceSource }
        : a,
    );
    let questions = s.questions;

    if (res.action === 'followup' && res.probe) {
      const probes = (latestAttempt({ ...s, attempts }, question.id)?.probes || []).slice();
      const current = latestAttempt({ ...s, attempts }, question.id);
      // 同一 attempt 上最多 2 轮：超出后强制推进
      if (current && probes.length >= 2) {
        await goNext({ ...s, attempts, questions, pendingProbe: null });
        return;
      }
      await persist({
        ...s,
        attempts,
        questions,
        pendingProbe: { question: res.probe, askedAt: Date.now() },
        status: 'running',
      });
      return;
    }

    // 插题：插在当前题之后，作为下一题（每阶段 ≤1、全场 ≤2）
    if (res.inject && canInject({ ...s, questions }, question.phase)) {
      const curIdx = questions.findIndex((q) => q.id === question.id);
      const injected: MockQuestion = { ...res.inject, kind: 'injected', injectedFrom: question.id };
      questions = [...questions.slice(0, curIdx + 1), injected, ...questions.slice(curIdx + 1)];
    }

    await goNext({ ...s, attempts, questions, pendingProbe: null });
  };

  return {
    list: [],
    usage: { count: 0, bytes: 0 },
    session: null,
    tab: 'interview',
    busy: '',
    error: '',
    notice: '',
    rewrites: {},

    refreshList: async () => {
      const r = await listMockSessions();
      if (r.ok) set({ list: r.sessions });
      else set({ error: r.error || '读取面试记录失败' });
    },

    refreshUsage: async () => {
      const r = await mockInterviewUsage();
      if (r.ok) set({ usage: { count: r.count, bytes: r.bytes } });
    },

    setTab: (tab) => set({ tab }),
    clearError: () => set({ error: '' }),
    clearNotice: () => set({ notice: '' }),

    newDraft: (job) => {
      const jm = job?.jobMeta;
      const draft = createDraftSession({
        jobId: job?.jobId ?? (jm?.jobId ? String(jm.jobId) : null),
        jobTitle: job?.jobTitle ?? jm?.title ?? '',
        company: job?.company ?? jm?.company ?? '',
        jdText: job?.jdText ?? jm?.description ?? '',
      });
      set({ session: draft, tab: 'interview', error: '', notice: '', rewrites: {} });
    },

    openSession: async (id) => {
      set({ busy: 'list' });
      try {
        const r = await readMockSession(id);
        if (!r.ok || !r.session) {
          set({ error: r.error || '会话不存在或已损坏' });
          return;
        }
        set({ session: r.session, tab: 'interview', error: '', notice: '', rewrites: {} });
      } finally {
        set({ busy: '' });
      }
    },

    removeSession: async (id) => {
      const r = await deleteMockSession(id);
      if (!r.ok) { set({ error: r.error || '删除失败' }); return; }
      if (get().session?.id === id) set({ session: null });
      await get().refreshList();
      await get().refreshUsage();
    },

    clearAllSessions: async () => {
      const r = await clearMockSessions();
      if (!r.ok) { set({ error: r.error || '清空失败' }); return; }
      set({ session: null, list: [], usage: { count: 0, bytes: 0 }, notice: '已清空全部面试记录' });
      await get().refreshList();
      await get().refreshUsage();
    },

    exportAll: async () => {
      const r = await exportMockSessions();
      if (!r.ok) {
        if (!r.canceled) set({ error: r.error || '导出失败' });
        return;
      }
      set({ notice: `已导出 ${r.count || 0} 场面试记录` });
    },

    updateJob: (patch) => {
      const s = get().session;
      if (!s) return;
      void persist({ ...s, job: { ...s.job, ...patch } });
    },

    updateConfig: (patch) => {
      const s = get().session;
      if (!s) return;
      const next: MockInterviewConfig = { ...s.config, ...patch };
      next.phase1Count = Math.min(6, Math.max(4, Number(next.phase1Count) || 4));
      next.phase2Count = Math.min(4, Math.max(3, Number(next.phase2Count) || 3));
      next.speechRate = Math.min(1.2, Math.max(0.9, Number(next.speechRate) || 1));
      void persist({ ...s, config: next });
    },

    startInterview: async () => {
      const s = get().session;
      if (!s) return;
      if (!hasApiKey()) {
        set({ error: '模拟面试需要 AI 出题与评分，请先在「设置 → AI / LLM 配置」填写 API Key（本功能不接 agent 代答）。' });
        return;
      }
      if (!String(s.job.jobTitle || '').trim()) { set({ error: '请先填写岗位名称' }); return; }
      if (String(s.job.jdText || '').trim().length < 30) {
        set({ error: 'JD 太短（少于 30 字）。模拟面试需要 JD 才能出针对性题目，可直接粘贴岗位描述。' });
        return;
      }
      set({ busy: 'recall', error: '' });
      try {
        // 先召回候选（本地 BM25，不新增 AI 调用），再和出题合并成同一次调用
        const bank = await recallForSession(s, new Set());
        set({ busy: 'phase1' });
        const r = await generatePhase1(s, ctxOf(), bank.candidates);
        const questions = enrichFromBank(r.questions);
        const next: MockSession = {
          ...s,
          questions,
          currentQuestionId: questions[0]?.id || null,
          status: questions.length ? 'ready' : 'draft',
          phase: 1,
          attempts: [],
          report: null,
          reverse: null,
          retry: null,
          startedAt: Date.now(),
          flags: r.localFallback
            ? { localFallback: true, bankRecall: bank.info, bankHits: countBankHits(questions) }
            : { bankRecall: bank.info, bankHits: countBankHits(questions) },
        };
        if (r.localFallback) {
          set({ error: `AI 出题失败（${r.error || '未知原因'}），已使用本地通用题。本场不针对你的岗位与简历，阶段二深挖也会跳过。` });
        }
        await persist(next, true);
        await get().refreshList();
      } finally {
        set({ busy: '' });
      }
    },

    beginAnswering: () => {
      const s = get().session;
      if (!s) return;
      void persist({ ...s, status: 'running', startedAt: s.startedAt || Date.now() }, true);
    },

    goReverse: async () => {
      const s = get().session;
      if (!s) return;
      await persist({ ...s, status: 'reverse', phase: 3, pendingProbe: null }, true);
    },

    submitAnswer: async (answer, durationMs, delivery) => {
      const s = get().session;
      if (!s) return;
      const text = String(answer || '').trim();
      if (!text) { set({ error: '回答不能为空（不会答可以点「跳过这题」）' }); return; }

      const ctx = ctxOf();

      // ===== 报告态重答：只重算该题 =====
      if (s.retry) {
        const qid = s.retry.questionId;
        const question = s.questions.find((q) => q.id === qid);
        if (!question) return;
        const attempt = {
          id: uid('att'),
          questionId: qid,
          answer: text,
          probes: [],
          skipped: false,
          submittedAt: Date.now(),
          durationMs,
          delivery,
        };
        const withAttempt: MockSession = { ...s, attempts: [...s.attempts, attempt], retry: null, status: 'running' };
        set({ busy: 'rescore' });
        await persist(withAttempt, true);
        try {
          const r = await rescoreAnswer(withAttempt, qid, ctx);
          const base = withAttempt.report;
          if (r.ok && r.result && base) {
            const questions = base.questions.map((q) => (q.questionId === qid ? r.result! : q));
            const report: MockReport = aggregateReport(
              questions,
              { deliveryAdvice: base.deliveryAdvice, summary: base.summary },
              base.reverse,
              true,
            );
            const done: MockSession = {
              ...withAttempt,
              report,
              status: 'finished',
              finishedAt: withAttempt.finishedAt || Date.now(),
            };
            await persist(applyReportToAttempts(done, report), true);
            set({ notice: '已重答并重新评分（其他题分数不变）' });
          } else {
            set({ error: `重答已记录，但重新评分失败：${r.error || '未知原因'}` });
            await persist({ ...withAttempt, status: 'finished' }, true);
          }
        } finally {
          set({ busy: '' });
        }
        await get().refreshList();
        return;
      }

      // ===== 追问补答 =====
      if (s.pendingProbe) {
        const qid = s.currentQuestionId;
        const question = s.questions.find((q) => q.id === qid);
        if (!qid || !question) return;
        set({ busy: 'advance' });
        try {
          const att = latestAttempt(s, qid);
          if (!att) return;
          const probes = (att.probes || []).map((p) => ({ ...p }));
          const last = probes[probes.length - 1];
          if (last && !last.answer) {
            last.answer = text;
            last.answeredAt = Date.now();
          } else {
            probes.push({ id: uid('prb'), question: s.pendingProbe.question, answer: text, askedAt: s.pendingProbe.askedAt, answeredAt: Date.now() });
          }
          const attempts = s.attempts.map((a) => (a.id === att.id ? { ...a, probes } : a));
          const base: MockSession = { ...s, attempts, pendingProbe: null };

          // 已用满 2 轮 → 不再裁决，直接推进
          if (probes.length >= 2) {
            await goNext(base);
            return;
          }
          const res = await advance(base, question, att.answer, probes, ctx, { allowInject: canInject(base, question.phase) });
          await applyAdvance(base, question, att.id, res);
        } finally {
          set({ busy: '' });
        }
        return;
      }

      // ===== 主答 =====
      const qid = s.currentQuestionId;
      const question = s.questions.find((q) => q.id === qid);
      if (!qid || !question) return;
      set({ busy: 'advance', error: '' });
      try {
        const attempt = {
          id: uid('att'),
          questionId: qid,
          answer: text,
          probes: [],
          skipped: false,
          submittedAt: Date.now(),
          durationMs,
          // 语音作答才有：与内容分分开存，报告里单独展示
          delivery,
        };
        const base: MockSession = { ...s, attempts: [...s.attempts, attempt], pendingProbe: null };
        await persist(base);
        const res = await advance(base, question, text, [], ctx, { allowInject: canInject(base, question.phase) });
        await applyAdvance(base, question, attempt.id, res);
      } finally {
        set({ busy: '' });
      }
    },

    skipQuestion: async () => {
      const s = get().session;
      if (!s || !s.currentQuestionId) return;
      const attempt = {
        id: uid('att'),
        questionId: s.currentQuestionId,
        answer: '',
        probes: [],
        skipped: true,
        submittedAt: Date.now(),
      };
      await persist({ ...s, attempts: [...s.attempts, attempt], pendingProbe: null });
      await goNext({ ...s, attempts: [...s.attempts, attempt], pendingProbe: null });
    },

    submitReverse: async (question) => {
      const s = get().session;
      if (!s) return;
      const q = String(question || '').trim();
      if (!q) { set({ error: '请输入你想反问的问题，或直接点「跳过反问」' }); return; }
      set({ busy: 'reverse' });
      try {
        const r = await answerReverse(s, q, ctxOf());
        if (!r.ok || !r.turn) {
          set({ error: `反问环节失败：${r.error || '未知原因'}。可直接跳过，不影响分数。` });
          return;
        }
        await persist({ ...s, reverse: r.turn }, true);
      } finally {
        set({ busy: '' });
      }
    },

    finishInterview: async () => {
      const s = get().session;
      if (!s) return;
      if (!hasApiKey()) {
        set({ error: '评分需要 AI，请先在设置页配置 API Key。' });
        return;
      }
      set({ busy: 'report', error: '' });
      const reporting: MockSession = { ...s, status: 'reporting', pendingProbe: null, retry: null };
      await persist(reporting, true);
      try {
        const r = await buildReport(reporting, ctxOf());
        const report = r.report;
        if (!r.ok) {
          set({ error: `评分失败（${r.error || '未知原因'}）。本场只保留转写，不显示分数。` });
        }
        // 降级标记必须写进报告（不静默跳过深挖环节）
        if (reporting.flags?.phase2Unavailable) {
          report.summary.advice = ['本轮未能生成针对简历的深挖题，报告只覆盖阶段一。', ...report.summary.advice].slice(0, 4);
        }
        if (reporting.flags?.localFallback) {
          report.summary.advice = ['本场使用本地通用题（非针对该岗位），分数仅供参考。', ...report.summary.advice].slice(0, 4);
        }
        const finished: MockSession = {
          ...reporting,
          report,
          status: 'finished',
          finishedAt: Date.now(),
        };
        await persist(applyReportToAttempts(finished, report), true);
      } finally {
        set({ busy: '' });
      }
      await get().refreshList();
      await get().refreshUsage();
    },

    retryQuestion: (questionId) => {
      const s = get().session;
      if (!s) return;
      void persist({ ...s, retry: { questionId, startedAt: Date.now() } }, true);
    },

    rewriteCurrent: async (questionId) => {
      const s = get().session;
      if (!s) return;
      set({ busy: 'rewrite', error: '' });
      try {
        const r = await rewriteAnswer(s, questionId, ctxOf());
        const gaps = r.gaps || [];
        set({
          rewrites: {
            ...get().rewrites,
            [questionId]: { text: r.ok && r.rewritten ? r.rewritten : '', gaps, blocked: Boolean(r.blocked) },
          },
        });
        if (!r.ok) {
          set({ error: r.error ? `改写未通过校验：${r.error}` : '改写失败' });
        }
      } finally {
        set({ busy: '' });
      }
    },

    backToConfig: () => {
      const s = get().session;
      if (!s) return;
      // 未开始的草稿回到配置态；已产生的会话保持原状态（历史仍可从栏②打开）
      set({ session: s.status === 'draft' || s.status === 'ready' ? { ...s, status: 'draft', questions: [], currentQuestionId: null } : s });
    },

    discardSession: async () => {
      const s = get().session;
      if (!s) return;
      if (s.status !== 'draft' && s.attempts.length > 0) {
        await get().removeSession(s.id);
      }
      set({ session: null, rewrites: {} });
    },

    clearAllData: async () => {
      const r = await clearMockInterviewAll();
      if (!r.ok) { set({ error: r.error || '清空失败' }); return; }
      set({ session: null, list: [], usage: { count: 0, bytes: 0 } });
    },
  };
});
