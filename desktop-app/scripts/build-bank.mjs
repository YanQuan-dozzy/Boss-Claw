// 生成内置题库（离线脚本，产物随包分发）
//
// 数据源：zhangjun640/Chinese_interview_small（Apache-2.0，16138 条，instruction/input/output 三键）
//   https://huggingface.co/datasets/zhangjun640/Chinese_interview_small
//
// 清洗口径（都在这里做，运行时不做）：
//   · 去编号前缀 / 折叠空白；
//   · 题干 8–120 字，答案非空且 ≤1500 字；
//   · 归一化后完全相同的题只留第一条；
//   · 方向 / 难度 / 题型用关键词规则自动分类（内置库没有人工标注，导入后用户可改）；
//   · **不生成 focus / keyPoints**：内置题的 output 是模型生成的，拿它判「漏答」等于
//     用一个模型的答案给另一个模型的评分背书（方案 §2.6、§5.7.5），所以一律 keyPointsFrom='none'。
//
// 用法：
//   node scripts/build-bank.mjs --src /path/to/qa_dataset_part2_new.json
// 产物：
//   desktop-app/resources/bank/zh-interview-small.json
//   desktop-app/resources/bank/NOTICE.md
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const srcPath = resolve(getArg('src', join(tmpdir(), 'bank', 'small.json')));
const outPath = resolve(getArg('out', join(root, 'resources', 'bank', 'zh-interview-small.json')));

const raw = JSON.parse(readFileSync(srcPath, 'utf8'));
if (!Array.isArray(raw)) throw new Error('数据源应为数组');

// 复用 TS 里的归一化 / 指纹 / 分类，避免脚本与运行时两套口径
const outDir = mkdtempSync(join(tmpdir(), 'bank-build-'));
const bundle = join(outDir, 'bank.cjs');
await build({
  entryPoints: [join(root, 'src', 'lib', 'bossclaw', 'mockInterviewBank.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent',
});
const B = require(bundle);

const MAX_Q = 120;
const MIN_Q = 8;
const MAX_A = 1500;

const stats = {
  total: raw.length,
  empty: 0,
  tooShort: 0,
  tooLong: 0,
  emptyAnswer: 0,
  duplicate: 0,
  kept: 0,
};
const seen = new Set();
const questions = [];
const dirCounter = new Map();
const diffCounter = new Map();
const catCounter = new Map();

for (const item of raw) {
  const rawQ = String(item?.instruction ?? item?.question ?? '').trim();
  const rawA = String(item?.output ?? item?.answer ?? '').trim();
  if (!rawQ || !rawA) {
    stats.empty += 1;
    continue;
  }
  // 去掉「1. 」「Q:」「问：」这类编号前缀
  const q = rawQ
    .replace(/^\s*(?:\d+\s*[.、)）]|Q\s*[:：]|问\s*[:：])\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const len = [...q].length;
  if (len < MIN_Q) {
    stats.tooShort += 1;
    continue;
  }
  if (len > MAX_Q) {
    stats.tooLong += 1;
    continue;
  }
  if (rawA.length < 10) {
    stats.emptyAnswer += 1;
    continue;
  }
  const norm = B.normalizeQuestionText(q);
  const hash = B.sha1Hex(norm);
  if (seen.has(hash)) {
    stats.duplicate += 1;
    continue;
  }
  seen.add(hash);

  const cls = B.classifyQuestion(q);
  questions.push({
    id: `b-${hash.slice(0, 12)}`,
    text: q,
    answer: rawA.length > MAX_A ? `${rawA.slice(0, MAX_A)}…` : rawA,
    directions: cls.directions,
    difficulty: cls.difficulty,
    category: cls.category,
    tags: cls.tags,
  });
  stats.kept += 1;
  cls.directions.forEach((d) => dirCounter.set(d, (dirCounter.get(d) || 0) + 1));
  diffCounter.set(cls.difficulty, (diffCounter.get(cls.difficulty) || 0) + 1);
  catCounter.set(cls.category, (catCounter.get(cls.category) || 0) + 1);
}

const payload = {
  schema: 1,
  id: 'builtin-zh-interview',
  name: '中文面试题库（内置）',
  type: 'builtin',
  license: 'Apache-2.0',
  source: 'https://github.com/zhangjun640/Chinese_interview_dataset',
  sourceVersion: 'Chinese_interview_small (16.1K)',
  builtAt: new Date().toISOString().slice(0, 10),
  count: questions.length,
  /** 内置题一律无要点：output 是模型生成的，不能当评分依据 */
  keyPointsFrom: 'none',
  questions,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
const size = statSync(outPath).size;

const fmt = (m) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');

writeFileSync(
  join(dirname(outPath), 'NOTICE.md'),
  `# 内置题库来源与许可

本目录的 \`zh-interview-small.json\` 由以下开源数据集清洗而来：

- **数据集**：Chinese_interview_dataset（Small / 16.1K）
- **作者**：zhangjun640
- **仓库**：https://github.com/zhangjun640/Chinese_interview_dataset
- **数据页**：https://huggingface.co/datasets/zhangjun640/Chinese_interview_small
- **许可**：Apache License 2.0（https://www.apache.org/licenses/LICENSE-2.0）
- **原始字段**：\`instruction\` / \`input\` / \`output\`（input 全部为空，已忽略）
- **清洗日期**：${payload.builtAt}
- **保留条数**：${questions.length} / ${raw.length}

清洗只做以下事情，未改写题干与答案内容：

1. 去除题干前的编号前缀、折叠空白；
2. 丢弃题干少于 ${MIN_Q} 字或多于 ${MAX_Q} 字、答案为空或少于 10 字的条目；
3. 归一化（全角转半角、去标点空白、英文小写）后完全相同的题只保留第一条；
4. 用关键词规则推断方向 / 难度 / 题型（内置库无人工标注，用户可在题库页修改）。

**内置题的 \`output\` 只是「参考资料（AI 生成，未校验）」**，不参与出题提示词，也不用于判定「漏答要点」；
内置题不产生「题库要点」标记（见方案 §5.7.5）。

Apache-2.0 要求分发时保留本声明与许可副本；本项目在「设置 → 关于 / 开源许可」中一并列出。
`,
  'utf8',
);

console.log(`wrote ${outPath}`);
console.log(`size ${(size / 1024 / 1024).toFixed(1)} MB, kept ${questions.length}`);
console.log('stats', JSON.stringify(stats));
console.log('directions', fmt(dirCounter));
console.log('difficulty', fmt(diffCounter));
console.log('category', fmt(catCounter));

rmSync(outDir, { recursive: true, force: true });
