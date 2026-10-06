// 账号级投递节流回归：守住「两套引擎共享同一 pacer / 同一连续投递计数」与「预算夹在防封号硬上限内」，
// 并覆盖**投递前置守卫四分支**（冷却 / 活跃时段 / 账号日上限 / 平台日上限）与**并发抢位不越额**。
//
// 背景（审查 #73 / #22）：工作台「一键投递」与自动沟通「批量发送」是两套可同时运行的引擎。
// 原先各自 `new ActionPacer(...)` 并各持一份批次休息计数 → 账号级每分钟动作上限翻倍、
// 批次休息间隔翻倍（保护被稀释一半）。收敛为 deliveryThrottle.ts 的进程级单例后：
//   · sharedPacer(相同预算) 必须返回**同一实例**（否则等于没共享）；
//   · 预算必须夹在 SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE 内（用户设 9~15 不得生效）。
//
// 背景（审查 #23 / §四·23）：`checkDeliveryGuards` 是四条投递路径共用的唯一守卫实现；
// `ActionPacer.waitForSlot` 唤醒后必须**重新竞争**空位，否则 N 个并发等待者会在同一时刻各自 record，
// 使实际动作数达到 N×budget（限速器形同虚设）。二者均需回归断言（本批补，批次 12）。
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
      contents: [
        "export * from './src/lib/bossclaw/deliveryThrottle.ts';",
        "export { SAFETY_LIMITS, ActionPacer, checkDeliveryGuards, effectiveDailyCap, effectiveDailyCapFor } from './src/lib/bossclaw/safety.ts';",
        "export { PLATFORM_IDS } from './src/lib/bossclaw/platforms.ts';",
      ].join('\n'),
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

// ===== E. waitForSlot 并发抢位（审查 §四·23）：守卫必须真的拦住「同批唤醒一起 record」=====
// 说明：waitForSlot 的窗口硬编码 60s，真实跑满窗口需 60s 以上（不适合放进常规回归）。
// 因此这里**分层验证**：
//   E1 入场抢占：并发 N>budget 时，只有 budget 个能立即返回（其余进入等待）；
//   E2 临界区复现：模拟「所有等待者被同一时刻唤醒」——循环里反复 canAct()+record()，
//      断言同一窗口内授予次数恒 == budget（这正是等待者醒来后执行的同一段同步逻辑）；
//   E3 归零后重新放行：窗口滑出（清空时间戳）后应恢复可动作。
{
  const BUDGET = 3;
  const WAITERS = 12;
  const p = new T.ActionPacer(BUDGET);

  // E1：并发入场，仅 budget 个立即返回
  const settled = [];
  const tasks = Array.from({ length: WAITERS }, (_, i) =>
    p.waitForSlot().then(() => settled.push(i)),
  );
  await new Promise((r) => setTimeout(r, 1500));
  eq('并发入场：立即返回数 == 预算', settled.length, BUDGET);
  ok('并发入场：其余等待者仍在等待', settled.length < WAITERS, 'settled=' + settled.length);

  // E2：临界区 —— 把「唤醒后重抢」的判定逻辑单独复现
  const p2 = new T.ActionPacer(2);
  let granted = 0;
  for (let i = 0; i < 5; i++) {
    if (p2.canAct()) { p2.record(); granted++; } // 等待者醒来后执行的正是这段
  }
  eq('同批唤醒临界区：授予次数 == 预算（不越额）', granted, 2);

  // E3：窗口滑出后恢复放行（用「把时间戳推到窗口外」模拟 60s 过去）
  const p3 = new T.ActionPacer(1);
  p3.record();
  ok('用满预算后不可动作', p3.canAct() === false);
  // canAct(now) 支持显式 now → 传 +61s 观察窗口滑动
  ok('窗口滑出 61s 后恢复可动作', p3.canAct(Date.now() + 61_000) === true);

  // 清理：让上面 E1 的等待者不再悬挂（进程即将退出，显式放弃即可）
  for (const t of tasks) t.catch(() => {});
}

