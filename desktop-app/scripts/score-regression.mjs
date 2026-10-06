// 岗位评分本地规则回归断言（零新增依赖）
//
// 为什么需要它：desktop-app 目前没有测试框架（package.json 无 vitest/jest，`verify` 只跑
// typecheck + build），而本地规则一旦判错，方向是直接改写评分与硬约束——尤其「硬性设置被突破」
// 这类错误在 UI 上表现为「分数看着还行但岗位明显不该进队列」，不跑断言根本发现不了。
//
// 做法：用项目里已有的 esbuild 把 TS 源打成临时 CJS 再 require，不引入任何新依赖、不改 package.json。
//
// 用法：node scripts/score-regression.mjs      （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 把「评分相关纯逻辑模块」打成一个临时 CJS（这些模块不依赖 electron / llm，可离线跑） */
async function loadScoringModule() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-score-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/bossclaw/jobMatch.ts';",
        "export { isLocationExcluded } from './src/lib/bossclaw/locationFilter.ts';",
        "export * from './src/lib/bossclaw/fitLevel.ts';",
        // 批次 6（审查 #3/#41/#43/#44）新增：AI 维度融合口径、关键词词边界、工作制度否定、脱敏邮箱
        "export { mergeAiDimensions } from './src/lib/bossclaw/matching.ts';",
        "export { keywordHit } from './src/lib/bossclaw/resumeMatch.ts';",
        "export * from './src/lib/bossclaw/workSchedule.ts';",
        "export * from './src/lib/bossclaw/resumeDesensitize.ts';",
        "export * from './src/lib/bossclaw/hrActivity.ts';",
        "export { extractSalaryMentions } from './src/lib/bossclaw/salaryCalibration.ts';",
        "export { collectFaultScope } from './src/lib/bossclaw/platforms.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'score-regression-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.url);
  const mod = require(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===== 断言工具 =====
let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  if (ok) pass += 1;
  else failures.push(`${name}\n      期望：${typeof expected === 'function' ? '(自定义判据)' : JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`);
}
function checkNoThrow(name, fn, predicate) {
  try {
    const value = fn();
    const ok = predicate(value);
    if (ok) pass += 1;
    else failures.push(`${name}\n      实际：${JSON.stringify(value)}`);
  } catch (err) {
    failures.push(`${name}\n      抛错：${err?.message || err}`);
  }
}

// ===== 样例构造 =====
function baseProfile() {
  return {
    facts: { education: [], experiences: [], projects: [], skills: [], certificates: [], capabilities: [] },
    primaryDirections: [],
    secondaryDirections: [],
    searchKeywords: [],
    hardConstraints: { locations: [], employmentTypes: [], salary: '', experience: '', degree: '' },
    excludeDirections: [],
    summary: '',
  };
}
function baseJob(over = {}) {
  return {
    title: '后端开发工程师',
    company: '示例科技',
    salary: '20-30K',
    location: '杭州·余杭区',
    description: '负责后端服务开发',
    jobId: 'regression-1',
    ...over,
  };
}

const { mod, cleanup } = await loadScoringModule();
const {
  computeLocalMatch,
  enhancedLocalScore,
  isLocationExcluded,
  fitLevelFromScore,
  normalizeFitLevel,
  scoreForFitLevel,
  decisionForFitLevel,
  FIT_LEVEL_META,
  mergeAiDimensions,
  keywordHit,
  detectWorkSchedule,
  desensitizeResumeText,
  hrActivityRank,
  meetsHrActivityFilter,
  extractSalaryMentions,
  collectFaultScope,
} = mod;

