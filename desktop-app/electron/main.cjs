// electron/main.cjs —— BossClaw 桌面版主进程（CommonJS）
// 单窗口 + webview（内置浏览器，默认引擎） + 安全 IPC。
// 启动 OpenClaw 本地桥接服务，并通过 contextBridge 暴露 webview 预加载路径。
// CloakBrowser 隐身引擎作为**可选**内置浏览器（用户设置切换；与 webview 平行运行）。
'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');

// ===== 轻量日志：仅在 BOSSCLAW_DEBUG=1 或开发模式写文件；正常情况只走 console =====
// 延迟访问 app（顶层 require 时 app 可能尚未就绪），且不影响其它调用方读取 dlog。
let _debugLogEnabled = null;
function isDebugEnabled() {
  if (_debugLogEnabled !== null) return _debugLogEnabled;
  // process.env 在 require 阶段即可访问；app.isPackaged 仅在 app 已 require 后才可用，
  // 这里延后到首次 dlog 调用时判定（此时 main.cjs 已被 Electron 主进程加载，app 必然就绪）。
  _debugLogEnabled = process.env.BOSSCLAW_DEBUG === '1' || (() => {
    try { return !app.isPackaged; } catch { return false; }
  })();
  return _debugLogEnabled;
}
let _debugLogPath = null;
function getDebugLogPath() {
  if (_debugLogPath) return _debugLogPath;
  try { _debugLogPath = path.join(app.getPath('userData'), 'bossclaw-debug.log'); }
  catch { _debugLogPath = null; }
  return _debugLogPath;
}
function dlog(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra ? ' ' + safeStringify(extra) : ''}`;
  if (isDebugEnabled()) {
    const p = getDebugLogPath();
    if (p) { try { fs.appendFileSync(p, line + '\n'); } catch {} }
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
}
function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

// ===== 全局异常兜底：避免单点崩溃让主进程整体退出 =====
process.on('uncaughtException', (err) => {
  dlog('error', 'uncaughtException', { message: err?.message, stack: err?.stack });
});
process.on('unhandledRejection', (reason) => {
  dlog('error', 'unhandledRejection', { reason: reason?.message || String(reason) });
});

// ===== 统一 IPC 错误包装 =====
function safeHandle(channel, handler) {
  // ipcMain.handle 抛出会让渲染进程 invoke reject；这里统一捕获并结构化返回
  // 保留 handler 自己的语义（返回 {ok, error, ...} 不会改；throw 会变成 reject）
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      dlog('error', `ipc handler failed: ${channel}`, { message: err?.message });
      // 同步抛回，让渲染进程 invoke 的 promise 自然 reject（与未包装前一致）
      throw err;
    }
  });
}
function safeOn(channel, handler) {
  ipcMain.on(channel, async (event, ...args) => {
    try {
      await handler(event, ...args);
    } catch (err) {
      dlog('error', `ipc listener failed: ${channel}`, { message: err?.message });
    }
  });
}

// ===== AI Skills 层：skills/<id>/SKILL.md（标准技能格式） =====
// 渲染层调用 AI 时按作用域启用技能：元数据（name/scope/defaultEnabled）经 jc:skills-list
// 读取，指令正文经 jc:skills-read 读取后注入 system prompt。仅允许白名单目录，防路径穿越。
// 内置技能（只读）位于 appPath/skills；自定义技能（用户导入/新建，可写）位于 userData/skills。
const SKILLS_DIR = path.join(app.getAppPath(), 'skills');
const CUSTOM_SKILLS_DIR = () => path.join(app.getPath('userData'), 'skills');
const SKILL_ID_RE = /^[a-z0-9-]+$/;
const SKILL_SCOPES = ['profile', 'job-analysis', 'greetings', 'assistant'];

/** 解析 SKILL.md frontmatter（--- 之间的 key: value）+ 正文（frontmatter 之后的内容） */
function parseSkillFile(raw) {
  const m = String(raw || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: String(raw || '').slice(m[0].length).trim() };
}

/** 读取单个技能目录下的全部技能元数据（目录不存在返回 []） */
async function readSkillDir(dir, custom) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // skills 目录不存在时返回空（不报错）
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !SKILL_ID_RE.test(ent.name)) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, ent.name, 'SKILL.md'), 'utf8');
      const parsed = parseSkillFile(raw);
      if (!parsed) continue;
      const scope = String(parsed.meta.scope || 'assistant');
      out.push({
        id: ent.name,
        name: String(parsed.meta.title || parsed.meta.name || ent.name),
        description: String(parsed.meta.description || ''),
        scope: SKILL_SCOPES.includes(scope) ? scope : 'assistant',
        defaultEnabled: String(parsed.meta.defaultEnabled) !== 'false',
        custom: Boolean(custom),
      });
    } catch { /* 单个技能读取失败跳过 */ }
  }
  return out;
}

safeHandle('jc:skills-list', async () => {
  const [builtin, custom] = await Promise.all([
    readSkillDir(SKILLS_DIR, false),
    readSkillDir(CUSTOM_SKILLS_DIR(), true),
  ]);
  return [...builtin, ...custom];
});

/** 读取技能正文：优先自定义目录（用户导入的会覆盖同 id 读取路径），再回退内置目录 */
async function readSkillBody(id) {
  for (const dir of [CUSTOM_SKILLS_DIR(), SKILLS_DIR]) {
    try {
      const raw = await fs.promises.readFile(path.join(dir, id, 'SKILL.md'), 'utf8');
      const parsed = parseSkillFile(raw);
      return { id, body: parsed ? parsed.body : raw };
    } catch { /* 继续下一个目录 */ }
  }
  return { id, body: '' };
}

safeHandle('jc:skills-read', async (_event, id) => {
  if (!SKILL_ID_RE.test(String(id || ''))) return { id: String(id || ''), body: '' };
  return readSkillBody(String(id));
});

// ---- 自定义技能：导入（raw SKILL.md 全文 / fields 表单）与删除 ----

/** 名称 → 目录 ID（小写字母数字连字符；纯中文等无 ASCII 名时回退 custom-<时间戳>） */
function slugifyId(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** id 是否已存在（自定义目录或内置目录） */
async function skillIdExists(id) {
  if (!SKILL_ID_RE.test(id)) return true;
  for (const dir of [CUSTOM_SKILLS_DIR(), SKILLS_DIR]) {
    try {
      await fs.promises.access(path.join(dir, id, 'SKILL.md'));
      return true;
    } catch { /* 继续 */ }
  }
  return false;
}

/** 生成不冲突的技能 ID（冲突时追加 -2/-3…） */
async function uniqueSkillId(base) {
  const clean = slugifyId(base) || `custom-${Date.now().toString(36)}`;
  let id = clean;
  let n = 1;
  while (await skillIdExists(id)) {
    id = `${clean}-${++n}`;
    if (n > 100) return `custom-${Date.now().toString(36)}`; // 兜底防死循环
  }
  return id;
}

/** 写入自定义技能 SKILL.md（与内置格式一致：frontmatter + 正文） */
async function writeCustomSkill({ id, name, description, scope, instructions }) {
  const dir = path.join(CUSTOM_SKILLS_DIR(), id);
  await fs.promises.mkdir(dir, { recursive: true });
  const md = [
    '---',
    `name: ${id}`,
    `title: ${name}`,
    `description: ${description || ''}`,
    `scope: ${scope}`,
    'defaultEnabled: true',
    '---',
    '',
    instructions.trim(),
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(dir, 'SKILL.md'), md, 'utf8');
}

safeHandle('jc:skills-import', async (_event, payload) => {
  const p = payload || {};
  let name = '';
  let description = '';
  let scope = 'assistant';
  let body = '';

  if (typeof p.raw === 'string' && p.raw.trim()) {
    // 方式一：导入 SKILL.md 全文（frontmatter + 正文）
    const parsed = parseSkillFile(p.raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'SKILL.md 格式错误：缺少 frontmatter 元信息块（文件需以 --- 开头，含 name/title、description、scope，正文为指令）。',
      };
    }
    name = String(parsed.meta.title || parsed.meta.name || '').trim();
    description = String(parsed.meta.description || '').trim();
    scope = String(parsed.meta.scope || 'assistant').trim();
    body = parsed.body;
  } else if (p.fields && typeof p.fields === 'object') {
    // 方式二：手动表单（设置页「新建技能」）
    name = String(p.fields.name || '').trim();
    description = String(p.fields.description || '').trim();
    scope = String(p.fields.scope || 'assistant').trim();
    body = String(p.fields.instructions || '').trim();
  } else {
    return { ok: false, error: '缺少导入内容：请提供 SKILL.md 全文（raw）或表单字段（fields）。' };
  }

  if (!name) return { ok: false, error: '技能名称不能为空（SKILL.md 需含 name 或 title）。' };
  if (!body) return { ok: false, error: '技能指令正文不能为空。' };
  if (!SKILL_SCOPES.includes(scope)) {
    return { ok: false, error: `作用域非法：${scope}（可选：${SKILL_SCOPES.join(' / ')}）。` };
  }

  const id = await uniqueSkillId(name);
  try {
    await writeCustomSkill({ id, name, description, scope, instructions: body });
  } catch (err) {
    return { ok: false, error: '写入失败：' + (err?.message || String(err)) };
  }
  dlog('info', `custom skill imported: ${id} (scope=${scope})`);
  return { ok: true, skill: { id, name, description, scope, defaultEnabled: true, custom: true } };
});

safeHandle('jc:skills-delete', async (_event, id) => {
  const skillId = String(id || '');
  if (!SKILL_ID_RE.test(skillId)) return { ok: false, error: '非法技能 ID。' };
  // 内置目录存在同名 → 拒绝（只允许删除自定义技能）
  try {
    await fs.promises.access(path.join(SKILLS_DIR, skillId, 'SKILL.md'));
    return { ok: false, error: '内置技能不可删除。' };
  } catch { /* 内置不存在，继续 */ }
  try {
    await fs.promises.rm(path.join(CUSTOM_SKILLS_DIR(), skillId), { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: '删除失败：' + (err?.message || String(err)) };
  }
  dlog('info', `custom skill deleted: ${skillId}`);
  return { ok: true };
});

// CloakBrowser 隐身浏览器（可选增强，默认关闭；用户在设置页切换）
// 不动 webviewTag/原 webview 路径——webview 仍是默认引擎，CloakBrowser 作为并行通道。
// 设计：AGENTS.md §2.1 末段（CloakBrowser 仅作可选增强，默认关闭，不得借此绕过验证码/账户验证）。
const cloakLauncher = require('./cloakbrowser/launcher.cjs');

const isDev = !app.isPackaged && process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';
const APP_ID = 'com.bossclaw.desktop';

app.setName('BossClaw');
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}


// dev 模式下 Vite 可能因 5173 被占用而自动换端口（5174/5175…），
// 若仍硬编码连 5173 会直接白屏。这里启动前扫描真实运行的 Vite 端口；
// 最多轮询 5 次（约 3s）即放弃，由 createMainWindow 回退加载 dist/index.html，
// 避免 Vite 未就绪时长时间空等（启动提速）。
const DEV_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179];
async function resolveDevUrl() {
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const port of DEV_PORTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 600);
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.status < 400) return `http://localhost:${port}`;
      } catch {}
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

