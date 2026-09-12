// src/procs.mjs —— 进程探测（定位 BossClaw 自己的 Electron 进程，避免误伤其它 Electron 应用）
import { execFile } from 'node:child_process';
import { listProcesses, isPidAlive, readControlBridgeInfo } from './context.mjs';

const isWin = process.platform === 'win32';

function psJson(script) {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = String(stdout).trim();
        if (!text) return resolve([]);
        try {
          const parsed = JSON.parse(text);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 列出 BossClaw 相关进程。
 *
 * ⚠️ 安全约定：拿不到命令行时（CIM 不可用）**不退化**为「返回全部 electron.exe」——
 * 那会让调用方（bossclaw_app_stop / smoke）误杀用户机器上其它 Electron 应用。
 * 宁可返回空 + 给出 warning，也不做有破坏性的猜测。
 * @returns {Promise<{processes:Array<{pid:number,name:string,commandLine?:string}>, method:'cim'|'tasklist'|'ps', bridge:object|null, warning?:string}>}
 */
export async function listBossclawProcesses() {
  const bridge = await readControlBridgeInfo();
  let processes = [];
  let method = 'tasklist';
  let warning;

  const rows = await psJson(
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='BossClaw.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
  );
  if (rows) {
    method = 'cim';
    const all = rows
      .map((r) => ({ pid: Number(r.ProcessId), name: String(r.Name || ''), commandLine: String(r.CommandLine || '') }))
      .filter((r) => Number.isFinite(r.pid));
    // 只认命令行指向本应用的进程（源码目录、release 打包产物或已安装的 BossClaw.exe）
    processes = all.filter((r) => /Boss-?claw/i.test(r.commandLine));
    if (!processes.length && all.length) {
      warning = `检测到 ${all.length} 个 electron/BossClaw 进程，但命令行均不指向 BossClaw，已按「未运行」处理（避免误伤其它应用）`;
    }
  } else {
    const all = await listProcesses();
    const named = all.filter((p) => /electron|bossclaw/i.test(p.name));
    if (!isWin) method = 'ps';
    warning = named.length
      ? `PowerShell CIM 不可用，无法核对命令行：检测到 ${named.length} 个 electron/BossClaw 进程却无法确认归属，已按「未运行」处理（避免误杀其它应用）`
      : undefined;
    processes = [];
  }

  const alive = processes.filter((p) => isPidAlive(p.pid));
  return { processes: alive, method, bridge, ...(warning ? { warning } : {}) };
}
