// electron/main.cjs —— BossClaw 桌面版主进程（CommonJS）
// 单窗口 + webview（内置浏览器，默认引擎） + 安全 IPC。
// 启动 OpenClaw 本地桥接服务，并通过 contextBridge 暴露 webview 预加载路径。
// CloakBrowser 隐身引擎作为**可选**内置浏览器（用户设置切换；与 webview 平行运行）。
'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session, clipboard, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
// 本地控制桥（供外部 agent / MCP 操作运行中的应用；默认关闭，见 control-bridge.cjs 的开启条件）
const { startControlBridge, resolveEnablement } = require('./control-bridge.cjs');

// ===== 轻量日志：仅在 BOSSCLAW_DEBUG=1 或开发模式写文件；正常情况只走 console =====
// 延迟访问 app（顶层 require 时 app 可能尚未就绪），且不影响其它调用方读取 dlog。
let _debugLogEnabled = null;
// P4-12：jc:webview-input 频率兜底的滑动窗口（近 60s 时间戳）
let inputWindow = [];
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

/** 解析 SKILL.md frontmatter（顶部成对分隔线之间的 key: value）+ 正文（frontmatter 之后的内容） */
// 分隔线兼容 --- 与 *** / === / ___ 等常见 YAML/文档分隔符（历史文件曾用 ***/---------------------，
// 统一按「整行仅由 3 个及以上同类分隔符组成」匹配，避免个别技能文件用非 --- 分隔导致解析失败、技能不显示）
function parseSkillFile(raw) {
  const delim = '[-*_=]';
  const m = String(raw || '').match(new RegExp(`^${delim}{3,}\\s*\\n([\\s\\S]*?)\\n${delim}{3,}\\s*\\n?`));
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
// 主窗口图标（nativeImage 加载 .ico，可同时作为大/小图标源：
// Windows 任务栏缩略图/右键预览小窗取的是窗口 ICON_SMALL，仅设 exe 资源不足，需在此显式设置）。
const APP_ICON_ICO = path.join(__dirname, '..', 'resources', 'icon.ico');
const APP_ICON = nativeImage.createFromPath(APP_ICON_ICO);
// Windows 任务栏按钮图标机制（重要）：
// - 调用 setAppUserModelId 后，任务栏按钮图标改从「与该 AUMID 匹配的快捷方式(.lnk)」获取；
//   打包安装版由 NSIS 注册了同 AUMID 的快捷方式 → 显示嵌入 exe 的项目图标（正常）。
// - dev / 便携运行（electron.exe .）没有该快捷方式 → Explorer 回退显示 exe 图标
//   （electron.exe = Electron 默认图标），BrowserWindow.icon 不生效 → 任务栏图标错误。
// 故仅在打包（app.isPackaged）时设置 AUMID；非打包运行让任务栏跟随窗口图标
// （resources/icon.ico），从而在 start-bossclaw.cmd 下也能显示项目图标。
if (process.platform === 'win32' && app.isPackaged) {
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
// 本地控制桥句柄（BOSSCLAW_CONTROL=1 时才非空）
let controlBridge = null;

// Camoufox 隐身引擎：本地 Python 桥（camoufox_server.py），端口 18767
let camoufoxProcess = null;
const CAMOUFOX_PORT = 18767;
const CAMOUFOX_TOKEN = 'bossclaw-camoufox';

// ===== 数据版本标记：v3 重建后首次启动自动清空旧数据（BOSS 登录态 / 隐身引擎数据）=====
// 本次「内置浏览器 + 收集投递沟通模块」从零重建，旧登录态与缓存需清空（用户需重新扫码登录）。
// 通过 userData 下的标记文件保证只清一次，之后正常启动不再重复清理。
const DATA_VERSION = 'v3-rebuild-20260815';
async function resetDataForVersion() {
  try {
    const marker = path.join(app.getPath('userData'), '.bossclaw-data-version');
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === DATA_VERSION) return;
    // 1) 清空 BOSS 登录态会话（persist:bossclaw 的 wt2 等 cookie）
    //    **必须 await**：clearStorageData 是异步的，旧实现「发起即返回」会让它与 createMainWindow 并发——
    //    用户在新装的 exe 首次启动后立刻在内置浏览器登录时，刚写入的 wt2 会被这次清理一并删掉，
    //    表现为「明明登录了却一直显示未登录、采集被登录墙拦下」。加上限兜底：清理异常缓慢时也不阻塞启动。
    try {
      await Promise.race([
        session.fromPartition('persist:bossclaw').clearStorageData(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (e) { dlog('warn', 'clear boss session storage failed', { message: e?.message }); }
    // 2) 清空 Camoufox 隐身引擎 cookie
    try {
      const camCookie = path.join(app.getPath('home'), '.bossclaw', 'camoufox-cookies.json');
      if (fs.existsSync(camCookie)) fs.unlinkSync(camCookie);
    } catch (e) { dlog('warn', 'clear camoufox cookie failed', { message: e?.message }); }
    // 3) 清空 CloakBrowser 隐身浏览器持久 profile
    try {
      const cloakProfile = path.join(app.getPath('userData'), 'cloakbrowser-profile');
      if (fs.existsSync(cloakProfile)) fs.rmSync(cloakProfile, { recursive: true, force: true });
    } catch (e) { dlog('warn', 'clear cloakbrowser profile failed', { message: e?.message }); }
    // 4) 写版本标记，避免重复清理
    try { fs.writeFileSync(marker, DATA_VERSION); } catch (e) { dlog('warn', 'write data-version marker failed', { message: e?.message }); }
  } catch (e) { dlog('warn', 'reset data for version failed', { message: e?.message }); }
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

// 项目本地 venv 的 python 可执行文件（install-deps.cmd 把 camoufox/playwright 装到这里）
function venvPython() {
  return process.platform === 'win32'
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv', 'bin', 'python');
}

function detectPython() {
  return new Promise((resolve) => {
    // 1) 项目本地 venv 优先（stealth 依赖安装处），避免误用未装依赖的系统 Python
    execFile(venvPython(), ['--version'], { timeout: 5000 }, (err) => {
      if (!err) return resolve(venvPython());
      // 2) 未创建 venv 时退回系统 Python
      const candidates = process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];
      let idx = 0;
      const tryNext = () => {
        if (idx >= candidates.length) return resolve(null);
        const cmd = candidates[idx++];
        execFile(cmd, ['--version'], { timeout: 5000 }, (e2) => {
          if (e2) return tryNext();
          resolve(cmd);
        });
      };
      tryNext();
    });
  });
}

// 执行 python 命令并返回 Promise（stderr 视为失败）
function runPythonAsync(python, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(python, args, { timeout: opts.timeout || 120000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        return reject(new Error(msg.trim() || `命令失败：${args[0] || ''}`));
      }
      resolve(String(stdout || '').trim());
    });
  });
}

// ===== 隐身引擎 Python 依赖自愈（后台安装，不阻塞请求）=====
// 背景：桥的 Chrome/Edge 回退路径运行时 `from playwright.sync_api import ...`，
// 若所选 Python 未装 playwright 会抛 `No module named 'playwright'`。
// 注意：首次安装不能阻塞在 IPC 请求里（否则前端按钮无限转圈），改为后台跑，请求立刻返回「安装中」。
let _cfxDepsReady = null;       // 本次会话已就绪的 python 路径
let _cfxDepsInstalling = null;  // 后台安装 Promise（去重）

// ===== 引擎检测状态持久化：内核/依赖检测过一次即跨启动保留，避免每次开软件重做 =====
// app.getPath 须在 ready 后调用，故惰性计算路径
function comfoxStateFile() {
  return path.join(app.getPath('home'), '.bossclaw', 'engine-state.json');
}
function loadEngineState() {
  try {
    const f = comfoxStateFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) { dlog('warn', 'load engine-state failed', { message: e?.message }); }
  return {};
}
function saveEngineState(patch) {
  try {
    const merged = { ...loadEngineState(), ...patch };
    const f = comfoxStateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(merged));
  } catch (e) { dlog('warn', 'save engine-state failed', { message: e?.message }); }
}
function markCamoufoxReady(python) {
  _cfxDepsReady = python;
  saveEngineState({ python, depsReady: true });
}

// 探测指定 python 缺失哪些 stealth 依赖（快，不触发安装）
function probeMissingDeps(python) {
  return new Promise((resolve) => {
    execFile(python, ['-c',
      "import importlib.util;ps=['playwright','camoufox'];print(','.join(p for p in ps if importlib.util.find_spec(p) is None))"],
      { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve(['playwright', 'camoufox']);
        // 空输出（无缺失）时 stdout 为换行符，必须 trim 后再过滤，否则误判 missing=["\r\n"]
        resolve(String(stdout || '').split(',').map((s) => s.trim()).filter(Boolean));
      });
  });
}

// 后台真正安装依赖：优先装进程 playwright（Chromium 回退必需、体积小、快）；
// camoufox 为可选增强（native 内核才需要），尽力安装，失败静默不阻塞。
async function installCamoufoxDeps(python) {
  // 决定安装目标：项目 .venv（干净、可复现）→ 否则退回所选 Python
  let target = python;
  const venv = venvPython();
  if (python !== venv) {
    try {
      if (!fs.existsSync(venv)) {
        await runPythonAsync(python, ['-m', 'venv', path.join(__dirname, '..', '.venv')], { timeout: 120000 });
      }
      if (fs.existsSync(venv)) target = venv;
    } catch (e) {
      dlog('warn', 'create stealth venv failed, fallback to system python', { message: e?.message });
      target = python;
    }
  }
  const pip = (pkg, idx) => runPythonAsync(target, ['-m', 'pip', 'install', '-q', '--upgrade', pkg], { timeout: 300000 })
    .catch(async (e) => {
      if (idx < 2) {
        dlog('warn', `pip install ${pkg} retry with mirror`, { message: e?.message });
        return runPythonAsync(target, ['-m', 'pip', 'install', '-q', '--upgrade', pkg,
          '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], { timeout: 360000 });
      }
      throw e;
    });
  // 1) 核心：playwright（必须装好，否则回退/原生内核 import camoufox 都会失败并抛 No module named 'playwright'）
  //    camoufox 0.5.x 要求 playwright<1.61，须锁定兼容版本
  try { await pip('playwright>=1.40,<1.61', 1); } catch (e) { dlog('error', 'playwright install failed', { message: e?.message }); throw e; }
  // 2) 可选：camoufox[geoip]（原生内核 + GeoIP，优先用于登录/沟通；失败不影响 Chromium 回退）
  try { await pip('camoufox[geoip]', 0); } catch (e) { dlog('info', 'camoufox install skipped (optional)', { message: e?.message }); }
  dlog('info', 'stealth deps ready', { target });
  return target;
}

// 确保依赖就绪：已就绪立即返回；缺失则触发后台安装并返回「安装中」。
async function ensureCamoufoxDeps(python) {
  if (_cfxDepsReady) return { python: _cfxDepsReady, ok: true, ready: true };
  let missing = [];
  try { missing = await probeMissingDeps(python); } catch (e) { missing = ['playwright', 'camoufox']; }
  if (!missing.length) {
    markCamoufoxReady(python);
    return { python, ok: true, ready: true };
  }
  // 开始后台安装（去重）
  if (!_cfxDepsInstalling) {
    _cfxDepsInstalling = installCamoufoxDeps(python)
      .then((target) => { markCamoufoxReady(target); _cfxDepsInstalling = null; return target; })
      .catch((e) => { dlog('error', 'install stealth deps failed', { message: e?.message }); _cfxDepsInstalling = null; return null; });
  }
  return {
    python, ok: false, ready: false, installing: true,
    message: '正在安装隐身引擎依赖（首次约需 1-2 分钟），请稍候后点击「检测状态」重试',
  };
}

// 检测隐身引擎可用性：仅 camouflage 隐身引擎（原生内核）可用。
// 实测 BOSS 会对 Playwright 驱动的系统 Chrome/Edge 返回空壳页，本地浏览器不可复用，
// 因此只有「Camoufox 包 + 原生内核」可用。
function checkCamoufoxEngine(pythonCmd) {
  return new Promise((resolve) => {
    if (!pythonCmd) return resolve(false);
    const probe = "import importlib.util;print(1 if importlib.util.find_spec('camoufox') is not None else 0)";
    execFile(pythonCmd, ['-c', probe], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout || '').trim() === '1');
    });
  });
}

