// 模拟面试 · 跨场次弱项聚合（纯函数，确定性）
//
// 为什么需要它：单场报告只能回答「这一场哪里没答好」，答不上「我到底总在漏什么」。
// 练到第五场时，用户真正想要的是后者。这里把同岗位最近若干场的漏答要点聚到一起，
// 只保留**至少两场都漏**的点——出现一次的可能只是这题特殊，出现两次以上才是习惯问题。
//
// 与「不做错题本」（方案决策 11）的关系：
//   决策 11 否决的是「独立的错题管理模块」（可增删改、排复习计划、跨岗位混在一起）。
//   这里做的是报告内的**只读聚合视图**，范围限定同岗位、数据只来自已有报告、不可编辑。
//   口径已写进方案 4.5 与决策 11 的修订说明，不是绕开决策。
//
// 聚类口径：归一化（去标点空白、小写）后，字符 bigram Jaccard ≥ 0.6 视为同一个缺口。
// 「没讲清楚归因方法」与「归因方法没讲清」会合并（实测 0.625）；「没说清口径」与
// 「没讲清口径」不会合并（0.33）——宁可分成两条，也不要把不同缺口揉成一条假结论。

import type { MockDimensionKey, MockReport, MockSession } from './mockInterviewTypes';
import { MOCK_DIMENSIONS } from './mockInterviewTypes';

/** 参与聚合的一场（只需要报告与时间，不搬整份会话） */
export interface InsightReport {
  id: string;
  finishedAt: number;
  report: MockReport;
}

export interface WeakPointStat {
  /** 归一化后的聚类键（同簇共用） */
  key: string;
  /** 展示用原文：取簇里最长的一条（信息量最大） */
  text: string;
  /** 被提到的总次数（同一场里重复提到会算多次，但 sessions 不会） */
  count: number;
  /** 涉及几场 */
  sessions: number;
  /** 最近一次出现的场次时间 */
  lastAt: number;
}

export interface DimensionAverage {
  key: MockDimensionKey;
  label: string;
  /** 跨场均值；全是 N/A 时为 null */
  avg: number | null;
  /** 参与平均的场次数 */
  count: number;
}

export interface InterviewTiming {
  /** 已提交的作答题数（不含跳过） */
  answered: number;
  /** 总作答时长（毫秒，只算有记录的题） */
  totalMs: number;
  /** 平均每题毫秒；没有记录时为 null */
  avgMs: number | null;
  /** 最长一题（毫秒），用于「哪类题最耗时」 */
  longest: { questionId: string; ms: number } | null;
}