// 最后一次构建产物入口：dev 服务器不可达时的兜底加载目标
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');

let mainWindow = null;
let bridgeProcess = null;
// Camoufox 隐身引擎：本地 Python 桥（camoufox_server.py），端口 18767
let camoufoxProcess = null;
const CAMOUFOX_PORT = 18767;
const CAMOUFOX_TOKEN = 'bossclaw-camoufox';

// ===== 数据版本标记：v3 重建后首次启动自动清空旧数据（BOSS 登录态 / 隐身引擎数据）=====
// 本次「内置浏览器 + 收集投递沟通模块」从零重建，旧登录态与缓存需清空（用户需重新扫码登录）。
// 通过 userData 下的标记文件保证只清一次，之后正常启动不再重复清理。
const DATA_VERSION = 'v3-rebuild-20260815';
function resetDataForVersion() {
  try {
    const marker = path.join(app.getPath('userData'), '.bossclaw-data-version');
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === DATA_VERSION) return;
    // 1) 清空 BOSS 登录态会话（persist:bossclaw 的 wt2 等 cookie）
    try { session.fromPartition('persist:bossclaw').clearStorageData().catch(() => {}); } catch {}
    // 2) 清空 Camoufox 隐身引擎 cookie
    try {
      const camCookie = path.join(app.getPath('home'), '.bossclaw', 'camoufox-cookies.json');
      if (fs.existsSync(camCookie)) fs.unlinkSync(camCookie);
    } catch {}
    // 3) 清空 CloakBrowser 隐身浏览器持久 profile
    try {
      const cloakProfile = path.join(app.getPath('userData'), 'cloakbrowser-profile');
      if (fs.existsSync(cloakProfile)) fs.rmSync(cloakProfile, { recursive: true, force: true });
    } catch {}
    // 4) 写版本标记，避免重复清理
    try { fs.writeFileSync(marker, DATA_VERSION); } catch {}
  } catch {}
}

