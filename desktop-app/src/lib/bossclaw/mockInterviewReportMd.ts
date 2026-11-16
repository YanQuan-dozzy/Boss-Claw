// 模拟面试 · 单场报告 Markdown（纯函数，零依赖）
//
// 用途：把一份会话导成可粘贴、可归档的 .md。为什么不是 JSON：
// JSON 导出是「备份全部会话」，用户拿到之后并不能读；这里要的是「这一场的复盘」，
// 落到 Markdown 才能贴进笔记软件、发给朋友或打印出来对照练习。
//
// 口径要求（与界面完全一致，不能出现两套说法）：
//   · 分数由本地按维度权重计算，模型只给档位；同一份回答重算恒定；
//   · N/A 不按 0 分算，也不参与加权；
//   · 表达体征单独一节，明写「不计入内容分」；
//   · 不出现录用概率、人格、情绪等推断（OfferU 的 prohibited_outputs 口径）。

import type { MockSession } from './mockInterviewTypes';
import {
  MOCK_CATEGORY_LABELS,
  MOCK_DIFFICULTY_LABELS,
  MOCK_EVIDENCE_LABELS,
  MOCK_PROBE_INTENT_LABELS,
  MOCK_ROLE_LABELS,
} from './mockInterviewTypes';
import type { MockCompareResult } from './mockInterviewCompare';
import { formatDelta } from './mockInterviewCompare';
import { formatDuration, interviewTiming } from './mockInterviewInsights';

export interface MockRewriteNote {
  text: string;
  gaps: string[];
  blocked?: boolean;
}

/** 导出用的跨场次洞察（只取展示所需字段，避免把 store 类型引进来） */
export interface MarkdownInsights {
  sessionCount: number;
  points: { text: string; sessions: number; count: number }[];
  dims: { key: string; label: string; avg: number | null }[];
}

export interface MarkdownOptions {
  /** 报告页里已经生成过的改写稿，按题目 id 索引 */
  rewrites?: Record<string, MockRewriteNote>;
  /** 同岗位上一场的对比结果（没有就不输出对比小节） */
  compare?: MockCompareResult | null;
  /** 同岗位近几场的弱项聚合（没有就不输出长期弱项小节） */
  insights?: MarkdownInsights | null;
  /** 是否为追练场次（本场由上一场的缺口生成） */
  drillFrom?: number | null;
}

