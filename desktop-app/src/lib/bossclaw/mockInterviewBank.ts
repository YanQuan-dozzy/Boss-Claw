// 模拟面试题库：切词 / BM25 召回 / 去重 / 自动分类（纯本地、零依赖、确定性）
//
// 为什么不用分词器：jieba 词典几 MB，且覆盖不到「跨域」「幂等」「Service Mesh」这类术语，
// 用户还会自己导入更偏的词。这里用「字符 bigram + 单字（0.3 权重）+ 英文/数字整词」的混合切分：
//   · 不需要任何词典，不会因为生僻技术名词失效；
//   · 对 10–30 字的题干已经足够精确；
//   · 代价是索引比词级倒排大 2–3 倍（16K 题可接受）。
//
// 召回是确定性的（BM25），「从候选里挑哪几道」交给同一次出题调用里的 LLM——
// 不新增调用、不新增嵌入模型、不新增启动时构建的向量索引。

import type { MockDifficulty, MockQuestionCategory } from './mockInterviewTypes';

export type BankDirection =
  | 'frontend'
  | 'backend'
  | 'algorithm'
  | 'data'
  | 'product'
  | 'test'
  | 'ops'
  | 'general';

export type BankType = 'builtin' | 'imported' | 'custom';

export const BANK_DIRECTIONS: BankDirection[] = [
  'frontend',
  'backend',
  'algorithm',
  'data',
  'product',
  'test',
  'ops',
  'general',
];

export const BANK_DIRECTION_LABELS: Record<BankDirection, string> = {
  frontend: '前端',
  backend: '后端',
  algorithm: '算法',
  data: '数据',
  product: '产品',
  test: '测试',
  ops: '运维',
  general: '通用',
};

export const BANK_TYPE_LABELS: Record<BankType, string> = {
  builtin: '内置',
  imported: '导入',
  custom: '自建',
};

export const BANK_DIFFICULTY_LABELS: Record<MockDifficulty, string> = {
  basic: '基础',
  standard: '标准',
  stress: '压力',
};

export const BANK_CATEGORY_LABELS: Record<MockQuestionCategory, string> = {
  icebreak: '破冰',
  fundamental: '专业基础',
  project: '项目深挖',
  behavior: '行为',
  closing: '收尾',
};

/** 题库题目（题库文件里就是这个形状，运行时再加 bankId） */
export interface BankQuestion {
  id: string;
  /** 读取时由仓储补上；题库文件里不存（避免每个文件重复自己的 id） */
  bankId?: string;
  text: string;
  /** 参考答案：只在本地点开时折叠展示，**永远不进提示词** */
  answer?: string;
  directions: BankDirection[];
  difficulty: MockDifficulty;
  category: MockQuestionCategory;
  tags: string[];
  focus?: string[];
  keyPoints?: string[];
  createdAt?: number;
}

export interface BankMeta {
  id: string;
  name: string;
  type: BankType;
  enabled: boolean;
  license: string;
  source: string;
  count: number;
  bytes: number;
  mtime: number;
  /** 内置库的来源版本（用于「恢复默认」判断） */
  version?: string;
  /** 内置库随包文件名 */
  file?: string;
}

/** 出题提示词里的候选（只带必要信息，不带答案与要点全文） */
export interface BankCandidate {
  id: string;
  bankId: string;
  text: string;
  directions: BankDirection[];
  difficulty: MockDifficulty;
  category: MockQuestionCategory;
  tags: string[];
  keyPointCount: number;
}

// ===== 文本归一化 =====

