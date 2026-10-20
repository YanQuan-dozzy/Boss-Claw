#!/usr/bin/env node
// scripts/edge-tts-protocol-regression.mjs —— 在线 TTS（edge-tts）离线回归
//
// 为什么需要它：Edge 接口从这台开发机的出口是被拦的（WS 升级返回 403，REST voices/list 正常），
// 所以「能不能联网」这条永远不可能在这里验证。能验证、也必须被钉死的是另外三件事：
//   1. 协议构造是纯函数：GEC 签名的时间窗口、SSML 转义、节奏百分比、音频帧解析；
//   2. 一次完整会话的读法：客户端发几条消息、服务端二进制帧怎么拼成 mp3、turn.end 何时算完成；
//   3. 失败语义：中途断开 / 卡死超时都必须 reject（由 speechService 静默回落本地，绝不弹错）。
// 后两条用一个本地 mock WebSocket 服务器跑真链路（同一份 edgeTts.cjs，不断言实现细节）。
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const edgeTts = require('../electron/edgeTts.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ===== 1. 纯函数 =====
console.log('\n[1] 协议构造（纯函数）');

const gecA = edgeTts.secMsGec(1750000000000);
ok('Sec-MS-GEC 是 64 位大写十六进制', /^[0-9A-F]{64}$/.test(gecA), gecA);
ok('同一 5 分钟窗口内结果稳定', edgeTts.secMsGec(1750000000000 + 60000) === gecA);
ok('跨 5 分钟窗口结果变化', edgeTts.secMsGec(1750000000000 + 6 * 60000) !== gecA,
  `${gecA} vs ${edgeTts.secMsGec(1750000000000 + 6 * 60000)}`);

ok('节奏 0.9 → -10%', edgeTts.rateToProsody(0.9) === '-10%', edgeTts.rateToProsody(0.9));
ok('节奏 1.0 → +0%', edgeTts.rateToProsody(1) === '+0%', edgeTts.rateToProsody(1));
ok('节奏 1.2 → +20%', edgeTts.rateToProsody(1.2) === '+20%', edgeTts.rateToProsody(1.2));
ok('节奏越界被夹到区间内', edgeTts.rateToProsody(5) === '+50%' && edgeTts.rateToProsody(0.3) === '-50%',
  `${edgeTts.rateToProsody(5)} / ${edgeTts.rateToProsody(0.3)}`);

const ssml = edgeTts.buildSsml({ text: 'A&B <c> "d"', voice: 'zh-CN-XiaoxiaoNeural', speed: 1 });
ok('SSML 含目标音色', ssml.includes("name='zh-CN-XiaoxiaoNeural'"));
ok('SSML 对 XML 特殊字符转义', ssml.includes('A&amp;B &lt;c&gt; &quot;d&quot;') && !ssml.includes('<c>'));
ok('SSML 带 prosody 节奏', ssml.includes("rate='+0%'"));

const url = edgeTts.buildUrl(1750000000000);
ok('URL 指向 edge/v1', url.includes('/consumer/speech/synthesize/readaloud/edge/v1'));
ok('URL 带 TrustedClientToken', url.includes('TrustedClientToken='));
ok('URL 带 Sec-MS-GEC 与大写签名', url.includes(`Sec-MS-GEC=${gecA}`));
ok('URL 带 ConnectionId（32 位十六进制）', /ConnectionId=[a-f0-9]{32}/.test(url));

// 二进制帧：[2 字节大端头长度][头文本][音频]
const audioPart = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const header = Buffer.from('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
const frame = Buffer.concat([
  (() => { const h = Buffer.alloc(2); h.writeUInt16BE(header.length, 0); return h; })(),
  header,
  audioPart,
]);
const parsed = edgeTts.parseAudioMessage(frame);
ok('音频帧解析出头文本', Boolean(parsed) && /Path:audio/.test(parsed.header));
ok('音频帧解析出音频字节', Boolean(parsed) && parsed.audio.equals(audioPart));
ok('非音频帧被忽略', edgeTts.parseAudioMessage(Buffer.from([0x00, 0x03, 0x61, 0x62, 0x63])) === null);

// ===== 2. 本地 mock 服务器上的真链路 =====
console.log('\n[2] 端到端（本地 mock WebSocket 服务器）');

function encodeFrame(payload, opcode = 1) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = b.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, b]);
}

