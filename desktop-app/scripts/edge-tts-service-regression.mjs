#!/usr/bin/env node
// scripts/edge-tts-service-regression.mjs —— 在线 TTS 在主进程语音服务里的路由与回落（离线）
//
// 与 edge-tts-protocol-regression 的分工：那份测协议本身（纯函数 + mock 服务器），
// 这份测 speechService 的三条口径，它们只存在于主进程、浏览器里测不到：
//   1. 开关关闭时不走在线（即使渲染层传了 engine:'online'）；
//   2. 自定义音色（clone_/voice_）永远留在本地，不会被送去 Edge；
//   3. 在线失败必须静默回落本地，并把 fellBack 标出来，而不是把错误抛给渲染层。
// 用最小 electron 替身跑真实的 speechService.cjs；在线分支不落地任何模型，所以无需语音包。
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const speechDir = mkdtempSync(join(tmpdir(), 'bossclaw-edge-svc-'));
process.env.BOSSCLAW_SPEECH_DIR = speechDir;
mkdirSync(join(speechDir, 'cache'), { recursive: true });

const require = createRequire(import.meta.url);
const Module = require('node:module');

// 最小 electron 替身：这条链路只用到 app.getPath（install.rootDir 会走 BOSSCLAW_SPEECH_DIR 覆盖）
const fakeElectron = { app: { getPath: () => speechDir, isPackaged: false }, utilityProcess: { fork: () => { throw new Error('不该走到 worker'); } } };
const origLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const install = require(join(root, 'electron', 'speechInstall.cjs'));
const service = require(join(root, 'electron', 'speechService.cjs'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

function encodeFrame(payload, opcode = 1) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = b.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  return Buffer.concat([header, b]);
}
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
    let mask = null;
    if (masked) { if (cur.length < off + 4) break; mask = cur.subarray(off, off + 4); off += 4; }
    if (cur.length < off + len) break;
    let payload = cur.subarray(off, off + len);
    if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]; }
    frames.push({ opcode, text: payload.toString('utf8') });
    cur = cur.subarray(off + len);
  }
  return { frames, rest: cur };
}
function startMock() {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = readFrames(buf);
      buf = Buffer.from(rest);
      if (frames.length >= 2) {
        const meta = Buffer.from('X-RequestId:m\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
        const h = Buffer.alloc(2); h.writeUInt16BE(meta.length, 0);
        // 假 mp3：帧同步 + 若干字节，够断言"整段被拼起来"
        socket.write(encodeFrame(Buffer.concat([h, meta, Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6])]), 2));
        socket.write(encodeFrame('X-RequestId:m\r\nPath:turn.end\r\n\r\n', 1));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, close: () => server.close(),
  })));
}

const onlineVoice = 'zh-CN-XiaoxiaoNeural';
const base = { text: '请用三分钟讲清楚你最近负责的项目。', sid: 3, speed: 1, onlineVoice };
const mp3Files = () => readdirSync(join(speechDir, 'cache')).filter((f) => f.endsWith('.mp3'));

console.log(`语音根目录：${speechDir}`);

try {
  // ===== 1. 开关默认关：即使渲染层传 engine:'online' 也不走在线 =====
  install.setOnlineEngine(false);
  const off = await service.synthesize({ ...base, engine: 'online' });
  ok('默认关时 state 反映 false', service.status().onlineEngine === false);
  ok('默认关时不走在线（回落本地并因缺语音包失败）', off.ok === false && off.engine !== 'online', JSON.stringify(off).slice(0, 120));

  // ===== 2. 开关开 + 正常接口：走在线并落 .mp3 缓存 =====
  const srv = await startMock();
  process.env.BOSSCLAW_EDGE_TTS_URL = `ws://127.0.0.1:${srv.port}/consumer/speech/synthesize/readaloud/edge/v1`;
  install.setOnlineEngine(true);
  const on = await service.synthesize({ ...base, engine: 'online' });
  ok('开关开启后 state 反映 true', service.status().onlineEngine === true);
  ok('走在线并返回 mp3', on.ok === true && on.engine === 'online' && on.mime === 'audio/mpeg', JSON.stringify(on).slice(0, 120));
  ok('返回体承载了 mp3 字节', Boolean(on.wavBase64) && on.bytes === 10);
  ok('缓存落的是 .mp3（不是 .wav）', mp3Files().length === 1, mp3Files().join(','));

  // ===== 3. 同一句第二次：命中 mp3 缓存，0 耗时，不再打接口 =====
  const cached = await service.synthesize({ ...base, engine: 'online' });
  ok('第二次命中缓存', cached.ok === true && cached.cached === true && cached.ms === 0);

  // ===== 4. 自定义音色必须留在本地：克隆 id 即便带 online 也不去 Edge =====
  const cloned = await service.synthesize({ text: base.text, sid: 3, speed: 1, engine: 'online', onlineVoice, voiceId: 'clone_abcdef123456' });
  ok('克隆音色不走在线', cloned.engine !== 'online', JSON.stringify(cloned).slice(0, 140));

  // ===== 5. 接口故障 → 静默回落本地（fellBack 标记，不抛错） =====
  srv.close();
  const broken = await service.synthesize({ ...base, text: `${base.text}（故障路径）`, engine: 'online' });
  ok('在线失败返回 fellBack 标记', broken.fellBack === true, JSON.stringify(broken).slice(0, 160));
  ok('回落失败原因是本地缺语音包，而非抛出异常', typeof broken.error === 'string' && broken.error.length > 0);
  ok('回落日志记录在 status.lastError', /在线语音不可用/.test(service.status().lastError || ''));

  delete process.env.BOSSCLAW_EDGE_TTS_URL;
  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
} finally {
  try { service.shutdown(); } catch { /* ignore */ }
  try { rmSync(speechDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1);
