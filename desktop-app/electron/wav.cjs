// WAV 编码与 PCM 拼接（纯函数，不依赖 electron）
//
// 为什么单独一个文件：流式朗读结束时要把分块拼回整段再写缓存。
// 拼错不会当场报错——坏的是**磁盘上的缓存**，下次朗读永远错，而且看起来像"模型跑飞了"。
// 所以这段逻辑必须能被 scripts/tts-pcm-regression.mjs 直接 require 并离线断言。
'use strict';

/** Float32 [-1,1] → 16-bit PCM 单声道 WAV（浏览器 <audio> 与 <audio> 标签都能直接播） */
function encodeWav(samples, sampleRate) {
  const rate = Math.max(8000, Math.round(Number(sampleRate) || 24000));
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/**
 * 按顺序拼接若干段 Float32 PCM。
 * 块与块的边界必须严格首尾相接：重复一段会听到"打嗝"，漏一段会吞字。
 */
function concatFloat32(parts) {
  const list = Array.isArray(parts) ? parts.filter((p) => p && p.length) : [];
  const total = list.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of list) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

module.exports = { encodeWav, concatFloat32 };
