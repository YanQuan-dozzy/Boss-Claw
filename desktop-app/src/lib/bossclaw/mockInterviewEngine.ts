// 模拟面试 AI 引擎：两段式出题 / 追问裁决 / 批量评分 / 反问 / 改写
//
// 三条硬口径（方案 §5）：
//   1. 模型不打分：每维只输出 { level: 1–4, pos: 1–3, evidence }，分数由本地 LEVEL_SCORE 映射；
//   2. 总分本地加权：模型返回的 total / band 一律丢弃；
//   3. 证据必须是回答子串：模型为了显得「有据可依」会润色引用，这里做确定性校验，对不上一律压分。
//
// 追问采用「确定性优先」：本地五条规则命中就不调 AI（省一次调用）；全部不命中才让模型裁决六态证据。

import { callModel, type ChatMessage } from './llm';
import { allocateContextBudget, fitContextToTokens } from './contextBudget';
import { buildSchoolDisclosureRule, resolveSchoolTier } from './schoolTier';
import { aggregateDelivery } from './mockInterviewDelivery';
import { BANK_DIFFICULTY_LABELS, BANK_DIRECTION_LABELS, type BankCandidate } from './mockInterviewBank';
import { skillInstructionsFor } from './skills';
import type { AppConfig, Profile } from './types';
import type {
  MockAdvanceResult,
  MockAttempt,
  MockDimensionKey,
  MockDimensionResult,
  MockEvidenceState,
  MockInterviewConfig,
  MockKeyPointsFrom,
  MockQuestion,
  MockQuestionCategory,
  MockQuestionResult,
  MockReport,
  MockSession,
  MockSessionStatus,
} from './mockInterviewTypes';
import {
  LEVEL_SCORE,
  MOCK_DIMENSIONS,
  MOCK_DIMENSION_KEYS,
  MOCK_EVIDENCE_SCORE_CAP,
  MOCK_MAX_FOLLOWUPS,
  MOCK_MIN_EVIDENCE_CHARS,
  MOCK_RUBRIC_VERSION,
  bandForScore,
  levelToScore,
} from './mockInterviewTypes';

export interface MockEngineContext {
  model: AppConfig['model'];
  resumeText: string;
  profile: Profile | null;
}

export interface MockAdvanceResultExt extends MockAdvanceResult {
  /** AI 是否被实际调用（规则命中为 false，用于 UI 提示与日志） */
  usedAI: boolean;
}