/** 本地时间 `YYYY-MM-DD HH:mm`；导出与界面共用，避免两处各写一份补零逻辑 */
export function formatDateTime(ts: number | null | undefined): string {
  const n = Number(ts || 0);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quote(text: string): string {
  const body = String(text || '').trim();
  if (!body) return '> （未作答）';
  // 多行回答逐行加 '>'，否则换行会把引用块切断
  return body
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * 生成单场报告 Markdown。
 * 纯函数：不读系统时间、不读文件，所有输入来自 session（因此可被回归脚本固定断言）。
 */
export function buildReportMarkdown(session: MockSession, opts: MarkdownOptions = {}): string {
  const s = session;
  const report = s.report;
  const lines: string[] = [];
  const title = s.job.jobTitle || '模拟面试';
  const rewrites = opts.rewrites || {};

  lines.push(`# 模拟面试报告 · ${title}`, '');

  const meta: string[] = [];
  if (s.job.company) meta.push(`- 公司：${s.job.company}`);
  meta.push(`- 面试官：${MOCK_ROLE_LABELS[s.config.role]} · ${MOCK_DIFFICULTY_LABELS[s.config.difficulty]}`);
  meta.push(`- 时间：${formatDateTime(s.finishedAt || s.updatedAt)}`);
  if (s.startedAt && s.finishedAt && s.finishedAt > s.startedAt) {
    meta.push(`- 用时：${Math.max(1, Math.round((s.finishedAt - s.startedAt) / 60000))} 分钟`);
  }
  const answered = s.questions.filter((q) => s.attempts.some((a) => a.questionId === q.id)).length;
  meta.push(`- 题量：${s.questions.length} 题（已答 ${answered}）`);
  if (report) meta.push(`- 评分口径：v${report.rubricVersion}（本地确定性计算，模型只给档位）`);
  lines.push(...meta, '');

  if (opts.drillFrom) {
    lines.push(`> 本场是针对上一场（${formatDateTime(opts.drillFrom)}）暴露的缺口追练的。`, '');
  }

  if (!report) {
    lines.push('## 报告尚未生成', '', '这场面试没有生成报告，只保留回答转录。', '');
  } else if (!report.aiAvailable || report.total == null) {
    lines.push(
      '## 分数',
      '',
      '**AI 评估不可用，本场不显示分数。**',
      '',
      '既然评不出来就不给一个看起来像真的数字，下面只保留回答转录。',
      '',
    );
  } else {
    lines.push('## 总分', '');
    lines.push(`**${report.total} / 100**${report.band ? ` · ${report.band.label}` : ''}`, '');
    lines.push('分数由本地按维度权重计算，同一份回答重算结果恒定。档位只描述这场答得够不够硬，不预测录用结果。', '');

    lines.push('## 维度分', '');
    lines.push('| 维度 | 权重 | 得分 |');
    lines.push('| --- | --- | --- |');
    for (const d of report.dimensions) {
      lines.push(`| ${d.label} | ${Math.round(d.weight * 100)}% | ${d.na ? '不适用' : d.score} |`);
    }
    lines.push('', 'N/A（不适用 / 未作答）的维度不参与加权，剩余权重按比例归一化，不按 0 分处理。', '');
  }

  // ===== 与上一场对比 =====
  const cmp = opts.compare;
  if (cmp) {
    lines.push('## 与上一场对比', '');
    lines.push(`上一场：${formatDateTime(cmp.prev.finishedAt)} · ${cmp.prev.total == null ? '无分' : `${cmp.prev.total} 分`}${cmp.prev.band ? `（${cmp.prev.band}）` : ''}`, '');
    if (!cmp.comparable) {
      lines.push(`> 注意：${cmp.notes.join('；')}。下面的差值仅供参考，不要当成同一把尺子下的进步。`, '');
    }
    lines.push(`总分：${formatDelta(cmp.totalDelta)}`, '');
    lines.push('| 维度 | 上一场 | 本场 | 变化 |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of cmp.dims) {
      lines.push(`| ${d.label} | ${d.prev == null ? 'N/A' : d.prev} | ${d.cur == null ? 'N/A' : d.cur} | ${formatDelta(d.delta)} |`);
    }
    lines.push('');
  }

  // ===== 逐题复盘 =====
  if (report) {
    lines.push(`## 逐题复盘（${report.questions.length} 题）`, '');
    report.questions.forEach((r, i) => {
      const q = s.questions.find((x) => x.id === r.questionId);
      const tags: string[] = [];
      if (q) tags.push(MOCK_CATEGORY_LABELS[q.category]);
      if (r.skipped) tags.push('跳过');
      tags.push(`证据${MOCK_EVIDENCE_LABELS[r.evidenceState]}（${r.evidenceSource === 'rule' ? '规则判定' : 'AI 判定'}）`);
      tags.push(r.scoredWith === 'withProbes' ? `基于主答 + 追问 ${r.probes.length} 轮` : '基于主答');
      if (r.keyPointsFrom === 'bank') tags.push('题库要点');
      else if (r.keyPointsFrom === 'none') tags.push('无要点依据');
      else tags.push('AI 推断要点');

      lines.push(`### ${i + 1}. ${r.questionText}`, '');
      lines.push(`\`${tags.join(' · ')}\``, '');
      lines.push(`**得分：${r.score == null ? (r.skipped ? '未作答' : '无法评分') : r.score}**`, '');
      const dimLine = report.dimensions
        .map((d) => `${d.label} ${r.dimensionScores[d.key] == null ? 'N/A' : r.dimensionScores[d.key]}`)
        .join(' · ');
      lines.push(dimLine, '');

      lines.push('**我的回答**', '', quote(r.answer), '');
      for (const p of r.probes) {
        const tag = p.intent ? `（${MOCK_PROBE_INTENT_LABELS[p.intent]}）` : '';
        lines.push(`**追问**${tag}：${p.question}`, '', '**补答**', '', quote(p.answer), '');
      }
      if (r.hitPoints.length) lines.push(`- 命中：${r.hitPoints.join('、')}`);
      if (r.missedPoints.length) lines.push(`- 漏答：${r.missedPoints.join('、')}`);
      if (r.suggestion) lines.push(`- 建议：${r.suggestion}`);
      if (r.delivery) {
        lines.push(
          `- 语音：${r.delivery.durationSec}s · 语速 ${r.delivery.charsPerMinute} 字/分 · 长停顿 ${r.delivery.longPauses} 次 · 口头禅 ${r.delivery.fillerTotal} 次`,
        );
      }
      if (r.invalidEvidence) lines.push('- ⚠️ 引用的原句未能在回答中定位，相关维度已按无证据压分');
      lines.push('');

      const rw = rewrites[r.questionId];
      if (rw && (rw.text || rw.gaps.length)) {
        lines.push('**改写稿**（只引用你的原答与简历事实）', '');
        lines.push(rw.text ? quote(rw.text) : '> （未生成：数字校验未通过，已回退为原答）', '');
        if (rw.gaps.length) {
          lines.push('需要你自己补充的真实细节：');
          for (const g of rw.gaps) lines.push(`- ${g}`);
          lines.push('');
        }
      }
    });
  }

  // ===== 反问 =====
  if (report?.reverse) {
    lines.push('## 反问环节', '');
    lines.push(`**我的提问**：${report.reverse.question}`, '');
    if (report.reverse.kept && report.reverse.answer) {
      lines.push(quote(report.reverse.answer), '');
      lines.push('_基于 JD 的模拟回答，不代表该公司真实情况。_', '');
    } else {
      lines.push('该提问涉及公司内部信息，模拟回答未存入报告。', '');
    }
    if (report.reverse.comment) lines.push(`**提问点评**：${report.reverse.comment}`, '');
  }

  // ===== 作答节奏（本地记录，不参与内容分） =====
  const timing = interviewTiming(s);
  if (timing.answered > 0) {
    lines.push('## 作答节奏（不计入内容分）', '');
    lines.push(`- 作答用时：${formatDuration(timing.totalMs)}（${timing.answered} 题）`);
    lines.push(`- 平均每题：${formatDuration(timing.avgMs)}`);
    if (timing.longest) {
      const q = s.questions.find((x) => x.id === timing.longest!.questionId);
      lines.push(`- 最长一题：${formatDuration(timing.longest.ms)}${q ? `（${q.text}）` : ''}`);
    }
    lines.push('', '用时只描述节奏，不参与内容分，也不代表答得好不好。', '');
  }

  // ===== 体征 =====
  const d = report?.delivery;
  if (d) {
    lines.push('## 表达体征（不计入内容分）', '');
    lines.push(`- 语速：${d.charsPerMinute} 字/分`);
    lines.push(`- 长停顿：${d.longPauses} 次（≥1.5s）`);
    lines.push(`- 口头禅：${d.fillerTotal} 次${d.fillerTotal ? `（${Object.entries(d.fillerWords).map(([k, v]) => `${k}×${v}`).join(' ')}）` : ''}`);
    lines.push(`- 有声占比：${Math.round((d.speechRatio || 0) * 100)}%（录音合计 ${Math.round(d.durationSec)}s）`);
    lines.push('');
    if (report?.deliveryAdvice) lines.push(`表达建议（AI 主观，不给分）：${report.deliveryAdvice}`, '');
  } else if (report) {
    lines.push('## 表达体征', '', '本场没有录音作答，无体征数据。', '');
  }

  // ===== 总结 =====
  if (report && (report.summary.gaps.length || report.summary.advice.length)) {
    lines.push('## 总结', '');
    if (report.summary.gaps.length) {
      lines.push('**最该补的缺口**', '');
      for (const g of report.summary.gaps) {
        lines.push(`- ${g.text}${g.jdRef ? `（JD：${g.jdRef}）` : ''}`);
      }
      lines.push('');
    }
    if (report.summary.advice.length) {
      lines.push('**可执行建议**', '');
      report.summary.advice.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
      lines.push('');
    }
  }

  // ===== 长期弱项（跨场次，本地统计） =====
  const ins = opts.insights;
  if (ins && ins.sessionCount > 1 && ins.points.length) {
    lines.push(`## 长期弱项（同岗位近 ${ins.sessionCount} 场）`, '');
    for (const p of ins.points.slice(0, 5)) {
      lines.push(`- ${p.text}（${p.sessions} 场都漏）`);
    }
    lines.push('');
    if (ins.dims.length) {
      lines.push('| 维度 | 长期均分 |');
      lines.push('| --- | --- |');
      for (const d of ins.dims) lines.push(`| ${d.label} | ${d.avg == null ? 'N/A' : d.avg} |`);
      lines.push('');
    }
    lines.push('_只统计同岗位、且至少两场都出现的漏答要点；跳过的题不算漏答。本地统计，不是 AI 判断。_', '');
  }

  // ===== 下一场重点（本地推断，不是 AI 结论） =====
  if (report) {
    const targets: string[] = [];
    if (cmp?.weakDimensions?.length) {
      targets.push(
        `维度补齐：${cmp.weakDimensions.map((w) => `${w.label}（${w.score == null ? 'N/A' : w.score}）`).join('、')} —— 这两项上一场之后没有提升。`,
      );
    }
    const missed = report.questions
      .filter((r) => !r.skipped && r.missedPoints.length)
      .slice(0, 3);
    for (const r of missed) {
      targets.push(`重答「${r.questionText}」，补上：${r.missedPoints.join('、')}`);
    }
    if (targets.length) {
      lines.push('## 下一场重点（本地从本场报告推出，不是 AI 结论）', '');
      targets.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
      lines.push('');
    }
  }

  lines.push('---', '', `由 BossClaw 模拟面试生成 · 会话 ${s.id}`, '');
  return lines.join('\n');
}

/** 导出文件名：`模拟面试-岗位-20261021.md`（去掉文件名非法字符，限制长度） */
export function reportFileName(session: MockSession): string {
  const raw = String(session.job.jobTitle || '模拟面试').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim();
  const title = (raw || '模拟面试').slice(0, 40);
  const d = new Date(session.finishedAt || session.updatedAt || Date.now());
  const p = (x: number) => String(x).padStart(2, '0');
  return `模拟面试-${title}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.md`;
}
