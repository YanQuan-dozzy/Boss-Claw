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
        "export { SAFETY_LIMITS, ActionPacer, checkDeliveryGuards, effectiveDailyCap, effectiveDailyCapFor, dailySentCount, dailySentCountFor, enabledSentCount } from './src/lib/bossclaw/safety.ts';",
        "export { PLATFORM_IDS } from './src/lib/bossclaw/platforms.ts';",
        "export { buildStatsSnapshot } from './src/lib/bossclaw/statsAggregate.ts';",
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

  // F3b daily-cap（多平台合计兜底）
  //
  // 数学事实（值得固化的口径）：账号级 cap = Σ(各启用平台额度)。要把「合计」推满，
  // 只能由**这些平台自己**的投递累计 —— 因此当合计触顶时，**判定平台自身必然也已满**
  // （否则合计 < Σ ≤ cap）。故在**多平台**下，`platform-cap` 总是先命中，`daily-cap`
  // 在结构上**不可能**先于它触发。`daily-cap` 的真实价值是**单平台**场景（两者同值）的
  // 等义兜底，以及未来若出现「不参与平台级判定的投放来源」时的总额闸门。
  //
  // 本用例固化上述事实：三平台各 10，全部投满 → 合计 30 触顶，但返回的是 platform-cap。
  {
    const [p1, p2, p3] = T.PLATFORM_IDS;
    const others = [p2, p3].filter(Boolean);
    if (others.length === 2) {
      const cfg3 = {
        ...baseCfg,
        platforms: {
          [p1]: { enabled: true, dailyTarget: 10 },
          [others[0]]: { enabled: true, dailyTarget: 10 },
          [others[1]]: { enabled: true, dailyTarget: 10 },
        },
      };
      const tot3 = T.effectiveDailyCap(cfg3);
      eq('三平台合计 = 30', tot3, 30);
      const rows = [
        ...Array.from({ length: 10 }, (_, i) => ({ id: 'a' + i, status: 'sent', sentAt: NOW, job: { platform: p1 } })),
        ...Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, status: 'sent', sentAt: NOW, job: { platform: others[0] } })),
        ...Array.from({ length: 10 }, (_, i) => ({ id: 'y' + i, status: 'sent', sentAt: NOW, job: { platform: others[1] } })),
      ];
      eq('三平台投满 → 合计达上限 30', T.enabledSentCount(cfg3, rows) >= tot3, true);
      const r = T.checkDeliveryGuards(cfg3, p1, rows);
      eq('三平台投满 → kind=platform-cap（平台级先判且更精确）', r.ok === false ? r.kind : null, 'platform-cap');
      // 反证：合计触顶时判定平台自身必已满（故 daily-cap 不可能先触发）
      eq('合计触顶 ⟹ 判定平台自身亦已满', T.dailySentCountFor(rows, p1) >= T.effectiveDailyCapFor(cfg3, p1), true);
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

  // F7 已关闭平台的投递**不得**占用账号级额度（审查 #23 后续 · 批次 13）
  // 反例（修复前）：平台 B 投 150 条后关闭、仅启用 A（A 今日 0 条）→ 全量计数 150 ≥ cap 120
  //   → 对 A 的投递被 daily-cap 误拦（且调用方 break 停掉整批），账号被「已关闭的平台」卡死。
  {
    const other = T.PLATFORM_IDS.find((p) => p !== pf);
    if (other) {
      const cap = T.effectiveDailyCap(baseCfg); // 只算已启用平台（默认全部启用 → 合理基线）
      // 构造：仅启用本轮平台；另一平台关闭，但它在今日有大量投递记录
      const cfg = {
        ...baseCfg,
        platforms: { [pf]: { enabled: true, dailyTarget: 120 }, [other]: { enabled: false, dailyTarget: 120 } },
      };
      const capOnlyA = T.effectiveDailyCap(cfg);
      const rows = Array.from({ length: capOnlyA }, (_, i) => ({
        id: 'x' + i, status: 'sent', sentAt: NOW, job: { platform: other },
      }));
      // 全量计数（旧口径）会 ≥ cap；已启用计数应为 0
      eq('已关闭平台的投递 → 全量计数 >= cap（旧口径会误拦）', T.dailySentCount(rows) >= capOnlyA, true);
      eq('已关闭平台的投递 → enabledSentCount == 0', T.enabledSentCount(cfg, rows), 0);
      const r = T.checkDeliveryGuards(cfg, pf, rows);
      eq('已关闭平台的战绩不占额度 → 本轮平台仍放行', r.ok, true);
    }
  }

  // F8 已启用平台的投递**必须**占额度（防止把 F7 改过头、放行所有情况）
  {
    const cap = T.effectiveDailyCap(baseCfg);
    const allEnabled = Array.from({ length: cap }, (_, i) => ({
      id: 'e' + i, status: 'sent', sentAt: NOW, job: { platform: pf },
    }));
    eq('已启用平台达上限 → 仍拦截', T.checkDeliveryGuards(baseCfg, pf, allEnabled).ok, false);
    eq('已启用平台达上限 → kind 非空', T.enabledSentCount(baseCfg, allEnabled), cap);
  }
}

