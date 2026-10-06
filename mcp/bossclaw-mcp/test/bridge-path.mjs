// 桥信息文件路径解析断言（审查 #66 / 批次 10）
// ---------------------------------------------------------------------------
// 背景：应用侧 electron/control-bridge.cjs 在 `app.getPath('userData')` 抛错时会把
//       info 文件**改写到 os.tmpdir()**；MCP 侧若只认 `<userData>/control-bridge.json`，
//       就会出现「桥其实已在监听，MCP 却报控制桥不可用」——且错误提示里印的路径不存在，
//       排查时被误导。本测试用「写一份真文件到候选路径」的方式**实跑**验证多路径查找。
//
// 覆盖：
//   1) 候选路径集合：至少含 userData 与 tmpdir 两条（顺序：显式 > userData > tmpdir）
//   2) 只有 tmpdir 有文件时，readControlBridgeInfo 仍能命中（核心防回归点）
//   3) 返回值带 infoFile，指出**实际命中的**那份路径
//   4) bridgeHint 列出全部已查找路径（不再是误导性的单一主路径）
//   5) 全部候选都不存在时返回 null
//   6) 文件存在但缺 port/token 视为无效，继续找下一个候选
//
// 用法：node test/bridge-path.mjs（独立）；亦可被 selftest.mjs import 复用（runBridgePath）。
// 注意：测试会在 os.tmpdir() 写临时文件，结束前**必定还原/清理**（含异常路径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 执行桥路径断言；返回失败项数（0 = 通过）。供 selftest.mjs 复用（不打印逐项 ✅ 以外的汇总噪声）。
 * @returns {Promise<number>} 失败数
 */
export async function runBridgePath() {
  const tmpFile = path.join(os.tmpdir(), 'bossclaw-control-bridge.json');
  const userDataFile = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'BossClaw',
    'control-bridge.json'
  );

  let pass = 0;
  const failures = [];
  const quiet = !process.argv[1] || !process.argv[1].endsWith('bridge-path.mjs');
  function check(name, got, want) {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    if (ok) {
      pass += 1;
      if (!quiet) console.log(`✅ ${name}`);
    } else {
      failures.push(name);
      if (!quiet) console.error(`✗ ${name}\n    期望: ${want}\n    实际: ${JSON.stringify(got)}`);
    }
  }

  // ---- 备份真实文件（如有），保证测试后可还原 ----
  const backups = new Map();
  for (const f of [tmpFile, userDataFile]) {
    backups.set(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  }
  function restore() {
    for (const [f, content] of backups) {
      try {
        if (content === null) fs.rmSync(f, { force: true });
        else fs.writeFileSync(f, content);
      } catch {
        /* 尽力还原 */
      }
    }
  }

  try {
    const ctx = await import('../src/context.mjs');

    // ---- 1. 候选路径集合 ----
    const files = ctx.CONTROL_BRIDGE_FILES;
    check('候选路径至少 2 条', files.length, (v) => v >= 2);
    check('候选含 <userData>/control-bridge.json', files, (v) => v.some((f) => f.includes('BossClaw') && f.endsWith('control-bridge.json')));
    check('候选含 <tmpdir>/bossclaw-control-bridge.json', files, (v) => v.some((f) => f === tmpFile));
    check('候选顺序：userData 先于 tmpdir', files, (v) => v.indexOf(userDataFile) < v.indexOf(tmpFile));
    check('CONTROL_BRIDGE_FILE = 首个候选', ctx.CONTROL_BRIDGE_FILE, files[0]);

    // ---- 2/3. 仅 tmpdir 有文件 → 仍能命中，且 infoFile 指向它 ----
    fs.rmSync(userDataFile, { force: true });
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify({ port: 17699, token: 'tok-tmp', pid: process.pid, startedAt: Date.now() }));
    const found = await ctx.readControlBridgeInfo();
    check('仅 tmpdir 有文件时能找到桥（#66 核心）', !!found, true);
    check('命中的是 tmpdir 那份', found && found.port, 17699);
    check('infoFile 指出实际命中路径', found && found.infoFile, tmpFile);

    // ---- 4. bridgeHint 列出全部已查找路径 ----
    const hint = ctx.bridgeHint();
    check('bridgeHint 列出 userData 路径', hint, (v) => v.includes(userDataFile));
    check('bridgeHint 列出 tmpdir 路径', hint, (v) => v.includes(tmpFile));
    check('bridgeHint 说明「依次」查找', hint, (v) => v.includes('依次'));

    // ---- 5. 全部候选不存在 → null ----
    fs.rmSync(tmpFile, { force: true });
    fs.rmSync(userDataFile, { force: true });
    check('全部候选缺失时返回 null', await ctx.readControlBridgeInfo(), null);

    // ---- 6. 文件存在但字段不全 → 视为无效，继续向后找 ----
    fs.writeFileSync(tmpFile, JSON.stringify({ port: 17699 })); // 缺 token
    check('缺 token 的文件不算命中', await ctx.readControlBridgeInfo(), null);
  } finally {
    restore();
  }

  if (!quiet) {
    console.log(`\n[桥路径回归] 通过 ${pass} 项，失败 ${failures.length} 项`);
    if (failures.length) console.error('失败项：\n  - ' + failures.join('\n  - '));
  }
  return failures.length;
}

// 作为独立脚本直接运行时（node test/bridge-path.mjs）执行并设置退出码
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  const fails = await runBridgePath();
  process.exit(fails ? 1 : 0);
}
