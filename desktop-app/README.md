# BossClaw 桌面版（Electron + React）

> 面向求职者的**本地 AI 投递助手**，**独立桌面应用，不占用你的浏览器**。单窗口桌面应用：固定功能侧栏 + 工作台三栏（侧栏 + 中栏消息进度 + 右栏内置浏览器） + 其余页面双栏；应用后台自动投递简历的同时，你的 Chrome / Edge / Firefox 照常使用。

> 完整使用与开发教程见仓库 [`docs/wiki/`](../docs/wiki/Home.md)（功能指南 / 架构 / 安全 / FAQ），需求与决策见本地 `docs/桌面版改造需求文档.md`（v1.2，仅本地保留）。

***

## 功能闭环

* **岗位来源**：内置浏览器打开招聘平台岗位 → 中栏点「加入任务」→ 自动识别 HR 活跃度（在线 / 刚刚活跃 / N 日内活跃）作为匹配判断依据；岗位详情自动清洗页面噪音（`jdCleaner.ts` 渲染层 + `webview.cjs` 同步）。岗位卡片带**平台标识 chip**（BOSS 直聘绿 / 智联招聘蓝 / 猎聘橙 / 前程无忧紫，`PlatformChip` 组件，配色集中定义于 `platforms.ts`）。

* **多平台（BOSS 直聘 / 猎聘 / 智联招聘 / 前程无忧 51Job）**：设置页「招聘平台」分区启用平台、调整平台优先级（数字 1 = 最高，决定工作台搜索顺序与自动沟通先完成高优先级平台再切换）、配置每平台「每日投递目标」（BOSS / 猎聘 / 前程无忧默认 120/日，智联 100/日，0 = 不限，均受平台侧上限 / `MAX_SAFE_DAILY=150` 收窄，智联平台侧约 100/日）并查看两通道登录状态。各平台登录态本地独立持久化：内置浏览器经 Electron 分区会话（工作台扫码登录），Camoufox 自动沟通经 `~/.bossclaw/camoufox-cookies-{platform}.json`（BOSS 保持 `camoufox-cookies.json`）。至少保留一个启用平台（唯一启用平台不可取消）。

* **半自动投递**：中栏批准岗位 → 浏览器跳转 → AI 草稿预填沟通框 → 用户发送。

* **评分与采集优化（v2.5.3）**：岗位匹配改为 **AI 四层整体裁决**（硬门槛 → 优先条件 → 职责信号 → 团队信号，一次判断给出 `fitLevel` 档位：strong / match / cautious / unfit），**分数由档位映射、不跨档，AI 分即最终分**（本地五维仅用于界面展示与 AI 不可用时兜底，不再做融合或降级调整）；五维语义锚点与「仅显著命中才给高分」的反通胀口径全链路统一；入队门槛改为设置页可配 `minQueueScore`；工作台会话级去重 + `addSkipLogOnce` 合并重复跳过日志。

* **多平台投递入口**：工作台「一键投递」仅处理 **BOSS 直聘岗位**（webview / 官方接口链路）；猎聘 / 智联 / 前程无忧岗位确认后保持投递队列，由「自动沟通」批量引擎投递。

* **自动辅助**：启动后按匹配优先级依次投递 `approved_queue` 队列；webview 回传投递阶段（打开沟通 → 填写 → 发送 → 确认文字气泡 → 确认结果），失败自动暂停交人工核对；**首次成功投递后强制暂停验收**（安全不变量）。

* **任务进度**：中栏任务级进度条 + 阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递），日志流实时滚动；失败可重试 / 忽略 / 跳过。

* **简历中心**：PDF / DOCX / TXT 本地解析（渲染进程内完成，无需桥接）：PDF 用自研解析器（Flate / ASCIIHex / ASCII85 / RunLength + ToUnicode / CMap），DOCX 用 mammoth 浏览器版 + 自研 ZIP/XML 双通道兜底，`.doc` 旧格式给出转档提示；「工作台定制」打招呼语提示词可编辑（留空用系统默认，统一驱动工作台岗位招呼语 / 定制简历求职信 / JD 预览）。

