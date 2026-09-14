// src/context.mjs —— BossClaw MCP 的运行上下文
// ---------------------------------------------------------------------------
// 职责：路径解析（仓库 / userData / 备份 / 日志 / 引擎）、进程执行器（含沙箱 env 清理与
// 超时）、文件遍历与文本搜索、备份快照解析、应用内控制桥客户端。
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
export const MCP_DIR = path.resolve(__dirname, '..');

/** 持久化「用户指定工作区根」的覆盖文件（纯文本一行绝对路径）；由 bossclaw_workspace 工具读写 */
export const WORKSPACE_FILE = path.join(MCP_DIR, '.workspace-root');

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
 * 判断一个根目录是否为「BossClaw 工作区」及其完整度。用于自寻路径与工具展示。
 * @returns {{root:string,type:'installed'|'dev',hasExe:boolean,packageJson:boolean,hasDesktopApp:boolean,bossclawRoot:boolean,complete:boolean}}
 */
export function workspaceHealth(root) {
  if (!root) root = '';
  const hasExe = existsFileSync(path.join(root, 'BossClaw.exe'));
  const hasDesktopApp = existsDirSync(path.join(root, 'desktop-app'));
  const installedPkg = existsFileSync(path.join(root, 'resources', 'app', 'package.json'));
  const devPkg = hasDesktopApp && existsFileSync(path.join(root, 'desktop-app', 'package.json'));
  const bossclawRoot = existsFileSync(path.join(root, 'AGENTS.md')) || hasDesktopApp || existsDirSync(path.join(root, 'mcp'));
  const type = hasExe ? 'installed' : 'dev';
  const complete = hasExe ? installedPkg : devPkg;
  return { root, type, hasExe, packageJson: hasExe ? installedPkg : devPkg, hasDesktopApp, bossclawRoot, complete };
}

/** 列出所有可被解析为工作区的候选根（安装根 + 开发仓库根），附健康度与原因。 */
export function listWorkspaceCandidates() {
  const roots = [...installedAppRootCandidates(), DEV_REPO_ROOT];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const h = workspaceHealth(root);
    let reason;
    if (h.type === 'installed' && !h.complete) reason = '存在 BossClaw.exe 但缺 resources/app/package.json（可能为旧副本）';
    else if (h.complete) reason = '完整可用的工作区';
    else if (!h.hasExe && !h.hasDesktopApp) reason = '未发现 BossClaw 标志，跳过';
    else reason = '不完整';
    out.push({ ...h, reason });
  }
  return out;
}

/**
 * 自寻路径：在候选里优先选择「完整 bundle」的工作区。
 *   - 优先返回「完整」的安装版（有 BossClaw.exe 且 resources/app/package.json 存在）；
 *   - 若无完整安装版，但有完整开发仓库（desktop-app/package.json 存在）则返回开发仓库；
 *   - 否则回退到首个安装根（保持现状兜底），最后才是开发仓库根。
 */
function bestWorkspaceRoot() {
  const candidates = listWorkspaceCandidates();
  const completeInstalled = candidates.find((c) => c.type === 'installed' && c.complete);
  if (completeInstalled) return completeInstalled.root;
  const completeDev = candidates.find((c) => c.type === 'dev' && c.complete);
  if (completeDev) return completeDev.root;
  const notBrokenInstalled = candidates.find((c) => c.type === 'installed' && !c.complete);
  if (notBrokenInstalled) return notBrokenInstalled.root;
  return DEV_REPO_ROOT;
}

/** 读取持久化覆盖的工作区根（无有效值返回 ''）。 */
function readWorkspaceOverride() {
  try {
    const p = fs.readFileSync(WORKSPACE_FILE, 'utf8').trim();
    return p && existsDirSync(p) ? p : '';
  } catch {
    return '';
  }
}

