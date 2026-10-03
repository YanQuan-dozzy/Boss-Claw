// 活跃时段 / 批次休息回归断言（零新增依赖）
//
// 为什么需要它：`activityWindow.ts` 决定「什么时候允许投递」，一旦判错方向是**静默且危险的**：
//   · 把该停的时段判成"可投" → 账号在凌晨被自动化，（更糟）每天精确同一分钟起止，反而放大风控特征；
//   · 把该投的时段判成"停" → 用户以为软件坏了（表现为「一直暂停」），或误以为设置没生效；
//   · 抖动用 Math.random 而非日期种子 → 同一分钟内两次判断结果不同，闸门自相矛盾；
//   · 批次休息边界算错 → 要么永不休息（失去保护），要么每个岗位都休息（软件不可用）。
// 这些都不被 typecheck / build 发现，必须断言守住。
//
// 做法：用项目里已有的 esbuild 把 TS 源打成临时 CJS 再 require（与 score-regression.mjs 同款，
// activityWindow.ts 是纯函数零依赖，无需桩）。
//
// 用法：node scripts/activity-window-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-activity-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: { contents: "export * from './src/lib/bossclaw/activityWindow.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  });
  const m = require(outfile);
  return { m, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const { m: A, cleanup } = await loadModule();

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; } 
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

// 构造固定时刻（本地时区）：2026-10-03
const D = (h, mi = 0, day = 3) => new Date(2026, 9, day, h, mi, 0, 0).getTime();
const NOON = D(12);
const NIGHT = D(3);
const NEXT_NOON = D(12, 0, 4);

// ===== A. dayRandom 确定性 =====
ok('dayRandom 同日同 salt 恒定', A.dayRandom(NOON, 1) === A.dayRandom(NOON + 3600_000, 1));
ok('dayRandom 同日不同 salt 不同', A.dayRandom(NOON, 1) !== A.dayRandom(NOON, 2));
ok('dayRandom 跨日不同', A.dayRandom(NOON, 1) !== A.dayRandom(NEXT_NOON, 1));
const r = A.dayRandom(NOON, 1);
ok('dayRandom 值域 [0,1)', r >= 0 && r < 1, 'r=' + r);

// ===== B. normalize 兜底 =====
const n1 = A.normalizeActiveHours(undefined);
eq('normalizeActiveHours(undefined) 启用', n1.enabled, true);
eq('normalizeActiveHours(undefined) start', n1.startHour, 8);
eq('normalizeActiveHours(undefined) end', n1.endHour, 23);
eq('normalizeActiveHours 越界 start 收敛到 23', A.normalizeActiveHours({ startHour: 99 }).startHour, 23);
eq('normalizeActiveHours 越界 start 收敛到 0', A.normalizeActiveHours({ startHour: -5 }).startHour, 0);
eq('normalizeActiveHours jitter 收敛到 120', A.normalizeActiveHours({ jitterMinutes: 999 }).jitterMinutes, 120);
eq('normalizeActiveHours enabled:false 保留', A.normalizeActiveHours({ enabled: false }).enabled, false);

const n2 = A.normalizeBatchRest({ minMinutes: 30, maxMinutes: 5 });
ok('normalizeBatchRest max<min 时把 max 抬到 min', n2.maxMinutes >= n2.minMinutes, JSON.stringify(n2));
eq('normalizeBatchRest everyNJobs 下界', A.normalizeBatchRest({ everyNJobs: 1 }).everyNJobs, 3);
eq('normalizeBatchRest everyNJobs 上界', A.normalizeBatchRest({ everyNJobs: 999 }).everyNJobs, 200);

// ===== C. resolveActiveWindow =====
const w = A.resolveActiveWindow(A.DEFAULT_ACTIVE_HOURS, NOON);
const jitterMs = A.DEFAULT_ACTIVE_HOURS.jitterMinutes * 60_000;
ok('窗口起点在 8:00 ± 抖动内', Math.abs(w.startMs - D(8)) <= jitterMs, 'start=' + new Date(w.startMs).toTimeString());
ok('窗口终点在 23:00 ± 抖动内', Math.abs(w.endMs - D(23)) <= jitterMs, 'end=' + new Date(w.endMs).toTimeString());
ok('非跨午夜时段 start < end', w.startMs < w.endMs);
ok('同一天多次调用窗口一致（确定性）', A.resolveActiveWindow(A.DEFAULT_ACTIVE_HOURS, NOON).startMs === w.startMs);
// 跨午夜：22 点至次日 6 点
const cross = A.resolveActiveWindow({ enabled: true, startHour: 22, endHour: 6, jitterMinutes: 0 }, NOON);
ok('跨午夜时段 endMs 落在次日', cross.endMs - cross.startMs > 7 * 3600_000, 'spanH=' + ((cross.endMs - cross.startMs) / 3600_000).toFixed(1));

