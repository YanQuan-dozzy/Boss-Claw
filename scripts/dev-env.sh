#!/bin/sh
# Boss-claw 开发包装器 —— 修正 PATH 后执行任意命令。
#
# 为什么需要它
#   C:\Windows\System32\bash.exe 是 WSL 启动器而不是真 bash，且在 PATH 中靠前，
#   导致 npm / npx（shebang 为 #!/usr/bin/env bash）被错误地交给 WSL 执行。
#   本脚本把 scripts/shim 前置到 PATH，使 `bash` 解析到真实 bash。
#   详见 scripts/shim/bash 顶部注释。
#
# 用法
#   ./scripts/dev-env.sh npm install
#   ./scripts/dev-env.sh npm run verify
#   ./scripts/dev-env.sh npx tsc -b
#   sh scripts/dev-env.sh node --version      # 任意命令都可用

set -e

if [ "$#" -eq 0 ]; then
  echo "用法: $0 <command> [args...]" >&2
  exit 2
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIM_DIR="$SELF_DIR/shim"

# NTFS 上 git 可能丢失执行位，这里补一次
[ -x "$SHIM_DIR/bash" ] || chmod +x "$SHIM_DIR/bash" 2>/dev/null || true

PATH="$SHIM_DIR:$PATH"
export PATH

exec "$@"
