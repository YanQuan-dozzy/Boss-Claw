#!/usr/bin/env node
// scripts/make-source-package.mjs —— 生成 macOS 源码自构建档案
//
// 没有 Mac 环境时，运行 `npm run package:source` 即可在 release/ 目录生成
// `BossClaw-<版本>-mac.tar.gz` 源码档案；Mac 用户解压后执行内含的
// `./build-mac.sh` 一键完成依赖安装与 dmg/zip 打包（Intel + Apple Silicon 双架构）。
'use strict';

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const pkg = require(path.join(appDir, 'package.json'));
const releaseDir = path.join(appDir, 'release');

fs.mkdirSync(releaseDir, { recursive: true });

const version = pkg.version;
const outFile = path.join(releaseDir, `BossClaw-${version}-mac.tar.gz`);

const excludes = [
  '--exclude=node_modules',
  '--exclude=dist',
  '--exclude=release',
  '--exclude=.git',
  '--exclude=*.tsbuildinfo',
  '--exclude=*.log',
];

console.log(`[make-source-package] 生成 macOS 源码自构建档案（v${version}）…`);
execFileSync('tar', ['-czf', outFile, ...excludes, '-C', appDir, '.'], { stdio: 'inherit' });

const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`[make-source-package] 完成：${outFile}（${size} MB）`);
console.log('[make-source-package] Mac 用户解压后执行 ./build-mac.sh 即可打包 dmg/zip（x64 + arm64）。');
