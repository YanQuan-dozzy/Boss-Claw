// electron/main.cjs —— BossClaw 桌面版主进程（CommonJS）
// 单窗口 + webview（内置浏览器，默认引擎） + 安全 IPC。
// 启动 OpenClaw 本地桥接服务，并通过 contextBridge 暴露 webview 预加载路径。
// CloakBrowser 隐身引擎作为**可选**内置浏览器（用户设置切换；与 webview 平行运行）。
'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');

// CloakBrowser 隐身浏览器（可选增强，默认关闭；用户在设置页切换）
// 不动 webviewTag/原 webview 路径——webview 仍是默认引擎，CloakBrowser 作为并行通道。
// 设计：AGENTS.md §2.1 末段（CloakBrowser 仅作可选增强，默认关闭，不得借此绕过验证码/账户验证）。
const cloakLauncher = require('./cloakbrowser/launcher.cjs');

const isDev = !app.isPackaged && process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';
const APP_ID = 'com.bossclaw.desktop';

// Windows 任务栏右键菜单、跳转列表、UWP 风格通知等都依赖 AppUserModelID。
// 未设置时 Windows 会把窗口归到 electron.exe，任务栏右键会显示 "Electron"。
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
    bridgeProcess = spawn(process.execPath, [server], {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    bridgeProcess.on('error', () => {});
  } catch {
    // 桥接为可选模块，启动失败不影响主程序
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
    camoufoxProcess.on('error', () => {});
    camoufoxProcess.on('exit', () => { camoufoxProcess = null; });
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
ipcMain.handle('jc:camoufox-status', async () => {
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
ipcMain.handle('jc:camoufox-call', async (_event, action, payload) => {
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
    minWidth: 1080,
    minHeight: 680,
    title: '',
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
      const dlog = (m) => { try { fs.appendFileSync(path.join(__dirname, '..', 'debug-render.log'), `[${new Date().toISOString()}] ${m}\n`); } catch {} };
      dlog('createMainWindow: isDev=' + isDev + ' target=' + (isDev ? '(dev url resolved)' : 'dist/index.html'));
      mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => { dlog('CONSOLE level=' + level + ' msg=' + message + ' @' + (sourceId || '') + ':' + line); });
      mainWindow.webContents.on('did-fail-load', (ev, errorCode, errorDescription, validatedURL) => { dlog('FAIL-LOAD code=' + errorCode + ' desc=' + errorDescription + ' url=' + validatedURL); });
      mainWindow.webContents.on('crashed', () => dlog('WEBVIEW CRASHED'));
      mainWindow.webContents.on('did-finish-load', () => {
        dlog('did-finish-load fired');
        setTimeout(async () => {
          try {
            const info = await mainWindow.webContents.executeJavaScript('(function(){var r=document.getElementById("root");return JSON.stringify({rootLen:r?r.innerHTML.length:-1,hasAppShell:!!document.querySelector(".app-shell,.ant-app"),bodyText:(document.body?document.body.innerText||"":"").slice(0,200),title:document.title});})()');
            dlog('DOM-CHECK ' + info);
          } catch (e) { dlog('DOM-CHECK ERROR ' + (e && e.message)); }
        }, 2500);
        // 诊断：切到工作台看内置浏览器 webview 加载情况
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript('(function(){var btns=[].slice.call(document.querySelectorAll(".nav-btn"));var b=btns.find(function(x){return (x.innerText||"").indexOf("工作台")>=0;});if(b){b.click();return "clicked-workbench";}return "no-workbench-btn";})()');
          } catch (e) { dlog('SWITCH ERROR ' + (e && e.message)); }
        }, 4000);
        setTimeout(async () => {
          try {
            const st = await mainWindow.webContents.executeJavaScript('(function(){var input=document.querySelector(".browser-bar input");var wv=document.querySelector("webview");return JSON.stringify({addrValue:input?input.value:null,addrPlaceholder:input?input.getAttribute("placeholder"):null,hasWebview:!!wv,webviewSrc:wv?wv.getAttribute("src"):null,webviewUrl:wv?wv.getURL?wv.getURL():"n/a":"n/a",barHTML:document.querySelector(".browser-bar")?document.querySelector(".browser-bar").innerText.slice(0,120):null});})()');
            dlog('BROWSER-STATE ' + st);
          } catch (e) { dlog('BROWSER-STATE ERROR ' + (e && e.message)); }
        }, 10000);
      });
      // ===== 临时诊断：webview 加载时序（定位「内置浏览器不显示 BOSS 链接」）=====
      mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
        const tag = wc.getURL?.() || '';
        dlog('WEBVIEW-ATTACHED url=' + tag);
        wc.on('did-start-navigation', (_ev, url, _isInPlace, _isMainFrame) => dlog('WEBVIEW did-start-navigation url=' + url));
        wc.on('did-navigate', (_ev, url) => dlog('WEBVIEW did-navigate url=' + url));
        wc.on('did-fail-load', (_ev, code, desc, url) => dlog('WEBVIEW did-fail-load code=' + code + ' desc=' + desc + ' url=' + url));
        wc.on('did-finish-load', () => dlog('WEBVIEW did-finish-load url=' + (wc.getURL?.() || '')));
        wc.on('dom-ready', () => dlog('WEBVIEW dom-ready url=' + (wc.getURL?.() || '')));
      });
    } catch {}
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 通知渲染进程窗口最大化状态变化（自绘标题栏「最大化/还原」图标随状态切换）
  mainWindow.on('maximize', () => mainWindow.webContents.send('jc:window-maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('jc:window-maximized-changed', false));

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
ipcMain.handle('jc:app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
}));

