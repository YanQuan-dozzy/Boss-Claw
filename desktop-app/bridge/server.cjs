#!/usr/bin/env node
'use strict';
// OpenClaw 本地桥接服务（Node 跨平台版）
// 提供：状态、日报、控制（start/pause/stop/restore）、简历解析兜底（PDF→pdftotext、DOCX/旧版 DOC→mammoth/转档）
// 移植并适配自 job-claw-main\旧版本\学习逻辑\desktop-bridge\server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { execFile, execFileSync } = require('child_process');

// L-4：配置损坏不应让桥接进程崩溃（模块加载期 JSON.parse 无兜底）
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (e) {
  console.warn(`[OpenClaw bridge] 读取 config.json 失败，回退默认配置：${e.message}`);
  config = {};
}
const PORT = Number(config.port) || 18765;
const dataDir = path.join(os.homedir(), '.bossclaw');
const databasePath = path.join(dataDir, 'data.json');
fs.mkdirSync(dataDir, { recursive: true });

// ===========================================================================
// C-2 本地桥鉴权加固
// ---------------------------------------------------------------------------
// 原实现：令牌硬编码 `bossclaw-desktop-bridge`（config.json + 前端 bundle 三处同源）、
// 经 URL query 传递；respond() 反射任意 Origin。=> 用户机器上任意网页（含 origin=null 的
// 沙箱 iframe）都能读 /report 数据并下 /command 指令。
// 现改为：
//   1) 令牌启动时随机生成，写入仅本机可读的运行时文件 ~/.bossclaw/bridge-token（不入库）；
//      也接受环境变量 BOSSCLAW_BRIDGE_TOKEN 覆盖（由主进程 spawn 时注入，便于同源共享）。
//   2) 不再反射任意 Origin：只对白名单来源（null / localhost / 127.0.0.1）回显 CORS 头，
//      其余来源一律拒绝且不回 CORS 头（浏览器侧无法读取响应）。
//   3) 校验 Host 头（防 DNS rebinding：恶意域解析到 127.0.0.1 时 Host 仍是恶意域）。
//   4) 令牌支持请求头 X-Bossclaw-Token（首选，不落入日志/URL）；保留 query 仅为命令行调试。
// ===========================================================================
function resolveBridgeToken() {
  const fromEnv = String(process.env.BOSSCLAW_BRIDGE_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenPath = path.join(dataDir, 'bridge-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 不存在则生成 */ }
  const generated = crypto.randomBytes(24).toString('hex');
  try {
    // wx：独占创建，避免两个进程同时首次启动时互相覆写（EEXIST 时读回既有值）
    fs.writeFileSync(tokenPath, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch {
    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) return existing;
    } catch { /* 读回失败则退回本次生成（下次启动会再对齐） */ }
    return generated;
  }
}
const TOKEN = resolveBridgeToken();

/** 白名单来源：Electron file:// 渲染层（Origin: null）、本机 dev server（任意端口）。 */
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true; // 无 Origin（本机 CLI）与 file:// 渲染层
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Host 头白名单：仅接受 127.0.0.1:<port> / localhost:<port>，拦 DNS rebinding。 */
function isAllowedHost(hostHeader) {
  const h = String(hostHeader || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;
}

/** 常量时间令牌比较（避免时序侧信道）。 */
function tokenEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 请求携带的令牌：头 X-Bossclaw-Token 优先，query token 兜底（命令行调试用）。 */
function requestToken(request, requestUrl) {
  const fromHeader = String(request.headers['x-bossclaw-token'] || '').trim();
  if (fromHeader) return fromHeader;
  return String(requestUrl.searchParams.get('token') || '').trim();
}

function emptyDatabase() {
  return { events: [], commands: [], snapshots: [], control: { running: false, paused: false } };
}
function loadDatabase() {
  try {
    return { ...emptyDatabase(), ...JSON.parse(fs.readFileSync(databasePath, 'utf8')) };
  } catch {
    return emptyDatabase();
  }
}
function saveDatabase(database) {
  const tmp = `${databasePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(database, null, 2));
  fs.renameSync(tmp, databasePath);
}
function buildReport(database) {
  const today = new Date().toLocaleDateString('zh-CN');
  const events = database.events.filter((e) => new Date(e.ts).toLocaleDateString('zh-CN') === today);
  const sent = events.filter((e) => e.message === '投递成功');
  const failed = events.filter((e) => e.message === '投递失败');
  const analyzed = events.filter((e) => String(e.message || '').startsWith('岗位分析完成'));
  const lines = sent.slice(0, 30).map((e) => `- ${e.data?.job?.title || '岗位'}${e.data?.job?.company ? ` · ${e.data.job.company}` : ''}`);
  return [
    `BossClaw 求职日报｜${today}`, '', `成功沟通：${sent.length}`, `沟通失败：${failed.length}`,
    `岗位分析：${analyzed.length}`, `运行事件：${events.length}`, '',
    ...(lines.length ? lines : ['- 暂无成功沟通记录']), '', 'ByChris',
  ].join('\n');
}
function commandExists(command) {
  try { execFileSync(process.platform === 'win32' ? 'where' : '/usr/bin/which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
}
function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: options.timeout || 30000, maxBuffer: options.maxBuffer || 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
    });
  });
}
function normalizeResumeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/^\(null\)$/gm, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function readableResumeText(text) {
  const compact = String(text || '').replace(/\s/g, '');
  if (compact.length < 40) return false;
  const readable = (compact.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  const bad = (compact.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g) || []).length;
  const hints = (String(text).match(/简历|教育|经历|项目|技能|电话|邮箱|GitHub|工作|实习|resume|education|experience|skills/gi) || []).length;
  return (readable - bad) / compact.length >= 0.5 && (hints > 0 || compact.length >= 220);
}
function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s);
  if (!match) throw new Error('简历文件数据格式无效');
  return Buffer.from(match[2], 'base64');
}
async function parseResumePdf(payload) {
  const bytes = decodeDataUrl(payload.dataUrl);
  if (!bytes.length || bytes.length > 18 * 1024 * 1024) throw new Error('PDF 文件大小无效');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossclaw-resume-'));
  const filePath = path.join(tempDir, 'resume.pdf');
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  const candidates = [];
  const diagnostics = [];
  const record = (method, ok, detail = '') => diagnostics.push({ method, ok, detail: String(detail || '').slice(0, 240) });
  try {
    if (commandExists('pdftotext')) {
      try {
        const { stdout } = await runFile('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 50000 });
        const text = normalizeResumeText(stdout);
        const ok = readableResumeText(text);
        record('pdftotext', ok, ok ? `${text.length} 字` : '无可靠正文');
        if (ok) candidates.push({ ok: true, text, method: 'pdftotext' });
      } catch (error) { record('pdftotext', false, error.message); }
    } else record('pdftotext', false, '未安装');

    if (!candidates.length) return { ok: false, text: '', method: 'none', error: '本机解析与 OCR 均未识别到可靠正文（可安装 poppler 的 pdftotext 或改用 DOCX/TXT）', diagnostics };
    candidates.sort((a, b) => b.text.length - a.text.length);
    return { ...candidates[0], diagnostics };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function parseResumeDoc(payload) {
  const bytes = decodeDataUrl(payload.dataUrl);
  if (!bytes.length || bytes.length > 18 * 1024 * 1024) throw new Error('.doc 文件大小无效');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossclaw-resume-doc-'));
  const filePath = path.join(tempDir, 'resume.doc');
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  const diagnostics = [];
  const record = (method, ok, detail = '') => diagnostics.push({ method, ok, detail: String(detail || '').slice(0, 240) });
  try {
    const converted = await convertDocToDocx(filePath, tempDir, record);
    if (!converted) {
      return {
        ok: false, text: '', method: 'none',
        error: '本机未找到可用的 .doc 转档器（需装 Microsoft Word 或 LibreOffice）；请在 Word 中「另存为」DOCX/PDF/TXT 后重新导入，或直接复制粘贴正文',
        diagnostics,
      };
    }
    try {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(converted.path) });
      const text = normalizeResumeText(value);
      const ok = readableResumeText(text);
      record('mammoth', ok, ok ? `${text.length} 字` : '无可靠正文');
      if (ok) return { ok: true, text, method: converted.method, diagnostics };
    } catch (error) {
      record('mammoth', false, error.message);
    }
    return { ok: false, text: '', method: 'none', error: 'DOC 已转档但未提取到可靠正文，请改用 DOCX/PDF 或直接粘贴正文', diagnostics };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findSoffice() {
  return ['soffice', 'libreoffice', 'soffice.exe'].find((cmd) => commandExists(cmd)) || '';
}

/** 旧版 .doc → .docx 转档：先试 LibreOffice（跨平台），再试 Windows + Word COM（需装 Office） */
async function convertDocToDocx(filePath, tempDir, record) {
  const outDir = path.join(tempDir, 'conv');
  fs.mkdirSync(outDir, { recursive: true });
  const expected = path.join(outDir, `${path.basename(filePath).replace(/\.doc$/i, '')}.docx`);

  const soffice = findSoffice();
  if (soffice) {
    try {
      await runFile(soffice, ['--headless', '--norestore', '--convert-to', 'docx', '--outdir', outDir, filePath], { timeout: 90000 });
      if (fs.existsSync(expected)) {
        record('soffice', true, '转档成功');
        return { path: expected, method: 'doc-soffice' };
      }
      record('soffice', false, '未产出 docx');
    } catch (error) {
      record('soffice', false, error.message);
    }
  } else {
    record('soffice', false, '未安装');
  }

  if (process.platform === 'win32') {
    // 路径经 base64 传入，规避中文路径与引号在命令行中的转义问题（-EncodedCommand 同样为编码传递）
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const script = [
      // 注：以下各行以 ';' 拼接为**单行** PowerShell，故不可含 `#` 注释（会注释掉本行后续全部语句）。
      // M-6：AutomationSecurity=3（msoAutomationSecurityForceDisable）强制禁用宏，避免打开不受信 .doc 执行宏。
      "$ErrorActionPreference='Stop'",
      `$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(filePath)}'))`,
      `$dst=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(expected)}'))`,
      '$w=New-Object -ComObject Word.Application',
      '$w.Visible=$false',
      '$w.DisplayAlerts=0',
      '$w.AutomationSecurity=3',
      'try{$d=$w.Documents.Open($src,$false,$true,$false);$d.SaveAs2($dst,12);$d.Close(0)}finally{$w.Quit()}',
    ].join(';');
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 90000 });
      if (fs.existsSync(expected)) {
        record('word-com', true, '转档成功');
        return { path: expected, method: 'doc-word-com' };
      }
      record('word-com', false, '未产出 docx');
    } catch (error) {
      record('word-com', false, error.message);
    }
  } else {
    record('word-com', false, '仅 Windows 可用');
  }
  return null;
}

