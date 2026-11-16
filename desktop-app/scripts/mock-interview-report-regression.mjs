// 模拟面试「报告对比 + Markdown 导出」回归断言（零新增依赖，esbuild 打包 TS 后离线执行）
//
// 为什么需要它：
//   · 对比差值一旦算错方向（把难度不同当成退步、把 N/A 当 0 分），用户会拿到一个
//     看起来精确但没有可比性的结论，而且界面上完全看不出错；
//   · Markdown 导出是「用户拿走的成品」，字段缺失 / N/A 写成 0 / 出现录用概率这类
//     推断，都是发出去之后才被发现的错误。
// 这两块都是纯函数，适合用固定 fixture 断言，不需要真实 AI 与文件系统。
//
// 用法：node scripts/mock-interview-report-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-report-'));
const outFile = join(outDir, 'bundle.cjs');

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || '值'} 不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}
function has(text, part, label) {
  if (!String(text).includes(part)) throw new Error(`${label || '文本'} 未包含 ${JSON.stringify(part)}`);
}
function hasNot(text, part, label) {
  if (String(text).includes(part)) throw new Error(`${label || '文本'} 不应包含 ${JSON.stringify(part)}`);
}

// ===== fixture =====
const T1 = Date.UTC(2026, 9, 18, 2, 0, 0); // 上一场
const T2 = Date.UTC(2026, 9, 20, 2, 0, 0); // 本场

const DIM_DEFS = [
  ['relevance', '相关性', 0.3],
  ['evidence', '证据具体性', 0.25],
  ['structure', '思路结构', 0.2],
  ['depth', '专业深度', 0.15],
  ['reflection', '复盘与权衡', 0.1],
];

function dims(scores) {
  // scores: { relevance: 80, depth: null } —— null 表示 N/A
  return DIM_DEFS.map(([key, label, weight]) => {
    const v = scores[key];
    const na = v == null;
    return { key, label, weight, score: na ? null : v, na, ...(na ? { naReason: '不适用' } : {}) };
  });
}

function questionResult(over = {}) {
  return {
    questionId: 'q1',
    questionText: '讲一个你把指标做上去的项目',
    phase: 1,
    answer: '我在上一家公司负责留存分析，把次日留存从 32% 提到 41%，口径是按注册次日登录算的。',
    probes: [{ question: '这 9 个点是怎么拆的？', answer: '拆成新人引导和推送两条线，引导贡献 6 个点。' }],
    dimensionScores: { relevance: 80, evidence: 76, structure: 72, depth: 65, reflection: null },
    dimensionEvidence: { relevance: '负责留存分析' },
    evidenceState: 'solid',
    evidenceSource: 'ai',
    invalidEvidence: false,
    scoredWith: 'withProbes',
    hitPoints: ['说清了指标口径'],
    missedPoints: ['没讲清楚归因方法'],
    suggestion: '把归因过程按「假设—验证」讲一遍。',
    skipped: false,
    keyPointsFrom: 'ai',
    score: 76,
    ...over,
  };
}

function session(over = {}) {
  const base = {
    id: 'sess-current-0001',
    version: 1,
    job: {
      jobId: 'job-1',
      jobTitle: '数据分析师',
      company: '示例科技',
      jdText: '负责用户增长分析，熟悉 SQL 与 AB 实验，能独立产出归因结论。',
      capturedAt: T1,
    },
    config: {
      role: 'tech',
      difficulty: 'standard',
      phase1Count: 4,
      phase2Count: 3,
      answerMode: 'text',
      readAloud: false,
      voiceId: 'zf_001',
      speechRate: 1,
      bankEnabled: true,
      recallTopK: 20,
    },
    status: 'finished',
    phase: 3,
    questions: [
      {
        id: 'q1',
        phase: 1,
        kind: 'planned',
        category: 'project',
        text: '讲一个你把指标做上去的项目',
        jdRef: '负责用户增长分析',
        focus: ['指标口径', '归因方法'],
        keyPointsFrom: 'ai',
      },
    ],
    attempts: [],
    currentQuestionId: null,
    pendingProbe: null,
    reverse: { question: '团队现在用什么数仓？', answer: '', kept: false, comment: '问题偏内部信息，面试时问更合适。', askedAt: T2 },
    report: null,
    retry: null,
    seq: 1,
    createdAt: T1,
    updatedAt: T2,
    startedAt: T1 + 60000,
    finishedAt: T2,
  };
  return { ...base, ...over };
}