// ===== F. 投递前置守卫 checkDeliveryGuards（审查 #23）：四分支 + 边界 =====
{
  const NOW = Date.now();
  const pf = T.PLATFORM_IDS[0]; // 主平台（boss）
  // 合法基线配置：活跃时段 00:00-24:00 全开、无冷却、不设平台目标
  const baseCfg = {
    pausedUntil: 0,
    activeHours: { enabled: false, startHour: 8, endHour: 23, jitterMinutes: 25 },
    autoCooldownMinutes: 30,
    platforms: {},
  };

  // F0 基线：全通过
  eq('基线（无冷却/时段关/无已投递）→ ok', T.checkDeliveryGuards(baseCfg, pf, []).ok, true);

  // F1 cooldown：pausedUntil 在未来
  {
    const cfg = { ...baseCfg, pausedUntil: NOW + 10 * 60_000 };
    const r = T.checkDeliveryGuards(cfg, pf, []);
    eq('冷却期内 → ok:false', r.ok, false);
    eq('冷却期内 → kind=cooldown', r.ok === false ? r.kind : null, 'cooldown');
  }
  // F1b 边界：pausedUntil 恰已过期 → 放行
  {
    const cfg = { ...baseCfg, pausedUntil: NOW - 1 };
    eq('冷却恰已过期 → 放行', T.checkDeliveryGuards(cfg, pf, []).ok, true);
  }

  // F2 window：活跃时段开启且当前不在窗口内（构造一个必然落空的 1 小时窗口）
  {
    const hour = new Date(NOW).getHours();
    // 造一个「当前小时」一定不在其中的 1 小时窗口（避开跨午夜歧义：挑当前小时 +2）
    const startH = (hour + 2) % 24;
    const endH = (startH + 1) % 24;
    const cfg = {
      ...baseCfg,
      activeHours: { enabled: true, startHour: startH, endHour: endH, jitterMinutes: 0 },
    };
    const r = T.checkDeliveryGuards(cfg, pf, []);
    eq('活跃时段外 → ok:false', r.ok, false);
    eq('活跃时段外 → kind=window', r.ok === false ? r.kind : null, 'window');
  }

  // F3 daily-cap：账号级已投递数达到 effectiveDailyCap
  {
    const cap = T.effectiveDailyCap(baseCfg);
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      id: 'p' + i, status: 'sent', sentAt: NOW, job: { platform: pf },
    }));
    // 上限 -1 → 放行；恰好 == 上限 → 拦截
    eq('账号级 上限-1 → 放行', T.checkDeliveryGuards(baseCfg, pf, mk(cap - 1)).ok, true);
    const r = T.checkDeliveryGuards(baseCfg, pf, mk(cap));
    eq('账号级 恰好达上限 → ok:false', r.ok, false);
    // ⚠️ 单平台场景下账号级合计 == 该平台额度，两者同时触顶 → 平台级先判，
    // 因此 kind 报 platform-cap（更精确、可被调用方 continue 跳过而非 break 整批）。
    // daily-cap 仅作为**多平台合计**的最终兜底存在，见 F3b。
    eq('账号级=平台级 时 → kind=platform-cap（更精确，先判）', r.ok === false ? r.kind : null, 'platform-cap');
  }

  // F3b daily-cap（多平台合计兜底）：其它平台已用掉额度 → 本轮平台虽未满，但账号合计已触顶
  {
    const other = T.PLATFORM_IDS.find((p) => p !== pf);
    if (other) {
      const totalCap = T.effectiveDailyCap(baseCfg);
      // 让「本轮平台」只占 1 条，其余额度全被另一个平台占满 → 合计触顶
      const rows = [
        { id: 'a', status: 'sent', sentAt: NOW, job: { platform: pf } },
        ...Array.from({ length: totalCap - 1 }, (_, i) => ({
          id: 'o' + i, status: 'sent', sentAt: NOW, job: { platform: other },
        })),
      ];
      const r = T.checkDeliveryGuards(baseCfg, pf, rows);
      eq('账号合计触顶（多平台）→ ok:false', r.ok, false);
      eq('账号合计触顶（多平台）→ kind=daily-cap（最终兜底）', r.ok === false ? r.kind : null, 'daily-cap');
    }
  }

  // F4 platform-cap：平台目标（dailyTarget）设小 → 达到平台上限即拦截，且 kind=platform-cap
  {
    const cfg = { ...baseCfg, platforms: { [pf]: { dailyTarget: 2 } } };
    const platformCap = T.effectiveDailyCapFor(cfg, pf);
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      id: 'q' + i, status: 'sent', sentAt: NOW, job: { platform: pf },
    }));
    eq('平台目标生效（cap=2）', platformCap, 2);
    eq('平台 上限-1 → 放行', T.checkDeliveryGuards(cfg, pf, mk(1)).ok, true);
    const r = T.checkDeliveryGuards(cfg, pf, mk(2));
    eq('平台 恰好达上限 → ok:false', r.ok, false);
    eq('平台 恰好达上限 → kind=platform-cap', r.ok === false ? r.kind : null, 'platform-cap');
  }

  // F5 非今日的 sentAt 不计入（跨天不误拦）
  {
    const cap = T.effectiveDailyCap(baseCfg);
    const yesterday = Array.from({ length: cap }, (_, i) => ({
      id: 'y' + i, status: 'sent', sentAt: NOW - 36 * 3600_000, job: { platform: pf },
    }));
    eq('昨日已投递不计入今日 → 放行', T.checkDeliveryGuards(baseCfg, pf, yesterday).ok, true);
  }

  // F6 其它状态的岗位不计入（pending/failed 不占额度）
  {
    const cap = T.effectiveDailyCap(baseCfg);
    const notSent = Array.from({ length: cap + 5 }, (_, i) => ({
      id: 'n' + i, status: 'pending', sentAt: NOW, job: { platform: pf },
    }));
    eq('非 sent 状态不占额度 → 放行', T.checkDeliveryGuards(baseCfg, pf, notSent).ok, true);
  }
}

cleanup();

console.log('[投递节流回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
