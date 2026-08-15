// scripts/check-fresh.mjs —— 判断 dist 构建产物是否新鲜（供 start-bossclaw.cmd 快速路径使用）
//
// 规则：dist/index.html 的 mtime 若早于任意渲染层源码（src/、index.html、vite.config.ts），
// 说明源码在上次构建之后改过，需要重建。electron/ 主进程代码不经 vite 打包，不计入。
//
// 退出码：
//   0 = 新鲜（dist 可直接启动）
//   1 = 源码更新，需要重建
//   2 = dist 缺失（调用方应先做存在性检查，这里兜底）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(root, 'dist', 'index.html');

if (!fs.existsSync(distIndex)) process.exit(2);

const distMtime = fs.statSync(distIndex).mtimeMs;

// 只扫描会影响 vite 产物的输入：渲染层源码 + 入口 + 构建配置
const scanTargets = ['src', 'index.html', 'vite.config.ts'];
let newest = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.vite') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else {
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* 忽略无法读取的文件 */
      }
    }
  }
}

for (const target of scanTargets) {
  const p = path.join(root, target);
  try {
    if (fs.statSync(p).isDirectory()) walk(p);
    else newest = Math.max(newest, fs.statSync(p).mtimeMs);
  } catch {
    /* 目标不存在则跳过 */
  }
}

process.exit(newest > distMtime ? 1 : 0);