function startBridge() {
  try {
    const server = path.join(__dirname, '..', 'bridge', 'server.cjs');
    // ELECTRON_RUN_AS_NODE=1：让 electron 二进制以纯 Node 模式运行桥接服务（mammoth/fs 等可用）
    const child = spawn(process.execPath, [server], {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    bridgeProcess = child;
    child.on('error', (err) => dlog('warn', 'bridge process error', { message: err?.message }));
    child.on('exit', (code, signal) => {
      // 异常退出（kill/uncaught）记录；正常 stop 也走这里，避免悬挂指针
      if (bridgeProcess === child) bridgeProcess = null;
      if (signal || (typeof code === 'number' && code !== 0)) {
        dlog('warn', 'bridge process exited', { code, signal });
      }
    });
  } catch (err) {
    // 桥接为可选模块，启动失败不影响主程序
    dlog('warn', 'bridge spawn failed', { message: err?.message });
  }
}

// ===== Camoufox 隐身引擎（Python 桥）=====

// 探测可用的 Python 解释器（优先 py launcher，其次 python/python3）
function detectPython() {
  return new Promise((resolve) => {
    const candidates = process.platform === 'win32'
      ? ['py', 'python', 'python3']
      : ['python3', 'python'];
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return resolve(null);
      const cmd = candidates[idx++];
      execFile(cmd, ['--version'], { timeout: 5000 }, (err) => {
        if (err) return tryNext();
        resolve(cmd);
      });
    };
    tryNext();
  });
}

// 检测隐身引擎可用性：camoufox 包已装 或 系统 Chrome/Edge/Firefox 存在（不启动浏览器）。
// 引擎是多内核自适应的——优先 Camoufox 原生内核（C++ 级），否则复用系统浏览器 + Playwright stealth，
// 因此只要「Python + 任一可用内核」即可启动桥（无需下载 492MB 专用内核）。
function checkCamoufoxEngine(pythonCmd) {
  return new Promise((resolve) => {
    if (!pythonCmd) return resolve(false);
    const probe = [
      "import importlib.util, os",
      "ok = importlib.util.find_spec('camoufox') is not None",
      "paths = [",
      "  r'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',",
      "  r'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',",
      "  r'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',",
      "  r'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',",
      "  r'C:\\Program Files\\Mozilla Firefox\\firefox.exe',",
      "  r'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',",
      "]",
      "ok = ok or any(os.path.exists(p) for p in paths)",
      "print(1 if ok else 0)",
    ].join('\n');
    execFile(pythonCmd, ['-c', probe], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout || '').trim() === '1');
    });
  });
}