/** 解析客户端（必须带掩码）的帧，返回 { frames, rest } */
function readFrames(buf) {
  const frames = [];
  let cur = buf;
  for (;;) {
    if (cur.length < 2) break;
    const opcode = cur[0] & 0x0f;
    const masked = (cur[1] & 0x80) !== 0;
    let len = cur[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (cur.length < 4) break; len = cur.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (cur.length < 10) break; len = Number(cur.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (cur.length < off + 4) break; mask = cur.subarray(off, off + 4); off += 4; }
    if (cur.length < off + len) break;
    let payload = cur.subarray(off, off + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    cur = cur.subarray(off + len);
  }
  return { frames, rest: cur };
}

/**
 * 起一个 mock Edge TTS 服务端。
 * @param {{mode?:'ok'|'abort'|'silent', audioBytes?:Buffer}} opts
 */
function startMock({ mode = 'ok', audioBytes = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]) } = {}) {
  const seen = { url: '', headers: null, messages: [] };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    seen.url = req.url;
    seen.headers = req.headers;
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = readFrames(buf);
      buf = Buffer.from(rest);
      seen.messages.push(...frames.map((f) => f.text));
      // 收到 config + ssml 两条文本消息后按模式响应
      if (seen.messages.length >= 2 && seen.messages.length <= 3) {
        if (mode === 'abort') { socket.destroy(); return; }
        if (mode === 'silent') return;
        const meta = Buffer.from('X-RequestId:mock\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
        const head2 = Buffer.alloc(2);
        head2.writeUInt16BE(meta.length, 0);
        socket.write(encodeFrame(Buffer.concat([head2, meta, audioBytes]), 2));
        socket.write(encodeFrame('X-RequestId:mock\r\nPath:turn.end\r\n\r\n', 1));
      }
    });
    socket.on('error', () => { /* 客户端主动关闭 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => server.close(),
    }));
  });
}

async function withEndpoint(port, fn) {
  const prev = process.env.BOSSCLAW_EDGE_TTS_URL;
  process.env.BOSSCLAW_EDGE_TTS_URL = `ws://127.0.0.1:${port}/consumer/speech/synthesize/readaloud/edge/v1`;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.BOSSCLAW_EDGE_TTS_URL;
    else process.env.BOSSCLAW_EDGE_TTS_URL = prev;
  }
}

// 2a. 正常路径
{
  const srv = await startMock();
  const r = await withEndpoint(srv.port, () => edgeTts.synthesize({
    text: '请介绍一下你自己。',
    voice: 'zh-CN-XiaoxiaoNeural',
    speed: 1.1,
  }));
  ok('正常路径返回 ok', r.ok === true, r.error);
  ok('返回 mp3 字节与长度一致', r.ok && Buffer.isBuffer(r.mp3) && r.bytes === r.mp3.length && r.bytes === 8,
    r.ok ? `bytes=${r.bytes}` : r.error);
  ok('返回目标音色', r.ok && r.voice === 'zh-CN-XiaoxiaoNeural');
  ok('客户端发了 config + ssml 两条消息', srv.seen.messages.length === 2, `n=${srv.seen.messages.length}`);
  ok('config 消息声明 mp3 输出', srv.seen.messages.some((m) => /audio-24khz-48kbitrate-mono-mp3/.test(m)));
  ok('ssml 消息含 target 音色与节奏', srv.seen.messages.some((m) => m.includes("name='zh-CN-XiaoxiaoNeural'") && m.includes("rate='+10%'")));
  ok('握手带 Origin（扩展同源）', Boolean(srv.seen.headers && String(srv.seen.headers.origin || '').startsWith('chrome-extension://')));
  ok('握手带 User-Agent', Boolean(srv.seen.headers && srv.seen.headers['user-agent']));
  ok('请求 URL 带 Sec-MS-GEC 签名', /Sec-MS-GEC=[0-9A-F]{64}/.test(srv.seen.url || ''));
  srv.close();
}

// 2b. 中途断开 → 必须 reject
{
  const srv = await startMock({ mode: 'abort' });
  const r = await withEndpoint(srv.port, () => edgeTts.synthesize({ text: '断开测试', speed: 1 }));
  ok('连接中断返回 ok:false', r.ok === false && /中断|未返回/.test(r.error || ''), r.error);
  srv.close();
}

// 2c. 卡死超时 → 必须 reject（本地服务端不回 turn.end）
{
  const srv = await startMock({ mode: 'silent' });
  const t0 = Date.now();
  const r = await withEndpoint(srv.port, () => edgeTts.synthesize({ text: '超时测试', speed: 1, timeoutMs: 1200 }));
  ok('超时返回 ok:false', r.ok === false && /超时/.test(r.error || ''), r.error);
  ok('超时在设定阈值附近生效（<4s）', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
  srv.close();
}

// 2d. 空文本直接短路，不建连接
{
  const r = await edgeTts.synthesize({ text: '   ', speed: 1 });
  ok('空文本不发起连接直接失败', r.ok === false && /文本为空/.test(r.error || ''), r.error);
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
