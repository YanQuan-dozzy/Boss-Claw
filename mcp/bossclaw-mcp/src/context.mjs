// src/context.mjs —— BossClaw MCP 的运行上下文
// ---------------------------------------------------------------------------
// 职责：路径解析（应用 / userData / 日志 / 引擎）、进程执行器（含沙箱 env 清理与
// 超时）、应用内控制桥客户端。只服务「控制已安装应用」，不含文件浏览 / 快照诊断等逻辑。
// 设计约束：**不依赖任何 npm 包**（仓库历史上有 npm install 被 EBUSY 阻断的情况），
// 只用 Node 内置模块，保证服务随时可用。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** mcp/bossclaw-mcp/src → mcp/bossclaw-mcp → mcp → <开发仓库根> */
const DEV_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const isWin = process.platform === 'win32';

/** 已安装打包版的候选安装根目录（自定义安装位置经 BOSSCLAW_INSTALL_DIR 环境变量指定）。 */
function installedAppRootCandidates() {
  return [
    process.env.BOSSCLAW_INSTALL_DIR,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'BossClaw') : '',
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'BossClaw') : '',
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'BossClaw') : '',
  ].filter(Boolean);
}

/** 同步探测已安装应用根目录（含 BossClaw.exe）；找不到返回 null。 */
function detectInstalledRootSync() {
  for (const root of installedAppRootCandidates()) {
    try {
      if (fs.statSync(path.join(root, 'BossClaw.exe')).isFile()) return root;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/**
 * 推导「应用根」：
 *   BOSSCLAW_REPO 环境变量（显式指定，优先级最高）
 *   > 自寻已安装应用（检测到 BossClaw.exe 的安装根）
 *   > DEV_REPO_ROOT（开发仓库兜底）
 */
function resolveRepoRoot() {
  if (process.env.BOSSCLAW_REPO) return path.resolve(process.env.BOSSCLAW_REPO);
  return detectInstalledRootSync() || DEV_REPO_ROOT;
}

export const REPO_ROOT = resolveRepoRoot();

/** 目标形态：installed（已安装打包版）/ dev（开发仓库）/ custom（BOSSCLAW_REPO 显式指定） */
export const MODE = process.env.BOSSCLAW_REPO
  ? 'custom'
  : (() => {
      try {
        return fs.statSync(path.join(REPO_ROOT, 'BossClaw.exe')).isFile() ? 'installed' : 'dev';
      } catch {
        return 'dev';
      }
    })();

/**
 * 应用目录：
 *   installed → <安装根>/resources/app（打包后的应用目录，含 electron/dist/node_modules）
 *   dev       → <仓库根>/desktop-app
 *   custom    → 优先 desktop-app，其次 resources/app。
 */
function resolveDesktopDir() {
  const da = path.join(REPO_ROOT, 'desktop-app');
  const ra = path.join(REPO_ROOT, 'resources', 'app');
  if (MODE === 'installed') {
    try {
      if (fs.statSync(ra).isDirectory()) return ra;
    } catch {
      /* 继续 */
    }
    return ra;
  }
  if (MODE === 'custom') {
    try {
      if (fs.statSync(da).isDirectory()) return da;
    } catch {
      /* 继续 */
    }
    try {
      if (fs.statSync(ra).isDirectory()) return ra;
    } catch {
      /* 继续 */
    }
  }
  return da;
}

export const DESKTOP_DIR = resolveDesktopDir();

/** Electron 的 app.setName('BossClaw')（electron/main.cjs:283）决定 userData 目录名 */
const APP_DIR_NAME = 'BossClaw';

function roamingDir() {
  if (isWin) return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** userData 解析：显式环境变量 > 有历史遗留的候选目录 > 标准路径 */
function resolveUserData() {
  if (process.env.BOSSCLAW_USERDATA) return process.env.BOSSCLAW_USERDATA;
  const base = roamingDir();
  const candidates = [path.join(base, APP_DIR_NAME), path.join(base, 'bossclaw-desktop')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 不存在则继续 */
    }
  }
  return candidates[0];
}

export const USERDATA_DIR = resolveUserData();
export const HOME_DIR = os.homedir();
/** 引擎/登录态数据目录（camoufox cookies、engine-state.json） */
export const BOSSCLAW_HOME = path.join(HOME_DIR, '.bossclaw');

/**
 * 控制桥信息文件的**候选路径**（读取顺序即优先级）。
 *
 * 审查 #66：应用侧 `electron/control-bridge.cjs:117-121` 在 `app.getPath('userData')` 抛错时
 * （userData 不可写 / 早期启动 / 权限受限）会把信息文件**改写到 `os.tmpdir()`**，
 * 而 MCP 侧原先只认 `<userData>/control-bridge.json` —— 一旦应用走回退分支，
 * 桥其实**已经在监听**，MCP 却报「控制桥当前不可用」，且提示里的路径指向一个不存在的文件，
 * 排查时被误导（这正是 §四表 26 提示文案里印的那个「桥信息文件」）。
 *
 * 另外 `BOSSCLAW_CONTROL_BRIDGE_FILE` 允许应用与 MCP 显式对齐同一路径（自定义部署/多实例隔离时用），
 * 与应用程序 `resolveUserData()` 读取的 `BOSSCLAW_USERDATA` 对称。
 */
function controlBridgeCandidates() {
  const list = [];
  const explicit = process.env.BOSSCLAW_CONTROL_BRIDGE_FILE;
  if (explicit) list.push(explicit);
  list.push(path.join(USERDATA_DIR, 'control-bridge.json'));
  list.push(path.join(os.tmpdir(), 'bossclaw-control-bridge.json'));
  // 去重（BOSSCLAW_CONTROL_BRIDGE_FILE 恰好等于标准路径时）
  return [...new Set(list)];
}

export const CONTROL_BRIDGE_FILES = controlBridgeCandidates();
/** 主路径（提示文案用；实际读取依次尝试 CONTROL_BRIDGE_FILES） */
export const CONTROL_BRIDGE_FILE = CONTROL_BRIDGE_FILES[0];

export const PATHS = {
  repoRoot: REPO_ROOT,
  desktop: DESKTOP_DIR,
  userData: USERDATA_DIR,
  home: HOME_DIR,
  bossclawHome: BOSSCLAW_HOME,
  controlBridgeFile: CONTROL_BRIDGE_FILE,
  electronBin: MODE === 'installed'
    ? path.join(REPO_ROOT, 'BossClaw.exe')
    : path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron'),
  distDir: path.join(DESKTOP_DIR, 'dist'),
  releaseDir: path.join(DESKTOP_DIR, 'release'),
  builtinSkills: path.join(DESKTOP_DIR, 'skills'),
  customSkills: path.join(USERDATA_DIR, 'skills'),
  engineState: path.join(BOSSCLAW_HOME, 'engine-state.json'),
  camoufoxCookies: path.join(BOSSCLAW_HOME, 'camoufox-cookies.json'),
  logs: {
    app: path.join(USERDATA_DIR, 'bossclaw-debug.log'),
    render: path.join(USERDATA_DIR, 'debug-render.log'),
    webview: path.join(USERDATA_DIR, 'bossclaw-webview-diag.log'),
  },
};

// ===========================================================================
// 安装版应用探测（打包后的 BossClaw.exe，如 <安装目录>\BossClaw.exe）
// ===========================================================================

const INSTALLED_EXE_NAME = 'BossClaw.exe';

/** electron-builder 常见安装位置（自定义目录经 BOSSCLAW_INSTALL_DIR；注册表卸载项兜底） */
function installedExeCandidates() {
  return installedAppRootCandidates().map((d) => path.join(d, INSTALLED_EXE_NAME));
}

/** NSIS / electron-builder 写入的卸载项注册表根 */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function regValue(key, valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', valueName], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout || '').match(/REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)/i);
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function resolveInstalledExeFromRegistry() {
  if (!isWin) return null;
  for (const root of UNINSTALL_ROOTS) {
    let keysText = null;
    await new Promise((resolve) => {
      execFile('reg', ['query', root], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        keysText = err ? null : String(stdout || '');
        resolve();
      });
    });
    if (!keysText) continue;
    const subKeys = keysText.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^HKEY_/i.test(s));
    for (const key of subKeys) {
      const name = await regValue(key, 'DisplayName');
      if (!name || !/boss-?claw/i.test(name)) continue;
      const loc = await regValue(key, 'InstallLocation');
      if (loc) {
        const exe = path.join(loc, INSTALLED_EXE_NAME);
        try {
          if (fs.statSync(exe).isFile()) return exe;
        } catch { /* 继续 */ }
      }
      const icon = await regValue(key, 'DisplayIcon');
      if (icon) {
        const exe = icon.split(',')[0].trim().replace(/^"|"$/g, '');
        try {
          if (fs.statSync(exe).isFile()) return exe;
        } catch { /* 继续 */ }
      }
    }
  }
  return null;
}

/**
 * 探测已安装的打包版应用可执行文件（BossClaw.exe）。
 * 优先级：BOSSCLAW_EXE 环境变量 > 常见安装目录 > 注册表卸载项（InstallLocation / DisplayIcon）。
 * 找不到时返回 null。用于 bossclaw_app_start 以 installed:true 启动安装版。
 */
export async function resolveInstalledExe() {
  const envExe = process.env.BOSSCLAW_EXE;
  if (envExe) {
    try {
      if (fs.statSync(envExe).isFile()) return envExe;
    } catch { /* 继续探测 */ }
  }
  for (const c of installedExeCandidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* 继续 */ }
  }
  return resolveInstalledExeFromRegistry();
}

/** 沙箱 / 打包环境会注入这些变量，必须清掉，否则 better-sqlite3、Electron 子进程会异常 */
const STRIPPED_ENV = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'ELECTRON_NO_ATTACH_CONSOLE'];

