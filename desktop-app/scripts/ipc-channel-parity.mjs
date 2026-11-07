// ipc-channel-parity.mjs —— IPC 通道清单一致性回归
//
// 背景（2026-10-21 分模块审查 B-4）：
//   `electron/preload/app.cjs` 的 `ALLOWED_IPC_CHANNELS` 文件头写着「表 = main.cjs / electron/*.cjs
//   中出现的全部 jc: 通道」。审查时实测主进程注册 116 个、白名单 113 个，缺
//   `jc:save-pdf-batch` / `jc:save-pdf-batch-cancel` / `jc:save-pdf-batch-progress`
//   —— 当时不影响功能（渲染层用等价的具名方法直连 ipcRenderer，不过白名单），但这类
//   「清单型不变量」靠人眼维护必然再次漂移。本脚本把它变成可执行断言。
//
// 断言三件事：
//   1) 主进程侧出现的每个 `jc:` 通道都在白名单里（否则有人用通用 invoke 调用时会被拒）；
//   2) 白名单里没有「主进程从未注册、渲染层也从未引用」的死通道；
//   3) 渲染层（src/**.ts(x)）里直接写出的 `jc:` 字面量都在白名单里。
//
// 取证方式：直接读源码文本做集合运算，**不复制任何通道清单**——清单只以代码为准。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ELECTRON_DIR = join(root, 'electron');
const SRC_DIR = join(root, 'src');
const PRELOAD_APP = join(ELECTRON_DIR, 'preload', 'app.cjs');

const CH_RE = /jc:[a-z0-9-]+/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function collect(files, exts, mutate) {
  const set = new Set();
  for (const file of files) {
    if (!exts.some((e) => file.endsWith(e))) continue;
    let text = readFileSync(file, 'utf8');
    if (mutate) text = mutate(file, text);
    for (const m of text.match(CH_RE) || []) set.add(m);
  }
  return set;
}

// ===== 1) 解析白名单（唯一权威：preload/app.cjs 的 Set 字面量）=====
const appSrc = readFileSync(PRELOAD_APP, 'utf8');
const setStart = appSrc.indexOf('const ALLOWED_IPC_CHANNELS = new Set([');
const setEnd = setStart < 0 ? -1 : appSrc.indexOf(']);', setStart);
if (setStart < 0 || setEnd < 0) {
  console.error('❌ 无法在 electron/preload/app.cjs 定位 ALLOWED_IPC_CHANNELS（标记被改动？请同步本脚本）');
  process.exit(1);
}
const whitelist = new Set(appSrc.slice(setStart, setEnd).match(CH_RE) || []);
if (!whitelist.size) {
  console.error('❌ ALLOWED_IPC_CHANNELS 解析为空，脚本失效');
  process.exit(1);
}

// ===== 2) 主进程侧通道（排除白名单声明块本身，否则等于自证）=====
const electronFiles = walk(ELECTRON_DIR).filter((f) => f !== PRELOAD_APP).concat([PRELOAD_APP]);
const mainChannels = collect(electronFiles, ['.cjs', '.js', '.mjs'], (file, text) => (
  file === PRELOAD_APP
    ? text.slice(0, setStart) + text.slice(setEnd) // 只挖掉 Set 字面量，保留本文件的其它通道引用
    : text
));

// ===== 3) 渲染层直写的通道 =====
const srcChannels = collect(walk(SRC_DIR), ['.ts', '.tsx']);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
}

const missing = [...mainChannels].filter((c) => !whitelist.has(c)).sort();
check('主进程出现的通道都在白名单内', missing.length === 0,
  missing.length ? `缺少 ${missing.length} 条：${missing.join(', ')}` : '');

const srcMissing = [...srcChannels].filter((c) => !whitelist.has(c)).sort();
check('渲染层直写的通道都在白名单内', srcMissing.length === 0,
  srcMissing.length ? `缺少 ${srcMissing.length} 条：${srcMissing.join(', ')}` : '');

const dead = [...whitelist].filter((c) => !mainChannels.has(c) && !srcChannels.has(c)).sort();
check('白名单没有死通道（主进程与渲染层都不引用）', dead.length === 0,
  dead.length ? `疑似死通道 ${dead.length} 条：${dead.join(', ')}` : '');

check('白名单无重复声明', (appSrc.slice(setStart, setEnd).match(CH_RE) || []).length === whitelist.size,
  `字面量 ${(appSrc.slice(setStart, setEnd).match(CH_RE) || []).length} 条 / 去重后 ${whitelist.size} 条`);

check('通道命名规范（小写字母、数字、连字符）',
  [...whitelist].every((c) => /^jc:[a-z0-9-]+$/.test(c)));

// 主进程注册数与白名单数只作为观测输出，不设阈值——新增通道时两边同步即自然相等
console.log(`\n[IPC 通道清单] 白名单 ${whitelist.size} 条 · 主进程引用 ${mainChannels.size} 条 · 渲染层直写 ${srcChannels.size} 条`);
console.log(`\n[IPC 通道一致性回归] 通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\n修复：把缺失通道补进 electron/preload/app.cjs 的 ALLOWED_IPC_CHANNELS（或在 main.cjs 删掉死通道）。');
  process.exit(1);
}
console.log('全部通过：白名单与主进程 / 渲染层的通道清单一致');