// ===== D. isWithinActiveWindow =====
eq('关闭时凌晨也算活跃（恒 true）', A.isWithinActiveWindow({ enabled: false }, NIGHT), true);
eq('默认配置 中午 在活跃时段', A.isWithinActiveWindow(A.DEFAULT_ACTIVE_HOURS, NOON), true);
eq('默认配置 凌晨3点 不在活跃时段', A.isWithinActiveWindow(A.DEFAULT_ACTIVE_HOURS, NIGHT), false);
eq('默认配置 深夜23:59 不在活跃时段', A.isWithinActiveWindow(A.DEFAULT_ACTIVE_HOURS, D(23, 59)), false);

// ===== E. nextActiveStartMs =====
const nextFromNight = A.nextActiveStartMs(A.DEFAULT_ACTIVE_HOURS, NIGHT);
const nextFromNoon = A.nextActiveStartMs(A.DEFAULT_ACTIVE_HOURS, NOON);
ok('凌晨时下一个活跃起点落在当天上午', nextFromNight > NIGHT && nextFromNight < D(9), 'at=' + new Date(nextFromNight).toTimeString());
ok('时段内时下一个活跃起点落在次日', nextFromNoon > D(23), 'at=' + new Date(nextFromNoon).toTimeString());
eq('关闭时 nextActiveStartMs 返回 now', A.nextActiveStartMs({ enabled: false }, NOON), NOON);

// ===== F. checkDeliveryGate =====
const g1 = A.checkDeliveryGate(A.DEFAULT_ACTIVE_HOURS, 0, NIGHT);
eq('非活跃时段 → 闸门关闭', g1.ok, false);
ok('非活跃时段 → 给出恢复时刻', typeof g1.nextAllowedAt === 'number' && g1.nextAllowedAt > NIGHT);
const g2 = A.checkDeliveryGate(A.DEFAULT_ACTIVE_HOURS, NOON + 60_000, NOON);
eq('冷却期内 → 闸门关闭', g2.ok, false);
const g3 = A.checkDeliveryGate(A.DEFAULT_ACTIVE_HOURS, 0, NOON);
eq('时段内且无冷却 → 闸门放行', g3.ok, true);
const g4 = A.checkDeliveryGate({ enabled: false }, 0, NIGHT);
eq('关闭时段限制后凌晨也放行', g4.ok, true);

// ===== G. batchRestDelayMs =====
eq('批次休息关闭 → 0', A.batchRestDelayMs({ ...A.DEFAULT_BATCH_REST, enabled: false }, 15), 0);
eq('计数为 0 → 0', A.batchRestDelayMs(A.DEFAULT_BATCH_REST, 0), 0);
eq('未命中边界 → 0', A.batchRestDelayMs(A.DEFAULT_BATCH_REST, 7), 0);
const rest = A.batchRestDelayMs(A.DEFAULT_BATCH_REST, A.DEFAULT_BATCH_REST.everyNJobs);
ok('命中边界 → 返回休息时长', rest > 0, 'rest=' + rest);
ok('休息时长落在 [min,max] 分钟',
  rest >= A.DEFAULT_BATCH_REST.minMinutes * 60_000 - 1 && rest <= A.DEFAULT_BATCH_REST.maxMinutes * 60_000 + 1,
  'min=' + rest / 60000);
// 多次采样应落在范围内（时长本身随机）
let allInRange = true;
for (let i = 0; i < 50; i++) {
  const v = A.batchRestDelayMs(A.DEFAULT_BATCH_REST, 30);
  if (v < 8 * 60_000 - 1 || v > 15 * 60_000 + 1) allInRange = false;
}
ok('休息时长 50 次采样均在 [8,15] 分钟内', allInRange);
eq('自定义 everyNJobs=5 时第 5 个命中', A.batchRestDelayMs({ enabled: true, everyNJobs: 5, minMinutes: 1, maxMinutes: 1 }, 5) > 0, true);
eq('自定义 everyNJobs=5 时第 4 个不命中', A.batchRestDelayMs({ enabled: true, everyNJobs: 5, minMinutes: 1, maxMinutes: 1 }, 4), 0);

// ===== H. 展示辅助 =====
ok('formatActiveWindow 形如 HH:MM–HH:MM', /^\d{2}:\d{2}–\d{2}:\d{2}$/.test(A.formatActiveWindow(A.DEFAULT_ACTIVE_HOURS, NOON)), A.formatActiveWindow(A.DEFAULT_ACTIVE_HOURS, NOON));
eq('humanDuration 6 小时', A.humanDuration(6 * 3600_000 + 12 * 60_000), '6 小时 12 分');
eq('humanDuration 45 分钟', A.humanDuration(45 * 60_000), '45 分');

cleanup();

console.log('[活跃时段回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
