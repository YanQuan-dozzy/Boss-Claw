// build/after-pack-win-icon.js —— 在打包阶段为 Windows 主 exe 注入 BossClaw 图标与应用元数据
//
// 背景：
//   - electron-builder 的 win.signAndEditExecutable 负责“写入图标 + 版本信息”，但它依赖
//     从 GitHub 下载件 winCodeSign 内的 rcedit-x64.exe；本机/离线环境连不上 GitHub 时该步骤失败。
//   - 因此本仓库将 signAndEditExecutable 置为 false（跳过其自身 rcedit），改为在 afterPack
//     钩子里用本地已有的 rcedit 二进制显式写入图标与元数据，从而离线也能产出正确名称/描述的 exe。
//   - 写入内容：应用图标（resources/icon.ico）+ FileDescription/ProductName/CompanyName/版本号，
//     彻底替换掉 Electron 默认的图标与描述。
//
// 用法：仅需在 package.json 的 build 配置顶层添加 "afterPack": "build/after-pack-win-icon.js"。
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// 定位一个可用的 rcedit-x64.exe（Windows 资源编辑工具）。
// 候选顺序：
//   1) 环境变量 RCEDIT_EXE（显式指定）；
//   2) 本项目 node_modules/rcedit/bin/rcedit-x64.exe（若显式安装了带二进制的 rcedit）；
//   3) npm 包 rcedit 的默认下载位置（node_modules .cache / electron-builder 缓存）；
//   4) electron-builder 本地缓存 Cache/winCodeSign/<hash>/rcedit-x64.exe（最常见的离线来源，按 hash 目录扫描）。
//
// 审查 #117：候选 3/4 依赖「本机曾成功下载过 winCodeSign」。干净 CI / 新机首次打包时可能**一个都不存在**，
// 此时旧实现直接 `throw` → **整个打包中断**（且 rcedit npm 包**不自带** rcedit-x64.exe：v4/v5 均为
// JS 包装器，运行时才下载，官方已标记 deprecated → 「把它加进 devDependencies」并不能修复本问题）。
// 故改为**默认 fail-soft**：找不到 rcedit 时打印醒目告警并继续打包（产出可用的安装包，仅 exe 图标/描述
// 回落到 Electron 默认），避免「为了一枚图标让整条流水线挂掉」；发布正式包时设 `BOSSCLAW_REQUIRE_ICON=1`
// 强制严格模式（找不到即失败），把「必须带图标」的诉求交给显式开关而非默认行为。
function findRcedit() {
  const candidates = [];
  if (process.env.RCEDIT_EXE) candidates.push(process.env.RCEDIT_EXE);
  candidates.push(path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'));

  const cacheRoots = [];
  if (process.env.LOCALAPPDATA) {
    cacheRoots.push(path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign'));
  }
  if (process.env.USERPROFILE) {
    cacheRoots.push(path.join(process.env.USERPROFILE, '.cache', 'electron-builder', 'winCodeSign'));
  }
  // npm 包 rcedit 的默认缓存目录（不同版本各异，一并纳入探测）。
  cacheRoots.push(path.join(__dirname, '..', 'node_modules', '.cache', 'rcedit'));

  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'rcedit-x64.exe');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

const RCEDIT_HINT =
  '未找到 rcedit-x64.exe（Windows 资源编辑工具）。' +
  '获取方式（任选其一）：① 设环境变量 RCEDIT_EXE 指向已有 rcedit-x64.exe；' +
  '② 让 electron-builder 正常下载 winCodeSign（即不设 win.signAndEditExecutable=false）；' +
  '③ 手动放置到本机 electron-builder Cache/winCodeSign/<hash>/ 下。';

exports.default = async function (context) {
  // 仅处理 Windows 打包；mac/linux 走各自平台图标，无需 rcedit。
  if (process.platform !== 'win32') return;

  const appInfo = context.packager.appInfo;
  const productName = String(appInfo.productName || 'BossClaw');
  const version = String(appInfo.version || '0.0.0');

  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exePath)) {
    console.log(`[after-pack-win-icon] 跳过：未找到 ${exePath}`);
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    // 审查 #117：默认 fail-soft（见上方 findRcedit 注释）。严格模式由 BOSSCLAW_REQUIRE_ICON 开启。
    const strict = /^(1|true|yes)$/i.test(String(process.env.BOSSCLAW_REQUIRE_ICON || ''));
    const msg = `[after-pack-win-icon] ${RCEDIT_HINT}`;
    if (strict || process.env.RCEDIT_EXE) {
      // 显式指定了 RCEDIT_EXE 却仍找不到（路径写错）→ 一定是配置错误，必须失败。
      throw new Error(
        `after-pack-win-icon: ${msg}` +
          (process.env.RCEDIT_EXE ? `（RCEDIT_EXE=${process.env.RCEDIT_EXE} 指向的文件不存在）` : '（已开启 BOSSCLAW_REQUIRE_ICON 严格模式）')
      );
    }
    console.warn(`${msg}\n[after-pack-win-icon] 已跳过图标/元数据注入：产物可正常使用，但 exe 将显示 Electron 默认图标与描述。` +
      '发布正式包请准备好 rcedit 后重打，或设 BOSSCLAW_REQUIRE_ICON=1 让本步失败以强制修复。');
    return;
  }

  const icon = path.join(context.packager.projectDir, 'resources', 'icon.ico');

  const versionString = [
    ['FileDescription', 'BossClaw —— 本地 AI 求职投递助手'],
    ['ProductName', productName],
    ['CompanyName', appInfo.companyName || appInfo.author || 'YanQuan'],
    ['LegalCopyright', appInfo.copyright || 'Copyright'],
    ['FileVersion', version],
    ['ProductVersion', version],
  ];

  const args = [exePath];
  if (fs.existsSync(icon)) args.push('--set-icon', icon);
  for (const [k, v] of versionString) args.push('--set-version-string', k, v);
  args.push('--set-file-version', `${version}.0`, '--set-product-version', `${version}.0`);
  if (process.env.RCEDIT_FLAGS) args.push(...process.env.RCEDIT_FLAGS.split(/\s+/));

  console.log(`[after-pack-win-icon] 注入 ${productName} 图标与元数据 → ${exePath}`);
  execFileSync(rcedit, args, { stdio: 'inherit' });
  console.log('[after-pack-win-icon] 完成');
};