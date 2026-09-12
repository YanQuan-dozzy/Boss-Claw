// src/runners/package.mjs —— 打包流水线（vite build → electron-builder）
// 单独成脚本，便于作为「一个后台任务」整体执行，避免在 MCP 进程里用定时器串联。
// 用法：node src/runners/package.mjs [nsis|portable|dir]
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..', '..', '..', 'desktop-app');
const target = process.argv[2] || 'nsis';

const env = { ...process.env };
for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH']) delete env[k];

function sh(cmd, args) {
  return new Promise((resolve) => {
    process.stdout.write(`\n=== ${[cmd, ...args].join(' ')} ===\n`);
    const child = spawn(cmd, args, { cwd: DESKTOP, env, stdio: 'inherit', windowsHide: true, shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      process.stderr.write(`spawn error: ${e?.message || e}\n`);
      resolve(1);
    });
  });
}

const sb = await sh(process.execPath, [path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
if (sb !== 0) {
  process.stderr.write('\n前置 vite build 失败，终止打包。\n');
  process.exit(sb);
}

const ebArgs = [path.join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js'), '--win'];
if (target === 'portable') ebArgs.push('portable');
if (target === 'dir') ebArgs.push('--dir');

const code = await sh(process.execPath, ebArgs);
process.exit(code);