* **AI 能力**：职业画像（AI 完整画像 → 精简重试 → 本地规则三级降级）；岗位匹配（**AI 五维评估 + 档位制裁决，AI 分即最终分**，本地多维评分仅作展示与兜底；评分 / 决策 / 硬条件拦截 / 沟通草稿）；**打招呼语（求职信）提示词优先级**：① greetings 技能（含用户自定义技能）→ ② 简历中心「打招呼语提示词」输入框内容 → ③ 本地规则；投递方向支持 **AI 生成/校准关键词**，并新增 **薪资校准模块** 与 **工作时间偏好** 供 AI 判断匹配与约束沟通内容；AI 生成 + 求职者口吻校验，失败回退本地规则。

* **定制简历**：侧栏「定制简历」页输入岗位 JD，AI 生成定制摘要 / 量化经历 / 求职信 / 技能缺口 / 优化建议，仅引用简历真实事实，AI 输出不达标回退本地规则兜底。

* **AI 技能体系**：`skills/` 内置 resume-profile / job-analysis / greetings / tailor-cv / great-resume / job-match 六技能（SKILL.md），按作用域注入 system prompt；greetings 即「工作台定制的打招呼语提示词」统一口径，驱动工作台岗位招呼语 / 简历中心 JD 预览 / 定制简历求职信；great-resume（经历酥化，assistant 作用域）、job-match（证据驱动岗位匹配，job-analysis 作用域）为增强技能、默认关闭，可在设置页手动启用；支持自定义技能导入 / 新建 / 删除（`userData/skills`，白名单防路径穿越）；设置页「AI 技能」卡片管理。

* **LLM 预设**：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟 / 自定义（OpenAI 兼容端点）。

* **OpenClaw 桥接**：本地 Node 服务（127.0.0.1:18765）提供状态 / 日报 / 指令控制 / OCR / 简历解析 / **日志查看**。

* **可选隐身增强（默认关闭）**：

  * **Camoufox** —— Python 桥（127.0.0.1:18767），**仅使用 Camoufox 原生隐身内核**（本地 Chrome / Edge 不可复用，需自行 `pip install "camoufox[geoip]" && camoufox fetch` 安装内核）。多平台模块在 `camoufox/platforms/`（common 基座 + liepin / zhaopin / job51）；Cookie 按平台独立持久化。非 BOSS 平台的搜索采集与投递均须经此通道。

  * **CloakBrowser** —— Playwright 持久上下文 + 多 Page（需要时自动从 `~/.cloakbrowser/` 加载约 200MB 隐身 Chromium）；含健康检查（`jc:cloak-health`），进程被外部关闭 / 崩溃时 UI 自动重启。

  * **不绕过验证码 / 账户验证**：code 35/36/32 立即停止并交人工。

* **自动沟通**（「自动沟通」页）：Camoufox 隐身引擎**多平台批量沟通**，按平台优先级串行消费（先完成高优先级平台的全部已确认岗位，再切下一平台）。投递语义按平台适配：BOSS 输入并发送打招呼语（**文字气泡确认**）；猎聘点「聊一聊」→ 平台用 **App 预设招呼语自动发送**（须先在猎聘 App 设置招呼语文案，脚本不注入文本），确认聊天窗打开 / 按钮变「继续聊」即计成功；智联 / 前程无忧点「投递」（前程无忧按「批量投递」+ 成功数量确认），确认「投递成功」/「已投递」即计成功。**AI 跟聊（needsReply）仅 BOSS 聊天链路支持**，其余平台回复请在平台 App 内人工跟进。平台卡片实时显示各平台引擎 / 登录状态，可逐平台「登录 / 退出」；未确认投递结果不计成功、code 35/36/32/37 立即停止交人工。

* **主题**：浅色 / 深色 / 跟随系统（antd + CSS 变量，状态持久化）。

