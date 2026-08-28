# BossClaw 桌面版（Electron + React）

> 面向求职者的**本地 AI 投递助手**。单窗口桌面应用：固定功能侧栏 + 工作台三栏（侧栏 + 中栏消息进度 + 右栏内置浏览器） + 其余页面双栏。

> 完整需求与决策见仓库根：[`docs/桌面版改造需求文档.md`](../docs/桌面版改造需求文档.md)（v1.2，已锁定不再讨论）。

---

## 功能闭环

- **岗位来源**：内置浏览器打开 BOSS 直聘岗位 → 中栏点「加入任务」→ 自动识别 HR 活跃度（在线 / 刚刚活跃 / N 日内活跃）作为匹配判断依据。
- **半自动投递**：中栏批准岗位 → 浏览器跳转 → AI 草稿预填沟通框 → 用户发送。
- **自动辅助**：启动后按匹配优先级依次投递 `approved_queue` 队列；webview 回传投递阶段（打开沟通 → 填写 → 发送 → 确认文字气泡 → 确认结果），失败自动暂停交人工核对；**首次成功投递后强制暂停验收**（安全不变量）。
- **任务进度**：中栏任务级进度条 + 阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递），日志流实时滚动；失败可重试 / 忽略 / 跳过。
- **简历中心**：PDF / DOCX / TXT 本地解析（渲染进程内完成，无需桥接）：PDF 用自研解析器（Flate / ASCIIHex / ASCII85 / RunLength + ToUnicode / CMap），DOCX 用 mammoth 浏览器版 + 自研 ZIP/XML 双通道兜底，`.doc` 旧格式给出转档提示。
- **AI 能力**：职业画像（AI 完整画像 → 精简重试 → 本地规则三级降级）；岗位匹配（评分 / 决策 / 硬条件拦截 / 沟通草稿）；**4 条个性化打招呼语**（AI 生成 + 求职者口吻校验，失败回退本地规则）。
- **LLM 预设**：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟 / 自定义（OpenAI 兼容端点）。
- **OpenClaw 桥接**：本地 Node 服务（127.0.0.1:18765）提供状态 / 日报 / 指令控制 / OCR / 简历解析 / **日志查看**。
- **可选隐身增强（默认关闭）**：
  - **Camoufox** —— Python 桥（127.0.0.1:18767），多内核自适应（优先 Camoufox 原生内核，否则复用系统 Chrome/Edge + Playwright stealth，**不下载额外内核**）。
  - **CloakBrowser** —— Playwright 持久上下文 + 多 Page（需要时自动从 `~/.cloakbrowser/` 加载约 200MB 隐身 Chromium）。
  - **不绕过验证码 / 账户验证**：code 35/36/32 立即停止并交人工。
- **主题**：浅色 / 深色 / 跟随系统（antd + CSS 变量，状态持久化）。
- **数据**：设置页可导出 / 导入 / 清空本地数据（localStorage）。

---

## 技术栈

- **Electron** `^31`（主进程 CommonJS：`electron/main.cjs` + `electron/preload/*`）
- **React 18 + TypeScript + Vite 5**（渲染进程：`src/`）
- **Ant Design 5**（UI）+ **Zustand**（状态，persist 接 localStorage）
- 打包：**electron-builder**（Windows 优先，NSIS 安装包 + 绿色便携版）

---

## 目录结构

```
desktop-app/
├── package.json / vite.config.ts / tsconfig*.json / index.html
├── .nvmrc                            # Node 22
├── .editorconfig                     # 跨编辑器编码风格
├── electron/
│   ├── main.cjs                      # 主进程：单窗口 + webview + IPC + CloakBrowser
│   ├── preload/
│   │   ├── app.cjs                   # 主窗口安全接口（contextBridge）
│   │   └── webview.cjs               # 内置浏览器 guest 页回传 + 真实输入
│   └── cloakbrowser/
│       ├── launcher.cjs              # CloakBrowser 生命周期管理（启动/标签/CDP输入）
│       └── cloakPreload.cjs          # CloakBrowser 页面预加载
├── bridge/                           # Node 桥接服务（mammoth / 文件 / 任务恢复）
├── camoufox/
│   ├── camoufox_server.py            # Python 隐身搜索/发送桥
│   └── requirements.txt
├── resources/
│   └── icon.ico
└── src/
    ├── main.tsx / App.tsx / theme.ts / index.css
    ├── store/                        # useAppStore / useDataStore / useSettingsStore
    ├── lib/                          # storage / electronApi / bridgeClient / bossclaw/*
    ├── components/                   # TitleBar / Sidebar / StatusBar / BrowserView / feedback
    └── pages/                        # Home / Workbench / Resume / Directions / Tasks / Stats / OpenClaw / AutoChat / Settings
```

---

## 环境准备（首次运行）

仓库**不包含**任何运行时依赖（`node_modules` / Electron 二进制 / Python 包均需自行下载）：

```bash
# 方式一（推荐，Windows）：一键安装脚本
install-deps.cmd          # 仓库根目录，自动完成 1+2，可选 3

# 方式二（手动）：
npm install               # 1. 安装 Node 依赖（含 Electron 二进制）
                          #    国内网络失败时加 --registry=https://registry.npmmirror.com
                          #    或设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
                          #    后执行 node node_modules/electron/install.js
```

