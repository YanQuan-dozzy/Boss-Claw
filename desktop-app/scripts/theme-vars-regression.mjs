// 主题变量单一来源守卫（审查 P5-01 / H10）：
// 运行时主题变量由 App.tsx 用 theme.ts::cssVars(effective) 内联覆盖到 <html> 内联样式，
// cssVars 是唯一运行时来源。本脚本断言：
//   A. cssVars 的 light 与 dark 两个分支键集合完全相等（缺任一侧 = 主题间分叉）；
//   B. index.css 中每个 var(--x) 引用都「有来源」：在 cssVars 中声明，或在 index.css
//      自身定义（组件/页面级功能变量如 --pf-*、--resume-tag-row-h 不走主题切换）。
// 用法：node scripts/theme-vars-regression.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssRaw = fs.readFileSync(path.join(desktopRoot, 'src', 'index.css'), 'utf8');
// 先剥离 CSS 注释：注释里出现的 `var(--status-*-rgb)` 这类「示意写法」不能被当成真实引用
// （审查 #114 批次踩到：通配写法 `--status-*` 被正则截成 `--status-` → 误报悬空变量）。
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const ts = fs.readFileSync(path.join(desktopRoot, 'src', 'theme.ts'), 'utf8');

// index.css 中引用的全部 var(--x)
const cssRefs = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
// index.css 中自身定义的变量（--name: value）。
// 前导边界允许：行首、`;`、`{`、`}`、块注释结束 `*/`（本脚本曾漏掉「紧跟在注释块之后」的定义，
// 导致 --brand / --status-*-rgb / --z-* 等被误判为「无来源」—— 见审查 #114 批次）。
const cssDefined = new Set(
  [...css.matchAll(/(?:^|[;{}\n]|\*\/)\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1])
);

// cssVars 函数体（结构：`? { …keys… }` 为 dark 分支、`: { …keys… }` 为 light 分支）
const fnBody = ts.match(/export const cssVars = \(mode: ThemeMode\) => \{[\s\S]*?\n\};/)?.[0];
if (!fnBody) {
  console.error('✗ 未找到 cssVars 函数体（theme.ts 结构变化？）');
  process.exit(1);
}
const qIdx = fnBody.indexOf('? {');
const cIdx = fnBody.indexOf(': {', qIdx);
if (qIdx < 0 || cIdx < 0) {
  console.error('✗ cssVars 分支结构解析失败（theme.ts 变化？）');
  process.exit(1);
}
const keysOf = (block) => new Set([...block.matchAll(/'--[a-z0-9-]+':/g)].map((m) => m[0].slice(1, -2)));
const darkKeys = keysOf(fnBody.slice(qIdx, cIdx));
const lightKeys = keysOf(fnBody.slice(cIdx));

let fail = 0;
// 断言 A：light 与 dark 键集合必须完全相等（一处多一处少 = 主题间分叉）
const onlyLight = [...lightKeys].filter((k) => !darkKeys.has(k));
const onlyDark = [...darkKeys].filter((k) => !lightKeys.has(k));
if (onlyLight.length || onlyDark.length) {
  fail += onlyLight.length + onlyDark.length;
  if (onlyLight.length) console.error(`✗ cssVars 仅 light 有：${onlyLight.join(', ')}`);
  if (onlyDark.length) console.error(`✗ cssVars 仅 dark 有：${onlyDark.join(', ')}`);
}
// 断言 B：每个引用都「有来源」（cssVars 或 index.css 自身定义）—— 防悬空变量
const themedOrDefined = new Set([...lightKeys, ...darkKeys, ...cssDefined]);
for (const v of [...cssRefs].sort()) {
  if (lightKeys.has(v) && darkKeys.has(v)) continue; // 主题变量 → 已断言两侧齐备
  if (!themedOrDefined.has(v)) {
    fail++;
    console.error(`✗ CSS 引用 ${v} 无来源：既不在 cssVars，也未在 index.css 定义`);
  }
}

console.log(`index.css var() 引用：${cssRefs.size} 个 | 自身定义：${cssDefined.size} 个 | cssVars light：${lightKeys.size} / dark：${darkKeys.size}`);
console.log(`light ∩ dark 完全相等：${onlyLight.length === 0 && onlyDark.length === 0 ? '✓' : '✗'}`);
if (fail) {
  console.error(`✗ 主题变量守卫失败（${fail} 项），cssVars 或 index.css 需同步`);
  process.exit(1);
}
console.log('✅ 主题变量：cssVars 双分支一致，CSS 全部引用均有来源');
process.exit(0);