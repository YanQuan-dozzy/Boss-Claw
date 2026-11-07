// eslint.config.mjs —— ESLint 9 flat config
//
// 定位（重要）：**不是造第二套 typecheck**。
//   `tsc -b` 已经开着 strict / noUnusedLocals / noUnusedParameters，类型正确性由它负责；
//   ESLint 在这里只补三类 tsc 管不到的问题：
//     ① React Hooks 依赖数组（漏依赖 = 闭包读到旧值，tsc 完全看不见）；
//     ② 显式 `any` / 非空断言等「写法上有毒但类型合法」的写法（先以 warn 计，逐步收敛）；
//     ③ CommonJS 侧（electron/*.cjs）的未定义变量与危险模式。
//
// 规则强度取「recommended，不带 type-checked」：type-checked 规则要传 `projectService`，
// 本仓库 3.3 万行 + 多个 tsconfig 引用会让单次 lint 到分钟级，收益不足以抵消开发体验损失。
//
// 用法：npm run lint / npm run lint:fix
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // 构建产物、打包产物、本地临时目录、Python 后端与随包资源一律不参与
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'tmp/**',
      'build/**',
      'resources/**',
      'camoufox/**',
      'skills/**',
      'scripts/fixtures/**',
      // 临时诊断产物（tmp-bundle / tmp-repro / tmp-diag-*）：多为 esbuild 打包出来的单文件，
      // 不属于源码，lint 它们只会制造噪声
      'scripts/tmp-*',
    ],
  },

  js.configs.recommended,

  // ===== 渲染层（TypeScript + React）=====
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: ['src/**/*.{ts,tsx}'] })),
  {
    files: ['src/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // hooks 规则：exhaustive-deps 保持 warn —— 本仓库有大量「刻意只依赖部分值」的 effect
      // （例如只在 activeId 变化时重跑投递），升成 error 会逼出一堆 eslint-disable。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // 显式 any 先按 warn 记账：当前有几十处（多为第三方 JSON / IPC payload 的边界），
      // 逐个换成 unknown + 校验属于独立重构，不适合与「接入 ESLint」混在一起。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 空接口 / 空对象类型在 props 占位里偶有使用，保留但不阻断
      '@typescript-eslint/no-empty-object-type': 'warn',
      // 未使用变量由 tsc 的 noUnusedLocals 兜底；此处关掉，避免与 `_` 前缀约定打架
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      // 允许 `void promise` 显式忽略 Promise（本项目用它标注「有意不 await」）
      '@typescript-eslint/no-floating-promises': 'off',
      // 空块：只保留「非 catch 的空块算问题」。本仓库大量 `catch {}` 是刻意的（清理失败不影响主流程），
      // 且注释已说明原因，逐处加 disable 反而更难读。
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 控制字符正则：JD 清洗 / PDF 去二进制头必须写 `\x00`（见 jdCleaner.ts 的不可见字符表），
      // 这条规则针对的是「误把控制字符写进正则」，与本仓库的用途正好相反。
      'no-control-regex': 'off',
      // 正则里的多余转义（`\/` `\[` `\-`）：纯风格，且改动正则有语义风险（一处不等价就是采不到数据）。
      'no-useless-escape': 'off',
      // 多 case 共用一段逻辑是本仓库的常态（消息分发 switch），空 case 标签不算「忘记 break」
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // 典型场景：`let timer; const finish = () => timer && clearTimeout(timer); timer = setTimeout(...)`
      // —— 赋值前就被闭包读取，改成 const 反而编译不过。ignoreReadBeforeAssign 正是为这种写法准备的。
      'prefer-const': ['error', { destructuring: 'any', ignoreReadBeforeAssign: true }],
    },
  },

  // ===== 主进程 / preload（CommonJS）=====
  {
    files: ['electron/*.cjs', 'electron/**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      // 主进程里有大量 `catch { /* 忽略 */ }` 与空分支，属既定风格
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // require 在 CJS 里是正常用法
      '@typescript-eslint/no-require-imports': 'off',
      'no-unused-vars': 'off',
      'no-control-regex': 'off',
      // 主进程日志里会有 `console.log`（启动/预加载注册），保留
      'no-console': 'off',
    },
  },

  // 这三个文件里有「注入到页面执行」的函数体（executeJavaScript / addInitScript 的来源），
  // 定义在主进程、执行在渲染进程，因此 window / document / location 等 DOM 全局在静态分析里是「未定义」。
  // 补 browser globals，而不是关掉 no-undef —— 保留对本进程真实笔误的检出能力。
  {
    files: ['electron/preload/webview.cjs', 'electron/cloakbrowser/*.cjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ===== 工具脚本（ESM）=====
  // 回归脚本大量做「把函数体注入 jsdom / Playwright 执行」，因此同时需要 node 与 browser 全局；
  // 又因为脚本以断言为主、存在较多一次性辅助变量，未使用变量不在此处强制。
  {
    files: ['scripts/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
    },
  },
);