export function sanitizedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  return { ...env, ...extra };
}

// ===========================================================================
// 进程执行
// ===========================================================================

/** spawn 失败原因登记（键为进程句柄；句柄常驻，条目数等于启动次数，量级可忽略） */
const spawnErrors = new Map();

/** 分离式启动（用于 Electron 主进程这种需要长驻的进程），返回 pid 与进程句柄 */
export function spawnDetached(cmd, args = [], opts = {}) {
  const { cwd = DESKTOP_DIR, env = {}, stdio = 'ignore' } = opts;
  const child = spawn(cmd, args, {
    cwd,
    env: sanitizedEnv(env),
    detached: true,
    windowsHide: true,
    shell: false,
    stdio,
  });
  // 审查 #20：spawn 失败（ENOENT / EPERM / 路径不存在）**不会同步抛出**，而是异步 emit 'error'。
  // 原实现没有任何监听 → 失败被全局 uncaughtException 吞掉，调用方仍拿到一个**无效 pid**，
  // 之后 probePort / killTree 全对着空气操作（症状：「启动成功」但应用一直没起来、且无原因可查）。
  // 这里挂一个兜底监听（并把 child 一并返回，供调用方用 waitForSpawn 精确等待失败）。
  child.on('error', (e) => {
    spawnErrors.set(child, String(e?.message || e));
  });
  child.unref();
  return { pid: child.pid, cmd: [cmd, ...args].join(' '), child };
}