const PUNCT_RE = /[\s\u3000，。、；：！？,.;:!?（）()【】\[\]"'“”‘’—\-…·]/g;

/** 归一化：去标点空白 + 小写，只用于聚类比较，不用于展示 */
export function normalizeWeakPoint(text: string): string {
  return String(text || '').toLowerCase().replace(PUNCT_RE, '');
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (!s) return set;
  if (s.length <= 2) { set.add(s); return set; }
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 相似阈值：低于它不合并。0.6 是实测折中（见文件头注释） */
export const WEAK_POINT_SIMILARITY = 0.6;
/** 太短的缺口描述（去标点后 <4 字）不参与相似合并，只做完全相同合并，避免「没说清」互相吃掉 */
const MIN_MERGE_LEN = 4;
/** 一个缺口至少在两场出现，才算「长期」 */
export const WEAK_POINT_MIN_SESSIONS = 2;

/**
 * 已知边界（审查 2026-10-21 C-2）：合并进簇时**不更新簇的 grams**，
 * 相似度始终对「该簇的首个样本」计算。因此 A≈B、B≈C 但 A≉C 时，C 会另起一簇（非链式合并）。
 * 这是刻意取舍：若按簇内任意成员判相似，A≈B≈C≈D 会一路「滚雪球」把语义不同的缺口并成一条，
 * 与文件头「宁可分成两条，也不要把不同缺口揉成一条假结论」的口径冲突。
 * 代价是跨度很大的同义改写会多出一行。若要改成「簇内代表向量」，必须同步更新回归脚本的期望值。
 */

interface Cluster {
  key: string;
  text: string;
  count: number;
  sessions: Set<string>;
  lastAt: number;
  grams: Set<string>;
}

/**
 * 聚合漏答要点。
 * @param reports 同岗位的历史报告（可含本场；按 finishedAt 不限顺序）
 * @param opts.minSessions 至少出现在几场里才算长期弱项（默认 2）
 */
export function aggregateWeakPoints(
  reports: InsightReport[],
  opts: { minSessions?: number } = {},
): WeakPointStat[] {
  const minSessions = Math.max(1, Number(opts.minSessions ?? WEAK_POINT_MIN_SESSIONS));
  const clusters: Cluster[] = [];
  const ordered = [...(reports || [])].sort((a, b) => Number(a.finishedAt || 0) - Number(b.finishedAt || 0));

  for (const rep of ordered) {
    const sid = rep.id;
    const at = Number(rep.finishedAt || 0);
    for (const q of rep.report?.questions || []) {
      if (q.skipped) continue; // 跳过不是「漏答」，是没答，混在一起会误导
      for (const raw of q.missedPoints || []) {
        const key = normalizeWeakPoint(raw);
        if (!key) continue;
        const grams = bigrams(key);
        let target: Cluster | null = null;
        if (key.length >= MIN_MERGE_LEN) {
          let best = 0;
          for (const c of clusters) {
            const sim = jaccard(grams, c.grams);
            if (sim >= WEAK_POINT_SIMILARITY && sim > best) { best = sim; target = c; }
          }
        } else {
          target = clusters.find((c) => c.key === key) || null;
        }
        if (target) {
          target.count += 1;
          target.sessions.add(sid);
          target.lastAt = Math.max(target.lastAt, at);
          if (String(raw).length > target.text.length) target.text = String(raw);
        } else {
          clusters.push({
            key,
            text: String(raw),
            count: 1,
            sessions: new Set([sid]),
            lastAt: at,
            grams,
          });
        }
      }
    }
  }

  return clusters
    .filter((c) => c.sessions.size >= minSessions)
    .map((c) => ({
      key: c.key,
      text: c.text,
      count: c.count,
      sessions: c.sessions.size,
      lastAt: c.lastAt,
    }))
    .sort((a, b) => {
      if (b.sessions !== a.sessions) return b.sessions - a.sessions;
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
      return a.key.localeCompare(b.key);
    });
}

/** 跨场维度均分（N/A 不参与，不按 0 分算） */
export function averageDimensions(reports: InsightReport[]): DimensionAverage[] {
  return MOCK_DIMENSIONS.map((d) => {
    const vals: number[] = [];
    for (const r of reports || []) {
      const hit = r.report?.dimensions?.find((x) => x.key === d.key);
      if (hit && !hit.na && hit.score != null) vals.push(Number(hit.score));
    }
    return {
      key: d.key,
      label: d.label,
      avg: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null,
      count: vals.length,
    };
  });
}

/**
 * 本场用时（只统计提交过的作答，跳过不计）。
 * 数据源是 attempt.durationMs（P1 起记录），纯本地，不参与内容分。
 */
export function interviewTiming(session: MockSession | null | undefined): InterviewTiming {
  const attempts = (session?.attempts || []).filter(
    (a) => !a.skipped && typeof a.durationMs === 'number' && Number(a.durationMs) > 0,
  );
  if (!attempts.length) return { answered: 0, totalMs: 0, avgMs: null, longest: null };
  const list = attempts.map((a) => ({ questionId: a.questionId, ms: Math.round(Number(a.durationMs)) }));
  const totalMs = list.reduce((s, x) => s + x.ms, 0);
  const longest = list.reduce((best, x) => (x.ms > best.ms ? x : best), list[0]);
  return {
    answered: list.length,
    totalMs,
    avgMs: Math.round(totalMs / list.length),
    longest,
  };
}

/** 毫秒 → 「3 分 20 秒」，报告里用；<1 分钟给「40 秒」 */
export function formatDuration(ms: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (!n) return '—';
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}
