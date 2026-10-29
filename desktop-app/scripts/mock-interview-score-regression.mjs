// 模拟面试「确定性口径」回归断言（零新增依赖，用项目已有的 esbuild 打包 TS 后离线执行）
//
// 为什么需要它：模拟面试的分数是本地算的，一旦算错方向是**静默的**——
//   · LEVEL_SCORE / 权重 / N/A 归一化改错 → 总分漂移，但界面看不出异常；
//   · 证据子串校验失效 → 模型润色过的「引用」被当成真的，评分依据不可信；
//   · 无证据不压分 → 报告分数虚高，整套「证据优先」的设计失效。
// 这些都不会被 typecheck 与构建发现，必须用断言守住。
//
// 用法：node scripts/mock-interview-score-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-score-'));
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

// `callModel` / 技能层用桩替换：评分口径是纯函数，不需要真实 AI 与 localStorage
const stubPlugin = {
  name: 'stub-ai',
  setup(b) {
    b.onResolve({ filter: /^\.\/llm$/ }, () => ({ path: 'stub-llm', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/skills$/ }, () => ({ path: 'stub-skills', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'stub-skills') {
        return { loader: 'js', contents: 'export const skillInstructionsFor = async () => "";' };
      }
      return {
        loader: 'js',
        contents: [
          'export const callModel = async () => { throw new Error("stub: 不应在离线回归中调用 AI"); };',
          'export const cachedCallModel = callModel;',
          'export const extractJson = (x) => x;',
        ].join('\n'),
      };
    });
  },
};

try {
  await build({
    entryPoints: [join(root, 'src/lib/bossclaw/mockInterviewEngine.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: outFile,
    logLevel: 'silent',
    plugins: [stubPlugin],
  });

  const E = require(outFile);

  // ===== 1. 四档 + 档内位置 → 分数 =====
  check('level/pos 映射与常量表一致（12 级）', () => {
    eq(E.levelToScore(4, 1), 85);
    eq(E.levelToScore(4, 3), 93);
    eq(E.levelToScore(3, 2), 76);
    eq(E.levelToScore(2, 3), 65);
    eq(E.levelToScore(1, 1), 30);
    eq(E.levelToScore(1, 3), 48);
  });
  check('非法档位/位置不返回 0 分，而是 null 或 clamp', () => {
    eq(E.levelToScore(0, 2), null);
    eq(E.levelToScore(5, 2), null);
    eq(E.levelToScore('x', 2), null);
    eq(E.levelToScore(3, 0), 72); // pos 被 clamp 到 1
    eq(E.levelToScore(3, 9), 80); // pos 被 clamp 到 3
  });

  // ===== 2. 证据档映射 =====
  check('总分 → 四档证据档（85/70/50/0）', () => {
    eq(E.bandForScore(93)?.key, 'strong');
    eq(E.bandForScore(85)?.key, 'strong');
    eq(E.bandForScore(84)?.key, 'effective');
    eq(E.bandForScore(70)?.key, 'effective');
    eq(E.bandForScore(69)?.key, 'improve');
    eq(E.bandForScore(50)?.key, 'improve');
    eq(E.bandForScore(49)?.key, 'insufficient');
    eq(E.bandForScore(null), null);
  });

  // ===== 3. 维度聚合与 N/A 归一化 =====
  const mkResult = (id, dims) => ({
    questionId: id,
    questionText: 'q',
    phase: 1,
    answer: 'a',
    probes: [],
    dimensionScores: dims,
    dimensionEvidence: {},
    evidenceState: 'solid',
    evidenceSource: 'ai',
    invalidEvidence: false,
    scoredWith: 'main',
    hitPoints: [],
    missedPoints: [],
    suggestion: '',
    skipped: false,
    keyPointsFrom: 'ai',
    score: null,
  });

  check('维度均值 + 权重加权 + N/A 不按 0 分（剩余权重归一化）', () => {
    const qs = [
      mkResult('a', { relevance: 80, evidence: 80, structure: 80, depth: 80, reflection: 80 }),
      mkResult('b', { relevance: 60, evidence: 60, structure: 60, depth: null, reflection: null }),
    ];
    const r = E.aggregateReport(qs, { deliveryAdvice: '', summary: { gaps: [], advice: [] } }, null, true);
    const by = Object.fromEntries(r.dimensions.map((d) => [d.key, d.score]));
    eq(by, { relevance: 70, evidence: 70, structure: 70, depth: 80, reflection: 80 });
    // (70*.3 + 70*.25 + 70*.2 + 80*.15 + 80*.1) / 1 = 72.5 → 73
    eq(r.total, 73);
    eq(r.band.key, 'effective');
    eq(r.dimensions.filter((d) => d.na).length, 0);
  });

  check('同一份输入重复计算，结果完全一致（可复算）', () => {
    const qs = [mkResult('a', { relevance: 85, evidence: 72, structure: 60, depth: 48, reflection: 80 })];
    const a = E.aggregateReport(qs, { deliveryAdvice: '', summary: { gaps: [], advice: [] } }, null, true);
    const b = E.aggregateReport(qs, { deliveryAdvice: '', summary: { gaps: [], advice: [] } }, null, true);
    eq({ total: a.total, dims: a.dimensions.map((d) => d.score) }, { total: b.total, dims: b.dimensions.map((d) => d.score) });
  });

  check('全部维度 N/A 时总分为 null（不给假分数）', () => {
    const qs = [mkResult('a', { relevance: null, evidence: null, structure: null, depth: null, reflection: null })];
    const r = E.aggregateReport(qs, { deliveryAdvice: '', summary: { gaps: [], advice: [] } }, null, true);
    eq(r.total, null);
    eq(r.band, null);
  });

  // ===== 4. 证据子串校验（防编造引用） =====
  const answer = '我们把接口响应时间从 800ms 压到 200ms，QPS 从 300 提到 900，同时把错误率降到 0.5%。';
  check('证据逐字来自回答 → 通过', () => {
    ok(E.isEvidenceGrounded('QPS 从 300 提到 900', answer), '原句应通过');
  });
  check('证据只改标点/空格 → 通过（归一化后是子串）', () => {
    ok(E.isEvidenceGrounded('我们把接口响应时间从800ms压到200ms', answer), '去标点后应通过');
  });
  check('证据是模型润色/编造的原句 → 不通过', () => {
    ok(!E.isEvidenceGrounded('我们把整体转化率提升了 30%', answer), '编造的引用必须被拒');
  });
  check('证据打乱词序 → 不通过（不允许改写词序）', () => {
    ok(!E.isEvidenceGrounded('接口响应时间从 200ms 压到 800ms', answer), '词序颠倒必须被拒');
  });
  check('证据过短（<10 字）→ 不通过', () => {
    ok(!E.isEvidenceGrounded('QPS 900', answer), '过短引用不算证据');
  });

  // ===== 5. 无证据 → 该维压到 69 以下（确定性护栏） =====
  const question = {
    id: 'q1',
    phase: 1,
    kind: 'planned',
    category: 'project',
    text: '讲讲你做的这个项目',
    jdRef: '',
    resumeRef: '',
    focus: ['口径'],
    rubric: [],
    probeDirections: [],
    sourceQuestionId: null,
    keyPointsFrom: 'ai',
  };
  const attempt = {
    id: 'att1',
    questionId: 'q1',
    answer,
    probes: [],
    skipped: false,
    submittedAt: Date.now(),
    evidenceState: 'solid',
    evidenceSource: 'ai',
  };
  const aiScore = (evidence) => ({
    questionId: 'q1',
    dimensions: {
      relevance: { level: 4, pos: 3, evidence },
      evidence: { level: 4, pos: 3, evidence },
      structure: { level: 4, pos: 3, evidence },
      depth: { level: 4, pos: 3, evidence },
      reflection: { level: 4, pos: 3, evidence },
    },
    hitPoints: [],
    missedPoints: [],
    suggestion: '',
    deliveryNote: '',
  });

  check('引用真实原句 → 该题拿满档 93，不标 invalidEvidence', () => {
    const r = E.buildQuestionResult(question, attempt, aiScore('QPS 从 300 提到 900'));
    eq(r.dimensionScores.relevance, 93);
    eq(r.invalidEvidence, false);
    eq(r.score, 93);
  });

  check('引用对不上 → 五维全部 clamp 到 69 以下，并标 invalidEvidence', () => {
    const r = E.buildQuestionResult(question, attempt, aiScore('我们把整体转化率提升了 30%'));
    for (const k of ['relevance', 'evidence', 'structure', 'depth', 'reflection']) {
      ok(r.dimensionScores[k] <= 69, `${k} 应 <= 69，实际 ${r.dimensionScores[k]}`);
    }
    eq(r.invalidEvidence, true);
    ok(r.score <= 69, '该题总分应 <= 69');
  });

  check('未作答 → N/A（null），不按 0 分', () => {
    const skipped = { ...attempt, skipped: true, answer: '' };
    const r = E.buildQuestionResult(question, skipped, aiScore('x'));
    eq(r.dimensionScores.relevance, null);
    eq(r.score, null);
    eq(r.skipped, true);
  });

  check('维度不适用（na=true）→ null，不拉低其他维', () => {
    const ai = aiScore('QPS 从 300 提到 900');
    ai.dimensions.depth = { na: true, level: null, pos: 1, evidence: '' };
    const r = E.buildQuestionResult(question, attempt, ai);
    eq(r.dimensionScores.depth, null);
    eq(r.dimensionScores.relevance, 93);
  });

  // ===== 6. 本地五条追问规则 =====
  check('回答过短 → 本地规则直接追问（不调 AI）', () => {
    const hit = E.localFollowupRule('做过一个项目，还行。', '');
    ok(hit && hit.reason === '回答过短', `应命中回答过短，实际 ${hit && hit.reason}`);
  });
  check('全程「我们」无「我」→ 追问个人贡献', () => {
    const text = '我们团队当时做了很多工作，我们对接了三个系统，我们最后把问题解决了，结果还不错，效果挺好，后来还被其他团队借鉴，整个过程大概持续了半年时间，中间也踩了不少坑，最后复盘的时候我们把整个过程整理成了文档，也做了分享，大家觉得挺有收获的。';
    const hit = E.localFollowupRule(text, '');
    ok(hit && hit.reason === '无个人贡献', `应命中无个人贡献，实际 ${hit && hit.reason}`);
  });
  check('无任何数字 → 追问量化结果', () => {
    const text = '当时我在公司负责这个项目，我牵头梳理了流程，也推动了团队协作，最后把事情做完了，效果还可以，大家也比较认可，后面又推广到了别的业务线，整体反馈不错，也沉淀了一些方法。';
    const hit = E.localFollowupRule(text, '');
    ok(hit && hit.reason === '无量化结果', `应命中无量化结果，实际 ${hit && hit.reason}`);
  });
  check('回答百分比与简历同一项目数值冲突 → 必追问，且优先于其他规则', () => {
    const resume = '负责订单系统重构，接口响应时间提升 20%，支撑日均 30 万单。';
    const ans = '当时我在公司负责订单系统重构，接口响应时间提升了 30%，最后支撑住了大促，团队配合也很好，整体效果不错。';
    const hit = E.localFollowupRule(ans, resume);
    ok(hit && hit.reason === '数字冲突', `应命中数字冲突，实际 ${hit && hit.reason}`);
    ok(hit.probe.includes('30%') && hit.probe.includes('20%'), '追问应点出两个数');
  });
  check('无冲突时不误报数字冲突', () => {
    const resume = '负责订单系统重构，接口响应时间提升 20%，支撑日均 30 万单。';
    const ans = '当时我在公司负责订单系统重构，接口响应时间提升了 20%，最后支撑住了日均 30 万单的大促，团队配合也很好。';
    const hit = E.localFollowupRule(ans, resume);
    ok(!hit || hit.reason !== '数字冲突', '同值不应判冲突');
  });

  // ===== 7. 改写稿数字防编造的基础能力 =====
  check('数字提取：只认文本里真实出现的数字', () => {
    eq(E.extractNumbers('从 800ms 降到 0.5%，QPS 900').sort(), ['0.5', '800', '900'].sort());
    eq(E.extractNumbers('没有任何数字'), []);
  });
} catch (e) {
  failures += 1;
  results.push(`  FAIL 构建/加载失败\n       ${e.message}`);
} finally {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(results.join('\n'));
if (failures) {
  console.error(`\n模拟面试评分回归：${failures} 项失败`);
  process.exit(1);
}
console.log(`\n模拟面试评分回归：全部通过（${results.length} 项）`);