/** 子进程句柄 → 启动失败原因（供 waitForSpawn 读取） */
export function spawnErrorOf(child) {
  return child ? spawnErrors.get(child) || null : null;
}

/**
 * 等待 spawn 结果：区分「真的起来了」与「spawn 失败」。
 * `error` 先到 → `{ok:false}`；`spawn` 先到 → `{ok:true}`；两者都没到（事件已错过）→ 超时后按成功返回
 * （pid 存在即认为句柄有效，后续 probePort 会给出真实结论）。
 */
export function waitForSpawn(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!child) return resolve({ ok: false, error: 'spawn 未返回进程句柄' });
    const known = spawnErrors.get(child);
    if (known) return resolve({ ok: false, error: known });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.once('error', (e) => done({ ok: false, error: String(e?.message || e) }));
    child.once('spawn', () => done({ ok: true, pid: child.pid }));
    setTimeout(() => done(child.pid ? { ok: true, pid: child.pid } : { ok: false, error: 'spawn 未产生 pid' }), timeoutMs);
  });
}

export function killTree(pid) {
  if (!pid) return Promise.resolve(false);
  if (isWin) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
    });
  }
  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
    resolve(true);
  });
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 列出系统进程（Windows 用 tasklist；其它平台尽力而为） */
export function listProcesses() {
  return new Promise((resolve) => {
    if (!isWin) {
      execFile('ps', ['-eo', 'pid=,comm='], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          String(stdout)
            .split('\n')
            .map((l) => l.trim().split(/\s+/))
            .filter((p) => p.length >= 2)
            .map((p) => ({ pid: Number(p[0]), name: p.slice(1).join(' ') }))
        );
      });
      return;
    }
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = String(stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
          return { name: cells[0], pid: Number(cells[1]), memKB: Number(String(cells[4] || '').replace(/[^\d]/g, '')) || 0 };
        })
        .filter((r) => Number.isFinite(r.pid));
      resolve(rows);
    });
  });
}