// ===== 通用小工具 =====

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown, max = 2000): string {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/** 截断单段文本并标记（用于把长回答压进预算，而不是把最后几道题整段丢掉） */
function clip(text: string, max: number): string {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（后文略）`;
}

function strArray(v: unknown, max = 8, each = 120): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, each)).filter(Boolean).slice(0, max);
}

/** 报告 JSON 里模型可能把 level 写成 "3"、pos 缺失、维度直接给数字——统一在此就地修复 */
function normalizeLevel(v: unknown): 1 | 2 | 3 | 4 | null {
  const n = Math.round(Number((v as { level?: unknown })?.level));
  if (!Number.isFinite(n) || n < 1 || n > 4) return null;
  return n as 1 | 2 | 3 | 4;
}

function normalizePos(v: unknown): 1 | 2 | 3 {
  const n = Math.round(Number((v as { pos?: unknown })?.pos));
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n)) as 1 | 2 | 3;
}

const CATEGORIES: MockQuestionCategory[] = ['icebreak', 'fundamental', 'project', 'behavior', 'closing'];

function normalizeCategory(v: unknown): MockQuestionCategory {
  const s = str(v, 20) as MockQuestionCategory;
  return CATEGORIES.includes(s) ? s : 'fundamental';
}

function normalizeKeyPointsFrom(v: unknown): MockKeyPointsFrom {
  const s = str(v, 10);
  return s === 'bank' || s === 'none' ? s : 'ai';
}

/**
 * 归一化一条题目。缺题干直接丢弃（返回 null），其余字段给安全默认值——
 * 只有结构性问题（题目数量不足 / 维度全缺）才重试，字段级问题一律就地修复（评审 P2-2）。
 */
function normalizeQuestion(raw: unknown, phase: 1 | 2): MockQuestion | null {
  const r = (raw || {}) as Record<string, unknown>;
  const text = str(r.text, 400);
  if (!text) return null;
  const focus = strArray(r.focus, 5, 80);
  const rubric = strArray(r.rubric, 6, 120);
  return {
    id: uid('mq'),
    phase,
    kind: r.kind === 'injected' ? 'injected' : 'planned',
    injectedFrom: r.injectedFrom ? str(r.injectedFrom, 64) : null,
    category: normalizeCategory(r.category),
    text,
    jdRef: str(r.jdRef, 200),
    resumeRef: str(r.resumeRef, 200),
    focus: focus.length ? focus : ['回答是否切题'],
    rubric,
    probeDirections: strArray(r.probeDirections, 3, 100),
    sourceQuestionId: r.sourceQuestionId ? str(r.sourceQuestionId, 64) : null,
    sourceBankId: r.sourceBankId ? str(r.sourceBankId, 64) : null,
    keyPointsFrom: r.sourceQuestionId ? normalizeKeyPointsFrom(r.keyPointsFrom) : 'ai',
  };
}

function normalizeInjected(raw: unknown, phase: 1 | 2, fromQuestionId: string): MockQuestion | null {
  const q = normalizeQuestion(raw, phase);
  if (!q) return null;
  q.kind = 'injected';
  q.injectedFrom = fromQuestionId;
  return q;
}

/** 题干去重（归一化后比较），用于出题自检与插题去重 */
function normQuestion(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 200);
}

function dedupeQuestions(list: MockQuestion[], existing: MockQuestion[] = []): MockQuestion[] {
  const seen = new Set(existing.map((q) => normQuestion(q.text)));
  const out: MockQuestion[] = [];
  for (const q of list) {
    const k = normQuestion(q.text);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
  }
  return out;
}

/** 出题自检（方案 4.2）：阶段一至少 1 行为题 1 开放题，阶段二至少 2 题带 resumeRef；不合格重试一次 */
function phase1Acceptable(qs: MockQuestion[], want: number): boolean {
  if (qs.length < Math.min(3, want)) return false;
  return qs.some((q) => q.category === 'behavior') && qs.some((q) => q.category !== 'behavior');
}

function phase2Acceptable(qs: MockQuestion[], want: number): boolean {
  if (qs.length < Math.min(2, want)) return false;
  return qs.filter((q) => Boolean(q.resumeRef)).length >= Math.min(2, qs.length);
}

// ===== 题库候选池（P3）：召回在本地，选择在同一次出题调用里 =====

/**
 * 候选清单只给「id / 题干 / 方向 / 难度 / 标签」。
 * **不给答案，也不给要点全文**：一旦给了参考答案，模型会按答案打分，而用户答的是自己的经历。
 */
function candidateBlock(candidates: BankCandidate[]): string {
  if (!candidates.length) return '';
  const lines = candidates.map(
    (c) =>
      `[${c.id}] ${c.text}｜${c.directions.map((d) => BANK_DIRECTION_LABELS[d]).join('/')}｜${BANK_DIFFICULTY_LABELS[c.difficulty]}｜${
        c.tags.slice(0, 3).join('、') || '无标签'
      }`,
  );
  return [
    '【候选题目】以下是从本地面试题库召回的题，可选用、可改写、也可以全部不用。',
    ...lines,
    '规则：',
    '1. JD 覆盖优先于题库命中。候选里没有能覆盖 JD 某条硬性要求的题，就自己出，不许为了用题库而降低针对性。',
    '2. 候选不含答案，也不要假设存在标准答案；你只负责把题出得贴岗位。',
    '3. 若采用或改写某道候选题，sourceQuestionId 填对应方括号里的 id；若改写后已偏离原题考察点，sourceQuestionId 置 null。',
    '4. 未采用任何候选题时，sourceQuestionId 一律为 null。',
  ].join('\n');
}

/**
 * 把模型返回的 sourceQuestionId 收敛到真实候选：
 *   · 编造的 id 一律置 null（否则报告会挂上一个不存在的「题库要点」来源）；
 *   · 候选没有要点的（内置库全部如此）标 'none'，不是 'ai'——「无要点」和「AI 现编」是两件事。
 */
function applyBankSources(qs: MockQuestion[], candidates: BankCandidate[]): MockQuestion[] {
  const map = new Map(candidates.map((c) => [c.id, c]));
  for (const q of qs) {
    const c = q.sourceQuestionId ? map.get(q.sourceQuestionId) : null;
    if (!c) {
      q.sourceQuestionId = null;
      q.sourceBankId = null;
      if (q.keyPointsFrom === 'bank') q.keyPointsFrom = 'ai';
      continue;
    }
    q.sourceQuestionId = c.id;
    q.sourceBankId = c.bankId;
    q.keyPointsFrom = c.keyPointCount > 0 ? 'bank' : 'none';
  }
  return qs;
}

// ===== 上下文裁剪（复用 contextBudget.ts 的唯一口径） =====

function fitParts(
  ctx: MockEngineContext,
  parts: Record<string, { text: string; weight: number }>,
  outputTokens: number,
): Record<string, string> {
  const weights: Record<string, number> = {};
  const keys = Object.keys(parts);
  for (const k of keys) weights[k] = parts[k].weight;
  const budgets = allocateContextBudget(ctx.model, weights, { outputTokens });
  const out: Record<string, string> = {};
  for (const k of keys) {
    // 注意：allocateContextBudget 只分配、不截断，必须再调 fitContextToTokens（评审 P2-3）
    out[k] = fitContextToTokens(parts[k].text, budgets[k] || 0);
  }
  return out;
}

function resumeTextOf(ctx: MockEngineContext): string {
  return fitParts(ctx, { resume: { text: ctx.resumeText || '', weight: 1 } }, 4000).resume || '';
}

function profileBrief(profile: Profile | null): string {
  if (!profile) return '';
  const facts = profile.facts;
  const skills = (facts?.skills || []).slice(0, 20).join('、');
  const dirs = (profile.primaryDirections || []).map((d) => d.name).filter(Boolean).slice(0, 3).join('、');
  return [dirs ? `求职方向：${dirs}` : '', skills ? `技能：${skills}` : ''].filter(Boolean).join('；');
}

function transcriptOf(session: MockSession, phase?: 1 | 2): string {
  const qs = session.questions.filter((q) => (phase ? q.phase === phase : true));
  const lines: string[] = [];
  for (const q of qs) {
    const att = latestAttempt(session, q.id);
    const label = q.kind === 'injected' ? '[临时追加]' : '';
    lines.push(`Q（${q.category}）${label}${q.text}`);
    if (!att) {
      lines.push('A：（未作答）');
      continue;
    }
    if (att.skipped) {
      lines.push('A：（用户跳过）');
      continue;
    }
    lines.push(`A：${clip(att.answer || '（空）', 500)}`);
    for (const p of att.probes || []) {
      if (p.answer) lines.push(`追问：${p.question}\n补答：${clip(p.answer, 300)}`);
    }
  }
  return lines.join('\n');
}

export function latestAttempt(session: MockSession, questionId: string): MockAttempt | null {
  const list = session.attempts.filter((a) => a.questionId === questionId);
  if (!list.length) return null;
  return list.reduce((best, cur) => (cur.submittedAt >= best.submittedAt ? cur : best), list[0]);
}

function jsonMessages(system: string, user: string): ChatMessage[] {
  // 技能层注入（skills/mock-interview-*/SKILL.md，启用态由设置页控制）。
  // 只放在 system 尾部，不改变各调用点自己的硬约束顺序。
  const extra = skillInstructionsFor('mock-interview');
  const sys = extra ? `${system}\n\n【技能指令】\n${extra}` : system;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

const ROLE_HINT: Record<MockInterviewConfig['role'], string> = {
  hr: 'HR 面：关注求职动机、稳定性、薪资与到岗预期、沟通协作、职业规划',
  tech: '技术面：关注原理理解、项目技术细节、故障复盘、方案取舍',
  manager: '主管面：关注推进力、跨团队协作、目标拆解、资源与取舍',
  general: '综合面：按「岗位方向 → 专业基础 → 项目深挖 → 行为」混合，先听后挖',
};

const DIFFICULTY_HINT: Record<MockInterviewConfig['difficulty'], string> = {
  basic: '基础难度：问题直白，问清事实与基本做法即可',
  standard: '标准难度：需要具体事例、可核对的细节与结果',
  stress: '压力难度：会连续追问口径、边界与反例，容忍「不知道」但要求区分事实与推测',
};

// ===== 阶段一：通用题 =====

const PHASE1_SYSTEM = `你是求职者的模拟面试官，正在为一场真实岗位面试做练习。你只负责提问，不评价、不给分、不解释。
规则：
1. 只输出 json：{"questions":[{"category":"icebreak|fundamental|project|behavior|closing","text":"题干","jdRef":"对应 JD 原文片段（可为空）","focus":["考察点"],"rubric":["评分要点"],"probeDirections":["可能追问的方向"],"sourceQuestionId":"采用的候选题 id 或 null"}]}
2. 阶段一只按岗位方向与面试官类型出题，**不要针对简历里的具体项目细节**（简历还没给你）；目的是先听候选人怎么说。
3. 每题必须能对应该岗位的一条真实要求，jdRef 填 JD 原文里的短句（不超过 40 字），不要编造 JD 没有的要求。
4. 题干用口语化的面试官口吻，不要书面语、不要「请列举三点」这类考试腔，不要出现「候选人」。
5. 至少 1 道行为题（过去怎么做的）、至少 1 道开放式专业题；题干之间不得重复或近似。
6. focus 2–4 条（这道题在听什么），rubric 2–4 条（答到什么算好），probeDirections 1–2 条。
7. 不得询问年龄、婚育、户籍、健康、政治面貌等与岗位无关的个人信息。`;

export async function generatePhase1(
  session: MockSession,
  ctx: MockEngineContext,
  candidates: BankCandidate[] = [],
): Promise<{ ok: boolean; questions: MockQuestion[]; localFallback: boolean; error?: string }> {
  const want = Math.min(6, Math.max(4, Number(session.config.phase1Count) || 4));
  const jd = fitParts(ctx, { jd: { text: session.job.jdText || '', weight: 1 } }, 4000).jd || '';
  const brief = profileBrief(ctx.profile);
  const user = [
    `岗位：${session.job.jobTitle || '未填写'}${session.job.company ? ` · ${session.job.company}` : ''}`,
    `面试官类型：${ROLE_HINT[session.config.role]}`,
    `难度：${DIFFICULTY_HINT[session.config.difficulty]}`,
    `请出 ${want} 道阶段一题目。`,
    brief ? `（候选人背景摘要，仅用于判断岗位语境，不要据此追问细节）${brief}` : '',
    '【JD 原文】',
    jd || '（未提供 JD，请按岗位名给出通用题，jdRef 留空）',
    candidateBlock(candidates),
  ].filter(Boolean).join('\n');

  const parse = (raw: unknown): MockQuestion[] => {
    const obj = raw as { questions?: unknown };
    const arr = Array.isArray(obj?.questions) ? obj.questions : [];
    return dedupeQuestions(
      arr.map((q) => normalizeQuestion(q, 1)).filter((q): q is MockQuestion => Boolean(q)),
    );
  };

  try {
    let raw = await callModel(jsonMessages(PHASE1_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.55,
      maxTokens: 2200,
      purpose: '模拟面试出题（阶段一）',
    });
    let qs = parse(raw);
    // 结构性问题（题量不足 / 缺行为题）才重试一次；字段级问题已在 normalize 里修复
    if (!phase1Acceptable(qs, want)) {
      raw = await callModel(
        jsonMessages(PHASE1_SYSTEM, `${user}\n\n（上一次输出不符合要求：题量不足或缺行为题、或题干重复。请严格按 json 重新输出 ${want} 道不重复的题。）`),
        ctx.model,
        { jsonMode: true, temperature: 0.5, maxTokens: 2400, purpose: '模拟面试出题（阶段一重试）' },
      );
      qs = parse(raw);
    }
    qs = applyBankSources(qs.slice(0, want), candidates);
    if (qs.length < 3) throw new Error('AI 返回的题目不足');
    return { ok: true, questions: qs, localFallback: false };
  } catch (e) {
    const local = localPhase1Questions(session.config, want);
    return { ok: false, questions: local, localFallback: true, error: String((e as Error)?.message || e) };
  }
}

/** 阶段一失败时的本地题（明确标注「本地题，非针对本岗位」；阶段二随之跳过） */
function localPhase1Questions(config: MockInterviewConfig, want: number): MockQuestion[] {
  const base: Array<{ category: MockQuestionCategory; text: string; focus: string[] }> = [
    { category: 'icebreak', text: '先简单介绍一下你自己，重点说说和你应聘这个岗位最相关的一段经历。', focus: ['表达是否有主线', '是否贴岗位'] },
    { category: 'fundamental', text: '结合你做过的一个项目，讲讲你在这个岗位最核心的一项工作是怎么做的。', focus: ['是否讲清做法', '是否有具体细节'] },
    { category: 'behavior', text: '讲一次你和别人意见不一致、最后把事推进下去的经历。', focus: ['冲突处理', '推进方式', '结果'] },
    { category: 'project', text: '你做过的事情里，哪一件的结果最能量化？具体数字是怎么来的？', focus: ['量化口径', '结果归属'] },
    { category: 'closing', text: '如果这次没能通过，你觉得自己最可能卡在哪个环节？', focus: ['自我认知', '复盘能力'] },
    { category: 'fundamental', text: '你最近在学什么？为什么学它？', focus: ['学习动机', '与岗位的相关性'] },
  ];
  if (config.role === 'hr') {
    base[1] = { category: 'fundamental', text: '你为什么想做这个岗位？未来两三年你希望自己成长成什么样？', focus: ['动机', '稳定性', '规划'] };
  } else if (config.role === 'tech') {
    base[1] = { category: 'fundamental', text: '挑一个你最熟的技术点，讲讲它的原理和你在项目里怎么用的。', focus: ['原理理解', '落地细节'] };
  } else if (config.role === 'manager') {
    base[1] = { category: 'fundamental', text: '如果让你接手一个进度已经落后的项目，你第一步做什么？', focus: ['拆解目标', '优先级', '协作'] };
  }
  return base.slice(0, Math.max(4, Math.min(want, base.length))).map((q) => ({
    id: uid('mq'),
    phase: 1,
    kind: 'planned',
    category: q.category,
    text: q.text,
    jdRef: '',
    resumeRef: '',
    focus: q.focus,
    rubric: [],
    probeDirections: [],
    sourceQuestionId: null,
    keyPointsFrom: 'none',
  }));
}

// ===== 阶段二：针对简历与阶段一回答的深挖题 =====

const PHASE2_SYSTEM = `你是求职者的模拟面试官。现在你已经听完候选人的第一轮回答，要针对简历与刚才的回答出深挖题。
只输出 json：{"questions":[{"category":"project|fundamental|behavior","text":"题干","jdRef":"对应 JD 原文片段","resumeRef":"锚定的简历事实（原文短句）","focus":["考察点"],"rubric":["评分要点"],"probeDirections":["追问方向"],"sourceQuestionId":"采用的候选题 id 或 null"}]}
规则：
1. 必须针对简历里真实存在的项目/经历，或阶段一回答里出现过的原话；**不得引入简历与回答里没有的公司、项目、数字**。
2. 追问优先级（从高到低）：① 指标口径与定义（这个数怎么算的、分母是什么）② 方法与工具细节 ③ 业务价值与影响 ④ 量化结果的真实性与推导过程。
3. 每题必须带 resumeRef（简历或回答里的原文短句，20 字以内）；找不到可锚定的事实时，改问「如果让你做你会怎么做」，并把 resumeRef 留空。
4. 至少 2 题直接对应 JD 的硬性要求，jdRef 填 JD 原文短句。
5. 题干口语化、不重复、不出现「请列举三点」这类书面语；不得询问与岗位无关的个人信息。
6. focus 2–4 条，rubric 2–4 条，probeDirections 1–2 条。`;

export async function generatePhase2(
  session: MockSession,
  ctx: MockEngineContext,
  candidates: BankCandidate[] = [],
): Promise<{ ok: boolean; questions: MockQuestion[]; error?: string }> {
  const want = Math.min(4, Math.max(3, Number(session.config.phase2Count) || 3));
  const parts = fitParts(
    ctx,
    {
      resume: { text: ctx.resumeText || '', weight: 0.45 },
      jd: { text: session.job.jdText || '', weight: 0.25 },
      transcript: { text: transcriptOf(session, 1), weight: 0.3 },
    },
    4200,
  );
  const user = [
    `岗位：${session.job.jobTitle || '未填写'}${session.job.company ? ` · ${session.job.company}` : ''}`,
    `面试官类型：${ROLE_HINT[session.config.role]}`,
    `请出 ${want} 道阶段二深挖题。`,
    '【简历原文】',
    parts.resume || '（简历为空，只能基于 JD 出题，resumeRef 一律留空）',
    '【JD 原文】',
    parts.jd || '（未提供 JD）',
    '【阶段一问答】',
    parts.transcript || '（无）',
    candidateBlock(candidates),
  ].filter(Boolean).join('\n');

  const parse = (raw: unknown): MockQuestion[] => {
    const obj = raw as { questions?: unknown };
    const arr = Array.isArray(obj?.questions) ? obj.questions : [];
    return dedupeQuestions(
      arr.map((q) => normalizeQuestion(q, 2)).filter((q): q is MockQuestion => Boolean(q)),
      session.questions,
    );
  };

  try {
    let raw = await callModel(jsonMessages(PHASE2_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 2400,
      purpose: '模拟面试出题（阶段二）',
    });
    let qs = parse(raw);
    if (!phase2Acceptable(qs, want)) {
      raw = await callModel(
        jsonMessages(PHASE2_SYSTEM, `${user}\n\n（上一次输出不符合要求：需 ${want} 道题、至少 2 题带 resumeRef 且直接对应 JD。请重新输出严格 json。）`),
        ctx.model,
        { jsonMode: true, temperature: 0.45, maxTokens: 2600, purpose: '模拟面试出题（阶段二重试）' },
      );
      qs = parse(raw);
    }
    qs = applyBankSources(qs.slice(0, want), candidates);
    if (!qs.length) throw new Error('AI 未返回深挖题');
    return { ok: true, questions: qs };
  } catch (e) {
    return { ok: false, questions: [], error: String((e as Error)?.message || e) };
  }
}

// ===== 追问：本地五条确定性规则优先 =====

/** 文本归一化：去标点/空白/全角，转小写——证据子串校验与去重共用 */
export function normalizeForMatch(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[％]/g, '%')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 取 % / 倍 的数值（只比这两类，避免「3 个项目」这类噪声） */
function percentClaims(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(?:%|％|倍)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function bigrams(text: string): Set<string> {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  a.forEach((x) => { if (b.has(x)) n += 1; });
  return n;
}

/**
 * 本地规则 5：回答里的百分比/倍数与简历同一项目的数值不一致 → 必追问。
 * 判定方式（确定性）：回答分句里出现 %/倍 数值，找到简历中含 %/倍 且与它共享 ≥2 个 bigram 的句子；
 * 两值不同即视为「口径可能不同、必须澄清」。共享 bigram 门槛避免了「任意两个百分比都算冲突」。
 */
export function findNumberConflict(answer: string, resumeText: string): { answerValue: number; resumeValue: number; resumeSentence: string } | null {
  const answerSents = String(answer || '').split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  const resumeSents = String(resumeText || '').split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const as of answerSents) {
    const av = percentClaims(as);
    if (!av.length) continue;
    const ab = bigrams(as);
    for (const rs of resumeSents) {
      const rv = percentClaims(rs);
      if (!rv.length) continue;
      if (overlap(ab, bigrams(rs)) < 2) continue;
      for (const a of av) {
        for (const r of rv) {
          if (Math.abs(a - r) > 0.01) return { answerValue: a, resumeValue: r, resumeSentence: rs.slice(0, 60) };
        }
      }
    }
  }
  return null;
}

interface LocalRuleHit {
  probe: string;
  reason: string;
}

/** 本地规则 1–5（顺序即优先级；数字冲突永远先问，因为它最容易被别的规则掩盖） */
export function localFollowupRule(answer: string, resumeText: string): LocalRuleHit | null {
  const text = String(answer || '').trim();
  const conflict = findNumberConflict(text, resumeText);
  if (conflict) {
    return {
      probe: `你这里提到 ${conflict.answerValue}%，而简历上写的是 ${conflict.resumeValue}%。这两个数哪个是准确的？口径一样吗？`,
      reason: '数字冲突',
    };
  }
  if (text.length < 80) {
    return { probe: '能再具体一点吗？当时你具体做了什么、怎么做的？', reason: '回答过短' };
  }
  const we = (text.match(/我们/g) || []).length;
  // 「我」字包含在「我们」里，直接数 /我/g 会永远 >0；这里扣掉「我们」才是真正的第一人称单数
  const me = (text.match(/我/g) || []).length - we;
  if (we >= 3 && me <= 0) {
    return { probe: '这件事里，你个人负责的部分具体是什么？', reason: '无个人贡献' };
  }
  if (!/\d/.test(text)) {
    return { probe: '最终结果有没有可以量化的指标？比如数量、比例或者时间上的变化。', reason: '无量化结果' };
  }
  if (!/(当时|那会儿|背景|阶段|公司|团队)/.test(text)) {
    return { probe: '当时的背景是什么样的？你为什么会接手这件事？', reason: '情境缺失' };
  }
  return null;
}

const ADVANCE_SYSTEM = `你是模拟面试官，刚听完候选人对一道题的回答。只输出 json：
{"action":"followup|advance","evidenceState":"insufficient|vague|partial|solid|strong|conflict","reasoning":"先写判断理由","probe":"若要追问，追问的原话；否则空字符串","inject":{"text":"临时追加的题目（仅在允许时给，否则 null）","category":"project|fundamental|behavior","focus":["考察点"],"jdRef":"JD 短句","resumeRef":"简历短句"}}
判定口径：
- insufficient 不足（基本没答到/答非所问）、vague 模糊（只有关键词没展开）、partial 部分（答到一部分考察点）、solid 扎实（基本覆盖）、strong 强（覆盖且有余量）、conflict 矛盾（与简历事实或前文冲突）。
- 只有前四种里的不足/模糊/部分才追问；扎实/强一律推进；矛盾必须追问澄清。
- **追问只问一个最关键的点**，口语化，20–40 字，不要一次问三件事；不要重复候选人已经说过的内容。
- reasoning 必须写在 evidenceState 之前（先分析再判定）。
- 允许临时追加题目时最多 1 道，且必须来自候选人上一段回答里出现的高价值线索；不允许时 inject 为 null。`;

export async function advance(
  session: MockSession,
  question: MockQuestion,
  answer: string,
  probes: Array<{ question: string; answer: string }>,
  ctx: MockEngineContext,
  opts: { allowInject: boolean } = { allowInject: false },
): Promise<MockAdvanceResultExt> {
  const rule = localFollowupRule(answer, ctx.resumeText);
  if (rule) {
    // 规则命中不调 AI：状态固定 partial、来源 rule，报告据此显示「部分（规则判定）」
    return {
      action: 'followup',
      evidenceState: 'partial',
      evidenceSource: 'rule',
      probe: rule.probe,
      usedAI: false,
    };
  }

  const parts = fitParts(
    ctx,
    {
      resume: { text: ctx.resumeText || '', weight: 0.4 },
      jd: { text: session.job.jdText || '', weight: 0.2 },
      answer: { text: `【主答】${answer}\n【追问补答】${probes.map((p) => `问：${p.question}\n答：${p.answer}`).join('\n')}`, weight: 0.4 },
    },
    4200,
  );
  const user = [
    `岗位：${session.job.jobTitle || ''}${session.job.company ? ` · ${session.job.company}` : ''}`,
    `题目：${question.text}`,
    `考察点：${question.focus.join('；') || '（未提供）'}`,
    question.rubric && question.rubric.length ? `评分要点：${question.rubric.join('；')}` : '',
    `已追问轮次：${probes.length}/${MOCK_MAX_FOLLOWUPS}`,
    opts.allowInject ? '本轮允许临时追加 1 道题（inject 可给）。' : '本轮不允许插题（inject 必须为 null）。',
    '【简历原文】',
    parts.resume || '（无）',
    '【JD 原文】',
    parts.jd || '（无）',
    '【候选人回答】',
    parts.answer,
  ].filter(Boolean).join('\n');

  try {
    const raw = await callModel(jsonMessages(ADVANCE_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 900,
      purpose: '模拟面试追问裁决',
    });
    const obj = (raw || {}) as Record<string, unknown>;
    const state = str(obj.evidenceState, 20) as MockEvidenceState;
    const evidenceState: MockEvidenceState = [
      'insufficient', 'vague', 'partial', 'solid', 'strong', 'conflict',
    ].includes(state) ? state : 'partial';
    const probe = str(obj.probe, 200);
    const cappedOut = probes.length >= MOCK_MAX_FOLLOWUPS;
    const wantFollow = str(obj.action, 12) === 'followup' && Boolean(probe) && !cappedOut;
    const inject = opts.allowInject && !wantFollow ? normalizeInjected(obj.inject, question.phase, question.id) : null;
    return {
      action: wantFollow ? 'followup' : 'advance',
      evidenceState,
      evidenceSource: 'ai',
      probe: wantFollow ? probe : undefined,
      inject,
      usedAI: true,
    };
  } catch {
    // AI 裁决失败 → 直接推进，不阻塞用户（fail-safe）
    return { action: 'advance', evidenceState: 'partial', evidenceSource: 'ai', usedAI: true };
  }
}

// ===== 评分：四档 + 档内位置 → 本地加权 =====

const REPORT_SYSTEM = `你是面试复盘教练，要给一场模拟面试做结构化评分。只输出 json：
{"questions":[{"questionId":"题目id","dimensions":{"relevance":{"reasoning":"先写判断依据","level":1,"pos":1,"evidence":"候选人回答中的原句（必须逐字摘录，10–60 字）"},"evidence":{...},"structure":{...},"depth":{...},"reflection":{"reasoning":"...","na":true}},"hitPoints":["命中的要点"],"missedPoints":["漏答的要点"],"suggestion":"一句话改进建议","deliveryNote":"表达建议（主观文字，不给分）"}],"deliveryAdvice":"整体表达建议（不给分）","summary":{"gaps":[{"text":"最该补的缺口","jdRef":"对应 JD 原文"}],"advice":["可执行建议1","建议2","建议3"]}}
评分口径（必须严格遵守）：
1. **不要给分数**，也不要给总分或档位；每维只给 level（1–4 档）与 pos（该档内 1 低 / 2 中 / 3 高）。
   4 强：有事实、有数量、归属清晰且说清口径；3 扎实：有事实与数量，归属或口径之一模糊；
   2 部分：有具体做法，缺数量或缺结果；1 不足：只有概括、名词或泛泛而谈。
2. 五个维度：relevance 相关性 / evidence 证据具体性 / structure 思路结构 / depth 专业深度 / reflection 复盘与权衡。
3. **每个维度必须引用候选人回答原句作 evidence**（逐字摘录，不得改写、不得润色、不得编造）；回答里确实找不到可引用原句时，evidence 留空字符串。
4. **回答长不等于答得好**：冗余、重复、绕圈子不加分，反而在相关性上扣分。
5. 某维度对该题不适用（如行为题无技术深度）时输出 {"na":true,"reasoning":"为什么"}，不要给 0 分；**不要为了省事把所有维度标 na**。
6. hitPoints / missedPoints 对着该题考察点与 JD 要求逐条比，各 0–4 条；missedPoints 只列真正该答而没答的，不要凑数。
7. 不得评价人格、情绪、诚实、健康、外貌等与工作能力无关的内容；不得预测录用概率。
8. questionId 必须原样使用输入中的 id。`;

interface AIQuestionScore {
  questionId: string;
  dimensions: Record<string, { level: number | null; pos: number; na: boolean; evidence: string }>;
  hitPoints: string[];
  missedPoints: string[];
  suggestion: string;
  deliveryNote: string;
}

interface AIScorePayload {
  questions: AIQuestionScore[];
  deliveryAdvice: string;
  summary: { gaps: { text: string; jdRef?: string }[]; advice: string[] };
}

function normalizeScorePayload(raw: unknown): AIScorePayload {
  const obj = (raw || {}) as Record<string, unknown>;
  const qs = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: AIQuestionScore[] = qs.map((q) => {
    const qq = (q || {}) as Record<string, unknown>;
    const dimsRaw = (qq.dimensions || {}) as Record<string, unknown>;
    const dimensions: AIQuestionScore['dimensions'] = {};
    for (const key of MOCK_DIMENSION_KEYS) {
      const d = (dimsRaw[key] || {}) as Record<string, unknown>;
      const na = d.na === true;
      dimensions[key] = {
        level: na ? null : normalizeLevel(d),
        pos: normalizePos(d),
        na,
        evidence: str(d.evidence, 160),
      };
    }
    return {
      questionId: str(qq.questionId, 64),
      dimensions,
      hitPoints: strArray(qq.hitPoints, 5, 100),
      missedPoints: strArray(qq.missedPoints, 5, 100),
      suggestion: str(qq.suggestion, 200),
      deliveryNote: str(qq.deliveryNote, 200),
    };
  });
  const summary = (obj.summary || {}) as Record<string, unknown>;
  const gapsRaw = Array.isArray(summary.gaps) ? summary.gaps : [];
  return {
    questions,
    deliveryAdvice: str(obj.deliveryAdvice, 400),
    summary: {
      gaps: gapsRaw
        .map((g) => {
          if (typeof g === 'string') return { text: str(g, 120), jdRef: '' };
          const gg = (g || {}) as Record<string, unknown>;
          return { text: str(gg.text, 120), jdRef: str(gg.jdRef, 120) };
        })
        .filter((g) => g.text)
        .slice(0, 5),
      advice: strArray(summary.advice, 4, 120),
    },
  };
}

/**
 * 证据原句是否真的出现在回答里（确定性护栏）。
 * 先做归一化子串匹配；不中再按「首次命中的 6 字锚点」取近似窗口做编辑距离（容错 10%，不允许改词序）。
 */
export function isEvidenceGrounded(evidence: string, source: string): boolean {
  const ev = normalizeForMatch(evidence);
  const src = normalizeForMatch(source);
  if (!ev || ev.length < MOCK_MIN_EVIDENCE_CHARS) return false;
  if (!src) return false;
  if (src.includes(ev)) return true;
  // 锚点定位：取证据中最长的 6 字片段，若在原文中出现，则以它为中心截近似窗口比较
  let anchor = '';
  for (let i = 0; i + 6 <= ev.length; i += 3) {
    const seg = ev.slice(i, i + 6);
    if (src.includes(seg)) { anchor = seg; break; }
  }
  if (!anchor) return false;
  const at = src.indexOf(anchor);
  const windowLen = Math.min(src.length, Math.round(ev.length * 1.2));
  const start = Math.max(0, Math.min(src.length - windowLen, at - Math.round(ev.length * 0.5)));
  const win = src.slice(start, start + windowLen);
  const dist = levenshtein(ev, win);
  const allowed = Math.ceil(ev.length * 0.1);
  // 允许 10% 编辑距离（模型可能补语气词/改标点），超过即视为改写引用
  return dist <= Math.max(allowed, 2) && Math.abs(win.length - ev.length) <= Math.ceil(ev.length * 0.15);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

/** 体征只挂在有录音的作答上；不在评分函数里计算，避免「顺带加分」的诱惑 */
function withDelivery(result: MockQuestionResult, attempt: MockAttempt | null): MockQuestionResult {
  return attempt?.delivery ? { ...result, delivery: attempt.delivery } : result;
}

function answerSource(attempt: MockAttempt): string {
  const probes = (attempt.probes || []).map((p) => p.answer).filter(Boolean).join('\n');
  return [attempt.answer || '', probes].filter(Boolean).join('\n');
}

/** 单题：把 AI 的档位输出折算成维度分（含证据护栏）。导出以便离线回归脚本直接断言「无证据 → 压分」。 */
export function buildQuestionResult(
  question: MockQuestion,
  attempt: MockAttempt | null,
  ai: AIQuestionScore | null,
): MockQuestionResult {
  const skipped = !attempt || attempt.skipped;
  const answer = attempt?.answer || '';
  const probes = (attempt?.probes || []).map((p) => ({ question: p.question, answer: p.answer }));
  const source = attempt ? answerSource(attempt) : '';
  const dimensionScores: Partial<Record<MockDimensionKey, number | null>> = {};
  const dimensionEvidence: Partial<Record<MockDimensionKey, string>> = {};
  let invalidEvidence = false;

  if (skipped || !answer.trim()) {
    // 未作答 → N/A（不按 0 分），报告文案「未作答」
    for (const key of MOCK_DIMENSION_KEYS) dimensionScores[key] = null;
    return {
      questionId: question.id,
      questionText: question.text,
      phase: question.phase,
      answer,
      probes,
      dimensionScores,
      dimensionEvidence,
      evidenceState: 'insufficient',
      evidenceSource: 'rule',
      invalidEvidence: false,
      scoredWith: probes.length ? 'withProbes' : 'main',
      hitPoints: [],
      missedPoints: [],
      suggestion: '',
      skipped: true,
      keyPointsFrom: question.keyPointsFrom,
      score: null,
    };
  }

  for (const key of MOCK_DIMENSION_KEYS) {
    const d = ai?.dimensions?.[key];
    if (!ai || !d) { dimensionScores[key] = null; continue; }
    if (d.na) { dimensionScores[key] = null; continue; }
    const raw = levelToScore(d.level, d.pos);
    if (raw == null) { dimensionScores[key] = null; continue; }
    const grounded = isEvidenceGrounded(d.evidence, source);
    if (!grounded) invalidEvidence = true;
    dimensionScores[key] = grounded ? raw : Math.min(raw, MOCK_EVIDENCE_SCORE_CAP);
    if (d.evidence) dimensionEvidence[key] = d.evidence;
  }

  // 单题分与总分同一口径：按 4+1 维权重加权（仅适用维度参与，权重归一化），
  // 不用「五维简单平均」——那会让「复盘与权衡(10%)」和「相关性(30%)」等权，与总分算法不自洽。
  const applicable = MOCK_DIMENSIONS.filter((d) => typeof dimensionScores[d.key] === 'number');
  const weightSum = applicable.reduce((sum, d) => sum + d.weight, 0);
  const score = weightSum > 0
    ? Math.round(applicable.reduce((sum, d) => sum + (dimensionScores[d.key] as number) * d.weight, 0) / weightSum)
    : null;

  const att = attempt as MockAttempt;
  return {
    questionId: question.id,
    questionText: question.text,
    phase: question.phase,
    answer,
    probes,
    dimensionScores,
    dimensionEvidence,
    evidenceState: att.evidenceState || 'partial',
    evidenceSource: att.evidenceSource || 'ai',
    invalidEvidence,
    scoredWith: probes.length ? 'withProbes' : 'main',
    hitPoints: ai?.hitPoints || [],
    missedPoints: ai?.missedPoints || [],
    suggestion: ai?.suggestion || '',
    skipped: false,
    keyPointsFrom: question.keyPointsFrom,
    score,
    deliveryNote: ai?.deliveryNote || '',
  };
}

/** 维度分 = 该维在所有适用题目上的均值；总分 = 维度分按权重加权（N/A 不参与，权重按比例归一化） */
export function aggregateReport(
  questions: MockQuestionResult[],
  bandsInput: { deliveryAdvice: string; summary: { gaps: { text: string; jdRef?: string }[]; advice: string[] } },
  reverse: MockReport['reverse'],
  aiAvailable: boolean,
): MockReport {
  const dimensions: MockDimensionResult[] = MOCK_DIMENSIONS.map((d) => {
    const vals = questions
      .map((q) => q.dimensionScores[d.key])
      .filter((v): v is number => typeof v === 'number');
    return {
      key: d.key,
      label: d.label,
      weight: d.weight,
      score: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null,
      na: vals.length === 0,
      naReason: vals.length === 0 ? '本场没有可评的题目' : undefined,
    };
  });

  const applicable = dimensions.filter((d) => d.score != null);
  const weightSum = applicable.reduce((s, d) => s + d.weight, 0);
  const total = weightSum > 0
    ? Math.round(applicable.reduce((s, d) => s + (d.score as number) * d.weight, 0) / weightSum)
    : null;

  return {
    rubricVersion: MOCK_RUBRIC_VERSION,
    dimensions,
    total,
    band: bandForScore(total),
    questions,
    reverse,
    summary: bandsInput.summary,
    deliveryAdvice: bandsInput.deliveryAdvice,
    delivery: aggregateDelivery(questions.map((q) => q.delivery).filter((d): d is NonNullable<typeof d> => Boolean(d))),
    aiAvailable,
    generatedAt: Date.now(),
  };
}

/**
 * 有效题量不足时必须在报告里说清楚（评审 P1-1）：
 * 跳过超过 1/3 时样本不足，分数只能「仅供参考」，不能当成一场完整面试的结论。
 */
function annotateCoverage(report: MockReport, session: MockSession): MockReport {
  const total = session.questions.length;
  if (!total) return report;
  const skipped = session.questions.filter((q) => {
    const a = latestAttempt(session, q.id);
    return !a || a.skipped;
  }).length;
  if (skipped > total / 3) {
    report.summary.advice = [
      `本场跳过或未作答 ${skipped}/${total} 题，有效题量不足，分数仅供参考。`,
      ...report.summary.advice,
    ].slice(0, 5);
  }
  return report;
}

/** AI 不可用时的报告：只给逐题转写，不给分数也不给档位（不造假分数） */
export function buildFallbackReport(session: MockSession, reason: string): MockReport {
  const questions = session.questions.map((q) => {
    const att = latestAttempt(session, q.id);
    return withDelivery(buildQuestionResult(q, att, null), att);
  });
  const report = aggregateReport(questions, { deliveryAdvice: '', summary: { gaps: [], advice: [] } }, session.reverse, false);
  report.summary.advice = [`AI 评分不可用：${reason}`, '可先对照自己的回答检查：每个结论有没有数字或事实支撑、有没有说清口径。'];
  return report;
}

export async function buildReport(
  session: MockSession,
  ctx: MockEngineContext,
): Promise<{ ok: boolean; report: MockReport; error?: string }> {
  const answered = session.questions.filter((q) => {
    const a = latestAttempt(session, q.id);
    return Boolean(a && !a.skipped && String(a.answer || '').trim());
  });
  if (!answered.length) {
    return { ok: false, report: buildFallbackReport(session, '本场没有有效作答'), error: '本场没有有效作答' };
  }

  // 逐题按固定上限裁剪，而不是让 fitContextToTokens 从尾部截断——
  // 后者会把「最后几道题」整段丢掉，等于这几题永远拿不到评分。
  const transcript = answered.map((q) => {
    const a = latestAttempt(session, q.id) as MockAttempt;
    const probes = (a.probes || [])
      .map((p) => `追问：${p.question}\n补答：${clip(p.answer, 300)}`)
      .join('\n');
    return [
      `[id:${q.id}] 题目：${q.text}`,
      `题型：${q.category}｜考察点：${q.focus.join('；') || '（无）'}${q.jdRef ? `｜JD 要求：${q.jdRef}` : ''}`,
      `回答：${clip(a.answer, 900)}`,
      probes ? `追问记录：\n${probes}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const parts = fitParts(
    ctx,
    {
      resume: { text: ctx.resumeText || '', weight: 0.25 },
      jd: { text: session.job.jdText || '', weight: 0.2 },
      transcript: { text: transcript, weight: 0.55 },
    },
    6000,
  );
  const user = [
    `岗位：${session.job.jobTitle || ''}${session.job.company ? ` · ${session.job.company}` : ''}`,
    `面试官类型：${ROLE_HINT[session.config.role]}`,
    '【简历原文】',
    parts.resume || '（无）',
    '【JD 原文】',
    parts.jd || '（无）',
    '【本场问答（含追问补答，评分必须把补答计入该题）】',
    parts.transcript,
    `请按 json 输出对以上 ${answered.length} 道题的评分。`,
  ].join('\n');

  try {
    const raw = await callModel(jsonMessages(REPORT_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 6000,
      purpose: '模拟面试报告评分',
    });
    const payload = normalizeScorePayload(raw);
    if (!payload.questions.length) throw new Error('AI 未返回逐题评分');
    const byId = new Map(payload.questions.map((q) => [q.questionId, q]));
    const results = session.questions.map((q) => {
      const att = latestAttempt(session, q.id);
      return withDelivery(buildQuestionResult(q, att, byId.get(q.id) || null), att);
    });
    const report = aggregateReport(
      results,
      { deliveryAdvice: payload.deliveryAdvice, summary: payload.summary },
      session.reverse,
      true,
    );
    return { ok: true, report: annotateCoverage(report, session) };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    return { ok: false, report: annotateCoverage(buildFallbackReport(session, msg), session), error: msg };
  }
}

/** 重答后只重算该题：用一次单题评分替换该题结果，其余题保持不动，再整体重新聚合 */
export async function rescoreAnswer(
  session: MockSession,
  questionId: string,
  ctx: MockEngineContext,
): Promise<{ ok: boolean; result?: MockQuestionResult; error?: string }> {
  const q = session.questions.find((x) => x.id === questionId);
  const a = latestAttempt(session, questionId);
  if (!q || !a || a.skipped || !String(a.answer || '').trim()) return { ok: false, error: '该题没有可评分的回答' };
  const probes = (a.probes || []).map((p) => `追问：${p.question}\n补答：${p.answer}`).join('\n');
  const user = [
    `岗位：${session.job.jobTitle || ''}`,
    `题目：${q.text}`,
    `考察点：${q.focus.join('；')}`,
    q.jdRef ? `JD 要求：${q.jdRef}` : '',
    '【简历原文】',
    resumeTextOf(ctx),
    '【回答（含追问补答）】',
    `[id:${q.id}] 回答：${a.answer}${probes ? `\n${probes}` : ''}`,
    '请只对这一道题按 json 输出评分（questions 数组只含这一题）。',
  ].filter(Boolean).join('\n');
  try {
    const raw = await callModel(jsonMessages(REPORT_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 1800,
      purpose: '模拟面试单题重评',
    });
    const payload = normalizeScorePayload(raw);
    const ai = payload.questions.find((x) => x.questionId === q.id) || payload.questions[0] || null;
    return { ok: true, result: withDelivery(buildQuestionResult(q, a, ai), a) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// ===== 反问环节（事实边界见方案 5.5.1） =====

const REVERSE_SYSTEM = `你在模拟面试的反问环节，以面试官身份回答候选人的提问。只输出 json：
{"refused":false,"answer":"回答","questionComment":"只评价候选人这个提问好不好（是否体现岗位理解、是否空泛、是否踩到禁区），不评价回答对不对"}
硬约束：
1. 你的信息只有四样：JD 原文、岗位名、公司名、公开行业常识。**不得推断**组织架构与汇报线、HC 与招聘进度、薪资与期权区间、团队规模与人员构成、内部技术选型与在研项目。
2. 遇到上述禁区（如「团队多少人」「汇报给谁」「现在用什么技术栈」「薪资多少」「还有 HC 吗」）：
   refused 设为 true，answer 固定为：「这个我在这儿没法替公司回答，真实情况得你到面试时问。建议你从这个角度准备：……」后接一句可执行的准备建议。
3. 回答里不得出现具体的团队人数、薪资数字、内部系统名或任何 JD 之外的公司事实；宁可说「JD 里没写」也不要编。
4. answer 控制在 120 字以内，口语化。`;

export async function answerReverse(
  session: MockSession,
  question: string,
  ctx: MockEngineContext,
): Promise<{ ok: boolean; turn: MockReport['reverse']; error?: string }> {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) return { ok: false, turn: null, error: '问题为空' };
  const jd = fitParts(ctx, { jd: { text: session.job.jdText || '', weight: 1 } }, 2000).jd || '';
  const user = [
    `岗位：${session.job.jobTitle || ''}${session.job.company ? ` · ${session.job.company}` : ''}`,
    '【JD 原文】',
    jd || '（无）',
    `候选人的提问：${q}`,
  ].join('\n');
  try {
    const raw = await callModel(jsonMessages(REVERSE_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 900,
      purpose: '模拟面试反问环节',
    });
    const obj = (raw || {}) as Record<string, unknown>;
    const refused = obj.refused === true;
    const answer = str(obj.answer, 500);
    return {
      ok: true,
      turn: {
        question: q,
        // 违反白名单（refused=true）的回答不入存档，只保留用户提问与点评
        answer: refused ? '' : answer,
        kept: !refused,
        comment: str(obj.questionComment, 300),
        askedAt: Date.now(),
      },
    };
  } catch (e) {
    return { ok: false, turn: null, error: String((e as Error)?.message || e) };
  }
}

/** 反问未完成 / 失败时的占位（报告里标注「未完成反问」，不影响分数） */
export function emptyReverseTurn(): MockReport['reverse'] {
  return null;
}

// ===== 改写回答（只引用真实事实） =====

const REWRITE_SYSTEM = `你在帮求职者改写一段面试回答，让它更有结构、更有证据。只输出 json：
{"rewritten":"改写后的回答","gaps":["需要用户自己补充的真实细节1","细节2"]}
硬约束：
1. 只能使用「用户原答」与「简历原文」里已存在的事实、数字、公司名、项目名、时间。
2. **不得新增任何数字**。原文没有的数字一个都不能出现；需要数字才能说清的地方，写进 gaps 让用户自己补。
3. 不得虚构经历、职责、证书、学历；不得承诺薪资、到岗时间、面试时间。
4. 结构建议：结论先行 → 背景/目标 → 你做了什么 → 结果与口径 → 复盘。保留求职者第一人称口吻。
5. 篇幅不超过原答的 1.6 倍（原文很短时可到 400 字以内），不要注水。`;

/** 提取文本中的所有数字（含小数、百分比），用于改写稿的确定性防编造校验 */
export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) out.add(m[0]);
  return Array.from(out);
}

export async function rewriteAnswer(
  session: MockSession,
  questionId: string,
  ctx: MockEngineContext,
): Promise<{ ok: boolean; rewritten?: string; gaps: string[]; blocked?: boolean; error?: string }> {
  const q = session.questions.find((x) => x.id === questionId);
  const a = latestAttempt(session, questionId);
  if (!q || !a || !String(a.answer || '').trim()) return { ok: false, gaps: [], error: '没有可改写的回答' };
  const resume = resumeTextOf(ctx);
  const tier = resolveSchoolTier(ctx.profile?.facts?.education || [], ctx.resumeText || '');
  const disclosure = buildSchoolDisclosureRule(tier);
  const user = [
    `岗位：${session.job.jobTitle || ''}`,
    `题目：${q.text}`,
    disclosure ? `【校名披露规则】${disclosure}` : '',
    '【简历原文】',
    resume || '（无）',
    '【用户原答】',
    a.answer,
  ].filter(Boolean).join('\n');
  try {
    const raw = await callModel(jsonMessages(REWRITE_SYSTEM, user), ctx.model, {
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 1800,
      purpose: '模拟面试改写回答',
    });
    const obj = (raw || {}) as Record<string, unknown>;
    const rewritten = str(obj.rewritten, 2000);
    const gaps = strArray(obj.gaps, 5, 120);
    if (!rewritten) return { ok: false, gaps, error: 'AI 未返回改写内容' };
    // 确定性校验：改写稿里每个数字都必须能在原答或简历中找到同值（找不到即判定编造）
    const allowed = new Set([...extractNumbers(a.answer), ...extractNumbers(ctx.resumeText || '')]);
    const invented = extractNumbers(rewritten).filter((n) => !allowed.has(n));
    if (invented.length) {
      return {
        ok: false,
        gaps: [...gaps, `以下数字无法在简历或原答中找到，请自行确认后再使用：${invented.join('、')}`],
        blocked: true,
        error: '改写稿包含原答与简历中不存在的数字，已回退为原答',
      };
    }
    return { ok: true, rewritten, gaps };
  } catch (e) {
    return { ok: false, gaps: [], error: String((e as Error)?.message || e) };
  }
}

// ===== 会话推进的纯函数部分（页面/ store 共用，便于回归测试） =====

/** 当前阶段的下一个状态（回答提交后如何推进） */
export function nextStatusAfterAdvance(
  question: MockQuestion,
  hasNextInPhase: boolean,
): { status: MockSessionStatus; phase: 1 | 2 | 3 } {
  if (hasNextInPhase) return { status: 'running', phase: question.phase };
  if (question.phase === 1) return { status: 'planning', phase: 2 };
  return { status: 'reverse', phase: 3 };
}

/** 是否允许插题：每阶段最多 1 道、全场最多 2 道（方案 4.4） */
export function canInject(session: MockSession, phase: 1 | 2): boolean {
  const injected = session.questions.filter((q) => q.kind === 'injected');
  return injected.length < 2 && injected.filter((q) => q.phase === phase).length < 1;
}

/** 该题已用追问轮次（取当前 attempt 的 probes 长度） */
export function probeCount(attempt: MockAttempt | null): number {
  return attempt ? (attempt.probes || []).length : 0;
}

/** 汇总「已答 / 当前 / 待答」进度（栏②进度点用） */
export function questionProgress(session: MockSession): { answered: number; total: number; index: number } {
  const answeredIds = new Set(session.attempts.filter((a) => !a.skipped).map((a) => a.questionId));
  const idx = session.currentQuestionId
    ? session.questions.findIndex((q) => q.id === session.currentQuestionId)
    : -1;
  return { answered: answeredIds.size, total: session.questions.length, index: idx };
}

/** 生成报告后把逐题结果回写到 attempt（分数 / 依据 / 命中漏答） */
export function applyReportToAttempts(session: MockSession, report: MockReport): MockSession {
  const attempts = session.attempts.map((a) => {
    const r = report.questions.find((q) => q.questionId === a.questionId);
    if (!r || a.skipped) return a;
    // 只回写该题最近一次 attempt（重答后旧 attempt 保留原分数，用于对比）
    const latest = latestAttempt(session, a.questionId);
    if (!latest || latest.id !== a.id) return a;
    return {
      ...a,
      dimensionScores: r.dimensionScores,
      dimensionEvidence: r.dimensionEvidence,
      invalidEvidence: r.invalidEvidence,
      hitPoints: r.hitPoints,
      missedPoints: r.missedPoints,
      suggestion: r.suggestion,
      score: r.score,
      scoredWith: r.scoredWith,
      keyPointsFromAtScore: r.keyPointsFrom,
    };
  });
  return { ...session, attempts, report };
}

/** 评分是否可用（UI 判断显示分数还是「评估不可用」） */
export function reportHasScore(report: MockReport | null): boolean {
  return Boolean(report && report.aiAvailable && report.total != null);
}

/** 维度档位文案（进度条颜色用）：null = N/A */
export function dimensionTone(score: number | null): 'ok' | 'warn' | 'bad' | 'na' {
  if (score == null) return 'na';
  if (score >= 70) return 'ok';
  if (score >= 50) return 'warn';
  return 'bad';
}

export { MOCK_DIMENSION_KEYS, LEVEL_SCORE, levelToScore, bandForScore };
