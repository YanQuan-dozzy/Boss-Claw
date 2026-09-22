// 智联搜索 URL「基础求职条件」附加回归断言（零新增依赖）
//
// 为什么需要它：内置浏览器列表级采集会**直接打开** platformUrls.ts 构建的智联搜索 URL，
// 「基础求职条件」必须真实拼进 URL，否则页面上看到的就是「不限」。本脚本守住该翻译结果，
// 并作为与 `camoufox/platforms/filters.py`（唯一权威）的**双源同步守卫**：
// 改任意一侧码表，另一侧（这里或 probe-platforms.py）必须跟着过。
//
// 用法：node scripts/zhaopin-url-regression.mjs    （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-zhilian-url-'));
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
      sourcefile: 'zhilian-url-entry.ts',
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
  const { buildZhaopinSearchUrl } = require(outfile);

  /** 智联 URL 样例：北京 + 10-15K + 关键词，附 criteria */
  const u = (criteria) =>
    buildZhaopinSearchUrl({ keyword: '全栈开发实习生', city: '北京', salary: '10-15K', page: 1, criteria });

  const base = u(undefined);
  has('基础 URL 含 路径式 + 城市码 + 薪资 + 关键词', base, '/sou/jl530/p1?sl=4&kw=');
  hasNot('无 criteria 不附加筛选参数', base, 'et=');
  hasNot('无 criteria 不附加筛选参数（we）', base, 'we=');
  hasNot('无 criteria 不附加筛选参数（fs）', base, 'fs=');

  // 求职类型 et（用户实测链接：全职2/实习4/兼职1/校招5）
  has('实习 → et=4', u({ employmentTypes: ['实习'] }), 'et=4');
  has('全职 → et=2', u({ employmentTypes: ['全职'] }), 'et=2');
  has('兼职 → et=1', u({ employmentTypes: ['兼职'] }), 'et=1');
  has('校招 → et=5', u({ employmentTypes: ['校招'] }), 'et=5');
  has('实习+校招 → et=4,5（,连接）', u({ employmentTypes: ['实习', '校招'] }), 'et=4,5');
  hasNot('求职类型=不限 → 不附加 et', u({ employmentTypes: ['不限'] }), 'et=');

  // 融资阶段 fs（不需要融资8/未融资1；有融资聚合 2;3;4;5;6）
  has('不需要融资 → fs=8', u({ financing: ['不需要融资'] }), 'fs=8');
  has('未融资 → fs=1', u({ financing: ['未融资'] }), 'fs=1');
  has('有融资聚合 → fs=2;3;4;5;6', u({ financing: ['有融资'] }), 'fs=2;3;4;5;6');
  has('有融资+未融资 → fs=2;3;4;5;6,1', u({ financing: ['有融资', '未融资'] }), 'fs=2;3;4;5;6,1');
  hasNot('融资=不限 → 不附加 fs', u({ financing: ['不限'] }), 'fs=');

  // 经验 we（1年以内同 0001；多选 , 连接）
  has('1年以内 → we=0001', u({ experiences: ['1年以内'] }), 'we=0001');
  has('1年以下 → we=0001', u({ experiences: ['1年以下'] }), 'we=0001');
  has('1年以下+1-3+3-5+5-10 → we=0001,0103,0305,0510',
    u({ experiences: ['1年以下', '1-3年', '3-5年', '5-10年'] }), 'we=0001,0103,0305,0510');

  // 学历 el / 公司规模 cs / 公司性质 ct
  has('本科 → el=4', u({ degrees: ['本科'] }), 'el=4');
  has('100-499人 → cs=3,8（聚合）', u({ companyScale: '100-499人' }), 'cs=3,8');
  has('20-99人 → cs=2', u({ companyScale: '20-99人' }), 'cs=2');
  has('国企 → ct=1', u({ companyType: '国企' }), 'ct=1');
  has('中外合资 → ct=4', u({ companyType: '中外合资' }), 'ct=4');
  has('港澳台企业 → ct=16', u({ companyType: '港澳台企业' }), 'ct=16');
  has('机关/事业单位 → ct=6;10', u({ companyType: '机关/事业单位' }), 'ct=6;10');
  has('其他 → ct=7;14;15', u({ companyType: '其他' }), 'ct=7;14;15');

  // 全量组合（对齐 filters.py 摘要口径）
  const full = u({
    employmentTypes: ['实习', '校招'], financing: ['有融资', '未融资'],
    experiences: ['1年以内'], degrees: ['本科'], companyScale: '100-499人', companyType: '国企',
  });
  has('全量组合 et', full, 'et=4,5');
  has('全量组合 fs', full, 'fs=2;3;4;5;6,1');
  has('全量组合 we', full, 'we=0001');
  has('全量组合 el', full, 'el=4');
  has('全量组合 cs', full, 'cs=3,8');
  has('全量组合 ct', full, 'ct=1');
} catch (err) {
  failures.push(`导入/执行失败：${err?.message || err}`);
} finally {
  cleanup();
}

if (failures.length) {
  console.error(`\n[智联 URL 回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[智联 URL 回归] 全部通过：${pass} 项断言`);
}