export async function readTextSafe(file, maxBytes = 2 * 1024 * 1024) {
  const st = await fsp.stat(file);
  if (st.size > maxBytes) {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      await fh.read(buf, 0, maxBytes, 0);
      return { text: buf.toString('utf8'), truncated: true, size: st.size };
    } finally {
      await fh.close();
    }
  }
  return { text: await fsp.readFile(file, 'utf8'), truncated: false, size: st.size };
}

export async function readJsonSafe(file) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return { ok: true, data: JSON.parse(txt), size: Buffer.byteLength(txt) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), size: 0 };
  }
}

export async function statSafe(p) {
  try {
    const st = await fsp.stat(p);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch {
    return { exists: false, size: 0, mtime: null, mtimeMs: 0, isDir: false };
  }
}

export function truncate(text, max = 12000) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}\n... [已截断，共 ${text.length} 字符]`;
}

/** TCP 可达性探测（用于隐蔽引擎桥端口等；超时默认 800ms，失败即视为不可达） */
export function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (up) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/**
 * 读取文件末尾若干行（可选正则过滤）。供日志类工具统一复用。
 * @returns {Promise<{exists:boolean,file:string,mtime:string|null,size:number,total:number,lines:string[]}>}
 *   exists=false 时仅返回 file；total 为过滤后的总行数，lines 为末若干行。
 */
export async function tailTextFile(file, { lines = 80, filterRe = null } = {}) {
  const st = await statSafe(file);
  if (!st.exists) return { exists: false, file, mtime: null, size: 0, total: 0, lines: [] };
  const { text } = await readTextSafe(file, 4 * 1024 * 1024);
  let all = text.split(/\r?\n/).filter(Boolean);
  if (filterRe) all = all.filter((l) => filterRe.test(l));
  return { exists: true, file, mtime: st.mtime, size: st.size, total: all.length, lines: all.slice(-lines) };
}

/** 点路径读取：getPath(obj, 'config.minScore') */
export function getPath(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted)
    .split('.')
    .filter(Boolean)
    .reduce((acc, seg) => {
      if (acc == null) return undefined;
      if (Array.isArray(acc)) {
        const idx = Number(seg);
        return Number.isInteger(idx) ? acc[idx] : undefined;
      }
      return acc[seg];
    }, obj);
}

// ===========================================================================
// 应用内控制桥（127.0.0.1 HTTP + token，由 electron/control-bridge.cjs 提供）
// ===========================================================================

export async function readControlBridgeInfo() {
  // 依次尝试候选路径（审查 #66）：应用可能在 userData 不可用时把信息文件写到 tmpdir。
  // 返回首个「文件存在且含 port+token」的条目；都不存在则返回 null。
  for (const file of CONTROL_BRIDGE_FILES) {
    const parsed = await readJsonSafe(file);
    if (!parsed.ok) continue;
    const info = parsed.data;
    if (!info?.port || !info?.token) continue;
    if (info.pid && !isPidAlive(info.pid)) return { ...info, stale: true, infoFile: file };
    return { ...info, infoFile: file };
  }
  return null;
}

/**
 * 「控制桥不可用」提示（**唯一实现**，供 control.mjs / agent.mjs 共用）。
 *
 * 审查 §四表 26：原实现有两份逐字复制，且两份**已经漂移** —— `control.mjs` 带「关闭方式」一行，
 * `agent.mjs` 漏了。收敛到本模块后，agent 系工具的错误提示也一并拿到关闭方式。
 * 后续修文案只改这一处。
 */
export function bridgeHint() {
  return [
    `应用内控制桥当前不可用。启用方式（三选一）：`,
    `  1) 用 bossclaw_app_start 启动（默认带 BOSSCLAW_CONTROL=1），或`,
    `  2) 让用户运行仓库根的 start-bossclaw.cmd（本地启动器默认已开启 agent 桥），或`,
    `  3) 手动以 BOSSCLAW_CONTROL=1 启动 Electron。`,
    `关闭方式：start-bossclaw.cmd --no-agent，或 BOSSCLAW_CONTROL=0 / --no-control-bridge。`,
    `已查找桥信息文件（依次）：`,
    ...CONTROL_BRIDGE_FILES.map((f, i) => `  ${i + 1}) ${f}`),
  ].join('\n');
}

export function bridgeRequest(info, method, urlPath, body, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (!info?.port) return resolve({ ok: false, error: '控制桥未就绪' });
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    // settled 幂等守卫：timeout / error / aborted 可能双触发，首个结算生效
    // （否则后到分支的字符串会覆盖先到分支的具体错误信息）。
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(v);
    };
    // 总时长兜底：socket timeout 只管空闲，对端「缓慢滴字节」不会触发——
    // 响应中途断流（桥进程退出 / 渲染层崩溃 / 代理干预）必须有兜底，否则 Promise 永久挂起。
    const hardTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* 已结束 */
      }
      finish({ ok: false, error: `控制桥请求总超时（${timeoutMs + 5_000}ms）` });
    }, timeoutMs + 5_000);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path: urlPath,
        headers: {
          'x-bossclaw-token': info.token || '',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text };
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          finish({ ok, status: res.statusCode, data, error: ok ? undefined : data?.error || `HTTP ${res.statusCode}` });
        });
        // 响应中途断流（服务端 destroy / 进程退出）→ 必须兜底，否则永久挂起
        res.on('error', (e) => finish({ ok: false, error: `控制桥响应异常：${e?.message || e}` }));
        res.on('aborted', () => finish({ ok: false, error: '控制桥响应被中断' }));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`控制桥请求超时（${timeoutMs}ms）`));
    });
    req.on('error', (e) => finish({ ok: false, error: String(e?.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function controlCall(method, urlPath, body, timeoutMs) {
  const info = await readControlBridgeInfo();
  if (!info) {
    return {
      ok: false,
      unavailable: true,
      error:
        '应用内控制桥未开启。请用 bossclaw_app_start 启动应用（会自动开启控制桥），' +
        '或手动以 BOSSCLAW_CONTROL=1 启动。',
    };
  }
  if (info.stale) {
    // 报出**实际读取到的那份**信息文件（审查 #66）：可能有多个候选路径，报主路径会误导排查。
    return { ok: false, unavailable: true, error: `控制桥记录已失效（pid ${info.pid} 不在运行）：${info.infoFile || CONTROL_BRIDGE_FILE}` };
  }
  return bridgeRequest(info, method, urlPath, body, timeoutMs);
}

// ===========================================================================
// 结果辅助
// ===========================================================================

/** 工具返回，格式为 { text, data, isError } */
export function ok(text, data) {
  return { text: String(text ?? ''), data, isError: false };
}

export function fail(text, data) {
  return { text: String(text ?? ''), data, isError: true };
}