// 启动隐身引擎 Python 桥（按需：Python + camoufox 包可用即启动）
// pythonOverride 调用方已确保依赖就绪时传入，避免重复探测；未传时自愈依赖（后台安装）。
async function startCamoufoxBridge(pythonOverride) {
  if (camoufoxProcess) return { running: true };
  let python = pythonOverride || (await detectPython());
  if (!python) return { running: false, error: '未检测到 Python 环境' };
  if (!pythonOverride) {
    const env = await ensureCamoufoxDeps(python);
    if (env.installing) return { running: false, installing: true, error: env.message || '隐身引擎依赖安装中，请稍候再试' };
    python = env.python || python;
  }
  const available = await checkCamoufoxEngine(python);
  if (!available) return { running: false, error: '隐身引擎未就绪：暂未下载 Camoufox 内核，请安装 Camoufox 隐身引擎内核：pip install "camoufox[geoip]" && camoufox fetch' };
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

// 后台预热：应用启动时加载持久化的「已就绪」状态并预拉起 Python 桥，
// 让登录/自动沟通首次点击不再承担冷启动（import camoufox/numpy 等较重）与重复检测。
// 性能口径：仅当「跨启动校验通过、依赖确实就绪」时才预拉 Python 进程（常驻内存 ~200-400MB）。
// 依赖缺失/损坏（state 过期）时不再无条件 spawn——否则每次启动都会白跑一个 python 进程，
// 造成启动后 CPU/内存占用升高；缺失场景交给首次使用时 ensureCamoufoxDeps 自愈。
function warmUpCamoufox() {
  (async () => {
    const python = await detectPython();
    if (!python) return;
    // 跨启动继承上次检测结果：python 一致且曾就绪 → 视为就绪，跳过重复探测。
    // 但需用一次廉价探测校验依赖仍在（避免 playwright/camoufox 被卸载或残留损坏目录后，
    // 持久化「已就绪」掩盖问题；探测缺失则交给 ensure 后台自愈重装）。
    const state = loadEngineState();
    let ready = false;
    if (state.python === python && state.depsReady) {
      let missing = [];
      try { missing = await probeMissingDeps(python); } catch { missing = ['playwright', 'camoufox']; }
      if (!missing.length) {
        markCamoufoxReady(python);
        ready = true;
        dlog('info', 'camoufox engine state restored', { python });
      } else {
        dlog('warn', 'camoufox engine state stale, will re-probe/install', { python, missing });
      }
    }
    if (!ready) return; // 依赖不可用：不预拉进程，等待首次使用时按需拉起
    await startCamoufoxBridge();
  })().catch((e) => dlog('warn', 'camoufox warm-up failed', { message: e?.message }));
}

// 渲染层查询 Camoufox 引擎状态（Python 探测 + camoufox 包检测 + 桥运行状态）
// platform 参数（boss/liepin/zhaopin/job51）：/status 返回对应平台登录态
safeHandle('jc:camoufox-status', async (_event, platform) => {
  const pf = String(platform || 'boss');
  const python = await detectPython();
  if (!python) return { python: false, running: false, ready: false, message: '未检测到 Python 环境' };
  // 自愈依赖后再判定可用性，避免「检测到内核但缺 playwright 运行时崩溃」
  const env = await ensureCamoufoxDeps(python);
  if (env.installing) {
    return { python: true, pythonCmd: python, camoufox: false, running: false, ready: false, installing: true, message: env.message || '正在安装隐身引擎依赖，请稍候' };
  }
  const readyPython = env.python || python;
  const available = await checkCamoufoxEngine(readyPython);
  const base = { python: Boolean(readyPython), pythonCmd: readyPython, camoufox: available };
  if (!available) {
    return { ...base, running: false, ready: false, message: '隐身引擎未就绪（暂未下载 Camoufox 内核，请安装 Camoufox 隐身引擎内核）' };
  }
  // 桥未运行则尝试拉起
  if (!camoufoxProcess) {
    const r = await startCamoufoxBridge(readyPython);
    if (!r.running) return { ...base, running: false, ready: false, message: r.error || '桥启动失败' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${CAMOUFOX_PORT}/status?token=${CAMOUFOX_TOKEN}&platform=${encodeURIComponent(pf)}`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return { ...base, running: true, ready: Boolean(data.ok), message: data.message || '', engine: data };
  } catch (e) {
    return { ...base, running: true, ready: false, message: String((e && e.message) || e) };
  }
});

// 显式停止隐身引擎桥（设置页用）
ipcMain.on('jc:camoufox-stop', () => stopCamoufoxBridge());

// 重启隐身引擎桥：先停后拉，返回最终状态（自动沟通误触关闭后自愈用；
// 多次重启失败由渲染层判定并自动停止自动沟通）
safeHandle('jc:camoufox-restart', async (_event, platform) => {
  const pf = String(platform || 'boss');
  stopCamoufoxBridge();
  const python = await detectPython();
  if (!python) return { python: false, running: false, ready: false, message: '未检测到 Python 环境' };
  const env = await ensureCamoufoxDeps(python);
  if (env.installing) {
    return { python: true, running: false, ready: false, installing: true, message: env.message || '正在安装隐身引擎依赖，请稍候' };
  }
  const readyPython = env.python || python;
  const available = await checkCamoufoxEngine(readyPython);
  if (!available) {
    return { python: Boolean(readyPython), camoufox: false, running: false, ready: false, message: '隐身引擎未就绪（仅支持 Camoufox 隐身引擎内核，本地浏览器不可复用）' };
  }
  const r = await startCamoufoxBridge(readyPython);
  if (!r.running) {
    return { python: Boolean(readyPython), camoufox: true, running: false, ready: false, message: r.error || '桥重启失败' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${CAMOUFOX_PORT}/status?token=${CAMOUFOX_TOKEN}&platform=${encodeURIComponent(pf)}`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return { python: Boolean(readyPython), camoufox: true, running: true, ready: Boolean(data.ok), message: data.message || '', engine: data };
  } catch (e) {
    return { python: Boolean(readyPython), camoufox: true, running: true, ready: false, message: String((e && e.message) || e) };
  }
});

// 渲染层调用隐身引擎桥（search/send/login），统一转发 127.0.0.1 请求
safeHandle('jc:camoufox-call', async (_event, action, payload) => {
  const python = await detectPython();
  if (!python) return { ok: false, error: '未检测到 Python 环境' };
  const env = await ensureCamoufoxDeps(python);
  if (env.installing) return { ok: false, installing: true, error: env.message || '隐身引擎依赖安装中，请稍候再试' };
  const readyPython = env.python || python;
  const available = await checkCamoufoxEngine(readyPython);
  if (!available) return { ok: false, error: '隐身引擎未就绪（本地浏览器不可复用，请安装 Camoufox 隐身引擎内核）' };
  if (!camoufoxProcess) {
    const r = await startCamoufoxBridge(readyPython);
    if (!r.running) return { ok: false, error: r.error || '桥启动失败' };
  }
  const pathMap = { search: '/search', send: '/send', chat: '/chat', login: '/login', logout: '/logout', clear: '/clear', platforms: '/platforms', progress: '/collection-progress' };
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
    icon: APP_ICON,
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
      // 关闭后台节流：最小化时渲染进程定时器仍按时触发（本地 5 分钟备份心跳 / 定时任务后台触发依赖此设置）
      backgroundThrottling: false,
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
        // 主框架过滤（对齐渲染层 BrowserView.tsx 口径）：iframe 子框架导航（广告/内嵌卡片）不写诊断日志
        wc.on('did-start-navigation', (ev, url, _isInPlace, legacyIsMainFrame) => {
          const isMainFrame = typeof ev?.isMainFrame === 'boolean' ? ev.isMainFrame : legacyIsMainFrame !== false;
          if (!isMainFrame) return;
          diagLog('WEBVIEW did-start-navigation url=' + url);
        });
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
    // ===== preload 注入判定（以「preload 自身事实」为权威，与渲染层同一口径）=====
    // 根因：<webview> 继承宿主 webPreferences（contextIsolation: true），preload 运行在**隔离世界**，
    //   其 window.__bossclawPreload 对主世界不可见 —— 旧实现用主世界 executeJavaScript 探测，
    //   恒为 null，于是 diag 日志把「注入成功」全部误报成 NOT-INJECTED
    //   （真机实测 584/584 全为误报，同期 preload-error 为 0，preload 自报标记正常）。
    // 权威信号 = preload 顶层输出的 `BOSS-CLAW-PRELOAD-INJECTED` console 标记（本 guest 捕获）。
    let preloadSeen = false;
    wc.on('console-message', (_ev, level, msg) => {
      const m = String(msg || '');
      if (m.includes('BOSS-CLAW-PRELOAD-INJECTED')) preloadSeen = true;
      if (/preload|uncaught|referenceerror|typeerror|is not|BOSS-CLAW/i.test(m)) webviewDiag('CONSOLE[' + level + '] ' + m.slice(0, 300));
    });
    wc.on('dom-ready', async () => {
      webviewDiag('DOM-READY url=' + (wc.getURL?.() || ''));
      let check = preloadSeen
        ? 'INJECTED(preload 顶层标记已捕获)'
        : 'NOT-SEEN(preload 顶层标记未捕获，需查 preload 路径 / preload-error)';
      if (!preloadSeen) {
        // 兜底：到隔离世界（preload 所在世界）再探测一次，避免 console 事件偶发丢失造成误判
        try {
          const v = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: 'String((window.__bossclawPreload) || "")' }]);
          const got = Array.isArray(v) ? String(v[0] || '') : String(v || '');
          if (got) check = 'INJECTED(隔离世界探测 ts=' + got + ')';
        } catch (e) { check += ' / probe-error=' + String((e && e.message) || e).slice(0, 120); }
      }
      webviewDiag('PRELOAD-CHECK ' + check);
      // 同步推送到渲染进程日志区（用户无需翻 diag 文件）
      try { mainWindow?.webContents.send('jc:webview-diag', { type: 'preload-check', result: check, url: wc.getURL?.() || '' }); } catch {}
    });
  });

  mainWindow.once('ready-to-show', () => {
    // 显式重设窗口图标：确保 Windows 任务栏缩略图/右键预览小窗（取 ICON_SMALL）也用 BossClaw 而非 Electron 默认。
    if (process.platform === 'win32' && !APP_ICON.isEmpty()) mainWindow.setIcon(APP_ICON);
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // ===== P30：渲染进程崩溃自愈 + 无响应检测 =====
  // 背景：网络卡顿/大对象序列化可能导致渲染进程崩溃（render-process-gone）或主线程无响应
  // （unresponsive）。原实现无任何处理——崩溃后窗口变白、点击无反应，用户关窗即整个应用退出。
  // 这里做兜底：崩溃后自动 reload（限频防死循环）；无响应时记录日志便于定位。
  let rendererGoneCount = 0;
  let rendererGoneWindowStart = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = String((details && details.reason) || 'unknown');
    const exitCode = details && details.exitCode;
    dlog('error', 'renderer-gone', { reason, exitCode, count: rendererGoneCount + 1 });
    if (reason === 'clean-exit') return; // 正常退出（非崩溃）不处理
    // 限频防死循环：60s 窗口内超过 3 次崩溃则不再自动 reload，避免「崩→刷→崩」无限循环
    const now = Date.now();
    if (now - rendererGoneWindowStart > 60000) {
      rendererGoneWindowStart = now;
      rendererGoneCount = 0;
    }
    rendererGoneCount += 1;
    if (rendererGoneCount > 3) {
      dlog('warn', 'renderer-gone 超过限频，停止自动 reload，等待用户操作');
      return;
    }
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          dlog('info', 'renderer-gone 自动 reload', { reason });
          mainWindow.webContents.reload();
        }
      } catch (e) {
        dlog('warn', 'renderer-gone reload 失败', { message: e && e.message });
      }
    }, 600);
  });
  // 主线程无响应/恢复：仅记录（自动杀进程风险大，等 Chromium 自行恢复；日志供根因定位）
  mainWindow.webContents.on('unresponsive', () => {
    dlog('warn', 'renderer-unresponsive 渲染进程主线程长时间无响应');
  });
  mainWindow.webContents.on('responsive', () => {
    dlog('info', 'renderer-responsive 渲染进程已恢复响应');
  });

  // 通知渲染进程窗口最大化状态变化（自绘标题栏「最大化/还原」图标随状态切换）
  mainWindow.on('maximize', () => mainWindow.webContents.send('jc:window-maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('jc:window-maximized-changed', false));
  // 通知渲染进程窗口置顶状态变化（标题栏图钉按钮随状态切换）
  mainWindow.on('always-on-top-changed', (_event, isOnTop) =>
    mainWindow.webContents.send('jc:window-always-on-top-changed', Boolean(isOnTop))
  );
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

// 读取「使用前必读」文档（首页「阅读使用文档」入口）。
// 用户文档源统一为 desktop-app/resources/docs/（随应用分发）：
// 打包版 = resources/docs/（extraResources 拷贝）；开发版 = app 目录下 resources/docs/。
safeHandle('jc:read-doc', async () => {
  const candidates = [
    path.join(process.resourcesPath, 'docs', '使用前必读.md'),
    path.join(__dirname, '..', 'resources', 'docs', '使用前必读.md'),
  ];
  for (const p of candidates) {
    try {
      const text = await fs.promises.readFile(p, 'utf8');
      return { ok: true, text, file: p };
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return { ok: false, error: '未找到「使用前必读」文档（resources/docs/使用前必读.md）' };
});

// 剪贴板写入（右键「查看网页源码」Modal 的复制按钮用；渲染进程 navigator.clipboard 在 file:// 下不可靠）
safeHandle('jc:clipboard-write', (_event, text) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// 保存定制简历 PDF：渲染进程传 A4 打印 HTML → 隐藏窗口 printToPDF → 系统保存对话框 → 写盘。
// 排版完全由 HTML/CSS 控制（resumePdf.ts 的 moderncv 风格模板），@page 控制页边距，
// printToPDF 传 margins:'none' 避免与 CSS 边距叠加。零额外依赖、中文由系统字体渲染。
safeHandle('jc:save-pdf', async (_event, defaultName, html) => {
  const name = String(defaultName || '').trim();
  if (!/^[\w\u4e00-\u9fa5()（）\-· ]{1,120}\.pdf$/i.test(name)) {
    return { ok: false, error: '文件名不合法（须以 .pdf 结尾）' };
  }
  const htmlText = String(html || '');
  if (htmlText.length < 200 || !/<!DOCTYPE html>/i.test(htmlText)) {
    return { ok: false, error: 'HTML 内容不完整，无法生成 PDF' };
  }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存定制简历',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  // 隐藏打印窗口：不启用 Node 能力，纯渲染 HTML（无脚本），保证安全
  const printWin = new BrowserWindow({
    show: false,
    width: 842,
    height: 1191,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlText));
    // 等待字体与样式渲染稳定（系统字体加载 + 布局）
    await new Promise((r) => setTimeout(r, 400));
    const pdf = await printWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'none' },
    });
    if (!pdf || !pdf.length) return { ok: false, error: 'PDF 生成结果为空' };
    await fs.promises.writeFile(filePath, pdf);
    return { ok: true, filePath };
  } catch (e) {
    dlog('error', 'printToPDF failed', { message: (e && e.message) || String(e) });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { printWin.destroy(); } catch {}
  }
});

// ===== 通用文本导出（CSV）：渲染层拼好文本 → 系统保存对话框 → 写盘 =====
// 口径：**每次导出都必须由用户选择保存位置**（不做静默落盘、不记忆目录）。
// 扩展名走白名单（默认只允许 .csv），避免误导出可执行文件；
// 文本已由渲染层带上 UTF-8 BOM，Excel / WPS 双击不会中文乱码。
safeHandle('jc:save-file', async (_event, defaultName, content, extWhitelist) => {
  const name = String(defaultName || '').trim();
  const text = String(content ?? '');
  const allowed = (Array.isArray(extWhitelist) && extWhitelist.length ? extWhitelist : ['csv']).map((e) =>
    String(e).replace(/^\./, '').toLowerCase()
  );
  const m = /^([\w\u4e00-\u9fa5()（）\-· ]{1,120})\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!m) return { ok: false, error: '文件名不合法（须为「名称.扩展名」）' };
  const ext = m[2].toLowerCase();
  if (!allowed.includes(ext)) {
    return { ok: false, error: `不支持的文件类型 .${ext}（仅支持 ${allowed.map((e) => `.${e}`).join(' / ')}）` };
  }
  if (!text) return { ok: false, error: '导出内容为空' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出数据',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [
      { name: ext === 'csv' ? 'CSV 数据表' : `${ext.toUpperCase()} 文件`, extensions: [ext] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(filePath, text, 'utf8');
    return { ok: true, filePath };
  } catch (e) {
    dlog('error', 'save-file failed', { message: (e && e.message) || String(e) });
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ===== 统计数据报表 PDF：渲染层传横向 A4 打印 HTML → 隐藏窗口 printToPDF → 保存对话框 =====
// 与 jc:save-pdf 的区别：本通道固定 **A4 横版**（统计页是宽幅布局），且对话框标题独立，
// 避免复用简历通道时出现「保存定制简历」这类错位标题。同样必须由用户选择保存位置。
safeHandle('jc:save-report-pdf', async (_event, defaultName, html) => {
  const name = String(defaultName || '').trim();
  if (!/^[\w\u4e00-\u9fa5()（）\-· ]{1,120}\.pdf$/i.test(name)) {
    return { ok: false, error: '文件名不合法（须以 .pdf 结尾）' };
  }
  const htmlText = String(html || '');
  if (htmlText.length < 200 || !/<!DOCTYPE html>/i.test(htmlText)) {
    return { ok: false, error: 'HTML 内容不完整，无法生成 PDF' };
  }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出统计报表',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  // 隐藏打印窗口：不启用 Node 能力，纯渲染 HTML（无脚本），保证安全；横版按 842×1191 倒置预置
  const printWin = new BrowserWindow({
    show: false,
    width: 1191,
    height: 842,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlText));
    await new Promise((r) => setTimeout(r, 400));
    const pdf = await printWin.webContents.printToPDF({
      pageSize: 'A4',
      landscape: true,
      printBackground: true,
      margins: { marginType: 'none' },
    });
    if (!pdf || !pdf.length) return { ok: false, error: 'PDF 生成结果为空' };
    await fs.promises.writeFile(filePath, pdf);
    return { ok: true, filePath };
  } catch (e) {
    dlog('error', 'report printToPDF failed', { message: (e && e.message) || String(e) });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { printWin.destroy(); } catch {}
  }
});

// 在系统文件管理器中定位到指定文件（导出成功后的「打开所在文件夹」）
safeHandle('jc:show-item', (_event, filePath) => {
  const p = String(filePath || '').trim();
  if (!p || !path.isAbsolute(p)) return { ok: false, error: '路径不合法' };
  try {
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 保存「达标岗位」数据到本地：渲染进程整理好 JSON → 系统保存对话框 → 写盘。
// 达标 = 岗位分析评分 >= 推荐岗位分（minScore）；达标岗位从工作台队列收集，由渲染层拼好传入。
// dirOpt 非空且为绝对路径时，直接写入该目录（不弹框，文件名按天自动生成）；否则弹出保存对话框。
safeHandle('jc:save-qualified-jobs', async (_event, defaultName, jsonText, dirOpt) => {
  const name = String(defaultName || '').trim();
  const json = String(jsonText || '');
  if (!/^[\w\u4e00-\u9fa5()（）\-· ]{1,120}\.json$/i.test(name)) {
    return { ok: false, error: '文件名不合法（须以 .json 结尾）' };
  }
  if (!json) return { ok: false, error: '无有效达标岗位数据' };
  let filePath;
  const dir = String(dirOpt || '').trim();
  if (dir && path.isAbsolute(dir)) {
    filePath = path.join(dir, name);
  } else {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存达标岗位数据',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [
        { name: 'JSON 数据', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    filePath = res.filePath;
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, json, 'utf8');
  return { ok: true, filePath };
});

// ===== 达标岗位导出目录（可选；不设置则每次弹保存框，设置后在指定目录自动按天写文件）=====
function qualJobsDirCtl() {
  const pointer = () => path.join(app.getPath('userData'), '.qualified-jobs-dir.txt');
  const readPointer = () => {
    try { const d = fs.readFileSync(pointer(), 'utf8').trim(); if (d) return d; } catch {}
    return '';
  };
  return { pointer, readPointer };
}

safeHandle('jc:qualified-jobs-dir-get', async () => {
  try { return { dir: qualJobsDirCtl().readPointer() }; }
  catch (e) { return { dir: '', error: String((e && e.message) || e) }; }
});

safeHandle('jc:qualified-jobs-dir-set', async (_event, dirPath) => {
  const dir = String(dirPath || '').trim();
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: '导出目录须为绝对路径' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(qualJobsDirCtl().pointer(), dir);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 系统目录选择对话框 → 持久化为达标岗位导出目录（选择即应用）
safeHandle('jc:qualified-jobs-dir-pick', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择达标岗位导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    const dir = filePaths[0];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(qualJobsDirCtl().pointer(), dir);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ===== 经历补充材料：按路径选择 + 每次调用现读（不落缓存/不持久化内容） =====
// 口径：渲染层只持有文件绝对路径；正文每次调用 AI 前经 jc:material-read 现读并重新解析，
// 因此用户在外部改了素材文件即时生效，应用内不保存任何素材内容副本。
// 素材扩展名白名单（P4-10 双端共享口径：选择对话框 filters 与读取校验必须一致）
const MATERIAL_EXT_WHITELIST = ['pdf', 'docx', 'md', 'markdown', 'txt', 'text'];
safeHandle('jc:material-pick', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择经历补充材料（PDF / DOCX / MD / TXT）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '简历与文本', extensions: MATERIAL_EXT_WHITELIST },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    return { ok: true, paths: filePaths.map((p) => ({ path: p, name: path.basename(p) })) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 按路径现读文件（不缓存）→ 返回 data URL，供渲染层复用既有解析链路（pdf 文本层 / docx / 纯文本）
safeHandle('jc:material-read', async (_event, filePath) => {
  try {
    const p = String(filePath || '');
    if (!p || !path.isAbsolute(p)) return { ok: false, error: '文件路径无效（需绝对路径）' };
    const stat = await fs.promises.stat(p);
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
    // 单文件上限 20MB：避免超大素材拖垮解析与内存
    if (stat.size > 20 * 1024 * 1024) return { ok: false, error: '文件超过 20MB' };
    // P4-10：扩展名白名单与 jc:material-pick 的 filters 同源（拒绝任意绝对路径读取 → 防敏感文件外泄）
    const ext = path.extname(p).replace(/^\./, '').toLowerCase();
    if (!MATERIAL_EXT_WHITELIST.includes(ext)) {
      return { ok: false, error: `不支持的素材格式：.${ext}（仅 PDF/DOCX/MD/TXT）` };
    }
    const buf = await fs.promises.readFile(p);
    const mime = ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    return {
      ok: true,
      name: path.basename(p),
      path: p,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      bytes: buf.length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ===== 本地数据备份目录（开机自启动同理，见下方 autostart 段）=====
// localStorage 为主存储；本地备份目录指针存 userData/.backup-dir.txt（独立于 localStorage，
// 避免 localStorage 缺失时无法得知恢复来源）。渲染层每 5 分钟脏检查后经此写盘。
function backupCtl() {
  const pointer = () => path.join(app.getPath('userData'), '.backup-dir.txt');
  const defaultDir = () => path.join(app.getPath('userData'), 'backup');
  const readPointer = () => {
    try { const d = fs.readFileSync(pointer(), 'utf8').trim(); if (d) return d; } catch {}
    return defaultDir();
  };
  const fileIn = (dir) => path.join(dir, 'bossclaw-local-backup.json');
  return { pointer, defaultDir, readPointer, fileIn };
}

/** 校验并持久化一个备份目录（绝对路径；自动创建、拷贝旧备份、写指针） */
function applyBackupDir(dir) {
  if (!path.isAbsolute(dir)) return { ok: false, error: '备份目录须为绝对路径' };
  const ctl = backupCtl();
  const oldDir = ctl.readPointer();
  fs.mkdirSync(dir, { recursive: true });
  // 旧目录存在备份文件且新目录无 → 拷贝，避免切换丢数据
  if (oldDir !== dir) {
    const src = ctl.fileIn(oldDir);
    const dst = ctl.fileIn(dir);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.copyFileSync(src, dst); } catch (e) { dlog('warn', 'backup dir copy failed', { message: e?.message }); }
    }
  }
  fs.writeFileSync(ctl.pointer(), dir);
  return { ok: true, dir };
}

safeHandle('jc:backup-dir-get', async () => {
  try { return { dir: backupCtl().readPointer() }; }
  catch (e) { return { dir: backupCtl().defaultDir(), error: String(e?.message || e) }; }
});

safeHandle('jc:backup-dir-set', async (_event, dirPath) => {
  try {
    return applyBackupDir(String(dirPath || '').trim());
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 系统目录选择对话框 → 持久化为备份目录（选择即应用）
safeHandle('jc:backup-dir-pick', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地备份目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    return applyBackupDir(filePaths[0]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

safeHandle('jc:backup-write', async (_event, bundle) => {
  const ctl = backupCtl();
  const dir = ctl.readPointer();
  const filep = ctl.fileIn(dir);
  const tmp = filep + '.tmp';
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    // 渲染层已按 '{"updatedAt":N,"keys":…}' 拼好文本直传；旧对象格式仍兼容（手动兜底序列化）
    const text = typeof bundle === 'string' ? bundle : JSON.stringify(bundle ?? {});
    if (text.length < 4) return { ok: false, error: '备份内容为空' };
    // 异步原子写（tmp + rename）：不阻塞主进程事件循环（同步 writeFileSync 在大包/慢盘时会卡窗口），
    // 中途失败也不会损坏上一次完好备份
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, filep);
    return { ok: true, file: filep, size: Buffer.byteLength(text) };
  } catch (e) {
    try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch { /* 清理失败忽略 */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
});

safeHandle('jc:backup-read', async () => {
  try {
    const ctl = backupCtl();
    const filep = ctl.fileIn(ctl.readPointer());
    if (!fs.existsSync(filep)) return { ok: false, file: null };
    const raw = fs.readFileSync(filep, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed) return { ok: false, file: null, error: '备份文件损坏' };
    return { ok: true, file: filep, bundle: parsed };
  } catch (e) {
    return { ok: false, file: null, error: String((e && e.message) || e) };
  }
});

safeHandle('jc:backup-delete', async () => {
  try {
    const ctl = backupCtl();
    const filep = ctl.fileIn(ctl.readPointer());
    if (fs.existsSync(filep)) fs.unlinkSync(filep);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ===== 开机自启动（Windows 登录项）=====
safeHandle('jc:autostart-get', async () => {
  try {
    const st = app.getLoginItemSettings();
    return { ok: true, openAtLogin: Boolean(st.openAtLogin) };
  } catch (e) {
    return { ok: false, openAtLogin: false, error: String((e && e.message) || e) };
  }
});

safeHandle('jc:autostart-set', async (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return { ok: true, enabled: Boolean(enabled) };
  } catch (e) {
    return { ok: false, enabled: Boolean(enabled), error: String((e && e.message) || e) };
  }
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

// P05：LLM 主进程代理（对齐 AGENTS.md「LLM 经预加载脚本代理真实请求」架构约定）。
// 渲染层不再直连 provider（规避部分端点 CORS 失败、统一主进程超时/错误口径），经此转发。
// 信任面同 jc:fetch-url（本地工具、URL 由渲染层自身配置的 provider 端点提供）。
safeHandle('jc:llm-proxy', async (_event, url, payload, apiKey, timeoutMs = 90000) => {
  const target = String(url || '');
  if (!/^https?:\/\//.test(target)) return { ok: false, status: 0, text: '', error: 'invalid url' };
  // P1-11：apiKey 从网页复制常带尾部空格/换行，trim 后再拼 Authorization 头，
  // 否则 fetch 会抛 `TypeError: Invalid value` 且被下面 catch 吞成模糊的失败信息。
  const key = String(apiKey || '').trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 90000));
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const timedOut = /aborted?|timeout/i.test(msg);
    return {
      ok: false, status: 0, text: '',
      error: timedOut ? 'timeout' : msg,
      // P1-11：区分「超时 / 请求头非法 / 网络」，供渲染层给用户可定位的提示
      hint: timedOut
        ? '请求超时：可增大模型请求超时上限或检查网络'
        : /invalid/i.test(msg)
          ? '请求头非法：请检查 API Key 是否包含多余空格或换行'
          : '网络请求失败：请检查网络连通性或服务地址',
    };
  } finally {
    clearTimeout(timer);
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
// 窗口置顶（标题栏图钉按钮）：查询当前置顶状态 / 切换
ipcMain.handle('jc:window-always-on-top', () => mainWindow?.isAlwaysOnTop() ?? false);
ipcMain.on('jc:window-always-on-top-set', (_event, value) => mainWindow?.setAlwaysOnTop(Boolean(value)));

// 检查 BOSS 直聘登录态：以 webview 持久化会话（persist:bossclaw）中的 wt2 主会话 cookie 为准。
// wt2 是 zhipin.com 的登录主 cookie，未登录时不存在；过期 cookie 不会由 Electron 返回。
// 多平台适配：同分区同时上报 猎聘/智联/51Job 的登录态（各自鉴权 cookie 名）。
const WEBVIEW_AUTH_COOKIE_HINTS = {
  boss: ['wt2'],
  liepin: ['lp_login', 'lp_token'],
  zhaopin: ['zp_auto', 'zp_sign'],
  job51: ['j_ticket', 'sajssp'],
};
const WEBVIEW_PLATFORM_DOMAIN = {
  boss: 'zhipin.com',
  liepin: 'liepin.com',
  zhaopin: 'zhaopin.com',
  job51: '51job.com',
};
function cookieUrl(c) {
  if (c.url) return c.url;
  const d = String(c.domain || '').replace(/^\.+/, '');
  return `https://${d || 'localhost'}`;
}
safeHandle('jc:boss-login', async () => {
  try {
    const ses = session.fromPartition('persist:bossclaw');
    const all = await ses.cookies.get({});
    const hasAuth = (hints) => hints.some((h) => all.some((c) => c.name.toLowerCase().includes(h) && c.value));
    const platforms = Object.fromEntries(
      Object.entries(WEBVIEW_AUTH_COOKIE_HINTS).map(([pf, hints]) => [pf, hasAuth(hints)]),
    );
    const wt2 = all.find((c) => c.name === 'wt2');
    return { loggedIn: Boolean(wt2 && wt2.value), cookie: Boolean(wt2), platforms };
  } catch (e) {
    return { loggedIn: false, error: String((e && e.message) || e) };
  }
});

// 清除指定平台在 persist:bossclaw 会话中的登录态 cookie（设置页「退出登录」用）
safeHandle('jc:boss-logout', async (_event, platform) => {
  try {
    const target = String(platform || '');
    const hints = WEBVIEW_AUTH_COOKIE_HINTS[target] || [];
    const domainHint = WEBVIEW_PLATFORM_DOMAIN[target];
    const ses = session.fromPartition('persist:bossclaw');
    const all = await ses.cookies.get({});
    let removed = 0;
    for (const c of all) {
      const name = String(c.name || '').toLowerCase();
      const domain = String(c.domain || '').toLowerCase();
      const matchHint = hints.some((h) => name.includes(h));
      const matchDomain = domainHint && domain.includes(domainHint);
      if (matchHint || matchDomain) {
        try {
          await ses.cookies.remove(cookieUrl(c), c.name);
          removed += 1;
        } catch {}
      }
    }
    dlog('info', 'boss-logout', { platform: target, removed });
    return { ok: true, removed };
  } catch (e) {
    dlog('error', 'boss-logout failed', { error: String((e && e.message) || e) });
    return { ok: false, error: String((e && e.message) || e) };
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
  // P4-12：主进程侧频率兜底（渲染层自律之外的最后防线）。
  // 阈值 = 16 次/分钟（渲染层 ActionPacer 正常 8 次/分钟，留 2 倍余量：
  // 既能拦住渲染层 bug 引发的输入风暴，又不误伤「填字 → 回车」两连击）。
  const now = Date.now();
  inputWindow = inputWindow.filter((t) => t > now - 60_000);
  if (inputWindow.length >= 16) {
    try { wc.send('jc:webview-input-done', { seq: String((payload && payload.seq) || ''), ok: false, action: String((payload && payload.action) || ''), error: 'rate limited' }); } catch {}
    dlog('warn', 'webview-input rate limited（主进程兜底）');
    return;
  }
  inputWindow.push(now);
  // ⚠️ 严禁 Number() 强转：preload 的 seq 是 "时间戳_随机数" 字符串，Number() 后变 NaN→0，
  // 回执 seq 与请求不匹配，preload 的 trustedInput 会每 4s 超时一次（3 次=13s）且永远配对不上。
  const seq = String((payload && payload.seq) || '');
  const action = String((payload && payload.action) || '');
  const text = String((payload && payload.text) || '');
  const reply = (result) => { try { wc.send('jc:webview-input-done', { seq, ...result }); } catch {} };
  try {
    switch (action) {
      case 'clickAt': {
        // 真实鼠标点击（isTrusted:true）：与 insertText/pressEnter 同源思路。
        // 背景：BOSS「立即沟通」对 preload 里 dispatchEvent 的合成点击**完全不响应**
        // （线上实测：点击后按钮仍在、无弹窗、无输入框、无导航、无风控），
        // 必须由主进程 sendInputEvent 产生可信鼠标事件。坐标为视口坐标（= getBoundingClientRect）。
        const x = Math.round(Number(payload && payload.x));
        const y = Math.round(Number(payload && payload.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return reply({ ok: false, action, error: 'bad coords' });
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        return reply({ ok: true, action, x, y });
      }
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
app.whenReady().then(async () => {
  // 数据版本重置：v3 重建后首次启动清空旧登录态/缓存（一次性，见 resetDataForVersion）。
  // 必须 await 完成后再创建窗口——否则清理会与用户「首次启动后立即登录」的写入竞态。
  await resetDataForVersion();
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
    if (typeof bossclawSession.setCacheSize === 'function') {
      bossclawSession.setCacheSize(256 * 1024 * 1024)
        .then(() => {
          if (typeof bossclawSession.getCacheSize !== 'function') return;
          return bossclawSession.getCacheSize();
        })
        .then((size) => {
          if (typeof size === 'number') dlog('info', 'bossclaw session cache size', { size });
        })
        .catch(() => {});
    }
  } catch (e) { console.error('session init failed:', e); }

  // 桥接服务改为按需启动：由用户在 OpenClaw / 设置页主动「启动/连接」后，
  // 经 jc:bridge-control(start) IPC 才 spawn；避免「未连接却显示已连接」。
  createMainWindow();
  // 后台预热隐身引擎（读取持久化状态 + 预拉起 Python 桥），登录不再承担冷启动卡顿
  warmUpCamoufox();

  // ===== 本地控制桥（可选；开启条件见 control-bridge.cjs：BOSSCLAW_CONTROL=1 或 --control-bridge）=====
  // 供 bossclaw-mcp 等外部 agent 读取实时状态 / 执行白名单动作（切页、暂停投递、截图…）。
  // 只监听 127.0.0.1 且要求 token；单向链路：仅 agent→MCP→应用，应用从不反向调 agent。
  try {
    const enablement = resolveEnablement();
    console.log(`[control-bridge] ${enablement.enabled ? '启用' : '未启用'}（${enablement.via}）`);
    controlBridge = startControlBridge({
      app,
      getWindow: () => mainWindow,
      log: (level, msg, extra) => dlog(level, msg, extra),
    });
  } catch (e) {
    console.error('[control-bridge] 初始化失败：', e?.message || e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});


app.on('window-all-closed', () => {
  if (bridgeProcess) { try { bridgeProcess.kill(); } catch {} bridgeProcess = null; }
  stopCamoufoxBridge();
  // 关闭 CloakBrowser 隐身浏览器（如已启动）
  try { cloakLauncher.stop(); } catch {}
  // 关闭本地控制桥并清理信息文件（避免残留 stale 记录被 MCP 读到）
  if (controlBridge) { try { controlBridge.stop(); } catch {} controlBridge = null; }
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
  starting: cloakLauncher.starting, // P26：透传 launcher 真实启动态，不再硬编码 false
  binary: cloakLauncher.binary,
  lastError: cloakLauncher.lastError,
}));

// 健康检查：探测 Playwright context 进程是否真的活着（防止 ready=true 但进程已死）。
// 返回 { ok, alive, reason?, pages }，alive=false 时 UI 走 ensureCloakEngine 自动重启路径。
safeHandle('jc:cloak-health', async () => {
  try {
    return await cloakLauncher.healthCheck();
  } catch (e) {
    return { ok: false, alive: false, error: String((e && e.message) || e), pages: 0 };
  }
});

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
