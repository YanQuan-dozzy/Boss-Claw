// 流式朗读回归：PCM 编解码的对齐 + 分块排期的间隙
//
// 为什么必须断言：
//   · base64 ↔ Float32 的对齐问题在本项目已经咬了两次（Buffer 内存池 byteOffset 不是 4 的倍数）；
//   · 分块播放的「断音」是用户能听见、代码看不出来的东西——排期算错不会报错，只会听起来卡。
//
// 用法：node scripts/tts-stream-regression.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-tts-stream-'));
const outFile = join(outDir, 'bundle.cjs');

await build({
  entryPoints: [join(root, 'src', 'lib', 'bossclaw', 'mockInterviewAudio.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
});
const A = require(outFile);

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
function eq(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label || '值'} 不符：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}
function near(v, target, tol, label) {
  if (Math.abs(v - target) > tol) throw new Error(`${label} 应≈${target}（±${tol}），实际 ${v}`);
}

// ===== PCM 编解码 =====
check('奇数长度 PCM 往返不丢采样', () => {
  const src = new Float32Array(44991); // 实测首块就是这个长度，/4 之后仍是整数
  for (let i = 0; i < src.length; i += 1) src[i] = Math.sin(i / 37) * 0.8;
  const back = A.base64ToFloat32(A.float32ToBase64(src));
  eq(back.length, src.length, '采样数');
  eq(back.byteOffset, 0, 'byteOffset（必须独立对齐）');
  let maxDiff = 0;
  for (let i = 0; i < src.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(back[i] - src[i]));
  ok(maxDiff === 0, `往返误差应为 0，实际 ${maxDiff}`);
});

check('负值与极值不被截断', () => {
  const src = new Float32Array([-1, -0.5, 0, 0.5, 1, -0.000001]);
  const back = A.base64ToFloat32(A.float32ToBase64(src));
  eq(Array.from(back), Array.from(src), '极值');
});

check('空块不抛异常', () => {
  eq(A.float32ToBase64(new Float32Array(0)), '', '空 base64');
  eq(A.base64ToFloat32('').length, 0, '空解码');
});

check('长度不是 4 的倍数时截断而不是抛错', () => {
  // 3 字节 = 0 个完整采样；7 字节 = 1 个完整采样
  const b3 = btoa(String.fromCharCode(1, 2, 3));
  const b7 = btoa(String.fromCharCode(0, 0, 128, 63, 9, 9, 9)); // 1.0f + 3 个尾巴字节
  eq(A.base64ToFloat32(b3).length, 0, '3 字节');
  eq(A.base64ToFloat32(b7).length, 1, '7 字节');
  near(A.base64ToFloat32(b7)[0], 1, 1e-6, '截断后仍能读出头一个采样');
});

// ===== 分块排期 =====
// 实测（Kokoro / 本机 CPU / RTF≈0.83）：「到达时刻(秒) → 块时长(秒)」
const MEASURED = [
  { at: 1.658, dur: 1.87 },
  { at: 2.731, dur: 1.11 },
  { at: 4.996, dur: 2.87 },
  { at: 7.88, dur: 3.65 },
  { at: 8.523, dur: 0.64 },
  { at: 11.523, dur: 3.73 },
  { at: 13.839, dur: 2.82 },
];

check('首块按 lead 排期，不去抢当前时刻', () => {
  const s = new A.AudioChunkScheduler(0.15);
  const slot = s.schedule(0, 1.87);
  near(slot.start, 0.15, 1e-9, '首个开始时刻');
  eq(slot.gap, 0, '首块无间隙');
  near(s.endSec, 2.02, 1e-9, '首块结束时刻');
  eq(s.underruns, 0, '断音次数');
});

check('块持续到达时首尾相接（无断音）', () => {
  const s = new A.AudioChunkScheduler(0.15);
  // 生成远快于播放：每块都在上一块播完之前到达
  for (let i = 0; i < 6; i += 1) s.schedule(0.1 + i * 0.2, 1);
  eq(s.underruns, 0, '断音次数');
  near(s.endSec, 0.25 + 6, 1e-9, '连续排期总时长');
});

check('实测时间线：检出 0.22s 断音', () => {
  const s = new A.AudioChunkScheduler(0.15);
  for (const c of MEASURED) s.schedule(c.at, c.dur);
  eq(s.chunks, MEASURED.length, '块数');
  eq(s.underruns, 1, '断音次数');
  near(s.maxGap, 0.218, 0.01, '最大间隙');
  // 首块 1.808 起播，中间两处迟到（0.218 + 0.014）全部顺延
  const totalAudio = MEASURED.reduce((n, c) => n + c.dur, 0);
  near(s.endSec, 1.808 + totalAudio + 0.232, 0.01, '总结束时刻');
});

check('迟到块不会被排到过去', () => {
  const s = new A.AudioChunkScheduler(0.15);
  s.schedule(0, 0.5); // 0.15 起播，0.65 结束
  const late = s.schedule(5, 0.5); // 5 秒才来
  ok(late.start >= 5, `开始时刻不能早于当前时刻，实际 ${late.start}`);
  near(late.gap, 5.01 - 0.65, 1e-9, '间隙按实际空档计');
  eq(s.underruns, 1, '断音次数');
});

check('阈值以下的抖动不算断音', () => {
  const s = new A.AudioChunkScheduler(0.15, 0.08);
  s.schedule(0, 1);
  s.schedule(1.02, 1); // 20ms 抖动
  eq(s.underruns, 0, '20ms 不应计入断音');
});

check('调度器边界：零时长块不推进时间轴', () => {
  const s = new A.AudioChunkScheduler(0.15);
  const a = s.schedule(0, 1);
  const b = s.schedule(0, 0);
  near(b.start, a.start + 1, 1e-9, '零时长块接在前一块结尾');
  near(s.endSec, a.start + 1, 1e-9, '总时长不变');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} 项失败` : `\n全部 ${results.filter((r) => r.startsWith('  ok')).length} 项通过`);
rmSync(outDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
