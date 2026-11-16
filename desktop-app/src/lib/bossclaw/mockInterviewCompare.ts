// 模拟面试 · 场次对比（纯函数，确定性）
//
// 为什么单独一个文件：报告里「比上一场进步了没有」是用户最关心的一句话，
// 但这句话很容易变成不可核对的感觉。这里把口径定死：
//   · 只跟**同一个岗位**的**上一场已完成**比（jobId 优先，其次归一化岗位名 + 公司）；
//   · 只比得分位（总分 / 维度分），不比表达体征——后者受录音设备影响，跨场不可比；
//   · 面试官类型、难度、评分口径任一不同 → comparable=false，并逐条说明原因，
//     UI 照实显示「仅参考」，不给一个看起来精确却没有可比性的差值。
//
// 参考项目：JadeAI（雷达图 + 改进计划）、AI-Interview（历史场次跳回证据）、
// MemCoach（递进式训练）。它们共同的教训是「对比必须交代口径」，否则用户会把
// 难度不同带来的 8 分差当成自己的进步。

import type {
  MockDimensionKey,
  MockDifficulty,
  MockIndexEntry,
  MockInterviewRole,
  MockReport,
  MockSession,
} from './mockInterviewTypes';
import { MOCK_DIMENSIONS } from './mockInterviewTypes';

/** 参与对比的一场（只保留可比的字段，不塞整份报告进 store） */
export interface MockCompareSide {
  id: string;
  jobTitle: string;
  company: string;
  finishedAt: number;
  role: MockInterviewRole;
  difficulty: MockDifficulty;
  rubricVersion: number;
  total: number | null;
  band: string | null;
  questionCount: number;
  skippedCount: number;
  dimensions: { key: MockDimensionKey; label: string; score: number | null }[];
}

export interface MockDimensionDelta {
  key: MockDimensionKey;
  label: string;
  prev: number | null;
  cur: number | null;
  /** 两侧都有分才算得出差值；任一侧 N/A 时为 null（不按 0 分算） */
  delta: number | null;
}

export interface MockCompareResult {
  prev: MockCompareSide;
  cur: MockCompareSide;
  totalDelta: number | null;
  dims: MockDimensionDelta[];
  /** 同岗位 + 同面试官类型 + 同难度 + 同评分口径，才算严格可比 */
  comparable: boolean;
  /** 不可比的具体原因，逐条；comparable=true 时为空数组 */
  notes: string[];
  /** 这一场最该补的维度（可比的、分数最低且未提升的，最多 2 个） */
  weakDimensions: { key: MockDimensionKey; label: string; score: number | null }[];
}

/** 岗位名归一化：去空白与常见后缀噪声，仅用于「手填岗位」没有 jobId 时的同岗位判定 */
export function normJobTitle(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000·・,，。.、/|()（）[\]【】-]+/g, '')
    .replace(/(急招|招聘|诚聘|高薪|双休|五险一金|长期有效)$/g, '');
}

/** 会话 → 对比侧数据；没有报告时返回 null（未完成 / 评分不可用都不可比） */
export function compareSideOf(session: MockSession | null | undefined): MockCompareSide | null {
  if (!session || !session.report) return null;
  const report: MockReport = session.report;
  return {
    id: session.id,
    jobTitle: session.job.jobTitle || '',
    company: session.job.company || '',
    finishedAt: Number(session.finishedAt || report.generatedAt || session.updatedAt || 0),
    role: session.config.role,
    difficulty: session.config.difficulty,
    rubricVersion: Number(report.rubricVersion) || 0,
    total: report.total == null ? null : Number(report.total),
    band: report.band?.label || null,
    questionCount: report.questions.length,
    skippedCount: report.questions.filter((q) => q.skipped).length,
    dimensions: MOCK_DIMENSIONS.map((d) => {
      const hit = report.dimensions.find((x) => x.key === d.key);
      const score = hit && !hit.na && hit.score != null ? Number(hit.score) : null;
      return { key: d.key, label: d.label, score: Number.isFinite(score as number) ? score : null };
    }),
  };
}

