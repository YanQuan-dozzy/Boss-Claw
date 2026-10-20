// 题库状态：注册表 / 题目 / BM25 索引 / 导入（P3）
//
// 索引只在需要时构建（进题库 Tab 或发起面试），构建结果：
//   · 进程内缓存（模块级，切页不重建）；
//   · 落盘缓存 <userData>/mock-interview/bank/index.cache.json（键 = 题库指纹，可删）。
// 缓存只存 postings/lens/df/ids，不存题干与答案——题干从已加载的题库里按 id 回填，
// 避免把 11MB 的内置库在缓存里再抄一份。

import { create } from 'zustand';
import { electronApi } from '@/lib/electronApi';
import {
  BANK_DIRECTION_LABELS,
  bankFingerprint,
  buildIndex,
  buildRecallQuery,
  recall as runRecall,
  type BankMeta,
  type BankQuestion,
  type BankDirection,
  type Bm25Index,
  type IndexInput,
  type RecallResult,
} from '@/lib/bossclaw/mockInterviewBank';

interface SerializedIndex {
  v: 1;
  fingerprint: string;
  ids: string[];
  bankIds: string[];
  lens: number[];
  df: Array<[string, number]>;
  postings: Array<[string, Array<[number, number]>]>;
}

export interface BankIndexInfo {
  fingerprint: string;
  count: number;
  buildMs: number;
  /** 本次索引来源：命中磁盘缓存 / 现场重建 */
  source: 'cache' | 'built' | 'none';
  builtAt: number;
}

interface BankState {
  banks: BankMeta[];
  activeBankId: string | null;
  questions: Record<string, BankQuestion[]>;
  indexInfo: BankIndexInfo;
  loading: boolean;
  busy: string;
  error: string;
  notice: string;

  refreshBanks: () => Promise<void>;
  selectBank: (bankId: string) => Promise<void>;
  ensureIndex: (opts?: { force?: boolean }) => Promise<BankIndexInfo>;
  clearCache: () => Promise<void>;

  createBank: (name: string) => Promise<BankMeta | null>;
  renameBank: (bankId: string, name: string) => Promise<boolean>;
  deleteBank: (bankId: string) => Promise<boolean>;
  toggleBank: (bankId: string, enabled: boolean) => Promise<void>;
  restoreBuiltin: () => Promise<void>;

  addQuestion: (bankId: string, q: Partial<BankQuestion>) => Promise<boolean>;
  updateQuestion: (bankId: string, questionId: string, patch: Partial<BankQuestion>) => Promise<boolean>;
  deleteQuestion: (bankId: string, questionId: string) => Promise<void>;

  /** 写入已准备好的导入题目（校验与去重在 UI 层完成） */
  writeImport: (bankId: string, questions: BankQuestion[], mode: 'append' | 'replace') => Promise<boolean>;

  recall: (opts: {
    jobTitle?: string;
    roleLabel?: string;
    difficultyLabel?: string;
    jdText?: string;
    skills?: string[];
    directions?: BankDirection[];
    difficulty?: 'basic' | 'standard' | 'stress' | null;
    excludeIds?: Set<string>;
    topK?: number;
  }) => Promise<RecallResult | null>;

  reset: () => void;
}

let indexCache: Bm25Index | null = null;
let indexDocs = new Map<string, BankQuestion>();
let building: Promise<BankIndexInfo> | null = null;

function serialize(index: Bm25Index): string {
  const data: SerializedIndex = {
    v: 1,
    fingerprint: index.fingerprint,
    ids: index.docs.map((q) => q.id),
    bankIds: index.bankIds,
    lens: index.lens,
    df: [...index.df.entries()],
    postings: [...index.postings.entries()].map(([term, list]) => [
      term,
      list.map((p) => [p.d, p.tf] as [number, number]),
    ]),
  };
  return JSON.stringify(data);
}

function hydrate(text: string, docs: Map<string, BankQuestion>, fingerprint: string): Bm25Index | null {
  try {
    const data = JSON.parse(text) as SerializedIndex;
    if (!data || data.v !== 1 || data.fingerprint !== fingerprint) return null;
    if (!Array.isArray(data.ids) || data.ids.length !== data.lens.length) return null;
    const ordered: BankQuestion[] = [];
    for (const id of data.ids) {
      const q = docs.get(id);
      if (!q) return null;
      ordered.push(q);
    }
    const totalLen = data.lens.reduce((s, x) => s + x, 0);
    return {
      fingerprint,
      docs: ordered,
      bankIds: data.bankIds,
      lens: data.lens,
      avgdl: ordered.length ? totalLen / ordered.length : 0,
      df: new Map(data.df),
      postings: new Map(data.postings.map(([term, list]) => [term, list.map(([d, tf]) => ({ d, tf }))])),
      builtAt: Date.now(),
      buildMs: 0,
    };
  } catch {
    return null;
  }
}