async function parseResumeText(payload) {
  if (!payload || !payload.dataUrl) throw new Error('缺少简历数据');
  const name = String(payload.name || '').toLowerCase();
  const isTxt = name.endsWith('.txt') || name.endsWith('.md');
  const isDocx = name.endsWith('.docx');
  const isDoc = name.endsWith('.doc');
  if (isTxt) {
    const text = normalizeResumeText(decodeDataUrl(payload.dataUrl).toString('utf8'));
    return { ok: readableResumeText(text), text, method: 'text' };
  }
  if (isDocx) {
    try {
      const mammoth = require('mammoth');
      const buffer = decodeDataUrl(payload.dataUrl);
      const { value } = await mammoth.extractRawText({ buffer });
      const text = normalizeResumeText(value);
      return { ok: readableResumeText(text), text, method: 'mammoth' };
    } catch (error) {
      return { ok: false, text: '', method: 'none', error: `DOCX 解析失败（需安装 mammoth 或改用 PDF/TXT）：${error.message}` };
    }
  }
  if (isDoc) {
    try {
      return await parseResumeDoc(payload);
    } catch (error) {
      return { ok: false, text: '', method: 'none', error: `DOC 解析失败（可改用 DOCX/PDF/TXT）：${error.message}` };
    }
  }
  return parseResumePdf(payload);
}

