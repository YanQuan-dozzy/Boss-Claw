// PDF 简历解析回归（零新增依赖）
//
// 为什么需要它：简历中心的 PDF 解析是手写的「内容流分词 + 坐标重建」，两条路径都有静默失效风险：
//   ① 把字体程序/图像等**二进制流当正文**送去分词 —— 随机二进制里的 '[' '<' '(' 会触发
//      tokenizeTextBlock 的**灾难性回溯**，实测 329KB 字体流 81s、1MB 以上卡死渲染进程；
//   ② 反过来，闸门收得过紧会**误杀真实内容流**，正文静默丢失（不报错、tsc 照过）。
// 两个方向都必须有断言钉死：既要「不卡、不产垃圾」，也要「正文一字不少」。
//
// 用法：node scripts/pdf-parse-regression.mjs      （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ===== 断言工具 =====
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望：${e}\n      实际：${a}`);
}
function contains(name, haystack, needle) {
  ok(name, String(haystack).includes(needle), `期望包含：${JSON.stringify(needle)}\n      实际：${JSON.stringify(String(haystack).slice(0, 260))}`);
}
function notContains(name, haystack, needle) {
  ok(name, !String(haystack).includes(needle), `期望不含：${JSON.stringify(needle)}`);
}

// ===== 加载被测模块 =====
async function loadExtractor() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-pdf-reg-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: "export { extractPdfText, isReadableResumeText } from './src/lib/bossclaw/pdfExtractor.ts';",
      resolveDir: root,
      sourcefile: 'pdf-regression-entry.ts',
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
  return { mod: require(outfile), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===== 最小 PDF 夹具构造器 =====
const latin1 = (s) => Buffer.from(s, 'latin1');
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function pdf(parts) {
  const out = Buffer.concat([latin1('%PDF-1.4\n'), ...parts.map((p) => latin1(p))]);
  return ab(out);
}
const obj = (id, dict, body) =>
  body == null
    ? `${id} 0 obj\n${dict}\nendobj\n`
    : `${id} 0 obj\n${dict}\nstream\n${body}\nendstream\nendobj\n`;

const CATALOG = obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
const PAGES = obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');

function pageObj(contentsId) {
  return obj(3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents ${contentsId} 0 R >>`);
}
const FONT = obj(6, '<< /Type /Font /Subtype /TrueType /BaseFont /F1 /FontDescriptor 7 0 R /ToUnicode 9 0 R >>');
const FONT_DESC = obj(7, '<< /Type /FontDescriptor /FontName /F1 /FontFile2 8 0 R >>');
// ToUnicode：<0001>→中 <0002>→文
const TUNICODE = obj(
  9,
  '<< /Length 999 >>',
  '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<0001> <4E2D>\n<0002> <6587>\nendbfchar\nendcmap\nend'
);

// 模拟真实字体程序：高熵二进制 + 夹带 'BT' 与括号（旧实现正是被这些字节骗进分词）
function fontBlob(size, { withBtEt = true } = {}) {
  const buf = randomBytes(size);
  if (withBtEt && size > 16) {
    Buffer.from('BT ', 'latin1').copy(buf, 0);
    Buffer.from(' ET', 'latin1').copy(buf, size - 3);
    for (let i = 64; i + 4 < size; i += 1013) buf.write('(A1)', i, 'latin1');
  }
  return deflateSync(buf);
}

// 内容流「正常但用批量绘制」的正文（大字体流不得让它被误杀）
const REAL_TEXT_CONTENT = 'BT /F1 12 Tf 40 700 Td (Hello Resume Education Skills Engineer) Tj ET';
// /Contents 被（错误地）指向字体程序流
const BROKEN_CONTENT = fontBlob(200 * 1024).toString('latin1');

const { mod, cleanup } = await loadExtractor();
const { extractPdfText, isReadableResumeText } = mod;

async function run(buffer) {
  const t0 = Date.now();
  let res = null;
  let err = null;
  try {
    res = await extractPdfText(buffer);
  } catch (e) {
    err = String((e && e.message) || e);
  }
  return { res, err, ms: Date.now() - t0 };
}

