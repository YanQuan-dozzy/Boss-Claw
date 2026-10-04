// 账号级投递节流回归：守住「两套引擎共享同一 pacer / 同一连续投递计数」与「预算夹在防封号硬上限内」。
//
// 背景（审查 #73 / #22）：工作台「一键投递」与自动沟通「批量发送」是两套可同时运行的引擎。
// 原先各自 `new ActionPacer(...)` 并各持一份批次休息计数 → 账号级每分钟动作上限翻倍、
// 批次休息间隔翻倍（保护被稀释一半）。收敛为 deliveryThrottle.ts 的进程级单例后：
//   · sharedPacer(相同预算) 必须返回**同一实例**（否则等于没共享）；
//   · 预算必须夹在 SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE 内（用户设 9~15 不得生效）。
//
// 用法：node scripts/delivery-throttle-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-throttle-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: "export * from './src/lib/bossclaw/deliveryThrottle.ts';\nexport { SAFETY_LIMITS } from './src/lib/bossclaw/safety.ts';",
      resolveDir: root, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  });
  return { m: require(outfile), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const { m: T, cleanup } = await load();

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; return; } fails.push(name + (detail ? '  → ' + detail : '')); };
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));

const CAP = T.SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE;

// ===== A. 单例：相同预算必须返回同一实例（共享才有意义）=====
{
  const a = T.sharedPacer(6);
  const b = T.sharedPacer(6);
  ok('sharedPacer 相同预算 → 同一实例', a === b, '两个引用不同 → 引擎各自分裂出私有 pacer');
  // 复现两套引擎的取用方式：连续两次取用必须是同一对象
  ok('sharedPacer 连续取用 → 同一实例（模拟双引擎）', T.sharedPacer(6) === T.sharedPacer(6));
}

// ===== B. 预算夹取（#22：硬上限不可被设置突破）=====
{
  eq('预算 = 硬上限（用户设 999）', T.sharedPacer(999).budget, CAP);
  eq('预算 = 硬上限（用户设 15）', T.sharedPacer(15).budget, CAP);
  eq('预算 = 硬上限（用户设 9）', T.sharedPacer(9).budget, CAP);
  eq('用户设 3 → 保持 3', T.sharedPacer(3).budget, 3);
  eq('用户设 6 → 保持 6', T.sharedPacer(6).budget, 6);
  eq('0/未配置 → 回退硬上限值', T.sharedPacer(0).budget, CAP);
  eq('未传参 → 回退硬上限值', T.sharedPacer().budget, CAP);
  // 负数/NaN 等脏值：沿用改造前语义（truthy 数值走 Math.max(1,…) 落到下限 1；
  // 仅 falsy 走默认值）。方向是**更严格**，不构成安全缺口，故不改动既有行为。
  eq('负数 → 落到下限 1（沿用既有语义）', T.sharedPacer(-5).budget, 1);
  eq('NaN → 回退硬上限值', T.sharedPacer(NaN).budget, CAP);
  ok('硬上限值本身低于平台约 30/分', CAP <= 10, 'CAP=' + CAP);
}

// ===== C. 限速器确实生效（预算 2 时第 3 次被拒）=====
{
  const p = T.sharedPacer(2);
  ok('初始可动作', p.canAct() === true);
  p.record();
  p.record();
  ok('用满预算后不可动作（同一分钟窗口）', p.canAct() === false);
  // 复位到默认预算，避免影响后续断言
  T.sharedPacer(CAP);
}

// ===== D. 连续投递计数：跨引擎累计，仅在休息后归零 =====
{
  T.resetDeliveredSinceRest();
  eq('初始计数为 0', T.deliveredSinceRest(), 0);
  eq('markDelivered 返回累计值 1', T.markDelivered(), 1);
  eq('markDelivered 返回累计值 2', T.markDelivered(), 2);
  eq('deliveredSinceRest 与 markDelivered 口径一致', T.deliveredSinceRest(), 2);
  T.resetDeliveredSinceRest();
  eq('reset 后归零', T.deliveredSinceRest(), 0);
  // 关键：两个「引擎」标记的是同一个计数器（不各自计数）
  T.markDelivered(); // 引擎 A
  T.markDelivered(); // 引擎 B
  eq('跨引擎共用一个计数器（A+B=2，而非各自 1）', T.deliveredSinceRest(), 2);
  T.resetDeliveredSinceRest();
}

cleanup();

console.log('[投递节流回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
