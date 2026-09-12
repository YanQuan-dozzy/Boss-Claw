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
| 支持平台 | BOSS 直聘 / 猎聘 / 智联招聘 / 前程无忧 51Job（`src/lib/bossclaw/platforms.ts` 平台注册层收口：元数据 / 投递语义 / 外部网申文案 / 阶段标签 / 每日上限；Camoufox 侧模块在 `camoufox/platforms/`） |
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
| `jc:boss-login` | 检查各平台在「内置浏览器（工作台）」会话中的登录态（BOSS 读 wt2 cookie，返回 platforms 映射） |
| `jc:boss-logout` | 退出指定平台的内置浏览器会话登录态 |
| `jc:webview-input` | webview 真实键盘输入（CDP 等价） |
| `jc:camoufox-*` | Camoufox Python 桥（status / search / send / login / logout / restart，按平台分发到 `camoufox/platforms/*`） |
| `jc:cloak-*` | CloakBrowser 隐身浏览器（启动 / 标签 / 输入 / health 健康检查，进程断开自动重启） |
| `jc:bridge-control` | OpenClaw Node 桥启停 |

## 四、渲染层状态分层

| Store | 内容 | 持久化 |
| --- | --- | --- |
| `useAppStore` | 运行时状态：主题、活动路由、桥状态、BOSS / 平台登录态、引擎状态 | 否（每次启动重置） |
| `useDataStore` | 业务数据：岗位 / 任务 / 日志 / 画像 | 是（localStorage，带版本号重置） |
| `useSettingsStore` | 用户配置：LLM 密钥、过滤规则、招呼语、引擎模式、招聘平台（启用 / 优先级 / 每日投递目标） | 是（设置页可导出 / 导入） |
| `useScheduleStore` | 定时任务条目（动作 / 时刻 / 星期 / 目标平台 / 单轮上限）+ 采集请求 | 是（`-schedule` 键，本地备份覆盖） |

## 五、目录结构

```
Boss-claw/
├── desktop-app/               当前主应用（Electron + React，v2.5.2）
│   ├── electron/
│   │   ├── main.cjs           主进程：单窗口 + webview + IPC + 子进程管理 + 备份目录/开机自启
│   │   ├── preload/
│   │   │   ├── app.cjs        主窗口安全接口（contextBridge）
│   │   │   └── webview.cjs    内置浏览器 guest 页回传 + 真实输入（多平台注入，非 BOSS 站点横向滚动修复等）
│   │   └── cloakbrowser/
│   │       ├── launcher.cjs   CloakBrowser 生命周期（启动/标签/CDP输入）
│   │       └── cloakPreload.cjs
│   ├── bridge/                OpenClaw Node 桥接后端（server.cjs + config.json）
│   ├── camoufox/              Python 隐身引擎桥（camoufox_server.py 基座 + platforms/ 平台模块：common.py / liepin.py / zhaopin.py / job51.py）
│   ├── skills/                AI 技能库（SKILL.md：resume-profile / job-analysis / greetings / tailor-cv / great-resume / job-match）
│   ├── src/
│   │   ├── main.tsx / App.tsx / theme.ts / index.css
│   │   ├── store/             useAppStore / useDataStore / useSettingsStore / useScheduleStore
│   │   ├── lib/               storage / electronApi / bridgeClient / localBackup / scheduler / bossclaw/*（platforms 平台注册 / matching / profile / greetings / jobMatch / jobAssistant / jdCleaner / skills 等）
│   │   ├── components/        TitleBar / Sidebar / StatusBar / BrowserView / MarkdownView / feedback
│   │   └── pages/             Home / Workbench / Resume / Directions / Tasks / ScheduleTasks / Stats / Assistant / OpenClaw / AutoChat / Settings
│   ├── resources/             应用图标等资源
│   └── package.json           依赖与 scripts
├── mcp/bossclaw-mcp/            Agent 操作通道：零依赖 stdio MCP（repo / runtime / state / control / workspace，详见本文「七」）
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
├── BossClaw-2.5.2-x64.exe        # Windows NSIS 安装包（推荐发行，最新 v2.5.2）
├── BossClaw-2.5.2-portable.exe   # Windows 绿色便携版（无需安装、解压即用）
└── win-unpacked/                 # 解压目录（可手工分发）
```

macOS 产物（`BossClaw-2.1.0-{x64,arm64}.dmg / .zip`）需在 macOS 上执行 `npm run package:mac` 构建；Linux 产物（AppImage / deb）由 `npm run package:linux` 在本机构建。

## 七、Agent 操作通道（外部 Agent → MCP → 应用）

> 权威定义见 `AGENTS.md` 第 5 节（本小节为归档要点）。

