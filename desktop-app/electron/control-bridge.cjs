// electron/control-bridge.cjs —— 本地控制桥（供外部 agent / MCP 操作运行中的应用）
// ---------------------------------------------------------------------------
// 目的：让外部进程（如 bossclaw-mcp）能够读取运行中的实时状态并执行**白名单**动作，
// 而不需要把整个应用改成可远程调用的形态。
//
// 安全设计（默认关闭，必须显式开启）：
//   1) 仅以下任一方式开启；均未提供时完全不启动（打包版/普通 `electron .` 保持关闭）：
//        · 环境变量 BOSSCLAW_CONTROL=1
//        · 命令行开关 --control-bridge（本地启动脚本 start-bossclaw.cmd 默认带上，
//          --no-agent 可关闭）—— 走参数而非环境变量，因为启动脚本经快捷方式拉起 electron，
//          环境变量继承不如参数可靠
//      显式关闭（BOSSCLAW_CONTROL=0 / --no-control-bridge）优先。
//   2) 只监听 127.0.0.1，端口默认 17650（可用 BOSSCLAW_CONTROL_PORT 覆盖；被占用自动 +1…+9）。
//   3) 除 /health 外全部要求 `x-bossclaw-token` 头；token 随机生成并写入
//      <userData>/control-bridge.json（仅本机用户可读）。
//   4) 动作本身由渲染层 src/lib/controlRuntime.ts 白名单强制；本文件只做路由与
//      主进程侧动作（窗口 / 截图 / 重载）。
//   5) **不提供**任何发消息、批量投递、绕过验证码或速率限制的能力。
//
// 端点：
//   GET  /health               → { ok, name, version, pid, port, at }
//   GET  /state[?path=a.b.c]   → 渲染层实时状态快照（可点路径裁剪）
//   POST /action               → { action, params } → { applied, message, previous, next, ... }
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 17650;
/** 端口被占用时的尝试跨度（同时跑多个实例时不至于把桥整个废掉） */
const PORT_SPAN = 10;
const MAX_BODY = 1024 * 1024;
const MAX_SHOT_WIDTH = 1440;
/** 等待渲染层控制运行时安装的上限：应用冷启动 / 渲染层重载期间调用需要排队等待 */
const RUNTIME_WAIT_MS = 25_000;
const RUNTIME_POLL_MS = 300;

/** 主进程侧动作（其余动作全部转发给渲染层白名单） */
const MAIN_ACTIONS = new Set(['focusWindow', 'reloadRenderer', 'openDevTools', 'screenshot', 'windowState', 'minimize', 'maximize']);

/**
 * 控制桥开启判定。
 *
 * 支持两种方式，**显式关闭优先**：
 *   1) 环境变量 BOSSCLAW_CONTROL=1 / =0
 *   2) 命令行开关 --control-bridge / --no-control-bridge
 *
 * 为什么要命令行开关：本地启动脚本（start-bossclaw.cmd）是通过**快捷方式**拉起 electron 的
 * （为让任务栏显示 BossClaw 而非 Electron），这种情况环境变量是否被继承取决于 shell 行为，
 * 不如直接写进快捷方式的参数可靠 —— 参数一定会出现在 process.argv 里。
 */
function resolveEnablement() {
  const raw = process.env.BOSSCLAW_CONTROL;
  const envOn = raw === '1' || raw === 'true' || raw === 'yes';
  const envOff = raw === '0' || raw === 'false' || raw === 'no';
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const flagOn = argv.includes('--control-bridge') || argv.includes('--bossclaw-control');
  const flagOff = argv.includes('--no-control-bridge') || argv.includes('--bossclaw-no-control');

  if (flagOff) return { enabled: false, via: 'CLI 显式关闭（--no-control-bridge）' };
  if (envOff) return { enabled: false, via: '环境变量显式关闭（BOSSCLAW_CONTROL=0）' };
  if (flagOn) return { enabled: true, via: 'CLI 开关 --control-bridge' };
  if (envOn) return { enabled: true, via: '环境变量 BOSSCLAW_CONTROL' };
  return { enabled: false, via: '未开启（默认关闭）' };
}

function b64(v) {
  return Buffer.from(JSON.stringify(v === undefined ? {} : v), 'utf8').toString('base64');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function dotPath(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted)
    .split('.')
    .filter(Boolean)
    .reduce((acc, seg) => (acc == null ? undefined : acc[seg]), obj);
}

/**
 * 启动控制桥。
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow
 * @param {(level: string, msg: string, extra?: object) => void} [deps.log]
 */