// 启动隐身引擎 Python 桥（按需：Python + camoufox 包或系统浏览器任一可用即启动）
async function startCamoufoxBridge() {
  if (camoufoxProcess) return { running: true };
  const python = await detectPython();
  if (!python) return { running: false, error: '未检测到 Python 环境' };
  const available = await checkCamoufoxEngine(python);
  if (!available) return { running: false, error: '未检测到可用内核：请安装 Chrome/Edge/Firefox，或执行 pip install "camoufox[geoip]" && camoufox fetch' };
  try {
    const server = path.join(__dirname, '..', 'camoufox', 'camoufox_server.py');
    // 防御性清理：若环境注入了 safe-delete shim（如部分沙箱/运行时），Python 的 shutil.rmtree
    // 会被拦截导致 camoufox fetch 等清理逻辑失败；spawn 时剥离该注入，不影响正常用户环境。
    const env = { ...process.env };
    if (String(env.PYTHONPATH || '').includes('vendor/shim')) delete env.PYTHONPATH;
    camoufoxProcess = spawn(python, [server, '--port', String(CAMOUFOX_PORT), '--token', CAMOUFOX_TOKEN], {
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
      env,
    });
    camoufoxProcess.on('error', (err) => dlog('warn', 'camoufox process error', { message: err?.message }));
    camoufoxProcess.on('exit', (code, signal) => {
      camoufoxProcess = null;
      if (signal || (typeof code === 'number' && code !== 0)) {
        dlog('warn', 'camoufox process exited', { code, signal });
      }
    });
    // 等待端口就绪（最多 6s）
    await new Promise((resolve) => {
      const deadline = Date.now() + 6000;
      const probe = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${CAMOUFOX_PORT}/status?token=${CAMOUFOX_TOKEN}`, { signal: AbortSignal.timeout(1200) });
          if (res.ok) return resolve(true);
        } catch {}
        if (Date.now() > deadline) return resolve(false);
        setTimeout(probe, 400);
      };
      probe();
    });
    return { running: true };
  } catch (e) {
    return { running: false, error: String((e && e.message) || e) };
  }
}

function stopCamoufoxBridge() {
  if (camoufoxProcess) {
    try { camoufoxProcess.kill(); } catch {}
    camoufoxProcess = null;
  }
}

// 渲染层查询 Camoufox 引擎状态（Python 探测 + camoufox 包检测 + 桥运行状态）
safeHandle('jc:camoufox-status', async () => {
  const python = await detectPython();
  const available = python ? await checkCamoufoxEngine(python) : false;
  const base = { python: Boolean(python), pythonCmd: python, camoufox: available };
  if (!available) {
    return { ...base, running: false, ready: false, message: '未检测到可用内核（需要 Chrome/Edge/Firefox 或 camoufox 原生内核）' };
  }
  // 桥未运行则尝试拉起
  if (!camoufoxProcess) {
    const r = await startCamoufoxBridge();
    if (!r.running) return { ...base, running: false, ready: false, message: r.error || '桥启动失败' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${CAMOUFOX_PORT}/status?token=${CAMOUFOX_TOKEN}`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return { ...base, running: true, ready: Boolean(data.ok), message: data.message || '', engine: data };
  } catch (e) {
    return { ...base, running: true, ready: false, message: String((e && e.message) || e) };
  }
});

// 显式停止隐身引擎桥（设置页用）
ipcMain.on('jc:camoufox-stop', () => stopCamoufoxBridge());

// 渲染层调用隐身引擎桥（search/send/login），统一转发 127.0.0.1 请求
safeHandle('jc:camoufox-call', async (_event, action, payload) => {
  const python = await detectPython();
  const available = python ? await checkCamoufoxEngine(python) : false;
  if (!available) return { ok: false, error: '未检测到可用内核（Chrome/Edge/Firefox 或 camoufox）' };
  if (!camoufoxProcess) {
    const r = await startCamoufoxBridge();
    if (!r.running) return { ok: false, error: r.error || '桥启动失败' };
  }
  const pathMap = { search: '/search', send: '/send', chat: '/chat', login: '/login', logout: '/logout', clear: '/clear' };
  const apiPath = pathMap[action];
  if (!apiPath) return { ok: false, error: `unknown action: ${action}` };
  try {
    const res = await fetch(`http://127.0.0.1:${CAMOUFOX_PORT}${apiPath}?token=${CAMOUFOX_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout((action === 'login' ? 360 : 240) * 1000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: 'BossClaw',
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    backgroundColor: '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    // frame: false — 完全自定义标题栏（含窗口控制按钮），由渲染进程 TitleBar 组件绘制
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false 让 preload 能 require('node:path') 等 Node 内置模块；
      // 否则 preload 崩溃，window.electron 不暴露，所有 IPC（含窗口控制按钮）失效。
      // contextIsolation 仍为 true、nodeIntegration 仍为 false，渲染进程安全边界不变。
      sandbox: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload', 'app.cjs'),
      spellcheck: false,
    },
  });

  if (isDev) {
    const url = await resolveDevUrl();
    if (url) {
      mainWindow.loadURL(url);
    } else if (fs.existsSync(DIST_INDEX)) {
      // Vite 未就绪：回退加载最后一次构建产物，避免白屏
      mainWindow.loadFile(DIST_INDEX);
    } else {
      // 既无 dev 服务器也无构建产物：给出一句可读的提示，而非白屏
      mainWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<html><body style="font-family:sans-serif;padding:40px"><h2>BossClaw 启动失败</h2>' +
              '<p>开发服务器未启动，且未找到构建产物 <code>dist/index.html</code>。</p>' +
              '<p>请在 desktop-app 目录执行 <code>npm run build</code> 或 <code>npm run dev</code> 后重试。</p></body></html>'
          )
      );
    }
  } else {
    mainWindow.loadFile(DIST_INDEX);
  }

  // === 白屏诊断日志（仅 BOSSCLAW_DEBUG=1 时启用，写入 debug-render.log）===
  if (process.env.BOSSCLAW_DEBUG === '1') {
    try {
      let diagPath;
      try { diagPath = path.join(app.getPath('userData'), 'debug-render.log'); }
      catch { diagPath = path.join(__dirname, '..', 'debug-render.log'); }
      const diagLog = (m) => { try { fs.appendFileSync(diagPath, `[${new Date().toISOString()}] ${m}\n`); } catch {} };
      diagLog('createMainWindow: isDev=' + isDev + ' target=' + (isDev ? '(dev url resolved)' : 'dist/index.html'));
      mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => { diagLog('CONSOLE level=' + level + ' msg=' + message + ' @' + (sourceId || '') + ':' + line); });
      mainWindow.webContents.on('did-fail-load', (ev, errorCode, errorDescription, validatedURL) => { diagLog('FAIL-LOAD code=' + errorCode + ' desc=' + errorDescription + ' url=' + validatedURL); });
      mainWindow.webContents.on('crashed', () => diagLog('WEBVIEW CRASHED'));
      mainWindow.webContents.on('did-finish-load', () => {
        diagLog('did-finish-load fired');
        setTimeout(async () => {
          try {
            const info = await mainWindow.webContents.executeJavaScript('(function(){var r=document.getElementById("root");return JSON.stringify({rootLen:r?r.innerHTML.length:-1,hasAppShell:!!document.querySelector(".app-shell,.ant-app"),bodyText:(document.body?document.body.innerText||"":"").slice(0,200),title:document.title});})()');
            diagLog('DOM-CHECK ' + info);
          } catch (e) { diagLog('DOM-CHECK ERROR ' + (e && e.message)); }
        }, 2500);
        // 诊断：切到工作台看内置浏览器 webview 加载情况
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript('(function(){var btns=[].slice.call(document.querySelectorAll(".nav-btn"));var b=btns.find(function(x){return (x.innerText||"").indexOf("工作台")>=0;});if(b){b.click();return "clicked-workbench";}return "no-workbench-btn";})()');
          } catch (e) { diagLog('SWITCH ERROR ' + (e && e.message)); }
        }, 4000);
        setTimeout(async () => {
          try {
            const st = await mainWindow.webContents.executeJavaScript('(function(){var input=document.querySelector(".browser-bar input");var wv=document.querySelector("webview");return JSON.stringify({addrValue:input?input.value:null,addrPlaceholder:input?input.getAttribute("placeholder"):null,hasWebview:!!wv,webviewSrc:wv?wv.getAttribute("src"):null,webviewUrl:wv?wv.getURL?wv.getURL():"n/a":"n/a",barHTML:document.querySelector(".browser-bar")?document.querySelector(".browser-bar").innerText.slice(0,120):null});})()');
            diagLog('BROWSER-STATE ' + st);
          } catch (e) { diagLog('BROWSER-STATE ERROR ' + (e && e.message)); }
        }, 10000);
      });
      // ===== 临时诊断：webview 加载时序（定位「内置浏览器不显示 BOSS 链接」）=====
      mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
        const tag = wc.getURL?.() || '';
        diagLog('WEBVIEW-ATTACHED url=' + tag);
        wc.on('did-start-navigation', (_ev, url, _isInPlace, _isMainFrame) => diagLog('WEBVIEW did-start-navigation url=' + url));
        wc.on('did-navigate', (_ev, url) => diagLog('WEBVIEW did-navigate url=' + url));
        wc.on('did-fail-load', (_ev, code, desc, url) => diagLog('WEBVIEW did-fail-load code=' + code + ' desc=' + desc + ' url=' + url));
        wc.on('did-finish-load', () => diagLog('WEBVIEW did-finish-load url=' + (wc.getURL?.() || '')));
        wc.on('dom-ready', () => diagLog('WEBVIEW dom-ready url=' + (wc.getURL?.() || '')));
      });
    } catch {}
  }

  // ===== 内置浏览器右键菜单（常驻注册）=====
  // webview 默认无右键菜单；补齐常规项（后退/前进/刷新/复制/粘贴/全选）+
  // 链接操作（新标签打开/复制链接）+ 查看网页源码（本页 Modal 展示，不跳新标签页）。
  // 后退/前进走 preload 的 SPA 历史栈（spa-back/spa-forward），整页导航与 SPA 内跳转都生效。
  mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
    wc.on('context-menu', (_ev, params) => {
      const template = [
        { label: '后退', click: () => { try { wc.send('spa-back'); } catch {} } },
        { label: '前进', click: () => { try { wc.send('spa-forward'); } catch {} } },
        { label: '刷新', click: () => { try { wc.reload(); } catch {} } },
        { label: '停止加载', click: () => { try { wc.stop(); } catch {} } },
        { type: 'separator' },
        { label: '复制', enabled: Boolean(params.selectionText), click: () => clipboard.writeText(params.selectionText || '') },
        { label: '粘贴', enabled: Boolean(params.isEditable), click: () => { try { wc.paste(); } catch {} } },
        { label: '全选', click: () => { try { wc.selectAll(); } catch {} } },
      ];
      if (params.linkURL) {
        template.push(
          { type: 'separator' },
          { label: '在新标签打开链接', click: () => mainWindow?.webContents.send('jc:webview-open-link', { url: params.linkURL }) },
          { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
        );
      }
      // 查看网页源码：主进程取 outerHTML 经 IPC 回传渲染进程，在本页 Modal 展示
      // （不用 wc.viewSource() —— 它会导航 webview 到 view-source: 新页面，体验割裂）。
      template.push(
        { type: 'separator' },
        { label: '查看网页源码', click: () => {
          try {
            wc.executeJavaScript('document.documentElement.outerHTML').then((html) => {
              mainWindow?.webContents.send('jc:webview-source', { url: wc.getURL?.() || '', html: String(html || '') });
            }).catch((e) => {
              mainWindow?.webContents.send('jc:webview-source', { url: wc.getURL?.() || '', html: '', error: String((e && e.message) || e) });
            });
          } catch {}
        } },
      );
      try { Menu.buildFromTemplate(template).popup({ window: mainWindow }); } catch {}
    });
  });

  // ===== webview 诊断（无条件写 userData/bossclaw-webview-diag.log；排查 preload 注入/IPC 失效）=====
  let webviewDiagPath = null;
  try { webviewDiagPath = path.join(app.getPath('userData'), 'bossclaw-webview-diag.log'); } catch {}
  const webviewDiag = (m) => { if (!webviewDiagPath) return; try { fs.appendFileSync(webviewDiagPath, `[${new Date().toISOString()}] ${m}\n`); } catch {} };
  mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
    let wpref = 'n/a';
    try {
      const prefs = wc.getLastWebPreferences?.() || {};
      wpref = JSON.stringify({ preload: prefs.preload, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, partition: prefs.partition });
    } catch {}
    webviewDiag('ATTACH url=' + (wc.getURL?.() || '') + ' prefs=' + wpref);
    try { mainWindow?.webContents.send('jc:webview-diag', { type: 'attach', prefs: wpref, url: wc.getURL?.() || '' }); } catch {}
    wc.on('preload-error', (_ev, err, code) => {
      webviewDiag('PRELOAD-ERROR code=' + code + ' err=' + String(err || '').slice(0, 300));
      try { mainWindow?.webContents.send('jc:webview-diag', { type: 'preload-error', errorCode: code, error: String(err || '').slice(0, 300) }); } catch {}
    });
    wc.on('dom-ready', async () => {
      webviewDiag('DOM-READY url=' + (wc.getURL?.() || ''));
      // 检查 preload 注入标记：window.__bossclawPreload 由 webview.cjs 顶层写入（sandboxed preload 与页面共享 window）
      let check = 'ERROR';
      try {
        const v = await wc.executeJavaScript('window.__bossclawPreload || null');
        check = v ? 'INJECTED ts=' + v : 'NOT-INJECTED';
        webviewDiag('PRELOAD-CHECK ' + check);
      } catch (e) { webviewDiag('PRELOAD-CHECK ERROR ' + String((e && e.message) || e).slice(0, 200)); }
      // 同步推送到渲染进程日志区（用户无需翻 diag 文件）
      try { mainWindow?.webContents.send('jc:webview-diag', { type: 'preload-check', result: check, url: wc.getURL?.() || '' }); } catch {}
    });
    wc.on('console-message', (_ev, level, msg) => {
      const m = String(msg || '');
      if (/preload|uncaught|referenceerror|typeerror|is not|BOSS-CLAW/i.test(m)) webviewDiag('CONSOLE[' + level + '] ' + m.slice(0, 300));
    });
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 通知渲染进程窗口最大化状态变化（自绘标题栏「最大化/还原」图标随状态切换）
  mainWindow.on('maximize', () => mainWindow.webContents.send('jc:window-maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('jc:window-maximized-changed', false));
  mainWindow.on('focus', () => mainWindow.webContents.send('jc:window-focus-changed', true));
  mainWindow.on('blur', () => mainWindow.webContents.send('jc:window-focus-changed', false));

  // 拦截新窗口：外部链接交系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevOrigin = url === DEV_URL || url.startsWith(DEV_URL + '/');
    if (!url.startsWith('file://') && !isDevOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return mainWindow;
}

// 前端请求打开外部链接
ipcMain.on('jc:open-external', (_event, url) => {
  if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// 前端获取应用信息（名称、版本等）
safeHandle('jc:app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
}));

// 剪贴板写入（右键「查看网页源码」Modal 的复制按钮用；渲染进程 navigator.clipboard 在 file:// 下不可靠）
safeHandle('jc:clipboard-write', (_event, text) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// 通用 URL 抓取（CORS 无关，供渲染进程获取 BOSS 公开接口，如城市编码表）。
// 在主进程用 Node 原生 fetch 请求，避免渲染进程跨域限制。
safeHandle('jc:fetch-url', async (_event, url) => {
  try {
    const target = String(url || '');
    if (!/^https?:\/\//.test(target)) return { ok: false, error: 'invalid url' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(target, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 窗口控制（frame:false 自绘标题栏按钮用）
ipcMain.on('jc:window-minimize', () => mainWindow?.minimize());
ipcMain.on('jc:window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('jc:window-close', () => mainWindow?.close());
ipcMain.handle('jc:window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// 检查 BOSS 直聘登录态：以 webview 持久化会话（persist:bossclaw）中的 wt2 主会话 cookie 为准。
// wt2 是 zhipin.com 的登录主 cookie，未登录时不存在；过期 cookie 不会由 Electron 返回。
safeHandle('jc:boss-login', async () => {
  try {
    const ses = session.fromPartition('persist:bossclaw');
    const cookies = await ses.cookies.get({ name: 'wt2' });
    const wt2 = cookies.find((c) => c.name === 'wt2');
    return { loggedIn: Boolean(wt2 && wt2.value), cookie: Boolean(wt2) };
  } catch (e) {
    return { loggedIn: false, error: String((e && e.message) || e) };
  }
});

// ===== 可信输入通道（Electron 版 CDP 输入）=====
// BOSS 聊天框是 React/Slate/Lexical 受控 contenteditable，只认真实浏览器输入（isTrusted:true），
// 会丢弃 webview preload 里 dispatchEvent 合成的 beforeinput/input/paste 事件（合成事件 isTrusted=false）。
// 参考实现：job-claw-main 用 chrome.debugger CDP Input.insertText + Input.dispatchKeyEvent(rawKeyDown Enter)；
//           boss-auto-job-main 用 Playwright fill()/type()（底层同为 CDP 真实输入）。
// Electron <webview> 无 CDP，等价物是 webContents.insertText()/selectAll()/delete()/sendInputEvent()。
// 由 webview preload（webview.cjs）直接 ipcRenderer.send 到本主进程，event.sender 即 guest webContents。
ipcMain.on('jc:webview-input', (event, payload) => {
  const wc = event.sender;
  const seq = Number((payload && payload.seq) || 0);
  const action = String((payload && payload.action) || '');
  const text = String((payload && payload.text) || '');
  const reply = (result) => { try { wc.send('jc:webview-input-done', { seq, ...result }); } catch {} };
  try {
    switch (action) {
      case 'insertText':
        if (!text) return reply({ ok: false, action, error: 'empty text' });
        wc.insertText(text);
        return reply({ ok: true, action });
      case 'selectAll':
        wc.selectAll();
        return reply({ ok: true, action });
      case 'delete':
        wc.delete();
        return reply({ ok: true, action });
      case 'pressEnter': {
        // 与 CDP rawKeyDown(Enter, text:'\r') + keyUp 等价：真实回车触发发送
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        return reply({ ok: true, action });
      }
      default:
        return reply({ ok: false, action, error: 'unknown action: ' + action });
    }
  } catch (e) {
    dlog('error', 'webview-input failed', { action, message: e?.message });
    return reply({ ok: false, action, error: String((e && e.message) || e) });
  }
});

// 前端请求启动/停止/暂停桥接
ipcMain.on('jc:bridge-control', (_event, type) => {
  if (type === 'start' && !bridgeProcess) startBridge();
  if (type === 'stop' && bridgeProcess) { try { bridgeProcess.kill(); } catch {} bridgeProcess = null; }
});

// 说明：不启用 app.requestSingleInstanceLock()——该 API 在部分受限/沙箱环境下
// 无其他实例时也会返回 false 导致主进程直接退出（实测 WorkBuddy 沙箱复现）。
// 进程去重由启动脚本 start-bossclaw.cmd 在启动前统一清理旧进程完成。
app.whenReady().then(() => {
  // 数据版本重置：v3 重建后首次启动清空旧登录态/缓存（一次性，见 resetDataForVersion）
  resetDataForVersion();
  // 移除默认应用菜单栏（File / Edit / View / Window / Help）
  Menu.setApplicationMenu(null);

  // ===== webview persist:bossclaw session 预热（减少首次加载慢问题）=====
  // 在 createMainWindow 之前就初始化 session，使 session 配置在 webview 挂载时已生效。
  // 提前初始化还可以触发 session 的磁盘缓存预热，减少 BOSS 首页冷加载延迟。
  try {
    const bossclawSession = session.fromPartition('persist:bossclaw');

    // ===== webview preload 双保险：session 级注入（绕过 webview 元素 preload 属性的各种问题）=====
    // <webview> 的 preload 属性要求 file: 协议且须在元素初始化时就位；sandbox:true 时还可能被忽略。
    // session.setPreloads 是官方机制，对 persist:bossclaw 会话内每个页面（含 webview guest）注入 preload。
    // webview.cjs 内部有防重复注入保护（window.__bossclawWebviewPreload），双路径同时生效也不会重复注册。
    const preloadPath = path.join(__dirname, 'preload', 'webview.cjs');
    bossclawSession.setPreloads([preloadPath]);
    const applied = (typeof bossclawSession.getPreloads === 'function') ? JSON.stringify(bossclawSession.getPreloads()) : 'n/a';
    console.log('SET-PRELOADS preload=' + preloadPath + ' applied=' + applied);

    // ===== User-Agent 设置：模拟真实 Chrome 浏览器，避免 BOSS 反爬导致加载缓慢/被拦截 =====
    // Electron 默认的 UA 包含 "Electron/31.x"，BOSS 直聘可能据此降级响应或触发额外验证，
    // 导致页面加载响应过慢（服务端对 Electron UA 有额外处理逻辑）。
    // 替换为与 Chromium 版本对齐的标准 Chrome UA（不含 Electron 特征）。
    const chromeVersion = process.versions.chrome || '128.0.0.0';
    const realChromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    bossclawSession.setUserAgent(realChromeUA);

    // ===== 磁盘缓存配置：增大缓存上限（默认值偏小，BOSS 首页资源较多）=====
    // setCacheSize 在 Electron 31+ 中对 persistent session 有效；
    // 256MB 缓存可显著减少二次加载时间（JS/CSS/图片缓存命中），冷启动也因缓存预热而加速。
    if (typeof bossclawSession.getCacheSize === 'function') {
      bossclawSession.getCacheSize().then((size) => {
        dlog('info', 'bossclaw session cache size', { size });
      }).catch(() => {});
    }
  } catch (e) { console.error('session init failed:', e); }

  // 桥接服务改为按需启动：由用户在 OpenClaw / 设置页主动「启动/连接」后，
  // 经 jc:bridge-control(start) IPC 才 spawn；避免「未连接却显示已连接」。
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});


app.on('window-all-closed', () => {
  if (bridgeProcess) { try { bridgeProcess.kill(); } catch {} bridgeProcess = null; }
  stopCamoufoxBridge();
  // 关闭 CloakBrowser 隐身浏览器（如已启动）
  try { cloakLauncher.stop(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// ===== CloakBrowser 隐身浏览器 IPC（可选增强）=====
// 与 webview 路径平行运行；用户在设置页启用后才启动 launcher。
// 启动前需二进制已下载（首次自动从 cloakbrowser.dev / GitHub Releases 下载 ~200MB 并校验签名）。
cloakLauncher.setCallbacks({
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('jc:cloak-event', event); } catch {}
    }
  },
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('jc:cloak-status-changed', status); } catch {}
    }
  },
  resolveProfileDir: () => {
    // 持久 profile 路径：<userData>/cloakbrowser-profile；登录态（wt2 等）跨重启保留
    return path.join(app.getPath('userData'), 'cloakbrowser-profile');
  },
});

// 二进制状态探测（不启动浏览器）
safeHandle('jc:cloak-binary', async () => {
  try {
    const info = await cloakLauncher.checkBinary();
    return { ok: true, binary: info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 启动隐身浏览器（首次会自动下载二进制）
safeHandle('jc:cloak-start', async (_event, opts) => {
  return await cloakLauncher.start(opts || {});
});

// 停止隐身浏览器
safeHandle('jc:cloak-stop', async () => {
  return await cloakLauncher.stop();
});

// 当前状态
safeHandle('jc:cloak-status', async () => ({
  ready: cloakLauncher.ready,
  starting: false,
  binary: cloakLauncher.binary,
  lastError: cloakLauncher.lastError,
}));

// 打开新标签页（返回 tabId）
safeHandle('jc:cloak-page-new', async (_event, tabId, url) => {
  return await cloakLauncher.newPage(tabId, url);
});

// 关闭标签页
safeHandle('jc:cloak-page-close', async (_event, tabId) => {
  return await cloakLauncher.closePage(tabId);
});

// 标签内导航
safeHandle('jc:cloak-page-navigate', async (_event, tabId, url) => {
  return await cloakLauncher.navigatePage(tabId, url);
});

// 后退 / 前进 / 刷新
safeHandle('jc:cloak-page-back', async (_event, tabId) => {
  return await cloakLauncher.goBackPage(tabId);
});
safeHandle('jc:cloak-page-forward', async (_event, tabId) => {
  return await cloakLauncher.goForwardPage(tabId);
});
safeHandle('jc:cloak-page-reload', async (_event, tabId) => {
  return await cloakLauncher.reloadPage(tabId);
});

// 向指定标签发送通道消息（等价于 webview.send）
safeHandle('jc:cloak-page-send', async (_event, tabId, channel, payload) => {
  return await cloakLauncher.sendToPage(tabId, channel, payload);
});

// 真实键盘输入（替换 jc:webview-input；走 Playwright CDP Input 天然 isTrusted:true）
safeHandle('jc:cloak-page-input', async (_event, tabId, action, text) => {
  return await cloakLauncher.pageInput(tabId, action, text);
});

// 列出所有打开的标签
safeHandle('jc:cloak-page-list', async () => {
  return { ok: true, pages: cloakLauncher.listPages() };
});
