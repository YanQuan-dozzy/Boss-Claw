// scripts/check-fresh.mjs —— 判断 dist 构建产物是否新鲜（供 start-bossclaw.cmd 快速路径使用）
//
// 旧逻辑用「源码 mtime 是否晚于 dist/index.html mtime」判定，脆弱：当源码文件 mtime 被
// 环境/工具（git 检出、沙箱写文件、IDE 保存）重置成旧时间时，会误判为「新鲜」→ 跳过重建 →
// 启动的是上一次（不含最新改动）的 dist（"重新构建但启动没更新" 的根因）。
//
// 新逻辑：对全部会影响 vite 产物的输入（src/、index.html、vite.config.ts）计算内容 SHA-1
// 快照，与上次构建写入 dist/.build-stamp 的快照比对。内容一致才视为新鲜，彻底排除 mtime 干扰。
//
// 退出码：
//   0 = 新鲜（dist 可直接启动）
//   1 = 源码已变更，需要重建
//   2 = dist 缺失（调用方应先做存在性检查，这里兜底）
//
// 用法：
//   node scripts/check-fresh.mjs         判断新鲜度（exit 0/1/2）
//   node scripts/check-fresh.mjs --write 构建后写入快照（需 dist/index.html 已存在）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(root, 'dist', 'index.html');
const stampPath = path.join(root, 'dist', '.build-stamp');

// 只扫描会影响 vite 产物的输入：渲染层源码 + 入口 + 构建配置
const scanTargets = ['src', 'index.html', 'vite.config.ts'];

function hashFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// 收集目录内所有文件的内容哈希（忽略 node_modules / dist / .vite）
function hashTree(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.vite') continue;
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) hashTree(p, out);
      else {
        const h = hashFile(p);
        if (h) out.push(h + ':' + entry.name);
      }
    } catch {
      /* 忽略无法读取的文件 */
    }
  }
}

// 计算当前源码快照
const parts = [];
for (const target of scanTargets) {
  const p = path.join(root, target);
  try {
    if (fs.statSync(p).isDirectory()) {
      const hs = [];
      hashTree(p, hs);
      parts.push(...hs.sort());
    } else {
      const h = hashFile(p);
      if (h) parts.push(h + ':' + target);
    }
  } catch {
    /* 目标不存在则跳过 */
  }
}
const current = crypto.createHash('sha1').update(parts.join('|')).digest('hex');

// 写入模式：构建成功后由 start-bossclaw.cmd 调用，把快照落盘
if (process.argv.includes('--write')) {
  if (!fs.existsSync(distIndex)) process.exit(2);
  try {
    fs.writeFileSync(stampPath, current);
  } catch {
    /* 写戳失败不阻塞启动，下次仍会按缺失处理重建 */
  }
  process.exit(0);
}

if (!fs.existsSync(distIndex)) process.exit(2);

let stamp = '';
try {
  stamp = fs.readFileSync(stampPath, 'utf8').trim();
} catch {
  stamp = '';
}
// 无快照（首次/旧版升级）或快照不一致 → 需重建
process.exit(stamp === current ? 0 : 1);
