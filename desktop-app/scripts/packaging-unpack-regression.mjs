// 打包解包一致性回归：Python 侧从磁盘读的文件，必须真的落在 app.asar.unpacked 里（零新增依赖）
//
// 为什么需要它（issue #24）：
//   camoufox/platforms/liepin.py 在**模块导入期**执行
//     (Path(__file__).resolve().parents[2] / 'electron' / 'preload' / 'liepin-im.cjs').read_text(...)
//   `camoufox/**` 是 unpack 的，所以打包后 parents[2] 落在 app.asar.unpacked\，
//   但 `electron/preload/liepin-im.cjs` 只打进 app.asar 内部（asarUnpack 未包含、条目无 unpacked 标记），
//   于是桥进程 import 阶段就 FileNotFoundError 退出，四个平台全部不可用。
//   electron-builder 的 asarUnpack 是**纯配置**，改错不会让任何现有测试变红 —— 只能靠静态守卫。
//
// 本脚本守住两条不变量：
//   1. camoufox/** 下所有 .py 仍在 asarUnpack 内（桥进程整个目录都要在磁盘上运行）；
//   2. Python 源码里以 'electron' / 'preload' / '<file>' 形式引用并 read_text 的文件，
//      必须存在于 electron/preload/ 且被某个 asarUnpack 模式覆盖。
//
// build.asar=false 时 electron-builder 不产出 app.asar / app.asar.unpacked，文件本来就以
// 明文目录分发，unpack 覆盖断言不适用（本地开发线即为此形态；公开发布线为 asar: true），
// 此时跳过覆盖类断言，仍校验「源码引用存在」。
//
// 用法：node scripts/packaging-unpack-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // desktop-app/

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass += 1;
  else failures.push(detail ? `${name}\n      ${detail}` : name);
}

/** 极简 glob（只支持本项目 asarUnpack 用到的 ** / *），返回匹配器 */
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // `a/**/b` 里的多余斜杠不强制
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/** 递归收集指定后缀的文件（posix 相对路径） */
function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const asarEnabled = pkg?.build?.asar !== false;
  const patterns = asarEnabled ? (pkg?.build?.asarUnpack ?? []) : [];
  if (asarEnabled) {
    ok('package.json 存在 build.asarUnpack', Array.isArray(patterns) && patterns.length > 0,
      `实际：${JSON.stringify(patterns)}`);
  } else {
    console.log('[打包解包一致性] build.asar=false：未启用 asar 打包，跳过 unpack 覆盖断言');
  }

  const matchers = patterns.map((p) => ({ pattern: p, re: globToRegExp(p) }));
  const covered = (relPath) => matchers.some((m) => m.re.test(relPath));

  // 匹配器自检：守卫本身不能是空转的
  ok('glob 自检：camoufox/** 命中 camoufox/platforms/liepin.py',
    globToRegExp('camoufox/**').test('camoufox/platforms/liepin.py'));
  ok('glob 自检：camoufox/** 不命中 electron/preload/liepin-im.cjs',
    !globToRegExp('camoufox/**').test('electron/preload/liepin-im.cjs'));
  ok('glob 自检：electron/preload/** 命中 electron/preload/liepin-im.cjs',
    globToRegExp('electron/preload/**').test('electron/preload/liepin-im.cjs'));

  // 不变量 1：camoufox 下所有 .py 都要 unpack（桥进程按 __file__ 找同级资源）
  const pyFiles = walk(join(root, 'camoufox'), '.py');
  ok('camoufox 下存在 .py 文件', pyFiles.length > 0, `实际找到 ${pyFiles.length} 个`);
  const notUnpacked = pyFiles
    .map((f) => relative(root, f).split(sep).join('/'))
    .filter((rel) => !covered(rel));
  if (asarEnabled) {
    ok('camoufox/** 下所有 .py 均被 asarUnpack 覆盖', notUnpacked.length === 0,
      notUnpacked.length ? `未覆盖：${notUnpacked.slice(0, 5).join(', ')}` : '');
  }

  // 不变量 2：Python 从磁盘读的 electron/preload 文件必须存在于磁盘且被 unpack
  // 源码形态固定为：/ 'electron' / 'preload' / '<file>'
  const PRELOAD_REF = /['"]electron['"]\s*\/\s*['"]preload['"]\s*\/\s*['"]([^'"]+)['"]/g;
  const refs = new Map(); // file -> [引用它的 .py]
  for (const f of pyFiles) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(PRELOAD_REF)) {
      const py = relative(root, f).split(sep).join('/');
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push(py);
    }
  }
  ok('Python 侧存在 electron/preload 文件引用', refs.size > 0,
    '若已改为内联/package data，请同步删掉本守卫');

  for (const [name, pys] of refs) {
    const rel = `electron/preload/${name}`;
    ok(`${rel} 存在于源码树（被 ${pys.join(', ')} 引用）`, existsSync(join(root, rel)));
    if (asarEnabled) {
      ok(`${rel} 被 asarUnpack 覆盖`, covered(rel),
        `当前 asarUnpack：${JSON.stringify(patterns)}\n      ` +
        `后果：打包后 Python 在导入期 FileNotFoundError，隐身引擎起不来`);
    }
  }

  // issue #24 的直接回归：这个具体文件一度只打进 asar 内部
  if (asarEnabled) {
    ok('回归 #24：electron/preload/liepin-im.cjs 被 unpack',
      covered('electron/preload/liepin-im.cjs'));
  }
} catch (err) {
  failures.push(`执行失败：${err?.message || err}`);
}

if (failures.length) {
  console.error(`\n[打包解包一致性] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[打包解包一致性] 全部通过：${pass} 项断言`);
}