/** 全角 → 半角，便于英文术语与数字匹配 */
export function toHalfWidth(text: string): string {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 题干归一化（精确去重口径）：全角转半角、英文小写、去掉空白与标点符号。
 * 只用于比较，不用于展示。
 */
export function normalizeQuestionText(text: string): string {
  return toHalfWidth(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 300);
}

/** 去重用的 SHA-1（同步实现，避免为了一个 hash 引入依赖或 async） */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j += 1) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j += 1) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** 题库指纹：任一题库的 id/mtime/条数变化 → 索引缓存失效 */
export function bankFingerprint(banks: Array<Pick<BankMeta, 'id' | 'mtime' | 'count'>>): string {
  const key = banks
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((b) => `${b.id}:${b.mtime}:${b.count}`)
    .join('|');
  return sha1Hex(key);
}

// ===== 切词 =====

/** 只处理高频虚词：表要小、可解释，不做「智能停用词」 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '一个', '我们', '你们', '他们',
  '这个', '那个', '什么', '怎么', '如何', '为什么', '可以', '需要', '进行', '以及',
  '对于', '如果', '因为', '所以', '但是', '而且', '还是', '就是', '这样', '那样',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'how', 'what', 'why',
]);

const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[a-z0-9_+#.]/;

export interface Token {
  term: string;
  /** bigram / 英文整词 = 1；单字 = 0.3（单字召回太泛，但完全丢掉会让两字词后半段失配时召回不到） */
  weight: number;
}

/** 混合切词：中文 bigram + 单字，英文/数字整词（小写） */
export function tokenize(text: string): Token[] {
  const s = toHalfWidth(text).toLowerCase();
  const out: Token[] = [];
  let cjkRun = '';
  let latinRun = '';

  const flushCjk = () => {
    if (!cjkRun) return;
    const run = cjkRun;
    cjkRun = '';
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      if (!STOPWORDS.has(ch)) out.push({ term: ch, weight: 0.3 });
      if (i + 1 < run.length) {
        const bi = run.slice(i, i + 2);
        if (!STOPWORDS.has(bi)) out.push({ term: bi, weight: 1 });
      }
    }
  };
  const flushLatin = () => {
    if (!latinRun) return;
    const w = latinRun;
    latinRun = '';
    if (w.length >= 2 && !STOPWORDS.has(w)) out.push({ term: w, weight: 1 });
  };

  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (LATIN_RE.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return out;
}

// ===== BM25 索引 =====

const K1 = 1.2;
const B = 0.75;

interface Posting {
  /** 文档下标 */
  d: number;
  /** 词频 */
  tf: number;
}

export interface Bm25Index {
  fingerprint: string;
  docs: BankQuestion[];
  bankIds: string[];
  /** 文档长度（token 数） */
  lens: number[];
  avgdl: number;
  df: Map<string, number>;
  postings: Map<string, Posting[]>;
  builtAt: number;
  buildMs: number;
}

export interface IndexInput {
  question: BankQuestion;
  bankId: string;
}

/** 建索引：只切题干，**不切答案**——答案不进提示词，也不该影响召回 */
export function buildIndex(items: IndexInput[], fingerprint: string): Bm25Index {
  const t0 = Date.now();
  const docs: BankQuestion[] = [];
  const bankIds: string[] = [];
  const lens: number[] = [];
  const df = new Map<string, number>();
  const postings = new Map<string, Posting[]>();
  let totalLen = 0;

  items.forEach((item) => {
    const idx = docs.length;
    docs.push(item.question);
    bankIds.push(item.bankId);
    const tokens = tokenize(item.question.text);
    lens.push(tokens.length);
    totalLen += tokens.length;

    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t.term, (tfMap.get(t.term) || 0) + 1);

    tfMap.forEach((tf, term) => {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push({ d: idx, tf });
      df.set(term, (df.get(term) || 0) + 1);
    });
  });

  const n = docs.length;
  return {
    fingerprint,
    docs,
    bankIds,
    lens,
    avgdl: n ? totalLen / n : 0,
    df,
    postings,
    builtAt: Date.now(),
    buildMs: Date.now() - t0,
  };
}