// ===== 一、正文提取保真（4 种内容流形态，闸门不得误杀）=====
{
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length ${REAL_TEXT_CONTENT.length} >>`, REAL_TEXT_CONTENT), FONT, FONT_DESC, obj(8, '<< /Length 64 /Filter /FlateDecode /Length1 64 >>', fontBlob(64, { withBtEt: false }).toString('latin1')), TUNICODE]));
  ok('正文 · 纯文本内容流不报错', !r.err, String(r.err));
  contains('正文 · 纯文本内容流完整还原', r.res?.text, 'Hello Resume Education Skills Engineer');
}

{
  // 中文：靠 ToUnicode + hex 字符串
  const c = 'BT /F1 12 Tf 40 700 Td <00010002> Tj ET';
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length ${c.length} >>`, c), FONT, FONT_DESC, obj(8, '<< /Length 64 /Filter /FlateDecode /Length1 64 >>', fontBlob(64, { withBtEt: false }).toString('latin1')), TUNICODE]));
  contains('正文 · ToUnicode CMap 中文还原', r.res?.text, '中文');
  ok('正文 · 走 unicode-map 分支', r.res?.method === 'pdf-unicode-map', String(r.res?.method));
}

{
  // 数组 TJ（批量绘制：同一行的多个片段 + 字距调整）
  const c = 'BT /F1 12 Tf 1 0 0 1 40 700 Tm [(Lead) -250 (Engineer)] TJ ET';
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length ${c.length} >>`, c), FONT, FONT_DESC, obj(8, '<< /Length 64 /Filter /FlateDecode /Length1 64 >>', fontBlob(64, { withBtEt: false }).toString('latin1')), TUNICODE]));
  contains('正文 · 数组 TJ 片段还原', r.res?.text, 'Lead');
  contains('正文 · 数组 TJ 第二片段还原', r.res?.text, 'Engineer');
}

{
  // 多行：Td 换行不得把整段并成一行，也不得拆成「一字一行」
  const c = 'BT /F1 12 Tf 40 700 Td (Line One Alpha) Tj 0 -20 Td (Line Two Beta) Tj ET';
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length ${c.length} >>`, c), FONT, FONT_DESC, obj(8, '<< /Length 64 /Filter /FlateDecode /Length1 64 >>', fontBlob(64, { withBtEt: false }).toString('latin1')), TUNICODE]));
  contains('正文 · 首行还原', r.res?.text, 'Line One Alpha');
  contains('正文 · 次行还原', r.res?.text, 'Line Two Beta');
  ok('正文 · 两行未并成一行', !String(r.res?.text).includes('Alpha Line Two'), JSON.stringify(r.res?.text));
}

// ===== 二、字体二进制不得当正文（回归核心：旧实现 1MB 需 4.6s / 2MB 卡死）=====
{
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, '<< /Length 5 >>', 'q Q'), FONT, FONT_DESC, obj(8, `<< /Length 999999 /Filter /FlateDecode /Length1 1048576 >>`, fontBlob(1024 * 1024).toString('latin1')), TUNICODE]));
  eq('字体流 · 1MB 不再被当正文（产出为空）', r.res?.text, '');
  ok('字体流 · 1MB 耗时 < 4000ms', r.ms < 4000, `实际 ${r.ms}ms`);
}

{
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, '<< /Length 5 >>', 'q Q'), FONT, FONT_DESC, obj(8, `<< /Length 999999 /Filter /FlateDecode /Length1 2097152 >>`, fontBlob(2 * 1024 * 1024).toString('latin1')), TUNICODE]));
  eq('字体流 · 2MB 不再被当正文（产出为空）', r.res?.text, '');
  ok('字体流 · 2MB 耗时 < 4000ms（旧实现在此卡死）', r.ms < 4000, `实际 ${r.ms}ms`);
}