* **定时任务**：侧栏「定时任务」页配置，按设定时刻（HH:mm + 星期，空 = 每天）自动触发「投递 / 采集 / 备份」三类动作；全局调度器每 15s 心跳扫描、按目标时刻去重（同一分钟只触发一次）。每条任务可圈定**目标平台**（留空 = 全部已启用平台）；「投递」任务可设**单轮条数上限**（>0 时成功满该数即结束本轮，等待下一触发时刻——多条限量定时投递即构成「分批投递」）；「分批投递模板」卡片一键创建 早间 09:00 / 午间 13:00 / 晚间 18:00 三条任务（默认每轮 40 条、全部启用平台）；旧版 `config.batchDelivery`（早中晚分批）启动时一次性迁移为「早/午/晚间限量投递」三条任务（幂等，仅迁移曾开启者）。投递复用自动投递引擎全部安全守卫（冷却 / 每日上限 / 平台配额 / 首条验收 / 风控交人工），引擎已在运行时跳过本次触发；「采集」经跨页标志（携带目标平台）交常驻工作台按平台逐一消费；最小化时仍触发（主进程关闭背景节流 `backgroundThrottling: false`）。

* **本地自动备份**：`localStorage` 为主存储，另按可配置目录（默认 `userData/backup`，写在 `userData/.backup-dir.txt` 指针）做周期写盘；每 5 分钟脏检查（序列化 keys 未变化则不重写文件），覆盖 `bossclaw-app / -settings-v2 / -data / -schedule` 四组键；`localStorage` 缺失或「清空全部数据」后，可从本地备份文件自动回签恢复。

* **开机自启动**：设置页开关，写入 Windows 登录项（`setLoginItemSettings`，打包安装版生效），配合定时任务实现应用运行期间自动投递 / 采集 / 备份。

* **首页「阅读使用文档」**：首页操作区提供「阅读使用文档」按钮，主进程读取用户文档 `resources/docs/使用前必读.md`（开发与打包同源，均指向应用 resources/docs/，`extraResources` 已配置）经 MarkdownView 抽屉渲染。

* **公司规模筛选**：设置页新增「公司规模」单选，映射 BOSS web 端 scale 参数（0-20人=301 … 10000人以上=306，不限 = 不附加过滤），参与搜索采集与搜索 URL 构造。

* **数据**：设置页可导出 / 导入 / 清空本地数据（localStorage），并支持「立即备份 / 从本地备份恢复」。

***

## 技术栈

* **Electron** `^31`（主进程 CommonJS：`electron/main.cjs` + `electron/preload/*`）

* **React 18 + TypeScript + Vite 5**（渲染进程：`src/`）

* **Ant Design 5**（UI）+ **Zustand**（状态，persist 接 localStorage）

* 打包：**electron-builder**（Windows NSIS + 便携版，macOS dmg + zip，Linux AppImage + deb）

***

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
│   ├── camoufox_server.py            # Python 隐身搜索/发送桥（多平台调度基座）
│   ├── platforms/                    # 平台模块：common.py（公共基座/人类化/Cookie 按平台持久化）+ liepin.py / zhaopin.py / job51.py
│   └── requirements.txt
├── resources/
│   └── icon.ico
├── skills/                          # AI 技能库（SKILL.md，内置 resume-profile / job-analysis / greetings / tailor-cv / great-resume / job-match）
│   ├── resume-profile/SKILL.md
│   ├── job-analysis/SKILL.md
│   ├── greetings/SKILL.md
│   ├── tailor-cv/SKILL.md
│   ├── great-resume/SKILL.md
│   └── job-match/SKILL.md
└── src/
    ├── main.tsx / App.tsx / theme.ts / index.css
    ├── store/                        # useAppStore / useDataStore / useSettingsStore / useScheduleStore
    ├── lib/                          # storage / electronApi / bridgeClient / localBackup / scheduler / bossclaw/*（platforms 平台注册 / matching / profile / greetings / jobMatch / jobAssistant / jdCleaner / skills 等）
    ├── components/                   # TitleBar / Sidebar / StatusBar / BrowserView / CloakView / PlatformChip / MarkdownView / feedback
    └── pages/                        # Home / Workbench / Resume / Directions / Tasks / ScheduleTasks / Stats / Assistant（定制简历）/ OpenClaw / AutoChat / Settings