外部 Agent（MCP 客户端）可通过仓库 `mcp/bossclaw-mcp`（零依赖标准 stdio，**单向 agent→MCP**）自主：读取仓库约束 / 应用文件 → 启动 / 停止应用 → 诊断状态 → 驱动运行中的应用。应用侧对应 `electron/control-bridge.cjs` + `src/lib/controlRuntime.ts`。

- **分层**：仓库层（5 组工具：`repo` 应用认知 / `runtime` 运行控制 / `state` 状态诊断 / `control` 应用控制 / `workspace` 工作区路径，读文件 / 进程启停 / 快照与日志诊断，无需应用运行）；应用层（`app_state` / `app_action` 内存实时状态 + 白名单动作 + 截图，需应用运行 + 控制桥）。
- **控制桥默认关闭**：仅经 `BOSSCLAW_CONTROL=1` 或 `--control-bridge` 显式开启（显式关闭优先，`--no-control-bridge` / `--no-agent`）；仅监听 `127.0.0.1`，除 `/health` 外全部要求 `x-bossclaw-token`（随机生成，写 `userData/control-bridge.json`）；动作白名单唯一权威实现于 `src/lib/controlRuntime.ts`。
- **发送类能力默认不开放**：仅当用户在应用内开启全自动（`config.executionMode === 'auto'`）时对 Agent 开放，且必须复用应用自带安全投递引擎（招呼语非空 / 外部网申跳过 / 文字气泡确认 / 风控码立即停止交人工）；人工确认（`review`）模式下 Agent 只能草拟、不得自动发送。
- **严禁**经控制桥绕过验证码或速率限制、修改 `SAFETY_LIMITS`、抬高每日上限。
- **单向链路**：应用不反向调 Agent；应用内 AI 在用户未配置 API Key 时一律回退本地规则（`buildLocalProfile` / `localFallback` 等），不转交外部 Agent。
- **状态口径**：读走写盘备份快照（只读）；写一律经控制桥直达运行中的应用，**绝不直接改写备份快照文件**。
- **验证**：`cd mcp/bossclaw-mcp && node test/selftest.mjs`（协议 + 只读，无需应用运行）；`node test/bridge-e2e.mjs`（起隔离实例全链路 + 清理）。

## 八、可选依赖安装

**隐身引擎（Camoufox / Playwright）**——需 Python 3.10+：

```bash
cd desktop-app/camoufox
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m camoufox fetch   # 必装：下载 Camoufox 原生内核(~150MB)；本地 Chrome/Edge 不可复用，不装则引擎不可用
```

**CloakBrowser**——首次启用「隐身浏览器」时自动下载 ~200MB 隐身 Chromium 到 `~/.cloakbrowser/` 并校验 Ed25519 签名；离线环境可用 `CLOAKBROWSER_BINARY_PATH` 指向本地二进制。

## 九、开发注意事项

- 涉及业务逻辑改动时，请优先回查本地需求文档 `docs/桌面版改造需求文档.md`（v1.2，仅本地保留，不入仓库）与参考项目 `job-claw-main` 的实现口径，对齐既定口径，禁止凭空重写。
- 修改 `electron/preload/webview.cjs` 等主进程 / preload 文件后，**必须重启 Electron** 才能生效（HMR 不覆盖 preload）。
- 业务逻辑对齐参考项目 `job-claw-main` 的采集与投递口径（`task-state` / `job-priority` / `conversation-identity`）。
- 多平台口径：平台元数据、投递语义（chat / App 招呼自动发送 / 简历投递）、外部网申文案、每日上限与优先级统一在 `src/lib/bossclaw/platforms.ts` 收口（BOSS 反爬与各平台行为调研口径：get_jobs / Auto-JobHunter）；新增平台只需扩展该注册层 + `camoufox/platforms/` 平台模块，渲染层组件（PlatformChip 等）自动跟随。
- 每日投递上限按平台独立计数（`platforms[k].dailyTarget`，0=不限，受平台侧上限与 `SAFETY_LIMITS.MAX_SAFE_DAILY` 收窄）；定时任务条目支持 `platforms?` / `limitPerRun?`（见 `useScheduleStore` / `scheduler.ts`），旧 `config.batchDelivery` 启动时一次性迁移为三条限量定时任务。
- AI 技能层：技能开关 / 指令变化 → messages 变化 → AI 缓存 key 自动失效；自定义技能存 `userData/skills`（内置 `appPath/skills` 只读），IPC 白名单校验防路径穿越。
- 开发模式下 Electron 加载 `http://localhost:5173`；生产模式加载 `dist/index.html`。
- 打包前建议先 `npm run verify`（类型检查 + 构建），再 `npm run package`。