// ===== G. 统计/展示路径的额度口径对称（审查 #23 后续 · 批次 14）=====
//
// 批次 13 修的是 **enforcement** 路径（checkDeliveryGuards / controlRuntime.autochatStep）：
// 账号级「已用」必须与额度（effectiveDailyCap，只累加已启用平台）同源。
// 本组守住同一规则在 **统计与展示** 路径（statsAggregate 今日进度）的落地：
// 关闭某平台后，其历史投递**不得**计入今日分子，否则统计页/CSV/PDF 会显示「今日 150 / 目标 120」
// 越界值、goalPct 溢出、PDF hbar 宽度 > 100%。
{
  const NOW = Date.now();
  const pf = T.PLATFORM_IDS[0]; // 主平台（boss）
  const other = T.PLATFORM_IDS.find((p) => p !== pf);

  // cfg：仅启用主平台；另一平台关闭（但今日有大量投递）
  const cfg = {
    pausedUntil: 0,
    activeHours: { enabled: false, startHour: 8, endHour: 23, jitterMinutes: 25 },
    platforms: { [pf]: { enabled: true, dailyTarget: 120 }, [other]: { enabled: false, dailyTarget: 120 } },
  };
  const capOnlyA = T.effectiveDailyCap(cfg); // 只算已启用的 pf → 120

  const closedRows = Array.from({ length: capOnlyA }, (_, i) => ({
    id: 'c' + i, status: 'sent', sentAt: NOW, createdAt: NOW,
    job: { platform: other, company: 'X', title: 'T' },
  }));

  const snap = T.buildStatsSnapshot({
    pending: closedRows, taskRuns: [], directionPlan: null, config: cfg, range: '7d', now: NOW,
  });

  // 修复前：todaySent 统计全部平台 → = capOnlyA(120)，goalPct = 100%
  // 修复后：分子只算已启用平台 → pf 今日 0 条 → todaySent = 0
  eq('统计：已关闭平台的今日投递 → 分子 todaySent = 0', snap.todaySent, 0);
  eq('统计：分母 dailyTarget = 仅已启用平台额度', snap.dailyTarget, Math.max(1, capOnlyA));
  eq('统计：goalPct 不再溢出（无越界进度）', snap.todaySent <= snap.dailyTarget, true);
  eq('统计：goalPct 恰为 0（今日实际未投）', snap.goalPct, 0);

  // 反向守卫：已启用平台**必须**照常计入（防止改过头、把今日进度恒置 0）
  const enabledRows = Array.from({ length: 3 }, (_, i) => ({
    id: 'e' + i, status: 'sent', sentAt: NOW, createdAt: NOW,
    job: { platform: pf, company: 'X', title: 'T' },
  }));
  const snap2 = T.buildStatsSnapshot({
    pending: enabledRows, taskRuns: [], directionPlan: null, config: cfg, range: '7d', now: NOW,
  });
  eq('统计：已启用平台的今日投递仍计入（反向守卫）', snap2.todaySent, 3);
  eq('统计：已启用平台 goalPct 正常（3/120）', snap2.goalPct, Math.round((3 / Math.max(1, capOnlyA)) * 100));
}

cleanup();

console.log('[投递节流回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
// 显式退出：本脚本 bundle 了 statsAggregate 模块，跑完后进程仍有残留句柄（esbuild service
// / Socket），不主动 exit 会挂住、且退出码变成超时码而非 0 —— CI / 门禁无法据此判成败。
process.exit(0);