```

***

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
>
> ```bash
> python -m venv .venv
> .venv\Scripts\pip install -r camoufox\requirements.txt
> .venv\Scripts\python -m camoufox fetch   # 必装：下载 Camoufox 原生内核(~150MB)；本地 Chrome/Edge 不可复用，不装则引擎不可用
> ```

> **可选 — CloakBrowser**：首次启用「隐身浏览器」模式时，launcher 自动下载 \~200MB 隐身 Chromium 到 `~/.cloakbrowser/` 并校验 Ed25519 签名。离线/受限环境可下载 `.zip` 后用 `CLOAKBROWSER_BINARY_PATH` 指向本地二进制。

***

## 常用命令

```bash
npm install                # 安装依赖

npm run dev                # 启动 Vite dev server（默认 5173；Electron 由 dev:electron 启动）
npm run dev:electron       # 构建 renderer 并以 Electron 打开（生产模式预览）
npm start                  # 仅启动 Electron（需先 build 或 dev 服务在跑）

npm run typecheck          # 仅类型检查（不打包）
npm run build              # 类型检查 + Vite 构建到 dist/
npm run verify             # typecheck + build 组合

npm run package            # 构建并打包 Windows NSIS 安装包 + 绿色便携版
npm run package:portable   # 仅打包绿色便携版（无需安装）
npm run package:dir        # 仅生成解压目录（不打包，便于本地试运行）
npm run package:mac        # 打包 macOS dmg + zip（只能在 macOS 系统执行）
npm run package:source     # 生成 macOS 源码打包档案（无 Mac 环境时交给 Mac 用户自行打包）
npm run package:linux      # 打包 Linux AppImage + deb
npm run package:all        # 打包 Windows + Linux
```

> **macOS 安装包**受 electron-builder 限制，只能在 macOS 上构建（dmg 依赖 macOS 系统工具）；Windows / Linux 可在本机直接打包。
> **没有 Mac 环境**：执行 `npm run package:source`，在 `release/` 生成 `BossClaw-<版本>-mac自行打包.tar.gz` 源码档案；Mac 用户安装 [Node.js 20+](https://nodejs.org) 后解压，运行内含的 `./build-mac.sh` 一键完成依赖安装与 dmg/zip 打包（Intel + Apple Silicon 双架构）。

> **Electron dev 模式**：开发模式下 Electron 加载 `http://localhost:5173`（自动扫描 5173-5179 端口），失败则回退 `dist/index.html`；生产模式只加载 `dist/index.html`。
> **首次运行需在本机有 Electron 运行环境**（`npm install` 会安装 `electron` 包及其二进制）。

> **环境变量**：
>
> * `BOSSCLAW_DEBUG=1`：写入 `userData/bossclaw-debug.log` 并启用白屏诊断日志（`userData/debug-render.log`）。
>
> * `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`：国内网络加速 Electron 二进制下载。

***

## 打包产出

各平台打包命令均在 `release/` 目录产出产物：

### Windows（`npm run package` 或 `package:all`）

```
release/
├── BossClaw-2.5.3-x64.exe           # Windows NSIS 安装包（推荐发行）
├── BossClaw-2.5.3-portable.exe      # Windows 绿色便携版（无需安装、解压即用）
├── BossClaw-2.5.3-x64.exe.blockmap  # NSIS 增量更新 blockmap（electron-builder 自动生成）
└── win-unpacked/                     # Windows 解压目录（可手工分发的文件夹）
```

### Linux（`npm run package:linux` 或 `package:all`）

默认一次性产出全部 5 种 Linux 格式：

