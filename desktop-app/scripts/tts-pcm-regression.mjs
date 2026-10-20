// 流式朗读的缓存回归：分块拼接 + WAV 编码
//
// 为什么必须断言：流式合成结束后要把分块拼回整段再写缓存。
// 拼错/写错不会当场报错——坏的是磁盘上的缓存，下次朗读永远是错的，而且看起来像"模型输出乱了"。
//
// 用法：node scripts/tts-pcm-regression.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { encodeWav, concatFloat32 } = require(join(root, 'electron', 'wav.cjs'));

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
function near(v, target, tol, label) {
  if (Math.abs(v - target) > tol) throw new Error(`${label} 应≈${target}（±${tol}），实际 ${v}`);
}

/** 读回 16-bit PCM（模拟浏览器/声卡看到的内容） */
function decodePcm(wav) {
  const n = wav.readUInt32LE(40) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = wav.readInt16LE(44 + i * 2);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

// ===== WAV 头 =====
check('WAV 头字段齐全且自洽', () => {
  const wav = encodeWav(new Float32Array(1000), 24000);
  eq(wav.length, 44 + 2000, '总长度');
  eq(wav.toString('ascii', 0, 4), 'RIFF', 'RIFF');
  eq(wav.toString('ascii', 8, 12), 'WAVE', 'WAVE');
  eq(wav.toString('ascii', 12, 16), 'fmt ', 'fmt 块');
  eq(wav.toString('ascii', 36, 40), 'data', 'data 块');
  eq(wav.readUInt32LE(4), 36 + 2000, 'RIFF 长度');
  eq(wav.readUInt16LE(20), 1, 'PCM');
  eq(wav.readUInt16LE(22), 1, '单声道');
  eq(wav.readUInt32LE(24), 24000, '采样率');
  eq(wav.readUInt32LE(28), 48000, '字节率');
  eq(wav.readUInt16LE(32), 2, '块对齐');
  eq(wav.readUInt16LE(34), 16, '位深');
  eq(wav.readUInt32LE(40), 2000, 'data 长度');
});

check('采样率被规整为整数（模型偶尔给浮点）', () => {
  const wav = encodeWav(new Float32Array(4), 24000.0000001);
  eq(wav.readUInt32LE(24), 24000, '采样率');
  eq(wav.readUInt32LE(28), 48000, '字节率（不能出现小数）');
});

// ===== 量化 =====
check('16-bit 量化往返误差在 1 LSB 内', () => {
  const src = new Float32Array(257);
  for (let i = 0; i < src.length; i += 1) src[i] = Math.sin(i / 11) * 0.9;
  const back = decodePcm(encodeWav(src, 24000));
  eq(back.length, src.length, '采样数');
  let maxDiff = 0;
  for (let i = 0; i < src.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(back[i] - src[i]));
  if (maxDiff > 1 / 32000) throw new Error(`往返误差过大：${maxDiff}`);
});

check('越界值削顶而不是回绕', () => {
  const wav = encodeWav(new Float32Array([2, -2, 1, -1]), 24000);
  eq(wav.readInt16LE(44), 32767, '正值削顶');
  eq(wav.readInt16LE(46), -32768, '负值削顶');
  eq(wav.readInt16LE(48), 32767, '1.0');
  eq(wav.readInt16LE(50), -32768, '-1.0');
});

check('NaN 不会写出非法采样', () => {
  const wav = encodeWav(new Float32Array([NaN, 0.5]), 24000);
  const v = wav.readInt16LE(44);
  if (!Number.isFinite(v)) throw new Error('NaN 采样被写成非法值');
});

// ===== 拼接 =====
check('拼接保持顺序与长度', () => {
  const a = new Float32Array([0.1, 0.2]);
  const b = new Float32Array([0.3]);
  const c = new Float32Array([0.4, 0.5, 0.6]);
  const out = concatFloat32([a, b, c]);
  eq(out.length, 6, '总长度');
  near(out[0], 0.1, 1e-6, '首段首采样');
  near(out[2], 0.3, 1e-6, '第二段边界（不能重复或漏掉）');
  near(out[5], 0.6, 1e-6, '末段末采样');
});

check('空块被跳过、空数组得到空结果', () => {
  eq(concatFloat32([]).length, 0, '空数组');
  eq(concatFloat32([new Float32Array(0), new Float32Array(0)]).length, 0, '全空块');
  eq(concatFloat32([new Float32Array([1]), new Float32Array(0), new Float32Array([2])]).length, 2, '中间空块');
});

check('实测分块长度拼成整段（7 块 / 16.69s / 24kHz）', () => {
  // 冒烟实测的 7 块采样数（合计 400510，对应 16.69s @24k）
  const sizes = [44991, 26645, 68898, 87568, 15414, 89492, 67600];
  const parts = sizes.map((n, idx) => {
    const p = new Float32Array(n);
    p.fill(idx / 10); // 用块序号做标记，验证拼接顺序
    return p;
  });
  const sum = sizes.reduce((a, b) => a + b, 0);
  const all = concatFloat32(parts);
  eq(all.length, sum, '总采样数');
  for (let i = 0; i < parts.length; i += 1) {
    const start = sizes.slice(0, i).reduce((a, b) => a + b, 0);
    near(all[start], i / 10, 1e-6, `第 ${i + 1} 块的起点`);
    near(all[start + sizes[i] - 1], i / 10, 1e-6, `第 ${i + 1} 块的终点`);
  }
  near(sum / 24000, 16.69, 0.01, '整段时长');
  const wav = encodeWav(all, 24000);
  eq(wav.length, 44 + sum * 2, 'WAV 文件长度');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} 项失败` : `\n全部 ${results.filter((r) => r.startsWith('  ok')).length} 项通过`);
process.exit(failures ? 1 : 0);
