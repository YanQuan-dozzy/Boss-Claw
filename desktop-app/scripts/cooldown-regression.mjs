// 风控冷却解析回归断言（零新增依赖）
//
// 为什么需要它：2026-10-03 之前，设置页「风控冷却」（`autoCooldownMinutes`）**是一处死设置** ——
// 全仓从未读取该字段，冷却恒为 `SAFETY_LIMITS.DEFAULT_COOLDOWN_MS`（30 分钟），用户改了没有任何效果。
// 把它接上真线涉及安全关键路径，一旦算错方向是**静默且危险**的：
//   · 基础冷却下沉到该级别的绝对下限以下 → 账号在命中风控后过短时间就继续作业，
//     正是把「限速」推向「封禁」的行为；
//   · 预设比例丢失（32 的 4×、36 的 2× 被抹平）→ 严重级别不再更保守；
//   · 未登录（cooldownMs=0）被误算成进入冷却 → 用户看到「冷却中」却无风控可言，误导判断；
//   · 默认值下结果与修复前不一致 → 属于「顺手改变了既有安全行为」，必须有断言拦住。
// 这些都不被 typecheck / build 发现，必须断言守住。
//
// 做法：用项目里已有的 esbuild 把 safety.ts 打成临时 CJS 再 require（与 score-regression.mjs 同款）。
//
// 用法：node scripts/cooldown-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-cooldown-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: { contents: "export * from './src/lib/bossclaw/safety.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  });
  const m = require(outfile);
  return { m, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const { m: S, cleanup } = await load();

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

const MIN = 60_000;
const cfg = (minutes) => ({ autoCooldownMinutes: minutes });
const sig = (code) => S.classifyRiskCode(code);

// ===== A. baseCooldownMs：边界与兜底 =====
{
  eq('基础冷却 默认 30 分钟', S.baseCooldownMs(cfg(30)), 30 * MIN);
  eq('基础冷却 未配置 → 默认 30 分钟', S.baseCooldownMs({}), 30 * MIN);
  eq('基础冷却 null → 默认 30 分钟', S.baseCooldownMs(null), 30 * MIN);
  eq('基础冷却 undefined → 默认 30 分钟', S.baseCooldownMs(undefined), 30 * MIN);
  eq('基础冷却 NaN → 默认 30 分钟', S.baseCooldownMs(cfg(NaN)), 30 * MIN);
  eq('基础冷却 0 → 默认 30 分钟（0 视为未配置，不当成「关闭冷却」）', S.baseCooldownMs(cfg(0)), 30 * MIN);
  eq('基础冷却 负数 → 默认 30 分钟', S.baseCooldownMs(cfg(-10)), 30 * MIN);
  eq('基础冷却 1 分钟 → 夹到硬下限 5 分钟', S.baseCooldownMs(cfg(1)), 5 * MIN);
  eq('基础冷却 5 分钟 → 保留下限值', S.baseCooldownMs(cfg(5)), 5 * MIN);
  eq('基础冷却 720 分钟 → 保留下限值', S.baseCooldownMs(cfg(720)), 720 * MIN);
  eq('基础冷却 99999 分钟 → 夹到上限 720 分钟', S.baseCooldownMs(cfg(99999)), 720 * MIN);
  eq('基础冷却 字符串数字可解析', S.baseCooldownMs({ autoCooldownMinutes: '45' }), 45 * MIN);
}

// ===== B. 默认值下必须与修复前**逐位一致**（不得顺手改变既有安全行为）=====
{
  const c = cfg(30);
  // 修复前：32 用 DEFAULT×4、36 用 DEFAULT×2、35/37/38 用 DEFAULT、1006/5002-5004 用 RATE_LIMIT
  eq('[默认30] 32 封禁 → 120 分钟（4×）', S.resolveCooldownMs(c, sig(32)), 120 * MIN);
  eq('[默认30] 36 账户异常 → 60 分钟（2×）', S.resolveCooldownMs(c, sig(36)), 60 * MIN);
  eq('[默认30] 35 安全验证 → 30 分钟', S.resolveCooldownMs(c, sig(35)), 30 * MIN);
  eq('[默认30] 37 环境异常 → 30 分钟', S.resolveCooldownMs(c, sig(37)), 30 * MIN);
  eq('[默认30] 38 环境异常未登录 → 30 分钟', S.resolveCooldownMs(c, sig(38)), 30 * MIN);
  eq('[默认30] 1006 限速 → 10 分钟（退避）', S.resolveCooldownMs(c, sig(1006)), 10 * MIN);
  eq('[默认30] 5002 服务端异常 → 10 分钟', S.resolveCooldownMs(c, sig(5002)), 10 * MIN);
  eq('[默认30] 5004 服务端异常 → 10 分钟', S.resolveCooldownMs(c, sig(5004)), 10 * MIN);
  eq('[默认30] 31 未登录 → 0（不进入冷却）', S.resolveCooldownMs(c, sig(31)), 0);
  ok('[默认30] 无信号 → 回落基础冷却', S.resolveCooldownMs(c, null) === 30 * MIN, String(S.resolveCooldownMs(c, null)));
  ok('[默认30] 未知码信号为 null → 回落基础冷却', S.resolveCooldownMs(c, sig(9999)) === 30 * MIN);
}

// ===== C. 用户调小：**只放大、不缩短** —— 已知风险码的预设保护不得被压缩 =====
{
  const tiny = cfg(5);
  eq('[基础5] 32 封禁 → 保持预设 120 分钟', S.resolveCooldownMs(tiny, sig(32)), 120 * MIN);
  eq('[基础5] 36 账户异常 → 保持预设 60 分钟', S.resolveCooldownMs(tiny, sig(36)), 60 * MIN);
  eq('[基础5] 35 安全验证 → 保持预设 30 分钟', S.resolveCooldownMs(tiny, sig(35)), 30 * MIN);
  eq('[基础5] 38 环境异常 → 保持预设 30 分钟', S.resolveCooldownMs(tiny, sig(38)), 30 * MIN);
  eq('[基础5] 1006 限速 → 保持预设 10 分钟', S.resolveCooldownMs(tiny, sig(1006)), 10 * MIN);
  eq('[基础5] 31 未登录 → 仍为 0（不因基础冷却进入冷却）', S.resolveCooldownMs(tiny, sig(31)), 0);
  // 这条是防「severity 下限表」式错误实现的哨兵：5002 是 10 分钟级，绝不能被拉到 30
  eq('[基础5] 5002 服务端异常 → 恰为预设 10 分钟（不得被 env 级别误拉到 30）', S.resolveCooldownMs(tiny, sig(5002)), 10 * MIN);
  // 基础冷却 < 默认值时，已知码一律等于预设（即「调小不生效于保护性冷却」）
  const allPresetHeld = [32, 36, 35, 37, 38, 1006, 5002].every(
    (c) => S.resolveCooldownMs(cfg(5), sig(c)) === S.resolveCooldownMs(cfg(30), sig(c)),
  );
  ok('[基础5] 全部已知码与默认值结果一致（调小不缩短保护）', allPresetHeld);
}

// ===== D. 用户调大：比例保持，级别间仍单调有序 =====
{
  const big = cfg(60);
  eq('[基础60] 32 封禁 → 240 分钟（4×）', S.resolveCooldownMs(big, sig(32)), 240 * MIN);
  eq('[基础60] 36 账户异常 → 120 分钟（2×）', S.resolveCooldownMs(big, sig(36)), 120 * MIN);
  eq('[基础60] 35 安全验证 → 60 分钟', S.resolveCooldownMs(big, sig(35)), 60 * MIN);
  eq('[基础60] 1006 限速 → 20 分钟（1/3）', S.resolveCooldownMs(big, sig(1006)), 20 * MIN);

  const huge = cfg(720);
  eq('[基础720] 35 → 720 分钟', S.resolveCooldownMs(huge, sig(35)), 720 * MIN);
  ok('[基础720] 32 不低于 35（封禁永远更保守）', S.resolveCooldownMs(huge, sig(32)) >= S.resolveCooldownMs(huge, sig(35)));
}

// ===== E. 性质检验：基础冷却单调不减，且永不短于该级别下限 =====
{
  // 下限 = 各码的原始预设（「只放大、不缩短」）
  const floors = { 32: 120 * MIN, 36: 60 * MIN, 35: 30 * MIN, 37: 30 * MIN, 38: 30 * MIN, 1006: 10 * MIN, 5002: 10 * MIN };
  let monotonic = true;
  let floored = true;
  const bases = [5, 6, 10, 15, 30, 45, 60, 180, 719, 720];
  for (const code of Object.keys(floors).map(Number)) {
    let prev = -1;
    for (const b of bases) {
      const v = S.resolveCooldownMs(cfg(b), sig(code));
      if (v < prev) monotonic = false;
      if (v < floors[code]) floored = false;
      prev = v;
    }
  }
  ok('单调性：基础冷却增大时结果不减小（6 个级别 × 10 档）', monotonic);
  ok('下限性：任何基础冷却下结果均不低于该级别绝对下限', floored);
}

// ===== F. 所有已知风险码都必须有可解析的冷却（防止新增码漏配）=====
{
  const known = [31, 32, 35, 36, 37, 38, 1006, 5002, 5003, 5004];
  const bad = known.filter((c) => {
    const s = sig(c);
    if (!s) return true;
    const v = S.resolveCooldownMs(cfg(30), s);
    return !Number.isFinite(v) || v < 0;
  });
  ok('全部已知风险码都能解析出有限非负冷却', bad.length === 0, JSON.stringify(bad));
  ok('封禁(32) 的冷却严格长于安全验证(35)', S.resolveCooldownMs(cfg(30), sig(32)) > S.resolveCooldownMs(cfg(30), sig(35)));
}

cleanup();

console.log('[风控冷却回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
