// 表达体征回归（P4）：能量 VAD、语速、长停顿、口头禅
//
// 为什么必须断言：体征是「看起来最像客观数据」的一块——分段阈值错一点，
// 长停顿次数就会从 2 变成 8；而用户没有任何办法判断哪个对。
//
// 用法：node scripts/mock-interview-delivery-regression.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-delivery-'));
const outFile = join(outDir, 'bundle.cjs');

await build({
  entryPoints: [join(root, 'src', 'lib', 'bossclaw', 'mockInterviewDelivery.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
});
const D = require(outFile);

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
function between(v, lo, hi, label) {
  if (!(v >= lo && v <= hi)) throw new Error(`${label} 应在 ${lo}–${hi}，实际 ${v}`);
}

const SR = 16000;

/** 生成一段「静音 + 正弦音」拼起来的 PCM */
function buildAudio(parts) {
  const total = parts.reduce((n, p) => n + Math.round(p.sec * SR), 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    const len = Math.round(p.sec * SR);
    if (p.amp > 0) {
      for (let i = 0; i < len; i += 1) {
        out[off + i] = p.amp * Math.sin((2 * Math.PI * 220 * i) / SR) + (p.noise || 0) * (Math.random() * 2 - 1);
      }
    } else if (p.noise) {
      for (let i = 0; i < len; i += 1) out[off + i] = p.noise * (Math.random() * 2 - 1);
    }
    off += len;
  }
  return out;
}

// ===== VAD =====
const audio = buildAudio([
  { sec: 1, amp: 0, noise: 0.001 },
  { sec: 2, amp: 0.2 },
  { sec: 2, amp: 0, noise: 0.002 },
  { sec: 3, amp: 0.2 },
  { sec: 0.5, amp: 0, noise: 0.001 },
]);
const analysis = D.analyzeEnergy(audio, SR);

check('两段语音识别为 2 段', () => {
  eq(analysis.segments.length, 2, '段数');
});
check('长停顿只数 ≥1.5s 的段间静音', () => {
  eq(analysis.longPauses, 1, '长停顿次数');
  between(analysis.pauseSec, 1.7, 2.3, '停顿总时长');
});
check('有声时长接近真实语音长度', () => {
  between(analysis.speechSec, 4.6, 5.4, '有声时长');
  between(analysis.speechRatio, 0.55, 0.65, '有声占比');
});
check('首尾静音不算停顿', () => {
  ok(analysis.pauseSec < 2.4, `停顿 ${analysis.pauseSec}s 把首尾静音算进去了`);
});

check('短于 320ms 的间隙被合并（正常换气不算停顿）', () => {
  const a = buildAudio([
    { sec: 1.5, amp: 0.2 },
    { sec: 0.2, amp: 0 },
    { sec: 1.5, amp: 0.2 },
  ]);
  const r = D.analyzeEnergy(a, SR);
  eq(r.segments.length, 1, '应合并为 1 段');
  eq(r.longPauses, 0, '不应产生长停顿');
});

check('纯静音不产生语音段', () => {
  const r = D.analyzeEnergy(new Float32Array(SR * 3), SR);
  eq(r.segments.length, 0, '段数');
  eq(r.speechSec, 0, '有声时长');
});

check('安静房间的底噪不会被当成说话', () => {
  const a = buildAudio([{ sec: 3, amp: 0, noise: 0.003 }]);
  const r = D.analyzeEnergy(a, SR);
  eq(r.segments.length, 0, '段数');
});

// ===== 文本指标 =====
check('口头禅按出现次数统计（不重叠）', () => {
  const r = D.countFillers('然后我们就是做了这个，嗯，然后又说了一遍，就是这样的。');
  eq(r.detail['然后'], 2, '「然后」次数');
  eq(r.detail['就是'], 2, '「就是」次数');
  eq(r.detail['嗯'], 1, '「嗯」次数');
  eq(r.detail['这个'], 1, '「这个」次数');
  eq(r.total, 6, '合计');
});

check('没有口头禅时不误报', () => {
  const r = D.countFillers('我把订单服务的 QPS 从 300 提到 900，P99 从 420ms 降到 180ms。');
  eq(r.total, 0, '合计');
});

check('语速以有声时长为分母', () => {
  const a = { durationSec: 60, speechSec: 30, pauseSec: 20, longPauses: 2, speechRatio: 0.5, noiseFloor: 0.001, segments: [] };
  const m = D.computeDelivery('一'.repeat(150), a);
  eq(m.charsPerMinute, 300, '字/分');
  eq(m.chars, 150, '字数');
});

check('字数统计忽略空白与换行', () => {
  eq(D.countChars('  你好 世界\n第二行 '), 7, '字数');
});

check('语速标签边界', () => {
  eq(D.paceLabel(0).text, '—', '0');
  eq(D.paceLabel(150).text, '偏慢', '150');
  eq(D.paceLabel(250).text, '适中', '250');
  eq(D.paceLabel(400).text, '偏快', '400');
});

check('多题体征按有声时长加权', () => {
  const a = D.aggregateDelivery([
    { durationSec: 30, speechSec: 30, charsPerMinute: 300, longPauses: 1, pauseSec: 0, fillerWords: { 然后: 2 }, fillerTotal: 2, speechRatio: 1, chars: 150 },
    { durationSec: 30, speechSec: 30, charsPerMinute: 180, longPauses: 1, pauseSec: 0, fillerWords: { 就是: 1 }, fillerTotal: 1, speechRatio: 1, chars: 90 },
  ]);
  eq(a.charsPerMinute, 240, '加权语速');
  eq(a.longPauses, 2, '停顿合计');
  eq(a.fillerTotal, 3, '口头禅合计');
  eq(a.fillerWords['然后'], 2, '口头禅明细');
});

check('没有录音作答时汇总为 null', () => {
  eq(D.aggregateDelivery([]), null, '空数组');
  eq(D.aggregateDelivery([{ ...D.EMPTY_DELIVERY }]), null, '全零');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} 项失败` : `\n全部 ${results.filter((r) => r.startsWith('  ok')).length} 项通过`);
rmSync(outDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