export const useBankStore = create<BankState>()((set, get) => ({
  banks: [],
  activeBankId: null,
  questions: {},
  indexInfo: { fingerprint: '', count: 0, buildMs: 0, source: 'none', builtAt: 0 },
  loading: false,
  busy: '',
  error: '',
  notice: '',

  refreshBanks: async () => {
    set({ loading: true });
    const r = await electronApi.mockInterview.bankList();
    if (!r.ok) {
      set({ loading: false, error: r.error || '读取题库失败' });
      return;
    }
    const banks = r.banks;
    const active = get().activeBankId && banks.some((b) => b.id === get().activeBankId)
      ? get().activeBankId
      : banks.find((b) => b.type === 'builtin')?.id || banks[0]?.id || null;
    set({ banks, activeBankId: active, loading: false, error: '' });
    if (active && !get().questions[active]) await get().selectBank(active);
  },

  selectBank: async (bankId) => {
    set({ activeBankId: bankId });
    if (get().questions[bankId]) return;
    set({ busy: 'load-bank' });
    const r = await electronApi.mockInterview.bankRead(bankId);
    set((s) => ({
      busy: '',
      questions: { ...s.questions, [bankId]: r.ok ? r.questions : [] },
      error: r.ok ? '' : r.error || '读取题库失败',
    }));
  },

  ensureIndex: async (opts = {}) => {
    if (building) return building;
    // 用户可能从工作台直接发起面试、从没打开过题库 Tab：注册表为空时先加载，
    // 否则会「静默地不使用题库」（配置页写着启用，实际没召回）。
    if (!get().banks.length) await get().refreshBanks();
    const state = get();
    const enabled = state.banks.filter((b) => b.enabled);
    const fingerprint = bankFingerprint(enabled);
    if (!opts.force && indexCache && indexCache.fingerprint === fingerprint) {
      return { ...state.indexInfo, count: indexCache.docs.length, source: 'cache' };
    }
    if (!enabled.length) {
      indexCache = null;
      const info: BankIndexInfo = { fingerprint, count: 0, buildMs: 0, source: 'none', builtAt: Date.now() };
      set({ indexInfo: info });
      return info;
    }

    building = (async () => {
      set({ busy: 'build-index' });
      // 让「正在构建题库索引…」先渲染出来，再开始同步切词
      await new Promise((r) => setTimeout(r, 30));
      try {
        const docs = new Map<string, BankQuestion>();
        const inputs: IndexInput[] = [];
        for (const bank of enabled) {
          let qs = get().questions[bank.id];
          if (!qs) {
            const r = await electronApi.mockInterview.bankRead(bank.id);
            if (!r.ok) continue;
            qs = r.questions;
            set((s) => ({ questions: { ...s.questions, [bank.id]: r.questions } }));
          }
          for (const q of qs) {
            docs.set(q.id, q);
            inputs.push({ question: q, bankId: bank.id });
          }
        }

        let index: Bm25Index | null = null;
        let sourceInfo: BankIndexInfo['source'] = 'built';
        if (!opts.force) {
          const cached = await electronApi.mockInterview.bankCacheRead();
          if (cached.ok && cached.data) index = hydrate(cached.data, docs, fingerprint);
          if (index) sourceInfo = 'cache';
        }
        if (!index) index = buildIndex(inputs, fingerprint);

        indexCache = index;
        indexDocs = docs;
        const info: BankIndexInfo = {
          fingerprint,
          count: index.docs.length,
          buildMs: index.buildMs,
          source: sourceInfo,
          builtAt: Date.now(),
        };
        set({ indexInfo: info, busy: '' });

        // 落盘只在现场重建时做；命中缓存当然不用再写
        if (sourceInfo === 'built' && inputs.length > 0) {
          void electronApi.mockInterview.bankCacheWrite(serialize(index));
        }
        return info;
      } catch (e) {
        set({ busy: '', error: `题库索引构建失败：${(e as Error).message}` });
        return { fingerprint, count: 0, buildMs: 0, source: 'none', builtAt: Date.now() } as BankIndexInfo;
      } finally {
        building = null;
      }
    })();
    return building;
  },

  clearCache: async () => {
    await electronApi.mockInterview.bankCacheClear();
    indexCache = null;
    await get().ensureIndex({ force: true });
  },

  createBank: async (name) => {
    set({ busy: 'create-bank', error: '' });
    const r = await electronApi.mockInterview.bankCreate(name);
    set({ busy: '' });
    if (!r.ok || !r.bank) {
      set({ error: r.error || '新建题库失败' });
      return null;
    }
    await get().refreshBanks();
    await get().selectBank(r.bank.id);
    set({ notice: `已新建题库「${r.bank.name}」` });
    return r.bank;
  },

  renameBank: async (bankId, name) => {
    const r = await electronApi.mockInterview.bankRename(bankId, name);
    if (!r.ok) {
      set({ error: r.error || '重命名失败' });
      return false;
    }
    await get().refreshBanks();
    return true;
  },

  deleteBank: async (bankId) => {
    const r = await electronApi.mockInterview.bankDelete(bankId);
    if (!r.ok) {
      set({ error: r.error || '删除题库失败' });
      return false;
    }
    set((s) => {
      const questions = { ...s.questions };
      delete questions[bankId];
      return { questions, activeBankId: s.activeBankId === bankId ? null : s.activeBankId };
    });
    indexCache = null;
    await get().refreshBanks();
    return true;
  },

  toggleBank: async (bankId, enabled) => {
    const r = await electronApi.mockInterview.bankToggle(bankId, enabled);
    if (!r.ok) {
      set({ error: r.error || '切换题库失败' });
      return;
    }
    indexCache = null;
    set((s) => ({
      banks: s.banks.map((b) => (b.id === bankId ? { ...b, enabled } : b)),
      indexInfo: { ...s.indexInfo, source: 'none' },
    }));
  },

  restoreBuiltin: async () => {
    const r = await electronApi.mockInterview.bankRestoreBuiltin();
    if (!r.ok) {
      set({ error: r.error || '恢复内置题库失败' });
      return;
    }
    indexCache = null;
    await get().refreshBanks();
    set({ notice: '内置题库已恢复' });
  },

  addQuestion: async (bankId, q) => {
    set({ busy: 'add-question', error: '' });
    const r = await electronApi.mockInterview.bankAddQuestion(bankId, q);
    set({ busy: '' });
    if (!r.ok) {
      set({ error: r.error || '新增题目失败' });
      return false;
    }
    await refreshBankQuestions(set, get, bankId);
    indexCache = null;
    await get().ensureIndex({ force: true });
    set({ notice: '已新增 1 道题，索引已重建' });
    return true;
  },

  updateQuestion: async (bankId, questionId, patch) => {
    set({ busy: 'update-question', error: '' });
    const r = await electronApi.mockInterview.bankUpdateQuestion(bankId, questionId, patch);
    set({ busy: '' });
    if (!r.ok) {
      set({ error: r.error || '保存题目失败' });
      return false;
    }
    await refreshBankQuestions(set, get, bankId);
    indexCache = null;
    await get().ensureIndex({ force: true });
    return true;
  },

  deleteQuestion: async (bankId, questionId) => {
    const r = await electronApi.mockInterview.bankDeleteQuestion(bankId, questionId);
    if (!r.ok) {
      set({ error: r.error || '删除题目失败' });
      return;
    }
    await refreshBankQuestions(set, get, bankId);
    indexCache = null;
    await get().ensureIndex({ force: true });
  },

  writeImport: async (bankId, questions, mode) => {
    set({ busy: 'import', error: '' });
    // 一次 IPC 写入：主进程用 tmp + rename 原子落盘，中途失败不会留下半份题库。
    // （不要分块：分块会在第 N 块失败时留下前 N-1 块，违反「失败即保持导入前状态」。）
    try {
      const r = await electronApi.mockInterview.bankImport(bankId, questions, mode);
      if (!r.ok) throw new Error(r.error || '写入失败');
      await refreshBankQuestions(set, get, bankId);
      indexCache = null;
      await get().ensureIndex({ force: true });
      set({ busy: '', notice: `已导入 ${questions.length} 道题，索引已重建` });
      return true;
    } catch (e) {
      set({ busy: '', error: (e as Error).message });
      return false;
    }
  },

  recall: async (opts) => {
    const info = await get().ensureIndex();
    if (!indexCache || !info.count) return null;
    const query = buildRecallQuery(opts);
    const enabledIds = get().banks.filter((b) => b.enabled).map((b) => b.id);
    const result = runRecall(indexCache, {
      queryText: query,
      topK: opts.topK ?? 20,
      directions: opts.directions,
      difficulty: opts.difficulty ?? null,
      excludeIds: opts.excludeIds,
      enabledBankIds: enabledIds,
    });
    return result;
  },

  reset: () => {
    indexCache = null;
    indexDocs = new Map();
    building = null;
    set({
      banks: [],
      activeBankId: null,
      questions: {},
      indexInfo: { fingerprint: '', count: 0, buildMs: 0, source: 'none', builtAt: 0 },
      error: '',
      notice: '',
    });
  },
}));

async function refreshBankQuestions(
  set: (fn: (s: BankState) => Partial<BankState>) => void,
  get: () => BankState,
  bankId: string,
): Promise<void> {
  const r = await electronApi.mockInterview.bankRead(bankId);
  if (!r.ok) return;
  set((s) => ({ questions: { ...s.questions, [bankId]: r.questions } }));
  // 注册表里的条数也要跟着更新
  const list = await electronApi.mockInterview.bankList();
  if (list.ok) set(() => ({ banks: list.banks }));
  void get;
}

/** 供出题侧使用：不依赖 React 生命周期 */
export function recallCandidates(opts: Parameters<BankState['recall']>[0]): Promise<RecallResult | null> {
  return useBankStore.getState().recall(opts);
}

export function indexSnapshot(): { index: Bm25Index | null; docs: Map<string, BankQuestion> } {
  return { index: indexCache, docs: indexDocs };
}

export const BANK_DIRECTION_OPTIONS = (Object.keys(BANK_DIRECTION_LABELS) as BankDirection[]).map((k) => ({
  value: k,
  label: BANK_DIRECTION_LABELS[k],
}));