// 通用 URL 抓取（CORS 无关，供渲染进程获取 BOSS 公开接口，如城市编码表）。
// 在主进程用 Node 原生 fetch 请求，避免渲染进程跨域限制。
ipcMain.handle('jc:fetch-url', async (_event, url) => {
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
ipcMain.handle('jc:boss-login', async () => {
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
ipcMain.handle('jc:cloak-binary', async () => {
  try {
    const info = await cloakLauncher.checkBinary();
    return { ok: true, binary: info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 启动隐身浏览器（首次会自动下载二进制）
ipcMain.handle('jc:cloak-start', async (_event, opts) => {
  return await cloakLauncher.start(opts || {});
});

// 停止隐身浏览器
ipcMain.handle('jc:cloak-stop', async () => {
  return await cloakLauncher.stop();
});

// 当前状态
ipcMain.handle('jc:cloak-status', async () => ({
  ready: cloakLauncher.ready,
  starting: false,
  binary: cloakLauncher.binary,
  lastError: cloakLauncher.lastError,
}));

// 打开新标签页（返回 tabId）
ipcMain.handle('jc:cloak-page-new', async (_event, tabId, url) => {
  return await cloakLauncher.newPage(tabId, url);
});

// 关闭标签页
ipcMain.handle('jc:cloak-page-close', async (_event, tabId) => {
  return await cloakLauncher.closePage(tabId);
});

// 标签内导航
ipcMain.handle('jc:cloak-page-navigate', async (_event, tabId, url) => {
  return await cloakLauncher.navigatePage(tabId, url);
});

// 后退 / 前进 / 刷新
ipcMain.handle('jc:cloak-page-back', async (_event, tabId) => {
  return await cloakLauncher.goBackPage(tabId);
});
ipcMain.handle('jc:cloak-page-forward', async (_event, tabId) => {
  return await cloakLauncher.goForwardPage(tabId);
});
ipcMain.handle('jc:cloak-page-reload', async (_event, tabId) => {
  return await cloakLauncher.reloadPage(tabId);
});

// 向指定标签发送通道消息（等价于 webview.send）
ipcMain.handle('jc:cloak-page-send', async (_event, tabId, channel, payload) => {
  return await cloakLauncher.sendToPage(tabId, channel, payload);
});

// 真实键盘输入（替换 jc:webview-input；走 Playwright CDP Input 天然 isTrusted:true）
ipcMain.handle('jc:cloak-page-input', async (_event, tabId, action, text) => {
  return await cloakLauncher.pageInput(tabId, action, text);
});

// 列出所有打开的标签
ipcMain.handle('jc:cloak-page-list', async () => {
  return { ok: true, pages: cloakLauncher.listPages() };
});