export interface RecallOptions {
  queryText: string;
  topK?: number;
  /** 方向过滤（命中任一即可；'general' 恒命中）；空数组 = 不过滤 */
  directions?: BankDirection[];
  difficulty?: MockDifficulty | null;
  /** 本场已用过的题库题 id */
  excludeIds?: Set<string> | string[];
  /** 只允许这些题库参与 */
  enabledBankIds?: string[] | Set<string>;
}

export interface RecallResult {
  candidates: BankCandidate[];
  /** 过滤条件导致 0 条时放宽过（先放宽难度，再放宽方向），UI/日志要能解释 */
  relaxed: boolean;
  /** 索引里参与本次召回的题目数 */
  poolSize: number;
  tookMs: number;
}

/** 长术语短语加成：连续 2 个 bigram（3 字）→ ×1.2，3 个及以上（≥4 字）→ ×1.5 */
function phraseBoost(query: string, docText: string): number {
  const q = toHalfWidth(query).toLowerCase();
  const d = toHalfWidth(docText).toLowerCase();
  let boost = 1;
  // 只在中文连续片段上找最长命中，最多看 8 字窗口（再长对短题干没有意义）
  const runs = q.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    for (let len = Math.min(8, run.length); len >= 3; len -= 1) {
      let hit = false;
      for (let i = 0; i + len <= run.length; i += 1) {
        if (d.includes(run.slice(i, i + len))) {
          hit = true;
          break;
        }
      }
      if (hit) {
        boost = Math.max(boost, len >= 4 ? 1.5 : 1.2);
        break;
      }
    }
  }
  return boost;
}

/**
 * BM25 召回。过滤是**软**的：方向/难度过滤后为 0 条时自动放宽并标记 relaxed，
 * 避免因为题库分类是启发式的（内置库没有人工标注）而把整场面试的候选清空。
 */
export function recall(index: Bm25Index, opts: RecallOptions): RecallResult {
  const t0 = Date.now();
  const topK = Math.max(1, Math.min(50, Number(opts.topK) || 20));
  const exclude = opts.excludeIds instanceof Set ? opts.excludeIds : new Set(opts.excludeIds || []);
  const allowedBanks =
    opts.enabledBankIds instanceof Set
      ? opts.enabledBankIds
      : opts.enabledBankIds
        ? new Set(opts.enabledBankIds)
        : null;
  const wantDirections: BankDirection[] = (opts.directions || []).filter((d) => d !== 'general');
  const wantDifficulty = opts.difficulty || null;

  const qTokens = tokenize(opts.queryText || '');
  const qWeight = new Map<string, number>();
  for (const t of qTokens) qWeight.set(t.term, Math.max(qWeight.get(t.term) || 0, t.weight));

  const scoreDocs = (useDirection: boolean, useDifficulty: boolean): Array<{ d: number; score: number }> => {
    const scores = new Map<number, number>();
    const n = index.docs.length;
    qWeight.forEach((weight, term) => {
      const list = index.postings.get(term);
      if (!list) return;
      const df = index.df.get(term) || 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        const dl = index.lens[p.d] || 1;
        const denom = p.tf + K1 * (1 - B + (B * dl) / (index.avgdl || 1));
        const s = (idf * (p.tf * (K1 + 1))) / denom;
        scores.set(p.d, (scores.get(p.d) || 0) + s * weight);
      }
    });

    const out: Array<{ d: number; score: number }> = [];
    scores.forEach((base, d) => {
      const q = index.docs[d];
      const bankId = index.bankIds[d];
      if (!q || exclude.has(q.id)) return;
      if (allowedBanks && !allowedBanks.has(bankId)) return;
      if (useDirection && wantDirections.length) {
        // 'general' 当通配：内置库 57% 的题是行为/综合题，分类器给不出方向；
        // 若把它们全滤掉，「前端」面试就只剩纯技术题，行为题一道都召不回来。
        const hit =
          q.directions.includes('general') || q.directions.some((x) => wantDirections.includes(x));
        if (!hit) return;
      }
      if (useDifficulty && wantDifficulty && q.difficulty !== wantDifficulty) return;
      out.push({ d, score: base * phraseBoost(opts.queryText, q.text) });
    });
    out.sort((a, b) => b.score - a.score || index.docs[a.d].id.localeCompare(index.docs[b.d].id));
    return out;
  };

  let ranked = scoreDocs(true, true);
  let relaxed = false;
  if (!ranked.length && (wantDirections.length || wantDifficulty)) {
    relaxed = true;
    ranked = scoreDocs(wantDirections.length > 0, false);
    if (!ranked.length && wantDirections.length) {
      relaxed = true;
      ranked = scoreDocs(false, false);
    }
  }

  const candidates: BankCandidate[] = ranked.slice(0, topK).map(({ d }) => {
    const q = index.docs[d];
    return {
      id: q.id,
      bankId: index.bankIds[d],
      text: q.text,
      directions: q.directions,
      difficulty: q.difficulty,
      category: q.category,
      tags: q.tags,
      keyPointCount: (q.keyPoints || []).length,
    };
  });

  return {
    candidates,
    relaxed,
    poolSize: index.docs.length,
    tookMs: Date.now() - t0,
  };
}

