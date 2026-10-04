// LLM JSON 解析回归：守住「截断不得被当成功」这一不变量。
//
// 背景：extractJson 的修复变体里有一条会**补右括号**（closeBrackets）。它把「括号未闭合」
// 的响应（典型 = 被截断）也解析成对象，且原实现对其**等同完整 JSON** 返回成功 ——
// 于是下游拿到字段缺失的半截对象却毫无告警（静默错值比报错更危险）。
// 修复后该路径以 `tailCut=true` 显式回报，调用方（llm.ts::callModel JSON 模式）据此
// 走二次补齐或按截断抛错；「是否截断」不再只依赖 finish_reason（第三方网关可能谎报为 stop）。
//
// 用法：node scripts/llm-json-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-llmjson-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: { contents: "export { extractJsonWithMeta, extractJson } from './src/lib/bossclaw/llm.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  });
  return { m: require(outfile), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const { m: M, cleanup } = await load();

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; return; } fails.push(name + (detail ? '  → ' + detail : '')); };
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));

// ===== A. 完整 JSON：不得标 tailCut =====
{
  const a = M.extractJsonWithMeta('{"score":80,"reason":"ok"}');
  eq('完整 JSON：tailCut=false', a.tailCut, false);
  eq('完整 JSON：值正确', a.value.score, 80);

  const b = M.extractJsonWithMeta('```json\n{"score":75}\n```');
  eq('markdown 围栏 JSON：tailCut=false', b.tailCut, false);
  eq('markdown 围栏 JSON：值正确', b.value.score, 75);

  const c = M.extractJsonWithMeta('{"score":60,"gaps":[]}\n以上就是我的分析。');
  eq('JSON + 尾随说明文字：tailCut=false（走结构末端修剪）', c.tailCut, false);
  eq('JSON + 尾随说明文字：值正确', c.value.score, 60);

  eq('前缀噪声（从首个 { 截取）：tailCut=false', M.extractJsonWithMeta('结果如下：{"score":50}').tailCut, false);
}

// ===== B. 括号未闭合（= 被截断）：必须标 tailCut，且对象确实字段缺失 =====
{
  const d = M.extractJsonWithMeta('{"score":80,"dimensions":{"skill":90');
  eq('截断 JSON：tailCut=true', d.tailCut, true);
  ok('截断 JSON：确实是字段缺失的半截对象（无 reason）', d.value && d.value.reason === undefined);

  const e = M.extractJsonWithMeta('{"matchedEvidence":["a","b"],"gaps":["c"');
  eq('数组截断：tailCut=true', e.tailCut, true);

  // 缺右花括号但数组已闭合的截断
  const f = M.extractJsonWithMeta('{"score":80,"gaps":[]');
  eq('缺右花括号：tailCut=true', f.tailCut, true);
}

// ===== C. 兼容包装与错误路径 =====
{
  eq('extractJson 包装：返回 .value', M.extractJson('{"score":80}').score, 80);
  eq('extractJson 包装（截断）：返回半截对象（不改变旧调用方行为）', M.extractJson('{"score":80').score, 80);

  let threw = false;
  try { M.extractJsonWithMeta('这不是 JSON'); } catch { threw = true; }
  ok('完全不可解析：抛错', threw);

  threw = false;
  try { M.extractJsonWithMeta(''); } catch { threw = true; }
  ok('空文本：抛错', threw);
}

cleanup();

console.log('[LLM JSON 解析回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