function respond(response, status, payload, origin, allowed) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (allowed) {
    // 仅对白名单来源回显 CORS 头（不再反射任意 Origin）
    headers['Access-Control-Allow-Origin'] = origin || 'null';
    headers['Access-Control-Allow-Headers'] = 'content-type, x-bossclaw-token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Private-Network'] = 'true';
    headers['Vary'] = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const origin = request.headers.origin || '';
  const allowed = isAllowedOrigin(origin);
  const reply = (status, payload) => respond(response, status, payload, origin, allowed);
  // Host 校验（DNS rebinding 防御）→ Origin 白名单 → 令牌（常量时间比较）
  if (!isAllowedHost(request.headers.host)) return reply(403, { ok: false, error: 'host denied' });
  if (!allowed) return reply(403, { ok: false, error: 'origin denied' });
  if (request.method === 'OPTIONS') return reply(200, {});
  if (!tokenEqual(requestToken(request, requestUrl), TOKEN)) return reply(403, { ok: false, error: 'token denied' });

  let body = '';
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return; // 已超限则丢弃后续数据，避免无限累积（内存放大）
    body += chunk;
    if (Buffer.byteLength(body) > 28 * 1024 * 1024) { tooLarge = true; body = ''; }
  });
  request.on('end', async () => {
    if (tooLarge) return reply(413, { ok: false, error: 'request too large' });
    try {
      const database = loadDatabase();
      const payload = body ? JSON.parse(body) : {};
      if (requestUrl.pathname === '/status') {
        return reply(200, {
          ok: true, name: 'bossclaw-bridge', version: '2.0.0', running: database.control.running, paused: database.control.paused,
          parsers: { pdftotext: commandExists('pdftotext'), soffice: findSoffice() || false, wordCom: process.platform === 'win32' },
          databasePath, events: database.events.length,
        });
      }
      if (requestUrl.pathname === '/logs') {
        // 桥接日志查看：最近的指令与事件（时间倒序，各最多 50 条）
        const commands = (database.commands || []).slice(-50).reverse();
        const events = (database.events || []).slice(-50).reverse();
        return reply(200, { ok: true, commands, events });
      }
      if (requestUrl.pathname === '/report') {
        return reply(200, { ok: true, report: buildReport(database) });
      }
      if (requestUrl.pathname === '/command') {
        const type = String(payload.type || 'status');
        if (type === 'start') { database.control.running = true; database.control.paused = false; }
        else if (type === 'pause') { database.control.paused = true; }
        else if (type === 'stop') { database.control.running = false; database.control.paused = false; }
        else if (type === 'restore') {
          const snapshot = database.snapshots.at(-1);
          return reply(200, { ok: true, snapshot: snapshot || null });
        }
        // L-3：commands 无上限会令 data.json 持续膨胀 → 仅保留最近 500 条
        database.commands.push({ type, ts: Date.now() });
        if (database.commands.length > 500) database.commands = database.commands.slice(-500);
        saveDatabase(database);
        return reply(200, { ok: true, control: database.control });
      }
      if (requestUrl.pathname === '/ocr') {
        try {
          const result = await parseResumePdf(payload);
          return reply(200, result);
        } catch (error) {
          return reply(200, { ok: false, error: error.message });
        }
      }
      if (requestUrl.pathname === '/resume-text') {
        try {
          const result = await parseResumeText(payload);
          return reply(200, result);
        } catch (error) {
          return reply(200, { ok: false, error: error.message });
        }
      }
      return reply(404, { ok: false, error: 'not found' });
    } catch (error) {
      return reply(500, { ok: false, error: error.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[OpenClaw bridge] listening on 127.0.0.1:${PORT}`);
});