// ===== 检索词构造 =====

/**
 * 查询串：岗位名 + 面试官类型 + 难度 + JD 硬性要求 + 简历技能。
 * JD 全文太长会稀释 BM25（长文档式查询），这里只取前若干行里的短句。
 */
export function buildRecallQuery(parts: {
  jobTitle?: string;
  roleLabel?: string;
  difficultyLabel?: string;
  jdText?: string;
  skills?: string[];
}): string {
  const jdLines = String(parts.jdText || '')
    .split(/[\n。；;]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 40)
    .slice(0, 12)
    .join(' ');
  return [
    parts.jobTitle || '',
    parts.roleLabel || '',
    parts.difficultyLabel || '',
    jdLines,
    (parts.skills || []).slice(0, 12).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 800);
}

// ===== 去重 =====

export interface DuplicateReport {
  /** 与已有题目（或本批更早的题）归一化后完全相同 */
  exact: number[];
  /** 近似重复：3-gram Jaccard > 0.85，只提示不自动删 */
  near: Array<{ index: number; similarTo: string; similarity: number }>;
}

function charTrigrams(text: string): Set<string> {
  const s = normalizeQuestionText(text);
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) set.add(s.slice(i, i + 3));
  if (s.length < 3 && s) set.add(s);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  small.forEach((x) => {
    if (big.has(x)) inter += 1;
  });
  return inter / (a.size + b.size - inter);
}

/**
 * 近似重复（3-gram Jaccard > threshold）。只提示、不自动删。
 *
 * 性能约束：不做全库两两比较（30K × 30K 是平方级，导入会卡死）。
 * 先用 3-gram 倒排缩小候选，再对候选算 Jaccard；共享 gram 少于 30% 的直接跳过
 * （Jaccard 不可能 > 0.85）。高频 gram（如「什么」）的倒排表过长，跳过不参与候选生成，
 * 否则一条「什么」就能把候选集撑到全库。
 */
