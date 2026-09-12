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
//   2) 本项目 node_modules/rcedit/bin/rcedit-x64.exe（若已安装 npm 包 rcedit）；
//   3) electron-builder 本地缓存 Cache/winCodeSign/<hash>/rcedit-x64.exe（最常见的离线来源，按 hash 目录扫描）。
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
  throw new Error(
    'after-pack-win-icon: 未找到 rcedit-x64.exe，无法注入 BossClaw 图标与元数据。' +
      '可安装 rcedit npm 包（npm i -D rcedit）或设置环境变量 RCEDIT_EXE 指向其路径。'
  );
}

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