/** 原子写入持久化覆盖（UTF-8 一行）。 */
export function setWorkspaceOverride(root) {
  const target = path.normalize(String(root || '').trim());
  if (!target) return false;
  fs.mkdirSync(MCP_DIR, { recursive: true });
  const tmp = `${WORKSPACE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, target, 'utf8');
  fs.renameSync(tmp, WORKSPACE_FILE);
  return true;
}

/** 清除持久化覆盖，返回是否成功。 */
export function clearWorkspaceOverride() {
  try {
    fs.unlinkSync(WORKSPACE_FILE);
    return true;
  } catch {
    return false;
  }
}

function existsFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function existsDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 推导「工作区 / 项目根」：
 *   BOSSCLAW_REPO 环境变量（显式指定，优先级最高）
 *   > WORKSPACE_FILE 持久化覆盖（bossclaw_workspace 工具写入）
 *   > bestWorkspaceRoot()（自寻路径：优先完整 bundle，避免旧安装副本）
 *   > DEV_REPO_ROOT（最后兜底）
 */
function resolveRepoRoot() {
  if (process.env.BOSSCLAW_REPO) return path.resolve(process.env.BOSSCLAW_REPO);
  const override = readWorkspaceOverride();
  if (override) return override;
  return bestWorkspaceRoot();
}

export const REPO_ROOT = resolveRepoRoot();
export const WORKSPACE_OVERRIDE_ACTIVE = Boolean(readWorkspaceOverride());

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

function readTextSync(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 备份目录：userData/.backup-dir.txt 指针优先，否则 userData/backup */
function resolveBackupDir() {
  const pointer = readTextSync(path.join(USERDATA_DIR, '.backup-dir.txt'));
  if (pointer) return pointer;
  return path.join(USERDATA_DIR, 'backup');
}

export const BACKUP_DIR = resolveBackupDir();
export const BACKUP_FILE = path.join(BACKUP_DIR, 'bossclaw-local-backup.json');
export const QUALIFIED_JOBS_DIR_FILE = path.join(USERDATA_DIR, '.qualified-jobs-dir.txt');
export const CONTROL_BRIDGE_FILE = path.join(USERDATA_DIR, 'control-bridge.json');

export const PATHS = {
  repoRoot: REPO_ROOT,
  desktop: DESKTOP_DIR,
  userData: USERDATA_DIR,
  home: HOME_DIR,
  bossclawHome: BOSSCLAW_HOME,
  backupDir: BACKUP_DIR,
  backupFile: BACKUP_FILE,
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

const MAX_STREAM_BYTES = 512 * 1024;

function clipStream(buf) {
  const s = buf.toString('utf8');
  if (s.length <= MAX_STREAM_BYTES) return { text: s, truncated: false };
  // 构建/打包的报错通常在尾部，头部含启动信息，故保头 + 保尾
  const head = s.slice(0, 32 * 1024);
  const tail = s.slice(-(64 * 1024));
  return { text: `${head}\n\n... [已截断 ${s.length - head.length - tail.length} 字符] ...\n\n${tail}`, truncated: true };
}

/**
 * 执行一个子进程并等待结束。
 * @returns {Promise<{ok:boolean,code:number|null,signal:string|null,stdout:string,stderr:string,durationMs:number,timedOut:boolean,cmd:string}>}
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd = DESKTOP_DIR, timeoutMs = 120_000, env = {}, maxBytes = MAX_STREAM_BYTES } = opts;
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: sanitizedEnv(env),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, code: null, signal: null, stdout: '', stderr: String(e?.message || e), durationMs: 0, timedOut: false, cmd: [cmd, ...args].join(' ') });
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid).catch(() => {});
    }, Math.max(1_000, timeoutMs));

    child.stdout?.on('data', (d) => {
      outLen += d.length;
      if (outLen <= maxBytes * 2) out.push(d);
    });
    child.stderr?.on('data', (d) => {
      errLen += d.length;
      if (errLen <= maxBytes * 2) err.push(d);
    });

    const finish = (code, signal, spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const o = clipStream(Buffer.concat(out));
      const e = clipStream(Buffer.concat(err));
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout: o.text,
        stderr: spawnErr ? `${e.text}${e.text ? '\n' : ''}${spawnErr}` : e.text,
        durationMs: Date.now() - started,
        timedOut,
        cmd: [cmd, ...args].join(' '),
      });
    };

    child.on('error', (e) => finish(null, null, String(e?.message || e)));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

/** 分离式启动（用于 Electron 主进程这种需要长驻的进程），返回 pid */
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
  child.unref();
  return { pid: child.pid, cmd: [cmd, ...args].join(' ') };
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

export async function findProcesses(namePattern) {
  const all = await listProcesses();
  const re = namePattern instanceof RegExp ? namePattern : new RegExp(namePattern, 'i');
  return all.filter((p) => re.test(p.name));
}

// ===========================================================================
// 文件工具
// ===========================================================================

export const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'dist',
  'release',
  '__pycache__',
  '.pytest_cache',
  'tmp',
  'scripts-tmp',
  '.trae',
  '.wiki-pub',
]);

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function relToRepo(p) {
  const r = path.relative(REPO_ROOT, p);
  return r.startsWith('..') ? p : r.split(path.sep).join('/');
}

/** 把用户传入的相对路径解析为仓库内绝对路径；越界直接抛错（防目录穿越） */
export function resolveInRepo(input, { allowOutside = false } = {}) {
  if (!input || typeof input !== 'string') throw new Error('path 不能为空');
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(REPO_ROOT, input);
  if (!allowOutside) {
    const rel = path.relative(REPO_ROOT, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`路径越界（仅允许仓库内）：${input}`);
    }
  }
  return abs;
}

/** 递归遍历文件（默认跳过 node_modules 等大目录），yield 绝对路径 */
export async function* walkFiles(root, opts = {}) {
  const { ignores = DEFAULT_IGNORES, maxFiles = 20000, maxDepth = 24, followSymlinks = false } = opts;
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ignores.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        count += 1;
        if (count > maxFiles) return;
        yield full;
      } else if (ent.isSymbolicLink() && followSymlinks) {
        try {
          const st = await fsp.stat(full);
          if (st.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
          else {
            count += 1;
            yield full;
          }
        } catch {
          /* 断链忽略 */
        }
      }
    }
  }
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

export async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
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

// ===========================================================================
// 持久化状态（备份快照 / zustand persist 键）
// ===========================================================================

export const PERSIST_KEYS = ['bossclaw-app', 'bossclaw-settings-v2', 'bossclaw-data', 'bossclaw-schedule'];

/** 单键解析：persist 存储格式为 {"state":{...},"version":n}，兼容直存对象 */
function parsePersistValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const obj = JSON.parse(String(raw));
    if (obj && typeof obj === 'object' && 'state' in obj) return obj;
    return { state: obj, version: null };
  } catch (e) {
    return { __parseError: String(e?.message || e) };
  }
}

/** 读取本地备份快照（应用每 5 分钟脏检查写盘一次；未运行时会偏旧） */
export async function readSnapshot() {
  const info = await statSafe(BACKUP_FILE);
  if (!info.exists) {
    return { ok: false, error: `未找到备份快照：${BACKUP_FILE}`, file: BACKUP_FILE };
  }
  const parsed = await readJsonSafe(BACKUP_FILE);
  if (!parsed.ok) return { ok: false, error: parsed.error, file: BACKUP_FILE };
  const bundle = parsed.data || {};
  const keys = {};
  for (const [k, v] of Object.entries(bundle.keys || {})) keys[k] = parsePersistValue(v);
  return {
    ok: true,
    file: BACKUP_FILE,
    fileInfo: info,
    updatedAt: bundle.updatedAt || null,
    updatedAtIso: bundle.updatedAt ? new Date(bundle.updatedAt).toISOString() : null,
    ageMinutes: bundle.updatedAt ? Math.round((Date.now() - bundle.updatedAt) / 60000) : null,
    keys,
  };
}

/** 从持久化键对象中取 state（自动剥掉 zustand 的 {state,version} 外壳） */
export function stateOf(parsedKey) {
  if (!parsedKey || typeof parsedKey !== 'object') return null;
  return 'state' in parsedKey ? parsedKey.state : parsedKey;
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
  const parsed = await readJsonSafe(CONTROL_BRIDGE_FILE);
  if (!parsed.ok) return null;
  const info = parsed.data;
  if (!info?.port || !info?.token) return null;
  if (info.pid && !isPidAlive(info.pid)) return { ...info, stale: true };
  return info;
}

export function bridgeRequest(info, method, urlPath, body, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (!info?.port) return resolve({ ok: false, error: '控制桥未就绪' });
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
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
          resolve({ ok, status: res.statusCode, data, error: ok ? undefined : data?.error || `HTTP ${res.statusCode}` });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`控制桥请求超时（${timeoutMs}ms）`));
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e?.message || e) }));
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
    return { ok: false, unavailable: true, error: `控制桥记录已失效（pid ${info.pid} 不在运行）：${CONTROL_BRIDGE_FILE}` };
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

/** 由 {ok:false, error} 形式的执行结果生成失败返回 */
export function fromExecError(tool, res, extra) {
  const detail = [res.stderr, res.stdout].filter(Boolean).join('\n');
  return fail(
    `${tool} 执行失败：${res.timedOut ? `超时（${res.durationMs}ms）` : `退出码 ${res.code}`}\n命令：${res.cmd}\n\n${truncate(detail, 8000)}`,
    { ...res, ...extra, isError: true }
  );
}