{
  // 括号炸弹：最坏形态（大量 '<' '(' '[' 且无配对）
  const bomb = Buffer.concat([latin1('BT '), Buffer.alloc(2 * 1024 * 1024, 0x5b), latin1(' ET')]);
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, '<< /Length 5 >>', 'q Q'), FONT, FONT_DESC, obj(8, `<< /Length 999999 /Filter /FlateDecode /Length1 2097152 >>`, deflateSync(bomb).toString('latin1')), TUNICODE]));
  eq('括号炸弹 · 2MB 字体流产出为空', r.res?.text, '');
  ok('括号炸弹 · 2MB 耗时 < 4000ms', r.ms < 4000, `实际 ${r.ms}ms`);
}

// ===== 三、/Contents 错误指向二进制流 → 不得抽取、不得卡死 =====
{
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length 999999 /Filter /FlateDecode /Length1 204800 /Subtype /Image >>`, BROKEN_CONTENT), FONT, FONT_DESC, obj(8, '<< /Length 64 /Filter /FlateDecode /Length1 64 >>', fontBlob(64, { withBtEt: false }).toString('latin1')), TUNICODE]));
  eq('错指 /Contents · 二进制流不被当正文', r.res?.text, '');
  ok('错指 /Contents · 耗时 < 4000ms', r.ms < 4000, `实际 ${r.ms}ms`);
}

// ===== 四、有正文 + 大字体流：正文完整（闸门不得误杀）=====
{
  const r = await run(pdf([CATALOG, PAGES, pageObj(4), obj(4, `<< /Length ${REAL_TEXT_CONTENT.length} >>`, REAL_TEXT_CONTENT), FONT, FONT_DESC, obj(8, `<< /Length 999999 /Filter /FlateDecode /Length1 2097152 >>`, fontBlob(2 * 1024 * 1024).toString('latin1')), TUNICODE]));
  contains('正文+大字体流 · 正文仍完整', r.res?.text, 'Hello Resume Education Skills Engineer');
  ok('正文+大字体流 · 耗时有界', r.ms < 4000, `实际 ${r.ms}ms`);
}

// ===== 五、可读度判定：字体垃圾不再冒充简历正文 =====
{
  const garbage = 'BThd1 0 obj << /Length 12 >> <0a1f2e3d4c5b6a79> Tj ET';
  ok('可读度 · 二进制垃圾判不可读', !isReadableResumeText(garbage));
  ok('可读度 · 正常简历文本判可读', isReadableResumeText('李四\n电话：13800000000\n教育经历：某大学 计算机科学与技术 本科\n技能：TypeScript / Node.js\n项目：招聘自动化平台'));
}

// ===== 六、源码契约（口径不被后续改动悄悄回退）=====
{
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const extractor = read('src/lib/bossclaw/pdfExtractor.ts');

  // 单字符类必须排除 '<' '('：这是灾难性回溯的根因，回退即重新卡死
  contains('契约 · 数组算子单字符类已消歧（排除 < 与 (）', extractor, '[^\\]\\\\<(');
  notContains('契约 · 不再使用有歧义的单字符类', extractor, '[^\\]\\\\]|');
  contains('契约 · 存在二进制流判据', extractor, 'isNonTextStream');
  contains('契约 · 存在内容流形状闸门', extractor, 'looksLikeTextContent');
  contains('契约 · 字体程序被列入非正文流', extractor, '/FontFile[23]?');
  contains('契约 · 主路径过闸门', extractor, 'stream.nonText || !looksLikeTextContent(stream.decodedText)');
  contains('契约 · 回退路径过闸门', extractor, '|| !looksLikeTextContent(object.decodedText)');
  contains('契约 · 回退路径跳过二进制流', extractor, 'if (object.nonText || processedStreams.has(object.id)) continue;');

  const resumeParser = read('src/lib/bossclaw/resumeParser.ts');
  contains('契约 · resumeParser 仍接入 extractPdfText', resumeParser, "from './pdfExtractor'");
  contains('契约 · PDF 分支走 extractPdfText', resumeParser, 'extractPdfText(buf)');
}

cleanup();

// ===== 汇总 =====
const total = pass + failures.length;
console.log(`\n[pdf-parse-regression] ${pass}/${total} 项通过`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过：字体二进制不再当正文、内容流分词无灾难性回溯、正文还原无回归\n');
