'use strict';
// ===== 人类化输入计划（纯函数，零依赖，可离线单测）=====
// 为什么单独成模块：轨迹生成是**可验证的纯逻辑**，而真实点击/输入是副作用。
// 把「怎么动」与「怎么发事件」分开，前者就能进回归脚本（scripts/humanize-regression.mjs），
// 不必依赖页面与 Electron 运行时。
//
// 设计原则（改动前先读，破坏任一条都会让回归失败）：
//   1) 随机性由调用方注入的 rng 提供（默认 Math.random）——单测必须可复现；
//   2) 端点必须精确落位：轨迹首尾点是**输入的原值**，不做抖动/弧线偏移，
//      否则真实点击会偏离元素中心（这是「点不中」类故障的头号原因）；
//   3) 中间点带弧线与抖动：真人不走直线、不落整数像素；
//   4) 所有时长/步数都被夹紧，绝不产生 0ms 停顿或无限长路径。

const DEFAULTS = {
  minSteps: 3,
  maxSteps: 6,
  minStepMs: 8,
  maxStepMs: 34,
  maxStepsHard: 12,
  stepMsHard: 120,
  curvature: 0.18,
  jitterPx: 1.6,
  distancePerExtraStep: 220,
};

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function randInt(rng, lo, hi) {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function finitePoint(p) {
  return Boolean(p) && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
}

/**
 * 生成 from → to 的鼠标轨迹（含首尾端点）。
 * @param {{x:number,y:number}} from 起点（上次光标位置；无历史时由调用方给一个合理起点）
 * @param {{x:number,y:number}} to   终点（元素中心，必须精确命中）
 * @param {() => number} rng         随机源（默认 Math.random，单测注入固定序列）
 * @param {object} [opts]            覆盖 DEFAULTS 的局部项
 * @returns {Array<{x:number,y:number,delayMs:number}>} 逐点；delayMs 表示「移动到该点之前」的停顿
 */
function buildMousePath(from, to, rng = Math.random, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!finitePoint(from) || !finitePoint(to)) return [];
  const fx = Math.round(Number(from.x));
  const fy = Math.round(Number(from.y));
  const tx = Math.round(Number(to.x));
  const ty = Math.round(Number(to.y));
  const dx = tx - fx;
  const dy = ty - fy;
  const dist = Math.hypot(dx, dy);
  // 起终点重合：不必造轨迹，直接返回单点（调用方据此跳过移动）
  if (dist === 0) return [{ x: tx, y: ty, delayMs: 0 }];

  // 步数随距离增长：短距离 3~4 点，长距离可到 12 点（仍受 maxStepsHard 夹紧）
  const extra = clamp(Math.round(dist / o.distancePerExtraStep), 0, 6);
  const steps = clamp(randInt(rng, o.minSteps, o.maxSteps) + extra, 1, o.maxStepsHard);

  // 垂直于运动方向的单位向量：用来把中间点推离直线，形成弧线
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = dist * o.curvature * (rng() * 2 - 1);

  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const isEnd = i === 0 || i === steps;
    // 端点精确落位（弧线/抖动在 t=0 与 t=1 处自然为 0，这里再显式保证一次）
    const arc = Math.sin(Math.PI * t) * bend;
    const jx = isEnd ? 0 : (rng() * 2 - 1) * o.jitterPx;
    const jy = isEnd ? 0 : (rng() * 2 - 1) * o.jitterPx;
    points.push({
      x: isEnd ? (i === 0 ? fx : tx) : Math.round(fx + dx * t + nx * arc + jx),
      y: isEnd ? (i === 0 ? fy : ty) : Math.round(fy + dy * t + ny * arc + jy),
      delayMs: i === 0 ? 0 : clamp(randInt(rng, o.minStepMs, o.maxStepMs), 0, o.stepMsHard),
    });
  }
  return points;
}

/** 点击前的「落点稳定」停顿：真人点下去前会有一次微小停顿 */
function settleDelayMs(rng = Math.random, base = 90, spread = 70) {
  return clamp(Math.round(base + (rng() * 2 - 1) * spread), 20, 400);
}

/** 打字前的延迟序列：模拟逐字输入的节奏（总时长受硬上限约束） */
function typingDelays(length, rng = Math.random, opts) {
  const o = Object.assign({ minMs: 28, maxMs: 120, maxTotalMs: 4200, maxChars: 260 }, opts || {});
  const n = clamp(Math.round(Number(length) || 0), 0, o.maxChars);
  const out = [];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const d = clamp(randInt(rng, o.minMs, o.maxMs), 0, o.maxMs);
    if (total + d > o.maxTotalMs) break;
    total += d;
    out.push(d);
  }
  return out;
}

module.exports = {
  DEFAULTS,
  buildMousePath,
  settleDelayMs,
  typingDelays,
  clamp,
};