export function findNearDuplicates(
  incoming: string[],
  existing: Array<{ id: string; text: string }> = [],
  threshold = 0.85,
): Array<{ index: number; similarTo: string; similarity: number }> {
  const existingGrams = new Map<string, Set<string>>();
  const gramToIds = new Map<string, Set<string>>();
  existing.forEach((q) => {
    const grams = charTrigrams(q.text);
    existingGrams.set(q.id, grams);
    grams.forEach((g) => {
      let set = gramToIds.get(g);
      if (!set) {
        set = new Set();
        gramToIds.set(g, set);
      }
      set.add(q.id);
    });
  });

  const gramToBatch = new Map<string, number[]>();
  const batchGrams: Set<string>[] = [];
  const out: Array<{ index: number; similarTo: string; similarity: number }> = [];
  const MAX_DF = 2000;

  incoming.forEach((text, i) => {
    const grams = charTrigrams(text);
    batchGrams.push(grams);
    const counts = new Map<string, number>();
    const bump = (key: string) => counts.set(key, (counts.get(key) || 0) + 1);
    grams.forEach((g) => {
      const ids = gramToIds.get(g);
      if (ids && ids.size <= MAX_DF) ids.forEach((id) => bump(`e:${id}`));
      const batch = gramToBatch.get(g);
      // 批内高频 gram 同样要限流：3 万条同模板题目会让每个 gram 的倒排表变成 3 万条，
      // 候选集直接爆炸（导入向导会在 30K 条时看起来卡死）。
      if (batch && batch.length <= MAX_DF) batch.forEach((j) => bump(`b:${j}`));
    });
    const need = Math.max(2, Math.ceil(grams.size * 0.3));
    let bestKey = '';
    let bestSim = 0;
    counts.forEach((c, key) => {
      if (c < need) return;
      const other = key.startsWith('e:')
        ? existingGrams.get(key.slice(2)) || new Set<string>()
        : batchGrams[Number(key.slice(2))] || new Set<string>();
      const sim = jaccard(grams, other);
      if (sim > threshold && sim > bestSim) {
        bestSim = sim;
        bestKey = key;
      }
    });
    if (bestKey) {
      out.push({
        index: i,
        similarTo: bestKey.startsWith('e:') ? bestKey.slice(2) : `本批第 ${Number(bestKey.slice(2)) + 1} 条`,
        similarity: Number(bestSim.toFixed(3)),
      });
    }
    grams.forEach((g) => {
      let list = gramToBatch.get(g);
      if (!list) {
        list = [];
        gramToBatch.set(g, list);
      }
      list.push(i);
    });
  });

  return out;
}

export interface DuplicateReport {
  /** 与已有题目（或本批更早的题）归一化后完全相同 */
  exact: number[];
  /** 近似重复：3-gram Jaccard > 0.85，只提示不自动删 */
  near: Array<{ index: number; similarTo: string; similarity: number }>;
}

/**
 * 去重（导入 / 新增时执行）：
 *   1. 精确去重：归一化后 SHA-1 相同 → 跳过；
 *   2. 近似去重：同批与同库内 3-gram Jaccard > 0.85 → 只提示，不自动删。
 */
export function findDuplicates(
  incoming: string[],
  existing: Array<{ id: string; text: string }> = [],
  threshold = 0.85,
): DuplicateReport {
  const exact: number[] = [];
  const seen = new Map<string, string>();
  existing.forEach((q) => seen.set(sha1Hex(normalizeQuestionText(q.text)), q.id));

  const candidates: string[] = [];
  incoming.forEach((text, i) => {
    const hash = sha1Hex(normalizeQuestionText(text));
    if (seen.has(hash)) {
      exact.push(i);
      return;
    }
    seen.set(hash, `batch-${i}`);
    candidates.push(text);
  });

  return { exact, near: findNearDuplicates(candidates, existing, threshold) };
}

// ===== 自动分类（内置库没有人工标注，只能启发式；结果可被用户手动改） =====