```
release/
├── BossClaw-2.1.0-x86_64.AppImage   # Linux 通用（跨发行版可执行单文件）
├── BossClaw-2.1.0-amd64.deb         # Debian / Ubuntu / Linux Mint 等 deb 系
├── BossClaw-2.1.0-x86_64.rpm        # RHEL / Fedora / CentOS / openSUSE 等 rpm 系
├── BossClaw-2.1.0-x64.pacman        # Arch Linux / Manjaro / EndeavourOS 等 pacman 系
├── BossClaw-2.1.0-x64.tar.gz        # 通用 gzip 压缩包（解压后直接运行）
└── linux-unpacked/                   # Linux 解压目录
```

也可以单独指定某一种：`npm run package:linux:deb` / `:rpm` / `:pacman` / `:tar`。

### macOS（`npm run package:mac`，只能在 macOS 系统执行）

```
release/
├── BossClaw-2.1.0-x64.dmg / .zip    # Intel Mac（x86_64）
├── BossClaw-2.1.0-arm64.dmg / .zip  # Apple Silicon（M1/M2/M3/M4）
└── mac/                              # macOS 解压目录（.app）
```

没有 Mac 环境时，执行 `npm run package:source` 生成 `BossClaw-2.1.0-mac自行打包.tar.gz` 源码档案（含 `build-mac.sh` 一键脚本），交给 Mac 用户解压后直接 `./build-mac.sh` 即可完成双架构 dmg/zip 打包。

***

## 功能侧栏入口

固定 11 入口：**首页 · 工作台（三栏自动投递）· 简历中心 · 投递方向 · 任务进度 · 定时任务 · 数据统计 · 定制简历 · OpenClaw · 自动沟通 · 设置**。

***

## 公开架构

### 进程边界

* **主进程**（`electron/main.cjs`，CommonJS）：单窗口生命周期 + IPC 总线 + `persist:bossclaw` 会话 + CloakBrowser / Camoufox / Node 桥 子进程管理。

* **预加载**（`electron/preload/*.cjs`，`contextIsolation: true`）：`app.cjs` 暴露 `window.electron` API；`webview.cjs` 注入 BOSS 页面，跑官方 API + DOM 兜底 + 真实键盘输入。

* **渲染进程**（`src/`，ESM）：React SPA + antd。`window.electron` 是唯一与主进程交互的接口。

### IPC 总线（白名单 channel）

详见 `electron/main.cjs` 与 `electron/preload/app.cjs`：

| Channel                       | 用途                                                |
| ----------------------------- | ------------------------------------------------- |
| `jc:app-info` / `jc:window-*` | 应用信息、窗口控制（标题栏按钮）                                  |
| `jc:open-external`            | 用系统浏览器打开外部链接                                      |
| `jc:read-doc`                 | 读取「使用前必读」文档（首页阅读入口；文档源 resources/docs/，开发与打包一致）   |
| `jc:fetch-url`                | 主进程代理跨域 fetch（城市编码表）                              |
| `jc:boss-login`               | 检查各平台在「内置浏览器（工作台）」会话中的登录态（BOSS 读 wt2 cookie，返回 platforms 映射） |
| `jc:boss-logout`              | 退出指定平台的内置浏览器会话登录态                              |
| `jc:webview-input`            | webview 真实键盘输入（CDP 等价）                            |
| `jc:camoufox-*`               | Camoufox Python 桥（status / search / send / login / logout / restart，按平台） |
| `jc:cloak-*`                  | CloakBrowser 隐身浏览器（启动 / 标签 / 输入 / health 健康检查自动重启）                  |
| `jc:bridge-control`           | OpenClaw Node 桥启停                                 |
| `jc:autostart-*`              | 开机自启动（Windows 登录项，get / set）                       |
| `jc:backup-*`                 | 本地备份（dir-get / dir-set / dir-pick / write / read / delete） |
| `jc:clipboard-write`          | 剪贴板写入（查看网页源码复制）                              |
| `jc:save-pdf`                 | 定制简历 A4 打印成 PDF 并保存                              |

所有 IPC handler 统一经 `safeHandle` 包装，未捕获异常写日志后**保持原有 throw 语义**（渲染端 `invoke` reject 行为不变）。