> **前置要求**：[Node.js 20+](https://nodejs.org)（推荐 22，`.nvmrc` 已固定）；本仓库根 `.nvmrc` 仅对 root 生效，desktop-app 内 `.nvmrc` 固定 Node 22。

> **可选 — 隐身引擎**（工作台「隐身搜索/隐身投递」）：需 Python 3.10+。运行 `install-deps.cmd` 并选择 y，或在 `camoufox/` 目录执行：
> ```bash
> python -m venv .venv
> .venv\Scripts\pip install -r camoufox\requirements.txt
> .venv\Scripts\python -m camoufox fetch   # 可选：下载指纹内核(~150MB)；跳过则自动回退系统 Chrome/Edge
> ```

> **可选 — CloakBrowser**：首次启用「隐身浏览器」模式时，launcher 自动下载 ~200MB 隐身 Chromium 到 `~/.cloakbrowser/` 并校验 Ed25519 签名。离线/受限环境可下载 `.zip` 后用 `CLOAKBROWSER_BINARY_PATH` 指向本地二进制。

---

## 常用命令

```bash
npm install                # 安装依赖

npm run dev                # 启动 Vite dev server（默认 5173；Electron 由 electron:dev 启动）
npm run electron:dev       # 构建 renderer 并以 Electron 打开（生产模式预览）
npm start                  # 仅启动 Electron（需先 build 或 dev 服务在跑）

npm run typecheck          # 仅类型检查（不打包）
npm run build              # 类型检查 + Vite 构建到 dist/
npm run verify             # typecheck + build 组合

npm run package            # 构建并打包 Windows NSIS 安装包 + 绿色便携版
npm run package:portable   # 仅打包绿色便携版（无需安装）
npm run package:dir        # 仅生成解压目录（不打包，便于本地试运行）
```

> **Electron dev 模式**：开发模式下 Electron 加载 `http://localhost:5173`（自动扫描 5173-5179 端口），失败则回退 `dist/index.html`；生产模式只加载 `dist/index.html`。
> **首次运行需在本机有 Electron 运行环境**（`npm install` 会安装 `electron` 包及其二进制）。

> **环境变量**：
> - `BOSSCLAW_DEBUG=1`：写入 `userData/bossclaw-debug.log` 并启用白屏诊断日志（`userData/debug-render.log`）。
> - `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`：国内网络加速 Electron 二进制下载。

---

## 打包产出

`npm run package` 在 `release/` 目录产出：

```
release/
├── BossClaw 桌面版-2.0.0-x64.exe        # NSIS 安装包（推荐发行）
├── BossClaw 桌面版-2.0.0-portable.exe   # 绿色便携版（无需安装、解压即用）
└── win-unpacked/                         # 解压目录（可手工分发的文件夹）
```

---

## 功能侧栏入口

固定 7 入口：**首页 · 工作台（三栏自动投递）· 简历中心 · 投递方向 · 任务进度 · OpenClaw · 设置**。

---

## 公开架构

### 进程边界

- **主进程**（`electron/main.cjs`，CommonJS）：单窗口生命周期 + IPC 总线 + `persist:bossclaw` 会话 + CloakBrowser / Camoufox / Node 桥 子进程管理。
- **预加载**（`electron/preload/*.cjs`，`contextIsolation: true`）：`app.cjs` 暴露 `window.electron` API；`webview.cjs` 注入 BOSS 页面，跑官方 API + DOM 兜底 + 真实键盘输入。
- **渲染进程**（`src/`，ESM）：React SPA + antd。`window.electron` 是唯一与主进程交互的接口。

### IPC 总线（白名单 channel）

详见 `electron/main.cjs` 与 `electron/preload/app.cjs`：

| Channel | 用途 |
| --- | --- |
| `jc:app-info` / `jc:window-*` | 应用信息、窗口控制（标题栏按钮） |
| `jc:open-external` | 用系统浏览器打开外部链接 |
| `jc:fetch-url` | 主进程代理跨域 fetch（城市编码表） |
| `jc:boss-login` | 检查 BOSS 直聘登录态（读 wt2 cookie） |
| `jc:webview-input` | webview 真实键盘输入（CDP 等价） |
| `jc:camoufox-*` | Camoufox Python 桥（status / search / send / login） |
| `jc:cloak-*` | CloakBrowser 隐身浏览器（启动 / 标签 / 输入） |
| `jc:bridge-control` | OpenClaw Node 桥启停 |

所有 IPC handler 统一经 `safeHandle` 包装，未捕获异常写日志后**保持原有 throw 语义**（渲染端 `invoke` reject 行为不变）。

### 渲染层状态分层

- **运行时状态**（`useAppStore`）：主题、活动路由、桥状态、BOSS 登录态、引擎状态——**不持久化**（每次启动重置）。
- **业务数据**（`useDataStore`）：岗位 / 任务 / 日志 / 画像——**持久化到 localStorage**（带 `bossclaw-data-version` 重置）。
- **用户配置**（`useSettingsStore`）：LLM 密钥、过滤规则、招呼语、引擎模式——**持久化**（设置页可导出/导入）。

---

## 常见问题

- **白屏**：`set BOSSCLAW_DEBUG=1` 后启动，查看 `userData/debug-render.log` 内 DOM 检查 / 浏览器状态。
- **首次启动登录态丢失**：v3 重建后首次启动会清空旧 `persist:bossclaw` 会话与 Camoufox 缓存（`DATA_VERSION='v3-rebuild-20260815'`）。需重新扫码登录。
- **隐身引擎报错 `未检测到可用内核`**：安装 Chrome / Edge / Firefox 任一，或 `pip install 'camoufox[geoip]' && python -m camoufox fetch`。

---

## 变更记录

- v2.0.0 — 内置浏览器 + 收集投递沟通模块从零重建；统一 IPC 错误包装；Workbench 三栏拆分；CloakBrowser / Camoufox 可选隐身增强。
