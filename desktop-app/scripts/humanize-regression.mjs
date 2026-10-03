// 人类化输入计划回归断言（零新增依赖）
//
// 为什么需要它：`humanize.cjs` 生成的是「鼠标轨迹与节奏」，它决定真实点击**落不落得中元素**。
// 这类 bug 是**静默且难归因的**：
//   · 端点被抖动偏移 → 真实点击偏离元素中心 → 点不中（表现为「按钮没反应」），而日志只会说超时；
//   · 步数/延迟未夹紧 → 轨迹拖到几秒 → 与 4s 信道超时竞争，偶发失败；
//   · 弧线系数过大 → 中间点飞到视口外，可能误触其它元素（真实点击无法 preventDefault，会真的点到别处）；
//   · 随机源不可注入 → 无法复现，线上问题只能靠猜。
// 这些都不被 typecheck / build 发现，必须断言守住。
//
// 做法：humanize.cjs 是纯 CommonJS、零依赖 → 直接 require，不需要 esbuild 打包，也不需要 DOM。
//
// 用法：node scripts/humanize-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const H = require(join(root, 'electron', 'preload', 'humanize.cjs'));

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

// 确定性随机源：把固定序列循环吐出（同一个 seed 必得同一个结果 = 可复现）
const seeded = (values) => { let i = 0; return () => values[i++ % values.length]; };
const fixed = (v) => () => v;
const MIX = seeded([0.12, 0.87, 0.41, 0.63, 0.05, 0.99, 0.28, 0.74, 0.36, 0.52, 0.81, 0.19, 0.47, 0.68, 0.03, 0.91]);

const A = { x: 100, y: 120 };
const B = { x: 640, y: 430 };

// ===== A. 端点必须精确命中（最要紧：决定点不点得中）=====
{
  const p = H.buildMousePath(A, B, fixed(0.5));
  ok('首点精确等于起点', p[0].x === A.x && p[0].y === A.y, JSON.stringify(p[0]));
  const last = p[p.length - 1];
  ok('末点精确等于终点（真实点击落点）', last.x === B.x && last.y === B.y, JSON.stringify(last));
  ok('首点 delayMs 为 0（起点不等待）', p[0].delayMs === 0, String(p[0].delayMs));
}
{
  // 多种随机源下都必须精确命中（防止某种 rng 恰好让端点抖动）
  let allExact = true;
  for (const rng of [fixed(0), fixed(0.25), fixed(0.5), fixed(0.75), fixed(1), MIX, Math.random]) {
    const p = H.buildMousePath(A, B, rng);
    const last = p[p.length - 1];
    if (!(p[0].x === A.x && p[0].y === A.y && last.x === B.x && last.y === B.y)) allExact = false;
  }
  ok('7 种随机源下端末点均精确命中', allExact);
}

// ===== B. 结构与边界 =====
{
  const p = H.buildMousePath(A, B, MIX);
  ok('点数在 [2, maxStepsHard+1]', p.length >= 2 && p.length <= H.DEFAULTS.maxStepsHard + 1, String(p.length));
  ok('每点都有有限数值坐标', p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.delayMs)));
  ok('每点延迟在 [0, stepMsHard]', p.every((q) => q.delayMs >= 0 && q.delayMs <= H.DEFAULTS.stepMsHard));
  ok('非首点延迟均 > 0（不产生瞬时轨迹）', p.slice(1).every((q) => q.delayMs > 0));
}
{
  eq('起点与终点重合 → 单点', H.buildMousePath({ x: 7, y: 9 }, { x: 7, y: 9 }, MIX).length, 1);
  eq('重合点坐标为原值', JSON.stringify(H.buildMousePath({ x: 7, y: 9 }, { x: 7, y: 9 }, MIX)[0]), JSON.stringify({ x: 7, y: 9, delayMs: 0 }));
  eq('起点为 null → 空数组', H.buildMousePath(null, B, MIX).length, 0);
  eq('终点为 null → 空数组', H.buildMousePath(A, null, MIX).length, 0);
  eq('坐标含 NaN → 空数组', H.buildMousePath({ x: NaN, y: 1 }, B, MIX).length, 0);
  eq('坐标含字符串数字 → 可解析（不返回空）', H.buildMousePath({ x: '10', y: '20' }, { x: '30', y: '40' }, MIX).length > 0, true);
}

