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
  parseExperienceYears,
  parseMonthSpan,
  profileExperienceYears,
  computeLocalMatch,
  enhancedLocalScore,
  isLocationExcluded,
  fitLevelFromScore,
  normalizeFitLevel,
  scoreForFitLevel,
  decisionForFitLevel,
  FIT_LEVEL_META,
} = mod;

try {
  // ===== 一、经验年限：经历行里的年月不能被当成「经验年数」 =====
  // 旧实现逐行取「全部数字的最小值」→「（2025.06-2025.09）」返回 2025.06，
  // 多段经历再求和 → 画像经验虚高到上千 → 「岗位要求年限 > 画像年限」硬约束永不成立（漏拦）。
  check(
    '经历行只含年月区间时，parseExperienceYears 不应产出年限',
    parseExperienceYears('XX科技 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发'),
    null
  );
  check(
    '中文年月区间同样不应被当成年限',
    parseExperienceYears('2022年9月-2023年6月 XX公司 后端开发'),
    null
  );
  check('正常「3-5年经验」仍取下限 3', parseExperienceYears('3-5年经验'), 3);
  check('「在校/应届」仍为 0 年', parseExperienceYears('在校/应届'), 0);

  checkNoThrow(
    '单段 2025.06-2025.09 ≈ 0.3 年（4 个月）',
    () => profileExperienceYears({ ...baseProfile(), facts: { ...baseProfile().facts, experiences: ['XX科技 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发'] } }),
    (v) => v === 0.3
  );
  checkNoThrow(
    '重叠经历取区间并集，不重复计数（2022.01-2023.01 与 2022.06-2023.06 → 18 个月 = 1.5 年）',
    () =>
      profileExperienceYears({
        ...baseProfile(),
        facts: { ...baseProfile().facts, experiences: ['A公司 开发（2022.01-2023.01）：负责后台', 'B公司 开发（2022.06-2023.06）：负责前台'] },
      }),
    (v) => v === 1.5
  );
  checkNoThrow(
    '不重叠的两段经历正确累加（13 + 13 个月 = 2.2 年）',
    () =>
      profileExperienceYears({
        ...baseProfile(),
        facts: { ...baseProfile().facts, experiences: ['A公司 开发（2020.01-2021.01）：负责后台', 'B公司 开发（2022.01-2023.01）：负责前台'] },
      }),
    (v) => v === 2.2
  );
  checkNoThrow(
    'parseMonthSpan 解析 2025.06-2025.09 为月序区间',
    () => parseMonthSpan('XX（2025.06-2025.09）'),
    (v) => v && v.start === 2025 * 12 + 6 && v.end === 2025 * 12 + 9
  );

  // ===== 二、硬约束：经验不足必须真的拦下来（硬性设置不可突破）=====
  checkNoThrow(
    'JD 要求 3 年经验 + 画像仅 4 个月实习 → 命中经验硬约束',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, experiences: ['XX科技 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发'] } };
      const job = baseJob({ description: '负责后台服务开发，要求3年以上经验' });
      return computeLocalMatch(job, profile, {}).hardBlocks;
    },
    (blocks) => blocks.length > 0 && blocks.some((b) => /年经验/.test(b))
  );
  checkNoThrow(
    '存在硬约束时，兜底分被压到 35 以内',
    () => {
      const profile = { ...baseProfile(), facts: { ...baseProfile().facts, experiences: ['XX科技 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发'] } };
      const job = baseJob({ description: '负责后台服务开发，要求3年以上经验' });
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