const DIRECTION_KEYWORDS: Record<Exclude<BankDirection, 'general'>, string[]> = {
  frontend: [
    '前端', 'vue', 'react', 'javascript', 'js', 'typescript', 'ts', 'css', 'html', 'dom', '浏览器',
    '组件', '页面', 'webpack', 'vite', '小程序', '跨域', 'ajax', 'http', '渲染', '路由', '移动端',
  ],
  backend: [
    '后端', 'java', 'jvm', 'spring', 'mysql', 'redis', '数据库', '并发', '线程', '分布式', '微服务',
    '消息队列', 'kafka', 'rocketmq', '索引', '事务', '锁', 'tcp', '网络', '缓存', '架构', '接口',
    '服务', '集群', '秒杀', '高并发', 'go', 'golang', 'c++', 'php', 'python',
  ],
  algorithm: [
    '算法', '排序', '动态规划', '二叉树', '链表', '哈希', '时间复杂度', '空间复杂度', '递归', '回溯',
    '贪心', '图论', '字符串匹配', 'leetcode', '机试', '手写', '机器学习', '深度学习', '模型',
  ],
  data: [
    '数据分析', 'sql', '指标', '用户增长', 'ab test', 'abtest', '数据仓库', 'hive', 'spark', '埋点',
    '报表', '漏斗', '留存', '画像', '数据清洗', '统计学', '可视化', 'bi',
  ],
  product: [
    '产品', '需求', '竞品', '功能设计', '用户调研', 'prd', '原型', '运营', '商业化', '用户体验',
    '版本规划', '优先级', '增长', '活动', '内容策略',
  ],
  test: [
    '测试', '用例', '自动化测试', '缺陷', 'bug', '回归', '性能测试', '接口测试', '单元测试',
    'selenium', 'jmeter', '质量',
  ],
  ops: [
    '运维', 'k8s', 'kubernetes', 'docker', '部署', '监控', '服务器', '故障', '排查', 'linux',
    'shell', 'nginx', '容量', '稳定性', '告警', 'ci/cd',
  ],
};

const ICEBREAK = ['自我介绍', '介绍一下你自己', '简单介绍', '为什么选择', '职业规划', '优点', '缺点', '兴趣爱好', '家庭', '性格'];
const BEHAVIOR = ['遇到', '经历', '冲突', '团队', '沟通', '最有成就', '失败', '压力', '加班', '领导', '协作', '意见不一致'];
const PROJECT = ['项目', '简历', '实习', '你做的', '负责的', '落地'];
const CLOSING = ['有什么想问', '薪资', '期望', '还有问题'];
const STRESS = ['设计', '架构', '优化', '如何保证', '方案', '估算', '高并发', '故障', '排查', '为什么', '分析', '取舍', '权衡'];
const BASIC = ['是什么', '有哪些', '区别', '介绍', '用过', '了解', '简单说说', '原理'];

export interface Classification {
  directions: BankDirection[];
  difficulty: MockDifficulty;
  category: MockQuestionCategory;
  tags: string[];
}

/** 关键词打分分类（确定性）：命中越多越可信，没命中落「通用 / 标准 / 专业基础」 */
export function classifyQuestion(text: string): Classification {
  const s = toHalfWidth(text).toLowerCase();
  const scores = new Map<BankDirection, number>();
  (Object.keys(DIRECTION_KEYWORDS) as Array<Exclude<BankDirection, 'general'>>).forEach((dir) => {
    let score = 0;
    for (const kw of DIRECTION_KEYWORDS[dir]) {
      if (s.includes(kw)) score += kw.length >= 4 ? 2 : 1;
    }
    if (score > 0) scores.set(dir, score);
  });
  const directions = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([d]) => d);
  if (!directions.length) directions.push('general');

  let category: MockQuestionCategory = 'fundamental';
  if (ICEBREAK.some((k) => s.includes(k))) category = 'icebreak';
  else if (CLOSING.some((k) => s.includes(k))) category = 'closing';
  else if (BEHAVIOR.some((k) => s.includes(k))) category = 'behavior';
  else if (PROJECT.some((k) => s.includes(k))) category = 'project';

  const stressHits = STRESS.filter((k) => s.includes(k)).length;
  const basicHits = BASIC.filter((k) => s.includes(k)).length;
  const difficulty: MockDifficulty =
    stressHits > basicHits ? 'stress' : basicHits > 0 ? 'basic' : 'standard';

  const tags = directions.filter((d) => d !== 'general').map((d) => BANK_DIRECTION_LABELS[d]);
  return { directions, difficulty, category, tags };
}