// ===== C. 中间点不得飞出包围盒（飞出去 = 可能误触其它元素）=====
{
  const p = H.buildMousePath(A, B, MIX);
  // 允许的越界 = 弧线幅度(距离×curvature) + 抖动 + 取整 1px
  const dist = Math.hypot(B.x - A.x, B.y - A.y);
  const slack = Math.ceil(dist * H.DEFAULTS.curvature + H.DEFAULTS.jitterPx + 2);
  const minX = Math.min(A.x, B.x) - slack;
  const maxX = Math.max(A.x, B.x) + slack;
  const minY = Math.min(A.y, B.y) - slack;
  const maxY = Math.max(A.y, B.y) + slack;
  const escaped = p.filter((q) => q.x < minX || q.x > maxX || q.y < minY || q.y > maxY);
  ok('全部点落在包围盒+弧线余量内', escaped.length === 0, JSON.stringify(escaped));
  // 极端：curvature 调大也不能无限飞（由 slack 公式倒逼）
  const wild = H.buildMousePath(A, B, fixed(0.999), { curvature: 0.5 });
  ok('curvature 放大后仍在可接受范围', wild.every((q) => Math.abs(q.x - B.x) < 5000 && Math.abs(q.y - B.y) < 5000));
}

// ===== D. 真人化特征：非直线、非整数像素、随距离增长 =====
{
  const p = H.buildMousePath({ x: 0, y: 0 }, { x: 600, y: 0 }, MIX);
  const offLine = p.slice(1, -1).filter((q) => q.y !== 0);
  ok('存在偏离直线的中间点（不是直线轨迹）', offLine.length > 0, JSON.stringify(p.map((q) => q.y)));

  const short = H.buildMousePath({ x: 0, y: 0 }, { x: 30, y: 0 }, fixed(0.5));
  const long = H.buildMousePath({ x: 0, y: 0 }, { x: 900, y: 0 }, fixed(0.5));
  ok('长距离轨迹点数 >= 短距离（步数随距离增长）', long.length >= short.length, 'short=' + short.length + ' long=' + long.length);

  // 注意：MIX 是**有状态**生成器（每次调用推进指针），可复现性必须用「同样的序列各来一份」验证
  const SEQ = [0.12, 0.87, 0.41, 0.63, 0.05, 0.99, 0.28, 0.74, 0.36, 0.52, 0.81, 0.19, 0.47, 0.68, 0.03, 0.91];
  const a = H.buildMousePath(A, B, seeded(SEQ));
  const b = H.buildMousePath(A, B, seeded(SEQ));
  ok('同一随机序列 → 结果可复现', JSON.stringify(a) === JSON.stringify(b));
  const c = H.buildMousePath(A, B, fixed(0.5));
  const d = H.buildMousePath(A, B, fixed(0.9));
  ok('不同随机源 → 轨迹不同（具备不确定性）', JSON.stringify(c) !== JSON.stringify(d));
}

// ===== E. 停顿与节奏 =====
{
  const s = H.settleDelayMs(MIX);
  ok('settleDelayMs 在 [20,400]', s >= 20 && s <= 400, String(s));
  ok('settleDelayMs 对极端随机源仍被夹紧', [fixed(0), fixed(1), fixed(-5), fixed(5)].every((r) => {
    const v = H.settleDelayMs(r);
    return v >= 20 && v <= 400;
  }));
}
{
  const t = H.typingDelays(20, MIX);
  eq('typingDelays 长度等于字符数（未触顶时）', t.length, 20);
  ok('typingDelays 每项在 [0, maxMs]', t.every((v) => v >= 0 && v <= 120));
  const big = H.typingDelays(5000, MIX);
  ok('typingDelays 受 maxChars 夹紧', big.length <= 260, String(big.length));
  const sum = H.typingDelays(260, MIX).reduce((x, y) => x + y, 0);
  ok('typingDelays 总时长受 maxTotalMs 夹紧', sum <= 4200, String(sum));
  eq('typingDelays 长度 0 → 空数组', H.typingDelays(0, MIX).length, 0);
  eq('typingDelays 负数 → 空数组', H.typingDelays(-5, MIX).length, 0);
}

// ===== F. clamp 本体 =====
{
  eq('clamp 下界', H.clamp(-1, 0, 10), 0);
  eq('clamp 上界', H.clamp(11, 0, 10), 10);
  eq('clamp 区间内原值', H.clamp(5, 0, 10), 5);
}

console.log('[人类化输入回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
