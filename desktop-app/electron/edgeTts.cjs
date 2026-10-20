// electron/edgeTts.cjs —— 在线 TTS 引擎（Microsoft Edge 神经语音），零依赖
//
// 定位（方案 6.6）：**可选高音质档，默认关闭**。不是主力路径，本地 Kokoro 才是默认。
// 走 Edge 的「朗读」接口（与浏览器扩展同一个），任意失败都静默回落本地 —— 因此
// 这个模块只需要把"一句话合成成 mp3"这一件事做对，不需要重试/队列/状态机。
//
// 为什么零依赖：Node 22+ 自带全局 WebSocket（undici），且支持自定义 headers。
//   → 不需要 ws 包，也不需要手写握手与帧编解码。
//   → 自带的 permessage-deflate 协商由 undici 处理，这里只面对"消息"层。
//
// 协议（逆向自 Edge 扩展，公开且稳定多年）：
//   · URL 查询串带公开的 TrustedClientToken 与 Sec-MS-GEC（SHA256(token + 5 分钟取整时间片)）
//   · 先发一条 config 文本帧（声明输出格式 mp3），再发一条 SSML 文本帧
//   · 服务端回若干二进制帧： [2 字节大端头长度][头文本含 Path:audio][mp3 字节]
//   · 最后回一条文本帧，含 Path:turn.end
//
// 稳定性口径（方案 6.6）：这是非官方接口，鉴权或结构随时可能变。
//   所以这里任何异常一律 reject，由 speechService 静默回落 —— 绝不让在线失败影响用户作答。
'use strict';

const crypto = require('node:crypto');

const DEFAULT_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '130.0.2849.68';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_VERSION}`;
// 与 Edge 扩展同一个 Origin，避免服务端按来源拒绝
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
// 12s 而不是更长：在线失败时这段等待是压在追问朗读的关键路径上的，
// 正常响应在 1–2s，超过 12s 已属异常，早一点回落本地对用户更友好。
const DEFAULT_TIMEOUT_MS = 12000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 接口地址（测试可用 BOSSCLAW_EDGE_TTS_URL 指向本地 mock 服务器） */
function endpoint() {
  const override = String(process.env.BOSSCLAW_EDGE_TTS_URL || '').trim();
  return override || DEFAULT_ENDPOINT;
}

/** WebSocket 连接 id：32 位小写十六进制，无分隔符 */
function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Sec-MS-GEC：SHA256(token + Windows 文件时间片) 的大写十六进制。
 * 时间片的算法是 Edge 自己的口径：Unix 秒 + 11644473600 换算成 100ns 单位，再向下取整到 5 分钟。
 * @param {number} [nowMs] 可注入的时间（测试用；默认取当前时间）
 */
function secMsGec(nowMs) {
  const ms = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const ticks = (BigInt(Math.floor(ms / 1000)) + 11644473600n) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return crypto
    .createHash('sha256')
    .update(rounded.toString() + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** RFC1123 风格的 UTC 时间串（服务端只当字符串记，不做校验，但格式要对） */
function edgeTimestamp(nowMs) {
  const d = new Date(Number.isFinite(nowMs) ? Number(nowMs) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/** 组装带鉴权参数的 WebSocket URL */
function buildUrl(nowMs) {
  const q = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    'Sec-MS-GEC': secMsGec(nowMs),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
    ConnectionId: connectId(),
  });
  return `${endpoint()}?${q.toString()}`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 速度倍率（0.5–1.5）→ Edge prosody 的百分比节奏，如 0.9 → '-10%' */
function rateToProsody(speed) {
  const r = Math.max(0.5, Math.min(1.5, Number(speed) || 1));
  const pct = Math.round((r - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** 组装 SSML（文字已由渲染层做过朗读规范化，这里只做 XML 转义） */
function buildSsml({ text, voice, speed }) {
  const name = String(voice || '').trim() || DEFAULT_VOICE;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${escapeXml(name)}'>` +
    `<prosody pitch='+0Hz' rate='${rateToProsody(speed)}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;
}

/** config 帧：告诉服务端要 mp3、不要逐句/逐词边界事件 */
function configMessage(nowMs) {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });
  return `X-Timestamp:${edgeTimestamp(nowMs)}\r\nContent-Type:application/json; charset=utf-8\r\nPath:ssml\r\n\r\n${body}`;
}

function ssmlMessage({ requestId, ssml, nowMs }) {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${edgeTimestamp(nowMs)}\r\nPath:ssml\r\n\r\n${ssml}`;
}

