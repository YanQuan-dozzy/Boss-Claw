# 架构与开发

本文面向想要理解 BossClaw 内部结构或参与开发的读者。

---

## 一、技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron `^31` |
| 渲染层 | React 18 + TypeScript + Vite 5 |
| UI 组件 | Ant Design 5 |
| 状态管理 | Zustand（persist 中间件接 localStorage） |
| 本地存储 | localStorage（零后端依赖，数据本地优先） |
| 打包 | electron-builder（Windows 优先：NSIS 安装包 + 绿色便携版） |
| 可选桥接 | OpenClaw Node 服务（127.0.0.1:18765）、Camoufox Python 桥（127.0.0.1:18767） |

## 二、进程模型

```
┌────────────────────────── 主进程（main.cjs，CommonJS） ──────────────────────────┐
│  单窗口生命周期 · IPC 总线（safeHandle 包装）· 会话持久化                          │
│  子进程管理：CloakBrowser / Camoufox / OpenClaw Node 桥                          │
├──────────────────────────────────────────────────────────────────────────────┤
│  预加载 preload/app.cjs（contextBridge → window.electron，安全 IPC + LLM 代理）   │
│  预加载 preload/webview.cjs（注入 BOSS 页面，页面回传 + 真实键盘输入）              │
├──────────────────────────────────────────────────────────────────────────────┤
│  渲染进程 src/（ESM）：React SPA + antd，window.electron 是唯一与主进程交互的接口   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **安全基线**：`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: true`
- 所有 IPC handler 统一经 `safeHandle` 包装，未捕获异常写日志后保持原 throw 语义（渲染端 `invoke` reject 行为不变）

## 三、IPC 总线（白名单 channel）

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

## 四、渲染层状态分层

| Store | 内容 | 持久化 |
| --- | --- | --- |
| `useAppStore` | 运行时状态：主题、活动路由、桥状态、BOSS 登录态、引擎状态 | 否（每次启动重置） |
| `useDataStore` | 业务数据：岗位 / 任务 / 日志 / 画像 | 是（localStorage，带版本号重置） |
| `useSettingsStore` | 用户配置：LLM 密钥、过滤规则、招呼语、引擎模式 | 是（设置页可导出 / 导入） |

## 五、目录结构

```
Boss-claw/
├── desktop-app/               当前主应用（Electron + React，v2.1.0）
│   ├── electron/
│   │   ├── main.cjs           主进程：单窗口 + webview + IPC + 子进程管理
│   │   ├── preload/
│   │   │   ├── app.cjs        主窗口安全接口（contextBridge）
│   │   │   └── webview.cjs    内置浏览器 guest 页回传 + 真实输入
│   │   └── cloakbrowser/
│   │       ├── launcher.cjs   CloakBrowser 生命周期（启动/标签/CDP输入）
│   │       └── cloakPreload.cjs
│   ├── bridge/                OpenClaw Node 桥接后端（server.cjs + config.json）
│   ├── camoufox/              Python 隐身引擎桥（camoufox_server.py + requirements.txt）
│   ├── skills/                AI 技能库（SKILL.md：resume-profile / job-analysis / greetings / tailor-cv）
│   ├── src/
│   │   ├── main.tsx / App.tsx / theme.ts / index.css
│   │   ├── store/             useAppStore / useDataStore / useSettingsStore
│   │   ├── lib/               storage / electronApi / bridgeClient / bossclaw/*（matching / profile / greetings / jobMatch / jobAssistant / jdCleaner / skills 等）
│   │   ├── components/        TitleBar / Sidebar / StatusBar / BrowserView / feedback
│   │   └── pages/             Home / Workbench / Resume / Directions / Tasks / Stats / Assistant / OpenClaw / AutoChat / Settings
│   ├── resources/             应用图标等资源
│   └── package.json           依赖与 scripts
├── docs/
│   ├── wiki/                  Wiki 教程源文件（Home / Quick-Start / User-Guide / Architecture / Safety / FAQ）
│   └── release-notes-*.md     版本发布说明
├── start-bossclaw.cmd         Windows 一键启动脚本
├── install-deps.cmd           依赖一键安装脚本
├── ATTRIBUTION.md / NOTICE    署名与 Apache-2.0 通知
└── LICENSE                    Apache License 2.0
```

## 六、常用命令（在 `desktop-app/` 下执行）

```bash
npm install                # 安装依赖

npm run dev                # 启动 Vite dev server（默认 5173）
npm run dev:electron       # 构建 renderer 并以 Electron 打开
npm start                  # 仅启动 Electron（需先 build 或 dev 服务在跑）

npm run typecheck          # 仅类型检查（不打包）
npm run build              # 类型检查 + Vite 构建到 dist/
npm run verify             # typecheck + build 组合

npm run package            # 构建并打包 Windows NSIS 安装包 + 绿色便携版
npm run package:portable   # 仅打包绿色便携版
npm run package:dir        # 仅生成解压目录（便于本地试运行）
npm run package:mac        # 打包 macOS dmg + zip（只能在 macOS 上执行）
npm run package:linux      # 打包 Linux AppImage + deb
npm run package:all        # 打包 Windows + Linux
```

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `BOSSCLAW_DEBUG=1` | 写入 `userData/bossclaw-debug.log` 并启用白屏诊断日志 |
| `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` | 国内网络加速 Electron 二进制下载 |
| `CLOAKBROWSER_BINARY_PATH` | 离线 / 受限环境下指向本地 CloakBrowser 二进制 |

### 打包产出（`npm run package` → `release/`）

```
release/
├── BossClaw-2.1.0-x64.exe        # NSIS 安装包（推荐发行）
├── BossClaw-2.1.0-portable.exe   # 绿色便携版（无需安装、解压即用）
└── win-unpacked/                 # 解压目录（可手工分发）
```

macOS 产物（`BossClaw-2.1.0-{x64,arm64}.dmg / .zip`）需在 macOS 上执行 `npm run package:mac` 构建；Linux 产物（AppImage / deb）由 `npm run package:linux` 在本机构建。

## 七、可选依赖安装

**隐身引擎（Camoufox / Playwright）**——需 Python 3.10+：

```bash
cd desktop-app/camoufox
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m camoufox fetch   # 必装：下载 Camoufox 原生内核(~150MB)；本地 Chrome/Edge 不可复用，不装则引擎不可用
```

**CloakBrowser**——首次启用「隐身浏览器」时自动下载 ~200MB 隐身 Chromium 到 `~/.cloakbrowser/` 并校验 Ed25519 签名；离线环境可用 `CLOAKBROWSER_BINARY_PATH` 指向本地二进制。

## 八、开发注意事项

- 涉及业务逻辑改动时，请优先回查本地需求文档 `docs/桌面版改造需求文档.md`（v1.2，仅本地保留，不入仓库）与参考项目 `job-claw-main` 的实现口径，对齐既定口径，禁止凭空重写。
- 修改 `electron/preload/webview.cjs` 等主进程 / preload 文件后，**必须重启 Electron** 才能生效（HMR 不覆盖 preload）。
- 业务逻辑对齐参考项目 `job-claw-main` 的采集与投递口径（`task-state` / `job-priority` / `conversation-identity`）。
- AI 技能层：技能开关 / 指令变化 → messages 变化 → AI 缓存 key 自动失效；自定义技能存 `userData/skills`（内置 `appPath/skills` 只读），IPC 白名单校验防路径穿越。
- 开发模式下 Electron 加载 `http://localhost:5173`；生产模式加载 `dist/index.html`。
- 打包前建议先 `npm run verify`（类型检查 + 构建），再 `npm run package`。
