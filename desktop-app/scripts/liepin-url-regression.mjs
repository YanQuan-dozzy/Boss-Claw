// 猎聘搜索 URL「基础求职条件 + HR 活跃度 + 薪资」附加回归断言（零新增依赖）
//
// 为什么需要它：内置浏览器列表级采集会**直接打开** platformUrls.ts 构建的猎聘搜索 URL，
// 筛选（salaryCode / workYearCode / eduLevel / compScale / compKind / pubTime）必须真实拼进 URL，
// 否则页面上看到的就是「不限」。本脚本守住该翻译结果，并作为与
// `camoufox/platforms/filters.py`（唯一权威）的**双源同步守卫**：
// 改任意一侧码表，另一侧（这里或 probe-platforms.py）必须跟着过。
//
// 用法：node scripts/liepin-url-regression.mjs    （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-liepin-url-'));
const outfile = join(dir, 'bundle.cjs');
const cleanup = () => rmSync(dir, { recursive: true, force: true });

let pass = 0;
const failures = [];
function has(name, actual, needle) {
  const ok = actual.includes(needle);
  if (ok) pass += 1;
  else failures.push(`${name}\n      期望含：${needle}\n      实际：${actual}`);
}
function hasNot(name, actual, needle) {
  const ok = !actual.includes(needle);
  if (ok) pass += 1;
  else failures.push(`${name}\n      不应含：${needle}\n      实际：${actual}`);
}

