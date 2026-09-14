#!/usr/bin/env bash
# BossClaw macOS 一键自构建脚本
#
# 用法：在 macOS 上解压 `BossClaw-<版本>-mac.tar.gz` 源码档案后，
#       在解压目录内执行 `./build-mac.sh`，即可完成：
#         1) 安装 Node 依赖（含 Electron 二进制，国内网络自动回退 npmmirror 镜像）
#         2) 打包 macOS 安装产物（dmg + zip，Intel x64 + Apple Silicon arm64 双架构）
# 产物输出到 release/ 目录。
#
# 前置要求：macOS 10.15+，Node.js 20+（https://nodejs.org）
set -euo pipefail

cd "$(dirname "$0")"

echo "==> BossClaw macOS 自构建开始"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 Node.js。请先安装 Node.js 20+（https://nodejs.org）后重试。"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未检测到 npm。请安装 Node.js 20+（自带 npm）后重试。"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "错误：Node.js 版本过低（$(node -v)），需要 20 以上。"
  exit 1
fi

echo "==> 1/2 安装依赖（npm install）"
if ! npm install; then
  echo "    默认源安装失败，改用 npmmirror 国内镜像重试…"
  npm install --registry=https://registry.npmmirror.com
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  node node_modules/electron/install.js
fi

echo "==> 2/2 打包 macOS dmg + zip（x64 + arm64 双架构）"
npm run package:mac

echo ""
echo "==> 构建完成，产物如下："
ls -lh release/ 2>/dev/null | grep -E "BossClaw-.*\.(dmg|zip)$" || true
echo ""
echo "==> 可将 release/ 中的 dmg/zip 分发给 Mac 用户使用。"
