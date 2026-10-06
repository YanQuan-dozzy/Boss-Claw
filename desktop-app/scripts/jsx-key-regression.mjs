// React key 稳定性守卫（审查 §四表 24 / 批次 11）：
// ---------------------------------------------------------------------------
// 列表用 map 下标作 key 时，任何重排（排序 / 插入 / 窗口位移）都会让 React 按位置复用 DOM：
// 动画、悬停态、焦点、受控输入值会**串到别的行**，且这类 bug 不会报错、tsc 也照过（静默）。
//
// 本脚本用 AST 无关的正则扫描（与 theme-vars-regression 同风格）断言：
//   A. `src/**/*.tsx` 中不存在 `key={单个小写标识符}` 形式（i / idx / index / n / k / j …）；
//   B. 例外白名单：确需下标且已人工确认「列表不重排」的位置 —— 以「文件:key表达式」精确登记，
//      新增例外必须在此显式加白（并附理由），避免悄悄回退。
//
// 为什么用正则而非 AST：本仓库无 @babel/parser 依赖，且 `key={x}` 的写法极其规律
// （属性名 + 单个标识符 + 花括号），正则误报率可接受；白名单兜住少数合法例外。
//
// 用法：node scripts/jsx-key-regression.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(desktopRoot, 'src');

/**
 * 视为「下标型」的标识符名（列表下标常见的命名）。
 *
 * 注意：**刻意不含 `k` / `n` / `key`** —— 它们在真实代码里更常是**业务短名**
 * （`key` = 路由名 / 维度名，见 App.tsx 的 NAV_PAGES、Tasks.tsx 的维度表），
 * 误报成本高于漏报（误报会逼着后来者写无意义的白名单，反而让守卫失去威信）。
 * 只保留「几乎只可能是下标」的名字。
 */
const INDEX_NAMES = new Set(['i', 'j', 'idx', 'index', 'itemIndex', 'rowIndex', 'pos', 'position']);

/**
 * 白名单：`相对路径 -> Set<key表达式>`，登记「确认不重排、用下标可接受」的位置。
 * 新增条目必须在注释里写清「为什么这份列表不会重排」。
 */
const ALLOWLIST = new Map([
  // 示例格式（当前为空 —— 所有 index key 已在批次 11 修完）：
  // ['pages/Foo.tsx', new Set(['i'])],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
let violations = [];
let scanned = 0;

for (const abs of files) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  const text = fs.readFileSync(abs, 'utf8');
  scanned += 1;
  const allow = ALLOWLIST.get(rel) || new Set();

  // 逐行扫描，便于给出准确行号；`key={ident}` 单标识符形式
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const m = line.match(/\bkey=\{([A-Za-z_$][\w$]*)\}/);
    if (!m) return;
    const name = m[1];
    if (!INDEX_NAMES.has(name)) return;
    if (allow.has(name)) return;
    violations.push({ rel, line: idx + 1, name, text: line.trim() });
  });
}

console.log(`扫描 .tsx 文件：${scanned} 个`);

if (violations.length) {
  console.error(`\n✗ 发现 ${violations.length} 处疑似「下标作 key」（重排时会串位）：`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  key={${v.name}}  →  ${v.text.slice(0, 90)}`);
  }
  console.error('\n修法：改用稳定业务键（id / 文本 / 模块+原文组合）；确需下标时在 ALLOWLIST 登记并注明理由。');
  process.exit(1);
}

console.log('✅ 未发现下标作 key（或均已在白名单登记）');
