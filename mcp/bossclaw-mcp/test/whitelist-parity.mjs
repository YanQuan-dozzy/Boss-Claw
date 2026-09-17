// 白名单双源一致性断言（审查 H10 / P6-08）：
// MCP 侧 control.mjs 的 RENDERER_ACTIONS 是 controlRuntime.ts::handlers 的手抄副本，
// 注释自称「唯一权威在 TS」却无断言守护 → 漂移静默积累。本测试固化差集检查：
//   断言 1：MCP RENDERER_ACTIONS ⊆ TS handlers（防「调了必失败」的幽灵动作）
//   提示 2：TS handlers 中未出现在 MCP 清单的动作（漏同步 → agent 看不到新能力；不 fail，
//          state 为内部端点，属有意豁免）
// 用法：node test/whitelist-parity.mjs（独立）；亦可被 selftest.mjs import 复用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function computeWhitelistDiff() {
  const mcpSrc = path.resolve(here, '..', 'src', 'tools', 'control.mjs');
  const tsSrc = path.resolve(here, '..', '..', '..', 'desktop-app', 'src', 'lib', 'controlRuntime.ts');
  const mcp = fs.readFileSync(mcpSrc, 'utf8');
  const ts = fs.readFileSync(tsSrc, 'utf8');

  const block = mcp.match(/const RENDERER_ACTIONS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('control.mjs 中未找到 RENDERER_ACTIONS');
  const actions = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const hb = ts.match(/const handlers: Record<string, Handler> = \{([\s\S]*?)\n\};/);
  if (!hb) throw new Error('controlRuntime.ts 中未找到 handlers 对象');
  const keys = new Set([...hb[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));

  const onlyMjs = [...actions].filter((a) => !keys.has(a)).sort();
  const onlyTs = [...keys].filter((k) => !actions.has(k)).sort();
  return { mcpCount: actions.size, tsCount: keys.size, onlyMjs, onlyTs };
}

export function runWhitelistParity() {
  const { mcpCount, tsCount, onlyMjs, onlyTs } = computeWhitelistDiff();
  console.log(`controlRuntime.ts handlers : ${tsCount}`);
  console.log(`MCP RENDERER_ACTIONS       : ${mcpCount}`);
  const exempt = ['state']; // 内部 POST 端点（snapshotState），不作为动作暴露 —— 有意豁免
  const realOnlyTs = onlyTs.filter((k) => !exempt.includes(k));
  if (onlyMjs.length) {
    console.error(`✗ MCP 存在 TS 侧没有的动作（幽灵动作，调了必失败）：${onlyMjs.join(', ')}`);
    return 1;
  }
  if (realOnlyTs.length) {
    console.warn(`⚠ 提示：TS 有而未同步到 MCP 的动作（agent 看不到新能力）：${realOnlyTs.join(', ')}`);
  } else {
    console.log('✅ MCP 白名单 ⊆ TS handlers（差集仅豁免项 state）');
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runWhitelistParity());
}