function startControlBridge({ app, getWindow, log = () => {} }) {
  const enablement = resolveEnablement();
  if (!enablement.enabled) return null;
  log('info', 'control bridge enabled', { via: enablement.via });

  const basePort = Number(process.env.BOSSCLAW_CONTROL_PORT) || DEFAULT_PORT;
  const token = process.env.BOSSCLAW_CONTROL_TOKEN || crypto.randomBytes(24).toString('hex');
  let boundPort = basePort;
  let listening = false;
  let infoFile = null;
  try {
    infoFile = path.join(app.getPath('userData'), 'control-bridge.json');
  } catch {
    infoFile = path.join(os.tmpdir(), 'bossclaw-control-bridge.json');
  }

  /**
   * 等待渲染层安装控制运行时。
   * 控制桥在 createMainWindow() 之后立即监听，此刻渲染层往往还在加载（或刚被重载），
   * 因此第一次 dispatch 必须允许等待，否则外部 agent 会拿到「运行时未安装」的假失败。
   */
  async function waitForRuntime(win) {
    const deadline = Date.now() + RUNTIME_WAIT_MS;
    let lastErr = null;
    for (;;) {
      if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
        throw new Error('主窗口不可用（窗口未创建或已销毁）');
      }
      try {
        const ready = await win.webContents.executeJavaScript(
          '!!(window.__bossclawControl && typeof window.__bossclawControl.dispatch === "function")',
          false
        );
        if (ready) return;
      } catch (e) {
        // 渲染帧被销毁（页面正在导航/重载）时 executeJavaScript 会抛错，属于预期，继续等
        lastErr = e;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待渲染层控制运行时超时（${RUNTIME_WAIT_MS}ms）：window.__bossclawControl 未安装。` +
            `请确认渲染层已用最新代码构建（${'src/lib/controlRuntime.ts'} 需在 main.tsx 中 install）${lastErr ? `；最后错误：${lastErr.message}` : ''}`
        );
      }
      await new Promise((r) => setTimeout(r, RUNTIME_POLL_MS));
    }
  }

  /** 在渲染层执行白名单动作：用 base64 传参，避免字符串拼接注入 */
  async function rendererDispatch(op) {
    const win = getWindow && getWindow();
    await waitForRuntime(win);
    // 注意：atob() 返回的是「字节串」（每个字符 = 一个字节值），多字节 UTF-8（中文等）必须
    // 经 Uint8Array + TextDecoder('utf-8') 正确解码成 Unicode 字符串，否则 JSON.parse 会乱码。
    const script = `(async () => {
      try {
        var api = window.__bossclawControl;
        if (!api || typeof api.dispatch !== 'function') return { __missing: true, hint: '渲染层控制运行时未安装' };
        var raw = atob(${JSON.stringify(b64(op))});
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        var jsonText = new TextDecoder('utf-8').decode(bytes);
        return await api.dispatch(JSON.parse(jsonText));
      } catch (e) {
        return { __error: String((e && e.message) || e), stack: String((e && e.stack) || '') };
      }
    })()`;
    const out = await win.webContents.executeJavaScript(script, false);
    if (out && out.__missing) throw new Error(`渲染层控制运行时未安装（window.__bossclawControl 缺失）：${out.hint || ''}`);
    if (out && out.__error) throw new Error(`渲染层动作异常：${out.__error}`);
    return out;
  }

  async function runMainAction(action, params = {}) {
    const win = getWindow && getWindow();
    if (!win || win.isDestroyed()) throw new Error('主窗口不可用');
    switch (action) {
      case 'focusWindow':
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return { applied: true, message: '窗口已聚焦', next: { focused: win.isFocused() } };
      case 'minimize':
        win.minimize();
        return { applied: true, message: '窗口已最小化' };
      case 'maximize': {
        const before = win.isMaximized();
        if (before) win.unmaximize();
        else win.maximize();
        return { applied: true, message: before ? '已取消最大化' : '已最大化', previous: before, next: win.isMaximized() };
      }
      case 'reloadRenderer':
        win.webContents.reload();
        return { applied: true, message: '渲染层已重载（控制桥仍可用）' };
      case 'openDevTools':
        win.webContents.openDevTools({ mode: params.mode === 'detach' ? 'detach' : 'right' });
        return { applied: true, message: '已尝试打开 DevTools' };
      case 'windowState':
        return {
          applied: true,
          message: '窗口状态',
          next: {
            visible: win.isVisible(),
            focused: win.isFocused(),
            minimized: win.isMinimized(),
            maximized: win.isMaximized(),
            fullScreen: win.isFullScreen(),
            bounds: win.getBounds(),
            alwaysOnTop: win.isAlwaysOnTop(),
            title: win.getTitle(),
          },
        };
      case 'screenshot': {
        const image = await win.webContents.capturePage();
        const size = image.getSize();
        const target = size.width > MAX_SHOT_WIDTH ? image.resize({ width: MAX_SHOT_WIDTH }) : image;
        const png = target.toPNG();
        const dir = path.join(app.getPath('userData'), 'control-screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        fs.writeFileSync(file, png);
        log('info', 'control bridge screenshot', { file, bytes: png.length, size: target.getSize() });
        return {
          applied: true,
          message: `已截图并保存：${file}（${png.length} 字节，${target.getSize().width}x${target.getSize().height}）`,
          next: { file, bytes: png.length, size: target.getSize() },
          __image: { base64: png.toString('base64'), mimeType: 'image/png' },
        };
      }
      default:
        throw new Error(`未知主进程动作：${action}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const sendJson = (code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      const route = url.pathname;

      if (route === '/health' && req.method === 'GET') {
        return sendJson(200, {
          ok: true,
          name: 'bossclaw-control',
          version: (() => { try { return app.getVersion(); } catch { return null; } })(),
          pid: process.pid,
          port: boundPort,
          at: Date.now(),
        });
      }

      if (req.headers['x-bossclaw-token'] !== token) {
        return sendJson(401, { ok: false, error: 'token 无效' });
      }

      if (route === '/state' && req.method === 'GET') {
        const snap = await rendererDispatch({ action: 'state' });
        // state 动作返回 { applied, message, next: 快照 }，这里只暴露快照本体
        const body = snap && snap.next !== undefined ? snap.next : snap;
        const wanted = url.searchParams.get('path');
        const picked = wanted ? dotPath(body, wanted) : body;
        return sendJson(200, { ok: true, at: Date.now(), pid: process.pid, port: boundPort, state: picked });
      }

      // ===== 单向链路：仅外部 agent 经 MCP 调用 /action、/state 操作应用（无 app→agent 通道）=====

      if (route === '/action' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          return sendJson(400, { ok: false, error: `请求体不是合法 JSON：${e.message}` });
        }
        const action = String(body.action || '');
        const params = body.params && typeof body.params === 'object' ? body.params : {};
        if (!action) return sendJson(400, { ok: false, error: '缺少 action' });
        try {
          const result = MAIN_ACTIONS.has(action) ? await runMainAction(action, params) : await rendererDispatch({ action, params });
          const image = result && result.__image;
          if (result && result.__image) delete result.__image;
          log('info', 'control bridge action', { action, applied: !!result?.applied });
          return sendJson(200, { ok: true, ...(result || {}), ...(image ? { image } : {}) });
        } catch (e) {
          log('warn', 'control bridge action failed', { action, error: String(e?.message || e) });
          return sendJson(400, { ok: false, applied: false, error: String(e?.message || e), action });
        }
      }

      return sendJson(404, { ok: false, error: `未知路由 ${route}` });
    } catch (e) {
      return sendJson(500, { ok: false, error: String(e?.message || e) });
    }
  });

  // 端口回退：17650 被占用（例如又开了一个实例）时依次尝试后续端口，
  // 否则第二个实例的桥会整个不可用（旧实现固定端口，遇 EADDRINUSE 只打日志）。
  server.on('error', (e) => log('warn', 'control bridge server error', { error: String(e?.message || e), code: e?.code }));

  function writeInfo(port) {
    const info = {
      port,
      token,
      pid: process.pid,
      startedAt: Date.now(),
      enabledVia: enablement.via,
      userData: (() => { try { return app.getPath('userData'); } catch { return null; } })(),
    };
    try {
      fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      console.error('[control-bridge] 写 info 文件失败：', e?.message || e);
    }
    return info;
  }

  function tryListen(index) {
    const port = basePort + index;
    const onError = (e) => {
      server.removeListener('listening', onListening);
      if (e?.code === 'EADDRINUSE' && index < PORT_SPAN - 1) {
        log('warn', 'control bridge port busy, trying next', { port, next: port + 1 });
        setTimeout(() => tryListen(index + 1), 50);
        return;
      }
      log('error', 'control bridge listen failed', { error: String(e?.message || e), port });
      console.error('[control-bridge] 启动失败：', e?.message || e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      boundPort = port;
      listening = true;
      writeInfo(port);
      log('info', 'control bridge ready', { port, infoFile });
      console.log(`[control-bridge] 已监听 http://127.0.0.1:${port}（信息文件 ${infoFile}）`);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  }

  tryListen(0);

  return {
    get port() {
      return boundPort;
    },
    /** 是否真正监听成功（端口回退失败时为 false，调用方据此判定通道不可用） */
    isListening() {
      return listening;
    },
    stop() {
      listening = false;
      try {
        server.close();
      } catch {
        /* 忽略 */
      }
      try {
        if (infoFile) fs.rmSync(infoFile, { force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

module.exports = { startControlBridge, resolveEnablement, CONTROL_BRIDGE_ENV: 'BOSSCLAW_CONTROL' };
