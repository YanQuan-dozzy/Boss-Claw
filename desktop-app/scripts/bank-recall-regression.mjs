// 题库召回与导入的离线回归（零新增依赖：用项目已有的 esbuild 打包 TS 后执行）
//
// 为什么要断言这些：
//   · BM25 排序错了是**静默的**——召回照样返回 20 条，只是都不相关，面试题看起来仍然「正常」；
//   · 去重漏了会在内置库里留下成片重复题，而用户只会觉得「题库很水」；
//   · 字段映射漏了 instruction/output，我们自己的内置库格式就导不进来；
//   · CSV 漏了 BOM 处理，首列表头会变成 \ufeff题目，映射全空——但文件看起来毫无问题。
//
// 用法：node scripts/bank-recall-regression.mjs   （EXIT 0 = 全通过）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-bank-'));
const entry = join(outDir, 'entry.ts');
const outFile = join(outDir, 'bundle.cjs');

writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(join(root, 'src', 'lib', 'bossclaw', 'mockInterviewBank.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src', 'lib', 'bossclaw', 'mockInterviewImport.ts'))};`,
  ].join('\n'),
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
});
const B = require(outFile);

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
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error(`${label} 偏差过大：${actual} vs ${expected}`);
}

function q(id, text, extra = {}) {
  return {
    id,
    text,
    answer: '',
    directions: ['general'],
    difficulty: 'standard',
    category: 'fundamental',
    tags: [],
    ...extra,
  };
}

// ===== 切词 =====
const tokens = B.tokenize('Redis 缓存穿透怎么解决？');
const terms = tokens.map((t) => t.term);
check('中文 bigram + 英文整词切分', () => {
  ok(terms.includes('redis'), '应保留英文整词 redis');
  ok(terms.includes('缓存'), '应有 bigram 缓存');
  ok(terms.includes('存穿'), '应有跨词 bigram 存穿');
  ok(!terms.includes('的'), '停用词「的」应被丢弃');
});
check('单字权重 0.3、bigram 权重 1', () => {
  const dan = tokens.find((t) => t.term === '缓');
  const bi = tokens.find((t) => t.term === '缓存');
  ok(dan && dan.weight === 0.3, '单字权重应为 0.3');
  ok(bi && bi.weight === 1, 'bigram 权重应为 1');
});

// ===== BM25 排序 =====
const docs = [
  q('d1', 'Redis 缓存穿透和击穿的区别是什么', { directions: ['backend'] }),
  q('d2', 'MySQL 索引失效的常见原因有哪些', { directions: ['backend'] }),
  q('d3', '怎么和产品经理沟通需求优先级', { directions: ['product'] }),
  q('d4', 'Vue 组件之间怎么通信', { directions: ['frontend'] }),
  q('d5', '分布式事务有哪些实现方案', { directions: ['backend'], difficulty: 'stress' }),
  q('d6', '分布式系统里事务一致性怎么保证', { directions: ['backend'], difficulty: 'stress' }),
  q('d7', '自我介绍', { directions: ['general'], category: 'icebreak', difficulty: 'basic' }),
];
const fingerprint = B.bankFingerprint([{ id: 'b1', mtime: 1, count: docs.length }]);
const index = B.buildIndex(
  docs.map((question) => ({ question, bankId: 'b1' })),
  fingerprint,
);

check('BM25 把最相关的题排第一', () => {
  const r = B.recall(index, { queryText: 'Redis 缓存穿透怎么解决', topK: 3 });
  eq(r.candidates[0].id, 'd1', '首位');
});

check('查询无命中时返回空而不是乱给', () => {
  const r = B.recall(index, { queryText: '量子计算 超导 低温', topK: 5 });
  eq(r.candidates.length, 0, '条数');
});

check('方向过滤保留 general 通配', () => {
  const r = B.recall(index, { queryText: '自我介绍 沟通 需求', topK: 10, directions: ['frontend'] });
  ok(r.candidates.some((c) => c.id === 'd7') || r.candidates.some((c) => c.id === 'd3'), '应保留通用/产品题作为候选');
});

check('难度过滤无结果时自动放宽并标记 relaxed', () => {
  const r = B.recall(index, { queryText: 'Redis 缓存穿透', topK: 5, difficulty: 'basic' });
  ok(r.candidates.length > 0, '应放宽后仍有候选');
  ok(r.relaxed, 'relaxed 应为 true');
});

check('excludeIds 排除本场已用题', () => {
  const r = B.recall(index, { queryText: 'Redis 缓存穿透', topK: 5, excludeIds: new Set(['d1']) });
  ok(!r.candidates.some((c) => c.id === 'd1'), 'd1 应被排除');
});

check('同一批题目重复建索引，召回结果完全一致', () => {
  const items = docs.map((question) => ({ question, bankId: 'b1' }));
  const a = B.recall(B.buildIndex(items, 'fp'), { queryText: 'Redis 缓存穿透', topK: 5 });
  const b = B.recall(B.buildIndex(items, 'fp'), { queryText: 'Redis 缓存穿透', topK: 5 });
  eq(a.candidates.map((c) => c.id), b.candidates.map((c) => c.id), '两次召回顺序');
});

check('短语加成让连续命中排在碎片命中之前', () => {
  const a = q('p1', '分布式事务怎么实现', { directions: ['backend'] });
  const b = q('p2', '分布式缓存和本地事务的区别', { directions: ['backend'] });
  const idx = B.buildIndex([a, b].map((question) => ({ question, bankId: 'b1' })), 'fp');
  const r = B.recall(idx, { queryText: '分布式事务', topK: 2 });
  eq(r.candidates[0].id, 'p1', '连续短语命中应排第一');
});

// ===== 去重 =====
check('精确去重：全角/标点/大小写差异也算同题', () => {
  const rep = B.findDuplicates(['Redis 缓存穿透？', 'redis缓存穿透'], [{ id: 'x1', text: 'Redis 缓存穿透' }]);
  eq(rep.exact, [0, 1], '两条都应判重');
});

check('近似去重：只提示、不删（相似度高但文字不同）', () => {
  const rep = B.findDuplicates(
    ['请介绍一下你负责的最有挑战的一个项目，以及你的具体贡献是什么'],
    [{ id: 'x2', text: '请介绍一下你负责的最有挑战的一个项目以及你的具体贡献' }],
  );
  eq(rep.exact.length, 0, '不应判为精确重复');
  ok(rep.near.length === 1, '应提示 1 条近似重复');
  ok(rep.near[0].similarity > 0.85, `相似度应 > 0.85，实际 ${rep.near[0]?.similarity}`);
});

check('改写幅度较大的题不判近似重复（阈值不能太松）', () => {
  const rep = B.findDuplicates(
    ['请介绍一下你负责的最有挑战的项目，以及你具体做了什么贡献'],
    [{ id: 'x4', text: '请介绍一下你负责的最有挑战的一个项目以及你的具体贡献' }],
  );
  eq(rep.near.length, 0, '相似度约 0.44，不应判重');
});

check('不相干的题不会被误判近似重复', () => {
  const rep = B.findDuplicates(['Vue 组件通信方式'], [{ id: 'x3', text: 'MySQL 索引失效原因' }]);
  eq(rep.near.length, 0, '近似重复条数');
});

// ===== 分类 =====
check('方向/题型分类命中关键词', () => {
  const vue = B.classifyQuestion('Vue 组件之间怎么通信');
  ok(vue.directions.includes('frontend'), 'Vue 题应归前端');
  const intro = B.classifyQuestion('请先做一下自我介绍');
  eq(intro.category, 'icebreak', '自我介绍应为破冰');
  const stress = B.classifyQuestion('如何设计一个高并发秒杀系统');
  eq(stress.difficulty, 'stress', '设计/高并发应为压力');
});

// ===== CSV / 映射 / 导入 =====
check('CSV 带 BOM 时首列表头不乱码', () => {
  const table = B.parseCsv('\ufeff题目,答案\nRedis 为什么快,内存+单线程\n');
  eq(table.headers[0], '题目', '首列表头');
  eq(table.rows.length, 1, '行数');
});

check('CSV 引号内的逗号与换行不被拆开', () => {
  const table = B.parseCsv('题目,答案\n"介绍一下项目,重点说数据","第一行\n第二行"\n');
  eq(table.rows[0][0], '介绍一下项目,重点说数据', '单元格 1');
  eq(table.rows[0][1], '第一行\n第二行', '单元格 2');
});

check('指令格式 JSON 的 instruction/output 自动命中映射', () => {
  const parsed = B.parseJsonRecords(
    JSON.stringify([{ instruction: '什么是幂等', input: '', output: '同一个请求执行多次结果一致' }]),
  );
  eq(parsed.error, undefined, '解析错误');
  const map = B.autoMap(parsed.headers);
  eq(map.text, 'instruction', '题干列');
  eq(map.answer, 'output', '答案列');
});

check('JSON 支持 { questions: [...] } 与纯字符串数组', () => {
  const a = B.parseJsonRecords(JSON.stringify({ questions: [{ question: '什么是闭包', answer: '函数与其词法环境的组合' }] }));
  eq(a.records.length, 1, '对象数组');
  const b = B.parseJsonRecords(JSON.stringify(['什么是闭包？函数和词法环境']));
  eq(b.records.length, 1, '字符串数组');
});

check('Markdown 按标题一题一块并识别「答案：」前缀', () => {
  const md = '## 什么是幂等\n答案：同一请求执行多次结果一致\n\n## 怎么做限流\n答案：令牌桶、漏桶\n';
  const parsed = B.parseMarkdownRecords(md);
  eq(parsed.records.length, 2, '块数');
  eq(parsed.records[0].question, '什么是幂等', '第一题题干');
  eq(parsed.records[0].answer, '同一请求执行多次结果一致', '第一题答案');
});

check('导入校验：缺题干 / 过短 / 精确重复分别计数', () => {
  const mapped = B.applyFieldMap(
    [
      { question: '这是第一条足够长的面试题目', answer: '答案一' },
      { question: '', answer: '没有题干' },
      { question: '太短', answer: 'x' },
      { question: '这是第一条足够长的面试题目', answer: '答案二' },
    ],
    { text: 'question', answer: 'answer', focus: null, keyPoints: null, directions: null, difficulty: null, category: null, tags: null },
  );
  const prep = B.prepareImport(mapped);
  eq(prep.report.total, 4, '总数');
  eq(prep.report.noText, 1, '缺题干');
  eq(prep.report.tooShort, 1, '过短');
  eq(prep.report.exactDuplicates, 1, '精确重复');
  eq(prep.report.valid, 1, '有效');
  eq(prep.questions.length, 1, '可写入条数');
});

check('导入超过上限时给出拆分建议且不写入', () => {
  const many = Array.from({ length: B.MAX_IMPORT_QUESTIONS + 1 }, (_, i) => ({
    question: `这是一道用于测试超限的第 ${i} 道面试题目`,
    answer: 'x',
  }));
  const mapped = B.applyFieldMap(many, {
    text: 'question', answer: 'answer', focus: null, keyPoints: null, directions: null, difficulty: null, category: null, tags: null,
  });
  const prep = B.prepareImport(mapped);
  ok(prep.report.overflow, '应标记 overflow');
  ok(/拆成多个文件/.test(prep.report.overflow.message), '应给出拆分建议');
});

// ===== 内置题库（真数据）=====
const builtinPath = join(root, 'resources', 'bank', 'zh-interview-small.json');
if (existsSync(builtinPath)) {
  const data = JSON.parse(readFileSync(builtinPath, 'utf8'));
  check('内置题库：条数在 12–14K，字段完整', () => {
    ok(data.questions.length >= 12000 && data.questions.length <= 14500, `实际 ${data.questions.length}`);
    ok(data.license === 'Apache-2.0', '许可应为 Apache-2.0');
    const bad = data.questions.filter((x) => !x.text || !x.id || !Array.isArray(x.directions));
    eq(bad.length, 0, '字段缺陷条数');
    eq(data.questions.filter((x) => (x.keyPoints || []).length).length, 0, '内置题不应带要点');
  });

  check('内置题库：建索引 < 3s 且能召回相关题', () => {
    const idx = B.buildIndex(
      data.questions.map((question) => ({ question, bankId: 'builtin-zh-interview' })),
      B.bankFingerprint([{ id: 'builtin', mtime: 1, count: data.questions.length }]),
    );
    ok(idx.buildMs < 3000, `建索引耗时 ${idx.buildMs}ms`);
    const r = B.recall(idx, { queryText: 'Redis 缓存击穿怎么解决', topK: 20, difficulty: 'stress' });
    ok(r.candidates.length === 20, `候选数 ${r.candidates.length}`);
    const hit = r.candidates.filter((c) => /redis|缓存/i.test(c.text)).length;
    ok(hit >= 5, `前 20 条里 Redis/缓存 相关仅 ${hit} 条`);
    console.log(`  info 内置题库 ${data.questions.length} 题 · 建索引 ${idx.buildMs}ms · 召回 ${r.tookMs}ms`);
  });

  check('内置题库：停用后索引为空，不影响调用方', () => {
    const idx = B.buildIndex([], 'empty');
    const r = B.recall(idx, { queryText: 'Redis', topK: 20 });
    eq(r.candidates.length, 0, '空索引应返回 0 条');
  });
} else {
  results.push('  skip 内置题库文件不存在（先跑 node scripts/build-bank.mjs）');
}

console.log(results.join('\n'));
console.log(failures ? `\n${failures} 项失败` : `\n全部 ${results.filter((r) => r.startsWith('  ok')).length} 项通过`);
rmSync(outDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