/**
 * 解析一条二进制音频消息： [2 字节大端头长度][头文本][音频字节]。
 * 头里不是 Path:audio 就返回空（服务端偶尔会回别的元数据帧）。
 * @returns {{ audio: Buffer, header: string } | null}
 */
function parseAudioMessage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 2) return null;
  const headerLen = b.readUInt16BE(0);
  if (b.length < 2 + headerLen) return null;
  const header = b.subarray(2, 2 + headerLen).toString('utf8');
  if (!/Path:audio/.test(header)) return null;
  return { audio: b.subarray(2 + headerLen), header };
}

/**
 * 合成一句话，返回 mp3。
 * @param {{text:string, voice?:string, speed?:number, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, mp3:Buffer, bytes:number, ms:number, voice:string} | {ok:false, error:string}>}
 */
function synthesize(opts) {
  const text = String((opts && opts.text) || '').trim();
  if (!text) return Promise.resolve({ ok: false, error: '朗读文本为空' });
  const voice = String((opts && opts.voice) || '').trim() || DEFAULT_VOICE;
  const speed = Number(opts && opts.speed) || 1;
  const timeoutMs = Math.max(3000, Number(opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      resolve(result);
    };

    const Ctor = globalThis.WebSocket;
    if (typeof Ctor !== 'function') {
      resolve({ ok: false, error: '当前运行时没有 WebSocket（需要 Node 22+），在线语音不可用' });
      return;
    }

    let ws;
    try {
      ws = new Ctor(buildUrl(), {
        headers: {
          Origin: ORIGIN,
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
            `(KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`,
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (e) {
      resolve({ ok: false, error: `在线语音连接失败：${String((e && e.message) || e)}` });
      return;
    }
    ws.binaryType = 'arraybuffer';

    const timer = setTimeout(() => finish({ ok: false, error: `在线语音超时（${Math.round(timeoutMs / 1000)}s）` }), timeoutMs);
    const parts = [];
    let sawAudio = false;

    ws.onopen = () => {
      try {
        const now = Date.now();
        ws.send(configMessage(now));
        ws.send(ssmlMessage({ requestId: connectId(), ssml: buildSsml({ text, voice, speed }), nowMs: now }));
      } catch (e) {
        finish({ ok: false, error: `在线语音发送失败：${String((e && e.message) || e)}` });
      }
    };
    ws.onmessage = (ev) => {
      const data = ev && ev.data;
      if (typeof data === 'string') {
        if (/Path:turn\.end/.test(data)) {
          const mp3 = Buffer.concat(parts);
          if (!sawAudio || !mp3.length) finish({ ok: false, error: '在线语音未返回音频' });
          else finish({ ok: true, mp3, bytes: mp3.length, ms: Date.now() - started, voice });
        }
        return;
      }
      let buf = null;
      if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (data && typeof data.arrayBuffer === 'function') { /* Blob：理论上不会走到，binaryType 已设为 arraybuffer */ }
      else if (data) buf = Buffer.from(data);
      if (!buf) return;
      const parsed = parseAudioMessage(buf);
      if (parsed && parsed.audio.length) {
        sawAudio = true;
        parts.push(parsed.audio);
      }
    };
    ws.onerror = () => {
      // 具体状态码在 onclose；这里只标记，避免重复结算
    };
    ws.onclose = (ev) => {
      const code = ev && ev.code;
      finish({ ok: false, error: `在线语音连接中断（code ${code || '?'}）` });
    };
  });
}

module.exports = {
  synthesize,
  // 导出纯函数供离线断言（不触网）
  secMsGec,
  buildUrl,
  buildSsml,
  rateToProsody,
  parseAudioMessage,
  configMessage,
  ssmlMessage,
  DEFAULT_VOICE,
  _endpoint: endpoint,
};