### 渲染层状态分层

* **运行时状态**（`useAppStore`）：主题、活动路由、桥状态、BOSS 登录态、引擎状态——**不持久化**（每次启动重置）。

* **业务数据**（`useDataStore`）：岗位 / 任务 / 日志 / 画像——**持久化到 localStorage**（带 `bossclaw-data-version` 重置）。

* **用户配置**（`useSettingsStore`）：LLM 密钥、过滤规则、招呼语、引擎模式——**持久化**（设置页可导出/导入）。

***

## 常见问题

* **白屏**：`set BOSSCLAW_DEBUG=1` 后启动，查看 `userData/debug-render.log` 内 DOM 检查 / 浏览器状态。

* **首次启动登录态丢失**：v3 重建后首次启动会清空旧 `persist:bossclaw` 会话与 Camoufox 缓存（`DATA_VERSION='v3-rebuild-20260815'`）。需重新扫码登录。

* **隐身引擎报错** **`未检测到可用内核`**：安装 Chrome / Edge / Firefox 任一，或 `pip install 'camoufox[geoip]' && python -m camoufox fetch`。

***

## 变更记录

* v2.5.3 — 评分裁决与简历定制收口：岗位匹配改为 AI 四层整体裁决（`fitLevel` 档位制，分随档走、AI 分即最终分），五维语义锚点与反通胀口径统一，入队门槛可配 `minQueueScore`；投递链路改走内置浏览器真实 DOM 沟通（单线性等终态、气泡级文字确认），自动沟通卡片新增「跳过」、附件按聊天页源码重构；定制简历保留能力描述语红线 + 七模块结构化文档 + 校名披露规则（仅 985/211 写校名）与目标城市同源；新增统计导出（CSV / PDF）、有界分析队列与新标签页管理。
* v2.5.2 — 采集评分优化与多页增强：岗位评分融合（AI×0.7 + 本地×0.3）、修正谨慎档、移除本地预筛开关、会话级去重；内置浏览器多页管理（browserRegistry）+ force-resize 重绘、修复页面加载崩溃；方向关键词 AI / 薪资校准 / 工作时间安排；内置 Agent 控制桥（白名单动作、本地令牌鉴权、默认关闭）+ MCP 服务器（`mcp/bossclaw-mcp`）。
* v2.5.0 — 多平台投递适配与安全加固：Camoufox 引擎按平台细分（job51 / liepin / zhaopin），「自动沟通」支持 BOSS 文字气泡、猎聘「聊一聊」、智联 / 前程无忧投递简历，各平台独立登录态与每日计数；HR 来消息后 AI 跟聊回复不再计入单日投递上限；会话去重 / 投递锁 / 持久化安全细节收敛。
* v2.4.0 — 定时任务（投递 / 采集 / 备份，HH:mm + 星期，心跳去重）；本地自动备份（5 分钟脏检查写盘 + 缺失自动回签恢复）；开机自启动（Windows 登录项）；首页「阅读使用文档」入口；公司规模筛选（BOSS scale）；新增 great-resume / job-match 增强技能；关闭后台节流保证最小化定时仍触发。
* v2.3.0 — 批量自动沟通引擎重构（遵循首次验收 / 打招呼语非空 / 频率限制等安全不变量）；隐身引擎（Camoufox）/ 隐身浏览器（CloakBrowser）与贡献模块细节优化；通信模块实现优化。
* v2.1.0 — AI 技能体系（内置 4 技能 + 自定义技能导入/新建/删除）；定制简历求职助手（JobAssistant，侧栏新增入口）；岗位匹配本地确定性多维匹配与 AI 融合；岗位采集页面噪音清洗（jdCleaner）；版本 / productName 统一为 BossClaw，新增 macOS / Linux 打包配置。

* v2.0.0 — 内置浏览器 + 收集投递沟通模块从零重建；统一 IPC 错误包装；Workbench 三栏拆分；CloakBrowser / Camoufox 可选隐身增强。

