// CSS 视觉守卫（审查 #107/#108/#112/#118/#119/#120 · 批次 15）：
// ---------------------------------------------------------------------------
// 这批 CSS 修复的共同点是「静默失效」—— 写错了不报错、tsc 照过、运行时看不出，
// 只有肉眼比对才可能发现。为了不让它们悄悄回退，这里用静态断言锁住每一条硬约束：
//
//   G1. #107：index.css 不得再用 `!important` 压制 `.ant-btn` 的 transition/transform
//            （`!important` 无视源码顺序，会永久废掉后加载的 index.polish.css 精修层）。
//   G2. #108：`.job-card` 在本库中**只能有一处本体定义**（`^\.job-card {`）——
//            历史上第二处 `border: 1px` 简写会把第一处的 `border-left: 3px` 状态色条压成 1px。
//   G3. #112：tsx 中不得使用未在 CSS 里定义的间距工具类（mb-12 / mt-12 / mb-16 / mt-16）。
//   G4. #118：已删除的死类不得回归（bridge-status / stat-strip / ss-* / job-detail-* / job-desc* / job-item）。
//   G5. #119：不得再用 `transition: all`（性能 + 意外过渡）；且必须存在 prefers-reduced-motion 兜底。
//   G6. #120：不得再出现 z-index 字面值（一律取 `var(--z-*)`）。
//
// 与 jsx-key-regression.mjs 同风格：正则扫描 + 明确白名单（当前为空）。
// 用法：node scripts/css-guard-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(desktopRoot, 'src');
const CSS_FILES = ['index.css', 'index.polish.css'].map((f) => path.join(SRC, f));

const cssText = Object.fromEntries(CSS_FILES.map((f) => [path.basename(f), fs.readFileSync(f, 'utf8')]));
const allCss = Object.values(cssText).join('\n');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
};

/* ---------- G1：无 !important 倒挂压制 .ant-btn 精修层 ---------- */
{
  const hits = [];
  for (const [name, txt] of Object.entries(cssText)) {
    stripCssComments(txt).split('\n').forEach((line, i) => {
      if (/\.ant-btn\b/.test(line) && /!important/.test(line) && /transition|transform/.test(line)) {
        hits.push(`${name}:${i + 1}`);
      }
    });
  }
  ok('G1 .ant-btn 无 !important 倒挂（transition/transform）', hits.length === 0, hits.join(', '));
}

/* ---------- G2：.job-card 本体定义唯一 ---------- */
{
  const defs = [];
  for (const [name, txt] of Object.entries(cssText)) {
    txt.split('\n').forEach((line, i) => {
      if (/^\.job-card\s*\{/.test(line.trim())) defs.push(`${name}:${i + 1}`);
    });
  }
  ok('G2 .job-card 本体定义唯一（防 border 简写压吞状态色条）', defs.length <= 1, `发现 ${defs.length} 处：${defs.join(', ')}`);
}

/* ---------- G3：无未定义的间距工具类 ---------- */
{
  const DEAD_UTILS = ['mb-12', 'mt-12', 'mb-16', 'mt-16'];
  const hits = [];
  for (const f of walkTsx(SRC)) {
    // 剥离 JSX 块注释 {/* */} 与行注释，避免说明文字里的类名被误判为真实用法
    const txt = fs.readFileSync(f, 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    txt.split('\n').forEach((line, i) => {
      for (const cls of DEAD_UTILS) {
        const re = new RegExp(`className=(?:"|\\{')[^"'\\n]*\\b${cls}\\b`);
        if (re.test(line)) hits.push(`${path.relative(desktopRoot, f)}:${i + 1} → ${cls}`);
      }
    });
  }
  ok('G3 无未定义的间距工具类（mb-12/mt-12/mb-16/mt-16）', hits.length === 0, hits.join(' | '));
}

/* ---------- G4：已删死类不得回归 ---------- */
{
  const BANNED = ['bridge-status', 'stat-strip', 'ss-item', 'ss-label', 'ss-value', 'job-detail-block', 'job-detail-rows', 'job-detail-row', 'job-detail-k', 'job-detail-v', 'job-desc-title', 'job-desc-text', 'job-item'];
  const hits = [];
  for (const [name, txt] of Object.entries(cssText)) {
    stripCssComments(txt).split('\n').forEach((line, i) => {
      for (const cls of BANNED) {
        if (new RegExp(`(^|[\\s,])&?\\.${cls}\\b`).test(line)) hits.push(`${name}:${i + 1} → .${cls}`);
      }
    });
  }
  ok('G4 已删死类未回归（bridge-status/stat-strip/ss-*/job-detail-*/job-desc*/job-item）', hits.length === 0, hits.join(' | '));
}

/* ---------- G5：无 transition:all + 存在 reduced-motion 兜底 ---------- */
{
  const alls = [];
  for (const [name, txt] of Object.entries(cssText)) {
    stripCssComments(txt).split('\n').forEach((line, i) => {
      if (/transition:\s*all\b/.test(line)) alls.push(`${name}:${i + 1}`);
    });
  }
  ok('G5a 无 transition: all（性能 + 意外过渡）', alls.length === 0, alls.join(', '));
  ok('G5b 存在 prefers-reduced-motion 兜底', /prefers-reduced-motion/.test(allCss));
}

/* ---------- G6：无 z-index 字面值 ---------- */
{
  const hits = [];
  for (const [name, txt] of Object.entries(cssText)) {
    const lines = stripCssComments(txt).split('\n');
    lines.forEach((line, i) => {
      // 变量定义行 `--z-xxx: 10;` 不算（它没有 z-index: 前缀）
      if (/z-index:\s*\d+/.test(line)) hits.push(`${name}:${i + 1}`);
    });
  }
  ok('G6 无 z-index 字面值（一律 var(--z-*)）', hits.length === 0, hits.join(', '));

  // G6b：用到的 --z-* 必须都在 :root 里定义过
  const used = new Set([...allCss.matchAll(/var\((--z-[a-z-]+)\)/g)].map((m) => m[1]));
  const defined = new Set([...allCss.matchAll(/(--z-[a-z-]+):/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  ok('G6b 用到的 --z-* 均已定义', missing.length === 0, missing.join(', '));
}

/* ---------- 工具 ---------- */
/**
 * 剥离 CSS 注释（含跨行块注释与行内注释），避免注释里提到的
 * `transition: all` / `z-index:0` / `!important` 被误判为真实声明。
 * 保留换行数（用等长空白替换）以维持行号可读。
 */
function stripCssComments(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function walkTsx(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsx(p, out);
    else if (/\.tsx$/.test(entry.name)) out.push(p);
  }
  return out;
}

console.log('[CSS 视觉守卫] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
process.exit(0);