function report(over = {}) {
  return {
    rubricVersion: 1,
    dimensions: dims({ relevance: 80, evidence: 76, structure: 72, depth: 65, reflection: null }),
    total: 76,
    band: { key: 'effective', label: '基本有效', min: 70 },
    questions: [questionResult()],
    reverse: null,
    summary: { gaps: [{ text: '归因方法没讲清', jdRef: '能独立产出归因结论' }], advice: ['用「假设—验证」结构复述一遍'] },
    deliveryAdvice: '',
    delivery: null,
    aiAvailable: true,
    generatedAt: T2,
    ...over,
  };
}

function indexEntry(over = {}) {
  return {
    id: 'sess-prev-0001',
    jobId: 'job-1',
    jobTitle: '数据分析师',
    company: '示例科技',
    role: 'tech',
    difficulty: 'standard',
    startedAt: T1,
    finishedAt: T1,
    status: 'finished',
    score: 72,
    band: '基本有效',
    rubricVersion: 1,
    phase1Count: 4,
    phase2Count: 3,
    injectedCount: 0,
    reverseAsked: false,
    updatedAt: T1,
    ...over,
  };
}

try {
  await build({
    entryPoints: [
      join(root, 'src/lib/bossclaw/mockInterviewCompare.ts'),
      join(root, 'src/lib/bossclaw/mockInterviewReportMd.ts'),
      join(root, 'src/lib/bossclaw/mockInterviewInsights.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: outDir,
    logLevel: 'silent',
  });
  const C = require(join(outDir, 'mockInterviewCompare.js'));
  const M = require(join(outDir, 'mockInterviewReportMd.js'));
  const I = require(join(outDir, 'mockInterviewInsights.js'));

  // ===== 1. 上一场挑选 =====
  check('挑上一场：同 jobId、已完成、早于本场，取最近一条', () => {
    const cur = session();
    const list = [
      indexEntry({ id: 'sess-current-0001' }),
      indexEntry({ id: 'sess-old-0001', finishedAt: T1 - 86400000, score: 60 }),
      indexEntry({ id: 'sess-prev-0001', finishedAt: T1, score: 72 }),
      indexEntry({ id: 'sess-newer-001', finishedAt: T2 + 86400000, score: 88 }),
      indexEntry({ id: 'sess-running-01', status: 'running', finishedAt: T1 + 1000 }),
      indexEntry({ id: 'sess-otherjob-1', jobId: 'job-2', jobTitle: '产品经理', score: 90 }),
      indexEntry({ id: 'sess-noscore-01', score: null }),
    ];
    const hit = C.pickPreviousEntry(list, cur);
    ok(hit, '应挑到一场');
    eq(hit.id, 'sess-prev-0001', '选中的场次');
  });

  check('挑上一场：没有同岗位历史时返回 null', () => {
    const cur = session();
    eq(C.pickPreviousEntry([indexEntry({ jobId: 'job-9' })], cur), null);
    eq(C.pickPreviousEntry([], cur), null);
  });

  check('挑上一场：无 jobId 时按「归一化岗位名 + 公司」判定同岗位', () => {
    const cur = session({ job: { jobId: null, jobTitle: '数据分析师 ', company: '示例科技', jdText: 'x', capturedAt: T1 } });
    const list = [indexEntry({ jobId: null, jobTitle: '数据分析师', company: '示例科技' })];
    eq(C.pickPreviousEntry(list, cur).id, 'sess-prev-0001');
    const otherCompany = [indexEntry({ jobId: null, jobTitle: '数据分析师', company: '另一家' })];
    eq(C.pickPreviousEntry(otherCompany, cur), null);
  });

  check('挑上一场：自己有 jobId 时以 jobId 为准，不因岗位名相同误判', () => {
    const cur = session();
    const list = [indexEntry({ jobId: 'job-2', jobTitle: '数据分析师', company: '示例科技' })];
    eq(C.pickPreviousEntry(list, cur), null);
  });

  // ===== 2. 差值计算 =====
  const prevSide = C.compareSideOf(session({
    id: 'sess-prev-0001',
    finishedAt: T1,
    report: report({
      total: 72,
      dimensions: dims({ relevance: 76, evidence: 80, structure: 72, depth: 60, reflection: null }),
      questions: [questionResult({ score: 72 })],
    }),
  }));
  const curSide = C.compareSideOf(session({ report: report() }));

  check('compareSideOf：N/A 维不落成 0 分', () => {
    const refl = curSide.dimensions.find((d) => d.key === 'reflection');
    eq(refl.score, null, 'N/A 维分数');
    eq(curSide.total, 76, '总分');
  });

  check('diffSessions：总分与维度差值方向正确', () => {
    const d = C.diffSessions(prevSide, curSide);
    eq(d.totalDelta, 4, '总分差');
    const rel = d.dims.find((x) => x.key === 'relevance');
    eq([rel.prev, rel.cur, rel.delta], [76, 80, 4], '相关性');
    const ev = d.dims.find((x) => x.key === 'evidence');
    eq(ev.delta, -4, '证据具体性应下降 4');
    const refl = d.dims.find((x) => x.key === 'reflection');
    eq(refl.delta, null, '两侧都 N/A 时不产生差值');
  });

  check('diffSessions：面试官类型 / 难度 / 口径不同 → 不可比且逐条说明', () => {
    const harder = { ...curSide, difficulty: 'stress' };
    const d = C.diffSessions(prevSide, harder);
    eq(d.comparable, false, '难度不同应判不可比');
    ok(d.notes.some((n) => n.includes('难度')), `notes 应提到难度：${JSON.stringify(d.notes)}`);

    const same = C.diffSessions(prevSide, curSide);
    eq(same.comparable, true, '条件一致应可比');
    eq(same.notes, [], '可比时 notes 应为空');

    const v2 = { ...curSide, rubricVersion: 2 };
    ok(C.diffSessions(prevSide, v2).notes.some((n) => n.includes('口径')), '口径不同应提示');
  });

  check('diffSessions：薄弱维度只挑「没提升」的，且按分数升序', () => {
    const d = C.diffSessions(prevSide, curSide);
    eq(d.weakDimensions.map((w) => w.key), ['structure', 'evidence'], '薄弱维度');
    ok(d.weakDimensions.every((w) => w.score != null), '薄弱维度必须是本场有分的');
  });

  check('diffSessions：任一入参缺失时返回 null（不产出半个对比）', () => {
    eq(C.diffSessions(null, curSide), null);
    eq(C.diffSessions(prevSide, null), null);
  });

  check('formatDelta：正负、零、缺失三种写法固定', () => {
    eq(C.formatDelta(4), '+4');
    eq(C.formatDelta(-2.5), '-2.5');
    eq(C.formatDelta(0), '持平');
    eq(C.formatDelta(null), '—');
  });

  // ===== 3. Markdown 报告 =====
  const md = M.buildReportMarkdown(session({ report: report() }));

  check('Markdown：标题 / 总分 / 档位 / 口径齐全', () => {
    has(md, '# 模拟面试报告 · 数据分析师');
    has(md, '**76 / 100** · 基本有效');
    has(md, '- 面试官：技术面 · 标准');
    has(md, '- 评分口径：v1');
  });

  check('Markdown：维度表按权重展示，N/A 写成「不适用」而不是 0', () => {
    has(md, '| 相关性 | 30% | 80 |');
    has(md, '| 专业深度 | 15% | 65 |');
    has(md, '| 复盘与权衡 | 10% | 不适用 |');
    hasNot(md, '| 复盘与权衡 | 10% | 0 |');
  });

  check('Markdown：逐题含回答、追问、命中、漏答、建议', () => {
    has(md, '### 1. 讲一个你把指标做上去的项目');
    has(md, '**我的回答**');
    has(md, '> 我在上一家公司负责留存分析');
    has(md, '**追问**：这 9 个点是怎么拆的？');
    has(md, '**补答**');
    has(md, '- 命中：说清了指标口径');
    has(md, '- 漏答：没讲清楚归因方法');
    has(md, '- 建议：把归因过程按「假设—验证」讲一遍。');
  });

  check('Markdown：证据状态与来源、评分依据都写出来', () => {
    has(md, '证据扎实（AI 判定）');
    has(md, '基于主答 + 追问 1 轮');
  });

  check('Markdown：总结与「下一场重点」都在', () => {
    has(md, '## 总结');
    has(md, '- 归因方法没讲清（JD：能独立产出归因结论）');
    has(md, '## 下一场重点');
    has(md, '重答「讲一个你把指标做上去的项目」，补上：没讲清楚归因方法');
  });

  check('Markdown：不出现录用概率 / 人格 / 情绪等禁用推断', () => {
    for (const word of ['录用概率', '通过率', '性格', '情绪', '诚实', '文化匹配']) {
      hasNot(md, word);
    }
  });

  check('Markdown：反问涉及公司内部信息时不写入模拟回答', () => {
    const s = session({ report: report({ reverse: { question: '团队多少人？', answer: '大概 20 人', kept: false, comment: '问得好', askedAt: T2 } }) });
    const out = M.buildReportMarkdown(s);
    has(out, '该提问涉及公司内部信息，模拟回答未存入报告。');
    hasNot(out, '大概 20 人');
  });

  check('Markdown：文字作答场次明写「无体征数据」', () => {
    has(md, '本场没有录音作答，无体征数据。');
  });

  check('Markdown：AI 不可用时不编分数', () => {
    const s = session({ report: report({ aiAvailable: false, total: null, band: null }) });
    const out = M.buildReportMarkdown(s);
    has(out, '**AI 评估不可用，本场不显示分数。**');
    hasNot(out, '**76 / 100**');
  });

  check('Markdown：报告缺失时只说明没有报告', () => {
    const out = M.buildReportMarkdown(session({ report: null }));
    has(out, '## 报告尚未生成');
    hasNot(out, '/ 100');
  });

  check('Markdown：带对比时输出对比小节，不可比要有提示', () => {
    const cmp = C.diffSessions(prevSide, curSide);
    const out = M.buildReportMarkdown(session({ report: report() }), { compare: cmp });
    has(out, '## 与上一场对比');
    has(out, '总分：+4');
    has(out, '| 相关性 | 76 | 80 | +4 |');

    const hard = C.diffSessions(prevSide, { ...curSide, difficulty: 'stress' });
    const out2 = M.buildReportMarkdown(session({ report: report() }), { compare: hard });
    has(out2, '下面的差值仅供参考');
  });

  check('Markdown：改写稿与「需自己补的真实细节」一并导出', () => {
    const out = M.buildReportMarkdown(session({ report: report() }), {
      rewrites: { q1: { text: '我负责留存分析（原文）', gaps: ['补齐归因方法'], blocked: false } },
    });
    has(out, '**改写稿**');
    has(out, '> 我负责留存分析（原文）');
    has(out, '- 补齐归因方法');
  });

  check('Markdown：多行回答不破坏引用块', () => {
    const q = questionResult({ answer: '第一行\n第二行' });
    const out = M.buildReportMarkdown(session({ report: report({ questions: [q] }) }));
    has(out, '> 第一行\n> 第二行');
  });

  check('Markdown：作答节奏与长期弱项（传入时）都导出', () => {
    const s = session({
      report: report(),
      attempts: [{ id: 'a1', questionId: 'q1', answer: '答', probes: [], skipped: false, submittedAt: T2, durationMs: 200000 }],
    });
    const out = M.buildReportMarkdown(s, {
      insights: {
        sessionCount: 3,
        points: [{ text: '没讲清楚归因方法', sessions: 3, count: 4 }],
        dims: [{ key: 'relevance', label: '相关性', avg: 74 }],
      },
    });
    has(out, '## 作答节奏（不计入内容分）');
    has(out, '- 作答用时：3 分 20 秒（1 题）');
    has(out, '## 长期弱项（同岗位近 3 场）');
    has(out, '- 没讲清楚归因方法（3 场都漏）');
    has(out, '| 相关性 | 74 |');
  });

  check('Markdown：只有一场时不出长期弱项小节', () => {
    const out = M.buildReportMarkdown(session({ report: report() }), {
      insights: { sessionCount: 1, points: [{ text: '某个缺口没答到细节', sessions: 1, count: 1 }], dims: [] },
    });
    hasNot(out, '## 长期弱项');
  });

  // ===== 4. 文件名 =====
  check('文件名：去掉路径非法字符并按日期命名', () => {
    const s = session({
      job: { ...session().job, jobTitle: '数据/分析师:急招' },
      finishedAt: Date.UTC(2026, 9, 20, 2, 0, 0),
    });
    const name = M.reportFileName(s);
    ok(!/[\\/:*?"<>|]/.test(name), `文件名不应含非法字符：${name}`);
    has(name, '数据分析师急招');
    ok(name.endsWith('.md'), '应以 .md 结尾');
  });

  check('formatDateTime：空值给占位符，不写 Invalid Date', () => {
    eq(M.formatDateTime(null), '—');
    eq(M.formatDateTime(0), '—');
    ok(!M.formatDateTime(T2).includes('Invalid'), '不应出现 Invalid Date');
  });

  // ===== 5. 跨场次弱项聚合 =====
  /** 造一场「只有漏答要点与维度分」的报告，场次 id 与时间可控 */
  function insightReport(id, finishedAt, missedGroups, dimScores) {
    const questions = (missedGroups || []).map((g, i) => questionResult({
      questionId: `q${i}`,
      missedPoints: g.points,
      skipped: Boolean(g.skipped),
    }));
    return {
      id,
      finishedAt,
      report: report({
        total: 70,
        questions: questions.length ? questions : [questionResult()],
        dimensions: dims(dimScores || { relevance: 80, evidence: 70, structure: 70, depth: null, reflection: null }),
      }),
    };
  }

  check('弱项聚合：同一缺口的不同措辞合并成一条（跨 2 场）', () => {
    const list = [
      insightReport('s1', T1, [{ points: ['没讲清楚归因方法'] }]),
      insightReport('s2', T2, [{ points: ['归因方法没讲清'] }]),
    ];
    const points = I.aggregateWeakPoints(list);
    eq(points.length, 1, '应合并为一条');
    eq(points[0].sessions, 2, '涉及场次');
    eq(points[0].count, 2, '累计次数');
    ok(points[0].text.length >= 7, `展示文案应取较长的原文：${points[0].text}`);
  });

  check('弱项聚合：只在一场出现的点不入选（不是「长期」）', () => {
    const list = [
      insightReport('s1', T1, [{ points: ['没讲清结果数字'] }]),
      insightReport('s2', T2, [{ points: ['漏了反问环节'] }]),
    ];
    eq(I.aggregateWeakPoints(list), []);
  });

  check('弱项聚合：同一场里重复提到只算一场（sessions 不虚高）', () => {
    const list = [insightReport('s1', T1, [{ points: ['没讲清楚归因方法'] }, { points: ['归因方法没讲清'] }])];
    const points = I.aggregateWeakPoints(list, { minSessions: 1 });
    eq(points.length, 1, '仍是一簇');
    eq(points[0].sessions, 1, '场次去重');
    eq(points[0].count, 2, '次数累计');
  });

  check('弱项聚合：跳过的题不算「漏答」', () => {
    const list = [
      insightReport('s1', T1, [{ points: ['没讲清楚归因方法'], skipped: true }]),
      insightReport('s2', T2, [{ points: ['没讲清楚归因方法'], skipped: true }]),
    ];
    eq(I.aggregateWeakPoints(list), []);
  });

  check('弱项聚合：按涉及场次降序，场次相同按次数', () => {
    const list = [
      insightReport('s1', T1, [{ points: ['A 点没答到细节'] }, { points: ['B 点没有量化结果'] }]),
      insightReport('s2', T2, [{ points: ['A 点没答到细节'] }, { points: ['B 点没有量化结果'] }]),
      insightReport('s3', T2 + 1000, [{ points: ['A 点没答到细节'] }]),
    ];
    const points = I.aggregateWeakPoints(list);
    eq(points[0].sessions, 3, 'A 点应排第一');
    eq(points[0].count, 3, 'A 点次数');
    eq(points[1].sessions, 2, 'B 点第二');
  });

  check('弱项聚合：空输入不报错，返回空数组', () => {
    eq(I.aggregateWeakPoints([]), []);
    eq(I.aggregateWeakPoints(null), []);
  });

  check('维度均分：N/A 场次不参与，不按 0 分算', () => {
    const a = insightReport('s1', T1, [], { relevance: 80, evidence: 70, structure: 60, depth: null, reflection: null });
    const b = insightReport('s2', T2, [], { relevance: 90, evidence: 70, structure: 60, depth: 50, reflection: null });
    const dimsOut = I.averageDimensions([a, b]);
    const rel = dimsOut.find((d) => d.key === 'relevance');
    eq([rel.avg, rel.count], [85, 2], '相关性均分');
    const dep = dimsOut.find((d) => d.key === 'depth');
    eq([dep.avg, dep.count], [50, 1], '专业深度只有一场有分');
    const refl = dimsOut.find((d) => d.key === 'reflection');
    eq([refl.avg, refl.count], [null, 0], '全程 N/A 时均分为 null');
  });

  // ===== 6. 用时统计 =====
  check('用时：跳过与无记录的作答不计入', () => {
    const s = session({
      attempts: [
        { id: 'a1', questionId: 'q1', answer: '答', probes: [], skipped: false, submittedAt: T2, durationMs: 30000 },
        { id: 'a2', questionId: 'q2', answer: '答', probes: [], skipped: false, submittedAt: T2, durationMs: 60000 },
        { id: 'a3', questionId: 'q3', answer: '', probes: [], skipped: true, submittedAt: T2, durationMs: 999999 },
        { id: 'a4', questionId: 'q4', answer: '答', probes: [], skipped: false, submittedAt: T2 },
      ],
    });
    const t = I.interviewTiming(s);
    eq(t.answered, 2, '作答题数');
    eq(t.totalMs, 90000, '总时长');
    eq(t.avgMs, 45000, '平均每题');
    eq(t.longest, { questionId: 'q2', ms: 60000 }, '最长一题');
  });

  check('用时：没有记录时全部为 0 / null，不产出 NaN', () => {
    const t = I.interviewTiming(session({ attempts: [] }));
    eq([t.answered, t.totalMs, t.avgMs, t.longest], [0, 0, null, null]);
    eq(I.interviewTiming(null).answered, 0);
  });

  check('formatDuration：秒 / 分 / 缺失三种写法', () => {
    eq(I.formatDuration(45000), '45 秒');
    eq(I.formatDuration(200000), '3 分 20 秒');
    eq(I.formatDuration(180000), '3 分');
    eq(I.formatDuration(0), '—');
    eq(I.formatDuration(null), '—');
  });
} catch (e) {
  failures += 1;
  results.push(`  FAIL 构建/加载失败\n       ${e.message}`);
} finally {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(results.join('\n'));
if (failures) {
  console.error(`\n模拟面试报告回归：${failures} 项失败`);
  process.exit(1);
}
console.log(`\n模拟面试报告回归：全部通过（${results.length} 项）`);