try {
  await build({
    stdin: {
      contents: "export * from './src/lib/bossclaw/platformUrls.ts';",
      resolveDir: root,
      sourcefile: 'liepin-url-entry.ts',
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
  const { buildLiepinSearchUrl } = require(outfile);

  /** 猎聘 URL 样例：全国 + 关键词，附 criteria / salary */
  const u = (patch = {}) =>
    buildLiepinSearchUrl({ keyword: '全栈开发实习生', city: '全国', page: 1, ...patch });

  // ---- 基础 URL（城市码 410 = 全国；参数名以平台自生成链接为准）----
  const base = u();
  has('基础 URL 含 城市码 + currentPage + 关键词', base, 'city=410&dq=410&currentPage=0&key=');
  hasNot('无 criteria 不附加经验', base, 'workYearCode=');
  hasNot('无 criteria 不附加学历', base, 'eduLevel=');
  hasNot('无 criteria 不附加规模', base, 'compScale=');
  hasNot('无 criteria 不附加性质', base, 'compKind=');
  hasNot('无 criteria 不附加活跃度', base, 'pubTime=');
  hasNot('无薪资不附加 salaryCode', base, 'salaryCode=');
  has('北京 → city=010', buildLiepinSearchUrl({ city: '北京' }), 'city=010&dq=010');

  // ---- 薪资 salaryCode（用户实测：10万以下 1 / 10-15万 2 / 自定义 9$11）----
  has('月薪区间 15-25K → 换算年薪自定义 18$30（原样 $，不 percent-encode）', u({ salary: '15-25K' }), 'salaryCode=18$30');
  has('月薪区间 12-20k（小写）→ salaryCode=14.4$24', u({ salary: '12-20k' }), 'salaryCode=14.4$24');
  has('年薪区间 9-11万 → salaryCode=9$11', u({ salary: '9-11万' }), 'salaryCode=9$11');
  has('年薪档名 16-20万 → salaryCode=3', u({ salary: '16-20万' }), 'salaryCode=3');
  has('年薪档名 100万以上 → salaryCode=7', u({ salary: '100万以上' }), 'salaryCode=7');
  has('纯数字码直接透传 → salaryCode=2', u({ salary: '2' }), 'salaryCode=2');
  hasNot('单值 20K 不附加（无法构成区间）', u({ salary: '20K' }), 'salaryCode=');
  hasNot('薪资=不限 不附加', u({ salary: '不限' }), 'salaryCode=');

  // ---- 经验 workYearCode（区间式单值；用户实测 应届生 1 / 实习生 2 / 0$1 / 1$3 / 3$5 / 10$999）----
  has('1年以内 → workYearCode=0$1', u({ criteria: { experiences: ['1年以内'] } }), 'workYearCode=0$1');
  has('1-3年 → workYearCode=1$3', u({ criteria: { experiences: ['1-3年'] } }), 'workYearCode=1$3');
  has('3-5年 → workYearCode=3$5', u({ criteria: { experiences: ['3-5年'] } }), 'workYearCode=3$5');
  has('5-10年 → workYearCode=5$10（推得）', u({ criteria: { experiences: ['5-10年'] } }), 'workYearCode=5$10');
  has('10年以上 → workYearCode=10$999', u({ criteria: { experiences: ['10年以上'] } }), 'workYearCode=10$999');
  has('应届生 → workYearCode=1', u({ criteria: { experiences: ['应届生'] } }), 'workYearCode=1');
  has('在校生 → workYearCode=2（平台「实习生」）', u({ criteria: { experiences: ['在校生'] } }), 'workYearCode=2');
  has('多选只取首个可映射项（1-3年 优先）', u({ criteria: { experiences: ['1-3年', '3-5年'] } }), 'workYearCode=1$3');
  hasNot('多选不拼接第二项', u({ criteria: { experiences: ['1-3年', '3-5年'] } }), 'workYearCode=1$3$3$5');
  hasNot('经验=不限 → 不附加', u({ criteria: { experiences: ['不限'] } }), 'workYearCode=');

  // ---- 学历 eduLevel（用户实测逐值确认 博士 010 / 硕士 030 / 本科 040 / 大专 050）----
  has('本科 → eduLevel=040', u({ criteria: { degrees: ['本科'] } }), 'eduLevel=040');
  has('硕士 → eduLevel=030', u({ criteria: { degrees: ['硕士'] } }), 'eduLevel=030');
  has('博士 → eduLevel=010', u({ criteria: { degrees: ['博士'] } }), 'eduLevel=010');
  has('大专 → eduLevel=050', u({ criteria: { degrees: ['大专'] } }), 'eduLevel=050');
  has('硕士+本科 → eduLevel=030$040', u({ criteria: { degrees: ['硕士', '本科'] } }), 'eduLevel=030$040');

  // ---- 公司规模 compScale（实测 010~040；设置页跨档项不附加）----
  has('0-20人 → compScale=010（并入猎聘 1-49人）', u({ criteria: { companyScale: '0-20人' } }), 'compScale=010');
  has('100-499人 → compScale=030', u({ criteria: { companyScale: '100-499人' } }), 'compScale=030');
  has('500-999人 → compScale=040', u({ criteria: { companyScale: '500-999人' } }), 'compScale=040');
  has('10000人以上 → compScale=080', u({ criteria: { companyScale: '10000人以上' } }), 'compScale=080');
  hasNot('20-99人 跨猎聘两档 → 不附加', u({ criteria: { companyScale: '20-99人' } }), 'compScale=');
  hasNot('1000-9999人 跨猎聘三档 → 不附加', u({ criteria: { companyScale: '1000-9999人' } }), 'compScale=');
  hasNot('公司规模=不限 → 不附加', u({ criteria: { companyScale: '不限' } }), 'compScale=');

  // ---- 公司性质 compKind（实测 外企 010 / 中外合资 020）----
  has('外企 → compKind=010', u({ criteria: { companyType: '外企' } }), 'compKind=010');
  has('中外合资 → compKind=020', u({ criteria: { companyType: '中外合资' } }), 'compKind=020');
  has('民营 → compKind=030（推得）', u({ criteria: { companyType: '民营' } }), 'compKind=030');
  has('国企 → compKind=040（推得）', u({ criteria: { companyType: '国企' } }), 'compKind=040');
  hasNot('港澳台企业 猎聘无对应 → 不附加', u({ criteria: { companyType: '港澳台企业' } }), 'compKind=');
  hasNot('机关/事业单位 猎聘无单值对应 → 不附加', u({ criteria: { companyType: '机关/事业单位' } }), 'compKind=');

  // ---- HR 活跃度 pubTime（实测 一天以内 1 / 三天以内 3）----
  has('today → pubTime=1', u({ criteria: { hrActivity: 'today' } }), 'pubTime=1');
  has('justActive → pubTime=1（猎聘最细为一天）', u({ criteria: { hrActivity: 'justActive' } }), 'pubTime=1');
  has('3days → pubTime=3', u({ criteria: { hrActivity: '3days' } }), 'pubTime=3');
  has('week → pubTime=7（推得）', u({ criteria: { hrActivity: 'week' } }), 'pubTime=7');
  has('month → pubTime=30（推得）', u({ criteria: { hrActivity: 'month' } }), 'pubTime=30');
  hasNot('HR活跃度=any → 不附加', u({ criteria: { hrActivity: 'any' } }), 'pubTime=');
  hasNot('仅在线 猎聘无对应窗口 → 不附加', u({ criteria: { hrActivity: 'online' } }), 'pubTime=');

  // ---- 全量组合（对齐 filters.py 摘要口径）----
  const full = u({
    salary: '15-25K',
    criteria: {
      experiences: ['1-3年'], degrees: ['硕士'], companyScale: '100-499人',
      companyType: '外企', hrActivity: '3days',
    },
  });
  has('全量组合 salaryCode', full, 'salaryCode=18$30');
  has('全量组合 workYearCode', full, 'workYearCode=1$3');
  has('全量组合 eduLevel', full, 'eduLevel=030');
  has('全量组合 compScale', full, 'compScale=030');
  has('全量组合 compKind', full, 'compKind=010');
  has('全量组合 pubTime', full, 'pubTime=3');
  hasNot('猎聘无求职类型筛选 → 不附加 jobKind', full, 'jobKind=');
  // ---- 融资阶段 compStage（实测 A轮 02 / B轮 03；键为**猎聘口径**选项名）----
  has('天使轮 → compStage=01（推得）', u({ criteria: { financing: ['天使轮'] } }), 'compStage=01');
  has('A轮 → compStage=02', u({ criteria: { financing: ['A轮'] } }), 'compStage=02');
  has('B轮 → compStage=03', u({ criteria: { financing: ['B轮'] } }), 'compStage=03');
  has('融资未公开 → compStage=08（推得）', u({ criteria: { financing: ['融资未公开'] } }), 'compStage=08');
  has('A轮+B轮 → compStage=02$03（多值 $ 拼接）', u({ criteria: { financing: ['A轮', 'B轮'] } }), 'compStage=02$03');
  hasNot('智联口径「有融资」在猎聘不附加', u({ criteria: { financing: ['有融资'] } }), 'compStage=');
  hasNot('智联口径「不需要融资/未融资」在猎聘不附加',
    u({ criteria: { financing: ['不需要融资', '未融资'] } }), 'compStage=');
} catch (err) {
  failures.push(`导入/执行失败：${err?.message || err}`);
} finally {
  cleanup();
}

if (failures.length) {
  console.error(`\n[猎聘 URL 回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[猎聘 URL 回归] 全部通过：${pass} 项断言`);
}