try {
  // ===== 一、经验：本地不再计算（2026-09-14 口径变更）=====
  // 经验维度已完全交给 AI 五维评估（job-analysis 的 dimensionScores.experience；提示词口径为
  // 「年限不足 → 降到谨慎档，绝不判不推荐」）。本地原先的「解析 JD 要求年限 / 画像经历区间并集」
  // 与相应断言随之删除，改用下面两条断言守住新口径，防止本地经验计算被悄悄加回来。
  checkNoThrow(
    '本地经验维度恒为 null（经验判定已交给 AI）',
    () => computeLocalMatch(baseJob({ description: '负责后台服务开发，要求3年以上经验' }), baseProfile(), {}).dimensions.experience,
    (v) => v === null
  );
  checkNoThrow(
    'JD 写「3年以上经验」+ 画像仅 4 个月实习 → 不再命中任何经验类硬约束',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, experiences: ['XX科技 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发'] } };
      const job = baseJob({ description: '负责后台服务开发，要求3年以上经验' });
      return computeLocalMatch(job, profile, {}).hardBlocks.filter((b) => /年经验|经验不足|经验/.test(b));
    },
    (blocks) => blocks.length === 0
  );

  // ===== 二、硬约束：学历不达标必须真的拦下来（硬性设置不可突破）=====
  checkNoThrow(
    'JD 要求硕士 + 画像本科 → 命中学历硬约束',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, education: ['XX大学 计算机科学与技术 本科'] } };
      const job = baseJob({ description: '岗位要求硕士及以上学历，负责后端服务开发' });
      return computeLocalMatch(job, profile, {}).hardBlocks;
    },
    (blocks) => blocks.length > 0 && blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '存在硬约束时，兜底分被压到 35 以内',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, education: ['XX大学 计算机科学与技术 本科'] } };
      const job = baseJob({ description: '岗位要求硕士及以上学历，负责后端服务开发' });
      return enhancedLocalScore(job, profile, {});
    },
    (v) => typeof v === 'number' && v <= 35
  );

  // ===== 三、学历：只认硬约束 + 教育经历行，不被正文里的学历词带跑 =====
  // 旧实现把整个 facts JSON 交给 extractDegree（取最高档）→ 项目行出现「协助博士生调研」
  // 就把画像判成博士 → 岗位要求硕士也不拦（漏拦，学历硬设置失效）。
  checkNoThrow(
    '正文含「博士」但教育经历为本科 → 学历仍按本科判定，要求硕士时命中硬约束',
    () => {
      const profile = {
        ...baseProfile(),
        facts: { ...baseProfile().facts, education: ['XX大学 计算机科学与技术 本科'], projects: ['协助博士生完成实验数据整理'] },
      };
      const job = baseJob({ description: '岗位要求硕士及以上学历，负责后端服务开发' });
      return computeLocalMatch(job, profile, {}).hardBlocks;
    },
    (blocks) => blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '画像完全没有学历信息时不误拦（profileDegreeLevel = 0）',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, projects: ['协助博士生完成实验数据整理'] } };
      const job = baseJob({ description: '岗位要求本科及以上学历' });
      return computeLocalMatch(job, profile, {}).hardBlocks;
    },
    (blocks) => !blocks.some((b) => /学历/.test(b))
  );

  // ===== 三之二、JD 学历要求解析：不得把「及以上」升档，不得采信「优先」与薪酬福利句 =====
  // 真实误拦（2026-10-03）：JD 写「本科及以上学历在读（本科大四、研究生优先）」/ 福利段写
  // 「硕士研究生实习薪资 3500 元/月」，旧实现全文取最高档 → 判成「要求硕士」→ 本科画像被硬拦。
  const bachelorProfile = () => ({
    ...baseProfile(),
    facts: { ...baseProfile().facts, education: ['XX大学 计算机科学与技术 本科'] },
  });
  checkNoThrow(
    '「本科及以上学历在读（本科大四、研究生优先）」+ 画像本科 → 不得命中学历硬约束',
    () => computeLocalMatch(baseJob({ description: '任职要求：本科及以上学历在读（本科大四、研究生优先），计算机、软件工程等相关专业' }), bachelorProfile(), {}).hardBlocks,
    (blocks) => !blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '「本科及以上 + 福利段『硕士研究生实习薪资 3500 元/月』」+ 画像本科 → 不得命中学历硬约束',
    () => {
      const desc = '任职要求：\n1、本科及以上，计算机相关专业优先;熟悉 AI 辅助编程者优先;\n薪酬福利：\n1、实习薪资标准：本科生实习薪资为 3000 元/月;硕士研究生实习薪资为 3500 元/月。';
      return computeLocalMatch(baseJob({ description: desc }), bachelorProfile(), {}).hardBlocks;
    },
    (blocks) => !blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '「硕士优先」不是硬性要求 → 画像本科不拦',
    () => computeLocalMatch(baseJob({ description: '岗位职责：后端开发。任职要求：本科及以上学历，硕士研究生优先' }), bachelorProfile(), {}).hardBlocks,
    (blocks) => !blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '「本科以上」漏判修复：画像大专 + JD 要求本科以上 → 必须拦下',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, education: ['XX学院 软件技术 大专'] } };
      return computeLocalMatch(baseJob({ description: '任职要求：本科以上学历，负责后端服务开发' }), profile, {}).hardBlocks;
    },
    (blocks) => blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '真正的「硕士及以上」要求仍必须拦下（不得被新口径放过）',
    () => computeLocalMatch(baseJob({ description: '任职要求：硕士及以上学历，计算机相关专业' }), bachelorProfile(), {}).hardBlocks,
    (blocks) => blocks.some((b) => /学历/.test(b))
  );
  checkNoThrow(
    '「学历不限」不构成要求',
    () => computeLocalMatch(baseJob({ description: '任职要求：学历不限，有相关经验即可' }), bachelorProfile(), {}).hardBlocks,
    (blocks) => !blocks.some((b) => /学历/.test(b))
  );

  // ===== 四、城市反选：跨省同名城市不得互相误杀 =====
  const excl = (provinces, cities = []) => ({ excludedProvinces: provinces, excludedCities: cities });
  check('排除青海 → 不应误杀「海南·海口」（海南藏族自治州 vs 海南省同名）', isLocationExcluded('海南·海口', excl(['青海'])), false);
  check('排除青海 → 仍应拦住「青海·海南州」', isLocationExcluded('青海·海南州', excl(['青海'])), true);
  check('排除海南 → 应拦住「海南·海口」', isLocationExcluded('海南·海口', excl(['海南'])), true);
  check('排除海南 → 不应误杀「青海·海南州」', isLocationExcluded('青海·海南州', excl(['海南'])), false);
  check('排除浙江 → 仍应拦住只显示城市的「杭州·余杭区」', isLocationExcluded('杭州·余杭区', excl(['浙江'])), true);
  check('排除城市「深圳」→ 应拦住「广东·深圳·南山区」', isLocationExcluded('广东·深圳·南山区', excl([], ['深圳'])), true);

  // ===== 五、置信度不再恒为 0.7/0.9 的死开关 =====
  // 旧口径按「非空维度数」计，而 salary/education/experience 缺失时都有中性兜底值（恒非 null），
  // 于是 confidence 恒 ≥ 0.7，matching.ts 的 `confidence >= 0.4/0.5` 门槛无条件成立。
  checkNoThrow(
    '画像/岗位信息稀薄时，confidence 应显著低于 0.7（不再是恒定的 0.7/0.9）',
    () => {
      const profile = {
        ...baseProfile(),
        facts: { ...baseProfile().facts, skills: ['Java'] },
        primaryDirections: [{ name: '后端开发工程师', confidence: 0.7, evidence: [] }],
      };
      const job = baseJob({ salary: '面议', description: '负责后端服务开发' });
      return computeLocalMatch(job, profile, {}).dimensions.confidence;
    },
    (v) => typeof v === 'number' && v < 0.7
  );

  // ===== 六、岗位适配档位 fitLevel（四层整体裁决 → 分数不跨档）=====
  // 四档分数区间：闭区间、互不重叠、并集覆盖 0-100。
  check(
    '四档分数区间互不重叠且覆盖 0-100',
    (() => {
      const order = ['unfit', 'cautious', 'match', 'strong'];
      let prev = -1;
      for (const k of order) {
        const { min, max } = FIT_LEVEL_META[k];
        if (min > max || min !== prev + 1) return false;
        prev = max;
      }
      return prev === 100;
    })(),
    true
  );
  check('fitLevelFromScore(95) → strong', fitLevelFromScore(95), 'strong');
  check('fitLevelFromScore(80) → match', fitLevelFromScore(80), 'match');
  check('fitLevelFromScore(60) → cautious', fitLevelFromScore(60), 'cautious');
  check('fitLevelFromScore(20) → unfit', fitLevelFromScore(20), 'unfit');
  check('fitLevelFromScore(NaN) → cautious（信息不足不盲目判死）', fitLevelFromScore(NaN), 'cautious');

  // normalizeFitLevel：标准值直通、中文近义归一、缺失按 score 反推
  check('normalizeFitLevel 标准值直通', normalizeFitLevel('match', 80), 'match');
  check('normalizeFitLevel 中文「高度匹配」→ strong', normalizeFitLevel('高度匹配', 90), 'strong');
  check('normalizeFitLevel 中文「谨慎」→ cautious', normalizeFitLevel('谨慎', 60), 'cautious');
  check('normalizeFitLevel 缺失 → 按 score 反推', normalizeFitLevel(undefined, 88), 'strong');
  check('normalizeFitLevel 非法值 → 按 score 反推', normalizeFitLevel('乱写', 30), 'unfit');

  // scoreForFitLevel：档位为准，跨档分数被夹回
  check('scoreForFitLevel(cautious, 95) 夹回谨慎档上限内', scoreForFitLevel('cautious', 95) <= 64, true);
  check('scoreForFitLevel(match, 20) 夹到匹配档下限', scoreForFitLevel('match', 20), 65);
  check('scoreForFitLevel(strong) 未给分取区间中点', scoreForFitLevel('strong', NaN), 91);
  check('scoreForFitLevel 档内分数保留', scoreForFitLevel('match', 82), 80);

  // 档位 → 决策一致性
  check('unfit → reject', decisionForFitLevel('unfit'), 'reject');
  check('match → recommend', decisionForFitLevel('match'), 'recommend');
  check('strong → recommend', decisionForFitLevel('strong'), 'recommend');
  check('cautious → cautious', decisionForFitLevel('cautious'), 'cautious');

  // ===== 七、中文技能词抽取与覆盖（C1：中文 JD 缺口检测 + 双向不误报）=====
  checkNoThrow(
    '中文 JD 提「消息队列 / 容器化」，画像无对应技能 → 两个真实缺口都被检出',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, skills: ['Java'] } };
      const job = baseJob({ description: '负责消息队列开发，掌握容器化部署与性能调优' });
      return computeLocalMatch(job, profile, {}).gaps;
    },
    (gaps) => gaps.some((g) => /「消息队列」/.test(g)) && gaps.some((g) => /「容器化」/.test(g))
  );
  checkNoThrow(
    '简历有 Docker（英文）→ JD 中文「容器化」视为已覆盖，不报缺口；消息队列仍报',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, skills: ['Java', 'Docker'] } };
      const job = baseJob({ description: '负责消息队列开发，掌握容器化部署与性能调优' });
      return computeLocalMatch(job, profile, {}).gaps;
    },
    (gaps) => gaps.some((g) => /「消息队列」/.test(g)) && !gaps.some((g) => /「容器化」/.test(g))
  );
  checkNoThrow(
    '简历写「容器化」（中文）→ JD 写 Docker 视为已覆盖，不误报缺口',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, skills: ['Java'] } };
      const job = baseJob({ description: '负责服务开发，掌握 Docker 容器化部署' });
      const resumeText = 'XX实习：使用容器化部署服务，负责后端开发';
      return computeLocalMatch(job, profile, {}, resumeText).gaps;
    },
    (gaps) => !gaps.some((g) => /docker/i.test(g))
  );
  checkNoThrow(
    '中文 JD「深度学习框架」+ 画像只有 PyTorch（同族）→ 不报缺口',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, skills: ['PyTorch'] } };
      const job = baseJob({ title: '深度学习算法工程师', description: '熟悉主流深度学习框架，负责模型训练与推理优化' });
      return computeLocalMatch(job, profile, {}).gaps;
    },
    (gaps) => !gaps.some((g) => /深度学习|pytorch|tensorflow/i.test(g))
  );
  checkNoThrow(
    '中文 JD 无实质技能缺口时不凑数（gaps 可为空）',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, skills: ['Java', 'Spring Boot', '消息队列'] } };
      const job = baseJob({ description: '负责 Java 后端开发，熟悉 Spring Boot，掌握消息队列' });
      return computeLocalMatch(job, profile, {}).gaps;
    },
    (gaps) => !gaps.some((g) => /消息队列|缓存|spring/i.test(g))
  );

  checkNoThrow(
    '标题带地点括号「后端开发工程师（杭州）」仍命中主方向（C2 标题标准化）',
    () => {
      const profile = { ...baseProfile(), primaryDirections: [{ name: '后端开发工程师', confidence: 0.7, evidence: [] }], facts: { ...baseProfile().facts, skills: ['Java'] } };
      const job = baseJob({ title: '后端开发工程师（杭州）' });
      return computeLocalMatch(job, profile, {}).dimensions.direction;
    },
    (v) => typeof v === 'number' && v >= 55
  );

  // ===== 六、AI 维度融合口径（审查 #3）=====
  // 铁律：AI 分 = 最终分；本地五维只做 UI 展示 + AI 不可用时的兜底，**禁融合**。
  // 原实现把「AI 缺失维」用本地值补齐后一并计入 wSum/wTotal → 本地逐词分以 40% 权重进入总分。
  const localOnly = (over = {}) => ({
    dimensions: { skill: 60, direction: 60, location: 60, salary: 60, education: 60, experience: null, overall: 60, ...over },
    hardBlocks: [],
    evidence: [],
    gaps: [],
  });
  const aiAll100 = {
    skill: { score: 100 }, direction: { score: 100 }, salary: { score: 100 },
    education: { score: 100 }, experience: { score: 100 },
  };
  const dimAll100 = mergeAiDimensions(aiAll100, localOnly());
  check('AI 五维全给 → overall = AI 加权分 100', dimAll100.dimensions.overall, 100);
  check('AI 五维全给 → 覆盖度 = 1', dimAll100.aiDimCoverage, (v) => Math.abs(v - 1) < 1e-9);
  const dimSkillOnly = mergeAiDimensions({ skill: { score: 100 } }, localOnly({ skill: 0, direction: 0, salary: 0, education: 0, overall: 0 }));
  check(
    'AI 只给技能维 → overall 只由该维算出（100），**不掺**本地兜底维（旧实现为 38）',
    dimSkillOnly.dimensions.overall,
    100
  );
  check('AI 只给技能维 → 覆盖度 < 0.6（不足以启用 60/40 融合）', dimSkillOnly.aiDimCoverage, (v) => v < 0.6);
  check(
    'AI 只给技能维 → 其余维仍以本地值兜底（仅展示）',
    [dimSkillOnly.dimensions.direction, dimSkillOnly.dimensions.salary, dimSkillOnly.dimensions.education],
    (v) => v.every((x) => x === 0)
  );
  const dimTwo = mergeAiDimensions({ skill: { score: 80 }, direction: { score: 40 } }, localOnly({ skill: 0, direction: 0, overall: 0 }));
  check('AI 给技能+方向（两主维）→ 覆盖度 ≥ 0.6', dimTwo.aiDimCoverage, (v) => v >= 0.6);
  check('AI 技能 80 + 方向 40 → overall = (80×.34+40×.28)/(.34+.28) = 62（重归一）', dimTwo.dimensions.overall, 62);
  const dimNone = mergeAiDimensions(null, localOnly({ overall: 55 }));
  check(
    'AI 一维未给 → aiDimUsed=false 且 overall 保持本地值（不触发融合）',
    [dimNone.aiDimUsed, dimNone.dimensions.overall],
    (v) => v[0] === false && v[1] === 55
  );
  const dimClamp = mergeAiDimensions({ skill: { score: 120 }, direction: { score: -5 } }, localOnly());
  check('AI 维度分越界被夹到 0-100', [dimClamp.dimensions.skill, dimClamp.dimensions.direction], (v) => v[0] === 100 && v[1] === 0);

  // ===== 七、关键词词边界（审查 #41）：`\b` 对 C# / C++ / .NET 方向性失效 =====
  check('keywordHit「C#」命中（旧实现 \\b 假阴性）', keywordHit('C#', '熟悉 C# 开发'), true);
  check('keywordHit「C#」不命中 c#abc（右界收紧，原为子串误命中）', keywordHit('C#', 'c#abc 模板'), false);
  check('keywordHit「C++」命中', keywordHit('C++', '要求 C++ 经验'), true);
  check('keywordHit「C++」不命中 c++abc（旧实现假阳性）', keywordHit('C++', 'c++abc 库'), false);
  check('keywordHit「.NET」命中 ASP.NET（首字符非 \\w，不设左界）', keywordHit('.NET', 'ASP.NET 开发'), true);
  check('keywordHit「.NET」不命中 dotnet', keywordHit('.NET', 'dotnet 开发'), false);
  check('keywordHit「Java」不命中 JavaScript（既有行为保持）', keywordHit('Java', 'JavaScript 工程师'), false);
  check('keywordHit「React」常规命中', keywordHit('React', 'react 开发经验'), true);
  check('keywordHit 中文仍按子串匹配', keywordHit('前端', '资深前端开发'), true);

  // ===== 八、工作制度否定表述（审查 #44）=====
  check('「非双休」不再被判为双休', detectWorkSchedule({ description: '本岗位非双休' }).detected, false);
  check('「不是双休」不再被判为双休', detectWorkSchedule({ description: '不是双休，介意者勿投' }).detected, false);
  check('「非周末双休」不再被判为双休', detectWorkSchedule({ description: '非周末双休' }).detected, false);
  check('「非双休勿投」同样按「未说明」处理（不反向断言是双休）', detectWorkSchedule({ description: '非双休勿投' }).detected, false);
  check('「无双休」不再被判为双休', detectWorkSchedule({ description: '本岗位无双休' }).detected, false);
  check('「周末双休」维持双休（22 天/月）', detectWorkSchedule({ description: '周末双休，五险一金' }).monthlyWorkDays, 22);
  check('「非双休 + 每周工作5.5天」→ 硬数字优先', detectWorkSchedule({ description: '非双休，每周工作5.5天' }).label, '每周 5.5 天');
  check('「非双休 + 月休6天」→ 月休优先', detectWorkSchedule({ description: '非双休，月休6天' }).label, '月休 6 天');

  // ===== 九、脱敏：EMAIL_RE 带 /g 的 lastIndex 漂移（审查 #43）=====
  check(
    '连续两行孤立邮箱都被删除（旧实现漏删第二行 → 明文残留）',
    desensitizeResumeText('a@b.com\nc@d.com\n张三').includes('@'),
    false
  );
  const maskedLine = desensitizeResumeText('联系我：x@y.com');
  check(
    '正文内散落邮箱等长打码（无明文残留）',
    [maskedLine.includes('@'), maskedLine.includes('x@y')],
    (v) => v[0] === false && v[1] === false
  );
  check('孤立手机号整行删除', desensitizeResumeText('13800138000\n张三').trim(), '张三');

  // ===== 十、HR 活跃度分级（审查 #98）=====
  // 旧实现 `/在线/` 置于所有判断之前 → 卡片文本里的「在线简历」「在线沟通」都被判为最高活跃（7），
  // 使「仅在线」筛选放行长期不活跃的岗位（浪费每日配额）。
  check('「在线」整段 → 7 级', hrActivityRank('在线'), 7);
  check('「当前在线」→ 7 级', hrActivityRank('当前在线'), 7);
  check('「张女士 · 在线」→ 7 级（独立词元）', hrActivityRank('张女士 · 在线'), 7);
  check('「在线简历」不再被判为 7 级（非活跃语义）', hrActivityRank('在线简历'), 0);
  check('「完善在线简历与求职意向」不再被判为 7 级', hrActivityRank('完善在线简历与求职意向'), 0);
  check('「在线沟通」不再被判为 7 级', hrActivityRank('在线沟通'), 0);
  check('「刚刚活跃」→ 6 级（回归既有口径）', hrActivityRank('刚刚活跃'), 6);
  check('「3日内活跃」→ 4 级', hrActivityRank('3日内活跃'), 4);
  check('「半年前活跃」→ 1 级', hrActivityRank('半年前活跃'), 1);
  check('空值 → 0 级（不参与过滤）', hrActivityRank(''), 0);
  check(
    '无法识别活跃度时不误杀（「在线简历」在「仅在线」筛选下仍放行）',
    meetsHrActivityFilter('在线简历', 'online'),
    true
  );
  check('「本周活跃」不满足「仅在线」筛选', meetsHrActivityFilter('本周活跃', 'online'), false);

  // ===== 十一、薪资提及折算缺省月工作日（审查 §四·21：禁 22 字面量）=====
  // 缺省值必须来自 workSchedule（周天数 × 52/12 = 22），不得在 salaryCalibration 里写死 22。
  // 断言用「日薪 × 月工作日 ÷ 1000」的实际结果盯住该口径：200 元/天 × 22 ÷ 1000 = 4.4 千元/月。
  check('extractSalaryMentions 缺省月工作日 = 双休口径 22 天（200元/天 → 4.4K/月）', extractSalaryMentions('200元/天')[0]?.monthlyK ?? null, 4.4);
  check('显式传单休口径 26 天：200元/天 → 5.2K/月', extractSalaryMentions('200元/天', 26)[0]?.monthlyK ?? null, 5.2);

  // ===== 十二、采集故障范围分类（审查 #83）=====
  // 队列级 = 账号/环境级 → 整批中止；平台级 = 只收口当前平台。分类错了要么过度阻断、要么带病续跑。
  check('1006 限速 → 平台级（旧实现落到 queue 兜底，一次限速即中止全平台采集）', collectFaultScope(1006), 'platform');
  for (const code of [32, 35, 36, 37, 38]) {
    check(`队列级故障码 ${code} → queue（整批中止交人工）`, collectFaultScope(code), 'queue');
  }
  check('31 未登录 → 平台级（只收口当前平台）', collectFaultScope(31), 'platform');
  check('404 平台接口不存在 → 平台级', collectFaultScope(404), 'platform');
  check('无码 / 0 → 平台级（不牵连其它平台）', [collectFaultScope(null), collectFaultScope(undefined), collectFaultScope(0)], (v) => v.every((x) => x === 'platform'));
  check('未知码 fail-safe → queue（宁停不错）', collectFaultScope(987654), 'queue');

  // ===== 汇总 =====
  if (failures.length) {
    console.error(`\n[评分回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exitCode = 1;
  } else {
    console.log(`[评分回归] 全部通过：${pass} 项断言`);
  }
} finally {
  cleanup();
}
