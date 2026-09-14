// 打招呼语「校名披露」本地规则回归断言（零新增依赖）
//
// 为什么需要它：口径为「只有简历院校属于 985/211 时才在招呼语里写出校名，其余一律不写校名」，
// 判定完全由本地名单（src/lib/bossclaw/schoolTier.ts）裁决并注入提示词 + 兜底拦截。
// 这类规则一旦判错，方向是「双非校名被写进招呼语发给 HR」，或反过来「985/211 校名被本地兜底抹掉」——
// 两种错都不会报错，只会静默影响投递质量，所以必须有断言守住。
//
// 做法：用项目里已有的 esbuild 把 TS 源打成临时 CJS 再 require，不引入任何新依赖、不改 package.json。
//
// 用法：node scripts/greeting-regression.mjs      （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 把校名披露 + 本地兜底模板相关的纯逻辑打成一个临时 CJS（不触发 electron / IPC） */
async function loadGreetingModule() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-greeting-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/bossclaw/schoolTier.ts';",
        "export { fallbackApplicantGreeting } from './src/lib/bossclaw/matching.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'greeting-regression-entry.ts',
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

const { mod, cleanup } = await loadGreetingModule();
const { resolveSchoolTier, hasSchoolMention, buildSchoolDisclosureRule, fallbackApplicantGreeting } = mod;

// ===== 一、院校层级判定（resolveSchoolTier）=====
check('985：北京大学 → 允许写校名', resolveSchoolTier(['北京大学 计算机科学与技术 本科']).allowSchoolName, true);
check('211：西安电子科技大学 → 允许写校名', resolveSchoolTier(['西安电子科技大学 | 通信工程 | 本科']).allowSchoolName, true);
check('211 带括号：中国矿业大学（北京）→ 允许写校名', resolveSchoolTier(['中国矿业大学（北京） 采矿工程 本科']).allowSchoolName, true);
check('双非：深圳大学 → 禁止写校名', resolveSchoolTier(['深圳大学 计算机科学与技术 本科']).allowSchoolName, false);
check('非 211：南京邮电大学 → 禁止写校名', resolveSchoolTier(['南京邮电大学 通信工程 本科']).allowSchoolName, false);
check('独立学院：华中科技大学文华学院 → 禁止写校名', resolveSchoolTier(['华中科技大学文华学院 计算机 本科']).allowSchoolName, false);
check('院系写法：北京大学光华管理学院 → 保守禁止', resolveSchoolTier(['北京大学光华管理学院 工商管理 本科']).allowSchoolName, false);
check('专科：某某职业技术学院 → 禁止写校名', resolveSchoolTier(['某某职业技术学院 计算机应用 大专']).allowSchoolName, false);
check('境外院校 → 禁止写校名', resolveSchoolTier(['University of Sydney 计算机 本科']).allowSchoolName, false);
check('无任何教育信息 → 保守禁止（防幻觉校名）', resolveSchoolTier([]).allowSchoolName, false);
check('本科双非 + 硕士 985 → 允许写校名', resolveSchoolTier(['深圳大学 计算机 本科', '浙江大学 软件工程 硕士']).allowSchoolName, true);
check('画像无教育行时退回简历原文判定', resolveSchoolTier([], '教育经历：北京大学 计算机科学与技术').allowSchoolName, true);

// ===== 二、违规检测（hasSchoolMention）=====
check('招呼语含 985 校名 → 违规', hasSchoolMention('您好，我是北京大学计算机专业在读本科生'), true);
check('招呼语含双非校名 → 违规', hasSchoolMention('您好，我是深圳大学计算机专业在读本科生'), true);
check('含「211」字样 → 违规', hasSchoolMention('我毕业于某 211 院校，做过 React 项目'), true);
check('含「985」字样 → 违规', hasSchoolMention('我是 985 高校计算机专业学生'), true);
check('不含校名 → 合规', hasSchoolMention('您好，我是计算机科学与技术专业在读本科生，做过 React 商城项目'), false);
check('日常表达「我在大学期间」不误报', hasSchoolMention('我在大学期间担任过学生会干部，负责活动统筹'), false);
check('日常表达「大学四年」不误报', hasSchoolMention('大学四年里我一直在做前端相关的项目'), false);
check('日常表达「大学本科阶段」不误报', hasSchoolMention('大学本科阶段主修计算机科学与技术'), false);

// ===== 三、提示词注入文本（buildSchoolDisclosureRule）=====
const allowRule = buildSchoolDisclosureRule({ eliteSchools: ['北京大学'], allowSchoolName: true });
check('允许分支点明可写出的院校', allowRule.includes('北京大学'), true);
check('允许分支仍禁止层级词', allowRule.includes('重点大学'), true);
const denyRule = buildSchoolDisclosureRule({ eliteSchools: [], allowSchoolName: false });
check('禁止分支明确禁止院校名称', denyRule.includes('禁止在招呼语中出现任何院校名称'), true);
check('禁止分支给出「只写学历/专业/年级」写法', denyRule.includes('学历 + 专业 + 年级'), true);

// ===== 四、本地兜底模板（fallbackApplicantGreeting）=====
const job = { title: '前端开发实习生', company: '某公司', salary: '150-200元/天', location: '杭州', description: 'React 开发' };
const profileWithDoubleNon = {
  summary: 's',
  facts: { education: ['深圳大学 计算机科学与技术 本科'], skills: ['React', 'TypeScript'] },
  hardConstraints: { degree: '本科', employmentTypes: ['实习'], experience: '在校' },
};
const greetDoubleNon = fallbackApplicantGreeting(job, profileWithDoubleNon);
check('非 985/211 兜底模板不含校名', /深圳大学/.test(greetDoubleNon), false);
check('非 985/211 兜底模板仍保留专业身份', /计算机科学与技术专业/.test(greetDoubleNon), true);
const profileWith985 = {
  summary: 's',
  facts: { education: ['北京大学 计算机科学与技术 本科'], skills: ['React'] },
  hardConstraints: { degree: '本科', employmentTypes: ['实习'], experience: '在校' },
};
check('985 兜底模板保留校名', /北京大学/.test(fallbackApplicantGreeting(job, profileWith985)), true);

cleanup();

console.log(`打招呼语校名披露回归：通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