/** 两场是否同一岗位：有 jobId 时以 jobId 为准，否则比「归一化岗位名 + 公司」 */
export function isSameJob(
  a: { jobId: string | null; jobTitle: string; company: string },
  b: { jobId: string | null; jobTitle: string; company: string },
): boolean {
  const aid = a.jobId == null ? '' : String(a.jobId).trim();
  const bid = b.jobId == null ? '' : String(b.jobId).trim();
  if (aid && bid) return aid === bid;
  if (normJobTitle(a.jobTitle) !== normJobTitle(b.jobTitle)) return false;
  // 岗位名相同但公司明确不同，视为两个岗位（同名岗位在不同公司不可比）
  const ac = String(a.company || '').trim();
  const bc = String(b.company || '').trim();
  if (ac && bc) return ac === bc;
  return true;
}

/**
 * 从历史索引里挑「上一场」：同岗位、已完成、有报告，且 finishedAt 早于当前场。
 * 多条时取最近的一条（确定性排序：finishedAt desc，同时间按 id desc）。
 */
export function pickPreviousEntry(
  list: MockIndexEntry[],
  current: MockSession,
): MockIndexEntry | null {
  const curAt = Number(current.finishedAt || current.updatedAt || Date.now());
  const candidates = (list || [])
    .filter((e) => e && e.id !== current.id)
    .filter((e) => e.status === 'finished')
    .filter((e) => isSameJob(
      { jobId: current.job.jobId, jobTitle: current.job.jobTitle, company: current.job.company },
      { jobId: e.jobId, jobTitle: e.jobTitle, company: e.company },
    ))
    .filter((e) => Number(e.finishedAt || 0) < curAt)
    // 没有总分说明那场 AI 评估不可用，拿它做基准没有意义
    .filter((e) => e.score != null);
  candidates.sort((a, b) => {
    const d = Number(b.finishedAt || 0) - Number(a.finishedAt || 0);
    return d !== 0 ? d : String(b.id).localeCompare(String(a.id));
  });
  return candidates[0] || null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 当前场 vs 上一场：算差值、判可比性、挑薄弱维度 */
export function diffSessions(prev: MockCompareSide | null, cur: MockCompareSide | null): MockCompareResult | null {
  if (!prev || !cur) return null;

  const totalDelta =
    prev.total == null || cur.total == null ? null : round1(cur.total - prev.total);

  const dims: MockDimensionDelta[] = cur.dimensions.map((d) => {
    const p = prev.dimensions.find((x) => x.key === d.key);
    const pv = p ? p.score : null;
    const delta = pv == null || d.score == null ? null : round1(d.score - pv);
    return { key: d.key, label: d.label, prev: pv, cur: d.score, delta };
  });

  const notes: string[] = [];
  if (prev.role !== cur.role) notes.push('面试官类型不同（出题取向不一样）');
  if (prev.difficulty !== cur.difficulty) notes.push('难度不同（压力面的分数天然更低）');
  if (prev.rubricVersion !== cur.rubricVersion) {
    notes.push(`评分口径不同（上一场 v${prev.rubricVersion}，本场 v${cur.rubricVersion}）`);
  }
  const comparable = notes.length === 0;

  // 薄弱维度：本场有分、且（上一场没有分 或 没有提升）
  const weak = dims
    .filter((d) => d.cur != null)
    .filter((d) => d.delta == null || d.delta <= 0)
    .sort((a, b) => Number(a.cur) - Number(b.cur))
    .slice(0, 2)
    .map((d) => ({ key: d.key, label: d.label, score: d.cur }));

  return { prev, cur, totalDelta, dims, comparable, notes, weakDimensions: weak };
}

/** 把差值格式化成展示文案（+4 / -3 / 持平 / —），保证 UI 与导出文案一致 */
export function formatDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return '—';
  if (delta === 0) return '持平';
  return delta > 0 ? `+${round1(delta)}` : `${round1(delta)}`;
}
