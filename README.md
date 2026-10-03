<div align="center">

# BossClaw

**面向求职者的本地 AI 投递助手（Electron 桌面应用）— 独立运行，不占用你的浏览器，正常上网的同时自动投递简历**

从简历解析、职业画像和岗位方向选择，到岗位信息整理、AI 匹配排序、沟通草稿生成与投递进度管理，全部集中在一个本地桌面应用中完成。

[快速开始](#快速开始) · [下载安装](#下载安装) · [核心功能](#核心功能) · [使用边界](#安全与使用边界) · [桌面版说明](desktop-app/README.md) · [Wiki](https://github.com/YanQuan-dozzy/Boss-Claw/wiki) · [Agent 接入](#外部-agent-接入可选控制桥--mcp--代答)

![Version](https://img.shields.io/badge/version-v2.5.5-078A83)
![Electron](https://img.shields.io/badge/Electron-%5E31-47848F)
![React](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)
![Storage](https://img.shields.io/badge/data-local--first-2AA66A)
![Language](https://img.shields.io/badge/language-简体中文-F06284)
![License](https://img.shields.io/badge/license-Apache--2.0-2AA66A)

</div>

> **版本口径**：本文以 `main` 分支当前实现为准；**当前代码版本为 v2.5.6**（2026-10-03，尚未打包发布）；**最新正式安装包为 v2.5.5**（2026-09-22 发布，Windows）。`main` 已包含 v2.5.6 的全部改动（内置浏览器请求头与真机画像对齐、猎聘 / 前程无忧全链路、岗位过期判定、AI 跟聊监听、旧版 `.doc` 解析等），功能表按当前实现标注。

## 下载安装

打包产物发布在 [GitHub Releases](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest)，**开箱即用，下载即可运行**：

| 版本 | 文件 | 说明 |
| --- | --- | --- |
| 🪟 安装版（推荐） | [BossClaw-2.5.5-x64.exe](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest/download/BossClaw-2.5.5-x64.exe) | 标准 NSIS 安装包，可自定义安装目录、创建桌面/开始菜单快捷方式 |
| 🪟 便携版 | [BossClaw-2.5.5-portable.exe](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest/download/BossClaw-2.5.5-portable.exe) | 绿色单文件，无需安装、解压即用 |

Linux（AppImage / deb / tar.gz）与 macOS（源码自构建档案）产物目前仍为 **v2.5.3**，见 [Releases](https://github.com/YanQuan-dozzy/Boss-Claw/releases) 对应版本页；也可从源码自行打包（`npm run package:linux` / `package:mac`，macOS 的 dmg 只能在 macOS 上构建）。

- **运行要求**：Windows 10/11（x64）；Linux 主流 x86_64 发行版；macOS 需自构建。
- **首次启动**按提示在「设置」页填写求职条件与 AI API Key 即可使用（API Key 只存本机，不上传）。
- BossClaw 由用户主动控制，不属于任何招聘平台的官方产品，也不代表平台提供授权、合作或背书；使用者应遵守适用法律、目标网站规则及账号使用要求。

## BossClaw 是什么

求职过程中，用户通常需要反复查看岗位要求、判断匹配程度、整理沟通内容、记录投递状态并处理失败任务。BossClaw 把这些环节整理为一条清晰流程：

```text
导入简历 → AI 生成职业画像 → 自主选择投递方向 → 整理岗位信息
        → AI 匹配与优先级排序 → 人工确认 / 半自动辅助 → 查看进度与处理异常
```

系统始终以**求职者 / 应聘者**身份工作：职业画像、岗位判断和沟通内容必须基于用户简历与岗位页面中存在的真实信息，不应虚构经历、技能、学历、薪资、到岗时间或其他事实。AI 输出仅作为辅助建议，重要内容应由用户核对后使用；BossClaw 的目标是减少重复整理工作，**而不是替代用户作出求职决定**。

**为什么是桌面端**：不同于必须寄生在浏览器里的扩展或网页脚本，BossClaw 是独立应用 —— 投递、沟通与登录态都在应用自带的浏览器窗口里完成，你的 Chrome / Edge / Firefox 照常使用；切走页面或关掉标签都不影响后台投递；简历、画像、任务与 API Key 全部留在本机。

## 核心功能

| 模块 | 能力 |
| --- | --- |
| 首页 / 工作台 | 运行状态与配置进度概览；工作台三栏（侧栏 + 消息进度 + 内置浏览器），搜索采集 → 审核 → 投递闭环，支持人工确认 / 半自动 / 自动辅助三种节奏；设置页可导出 / 导入 / 清空本地数据与备份恢复，主题支持浅色 / 深色 / 跟随系统 |
| 多平台招聘 | BOSS 直聘 + 可选启用 **猎聘 / 智联招聘 / 前程无忧 51Job**：平台优先级、独立登录态与每日配额（BOSS / 猎聘 / 前程无忧默认 120/日，智联 100/日），岗位卡片带平台标识；四平台均已打通「搜索 URL 构造 → 列表采集 → 详情 JD 补齐 → 审核入队 → 投递」全链路 |
| 简历中心 | 导入 PDF / DOCX / DOC（含旧版 Word 97-2003 与「实为 RTF / HTML」的文件）/ MD / TXT，**全部本地解析**、保留可编辑原文 |
| 职业画像 / 投递方向 | AI 生成可编辑画像（失败逐级回落本地规则）；方向支持勾选、修改搜索词、调整优先级、AI 生成 / 校准关键词 |
| 岗位过滤（确定性） | 城市反选、公司 / 猎头黑名单、HR 活跃度、面试方式（**未明确披露不误杀**）、**JD 截止日期过期判定**（仅 JD 显式写明时生效，默认猎聘开启）—— 纯本地判定，不消耗 AI Token 与投递配额 |
| AI 匹配与评分 | **AI 四层整体裁决**（硬门槛 → 优先条件 → 职责信号 → 团队信号），给出 `fitLevel` 档位（strong / match / cautious / unfit），**分数随档走、AI 分即最终分**；本地五维分只用于界面展示与 AI 不可用时兜底，唯一改分能力为硬约束拦截 |
| 沟通与投递 | AI 生成个性化招呼语（求职者口吻、≤250 字）；工作台「一键投递」按岗位平台自动分派通道（BOSS 走详情页真实 DOM 沟通；猎聘 / 智联 / 前程无忧在各自平台标签页内投递） |
| 自动沟通 | 可选真实浏览器引擎（Camoufox）多平台批量沟通：BOSS 发招呼语（文字气泡确认）、猎聘「聊一聊」（App 预设招呼语）、智联 / 前程无忧投递简历；按平台优先级串行、各平台独立计数 |
| AI 跟聊（BOSS） | 可选开关：常驻巡检「已投递」会话，HR 发来新消息即带多轮上下文生成回复并发送，HR 明确拒绝则收口该会话；回复类发送**不计入**单日投递上限 |
| 定制简历 | 输入目标岗位 JD，生成定制摘要 / 量化经历 / 求职信 / 技能缺口 / 优化建议，仅引用简历真实事实，不达标回退本地规则 |
| AI 技能 | 标准 SKILL.md 技能体系（内置 7 项），支持自定义技能导入 / 新建 / 删除，按作用域注入提示词 |
| 定时任务 / 备份 | 按 HH:mm + 星期自动触发投递 / 采集 / 备份，可圈定目标平台与单轮上限；本地每 5 分钟脏检查写盘、缺失自动回签恢复；支持开机自启动 |
| 数据统计 | 投递量 / 沟通量 / 成功率看板 + **投递漏斗**（采集入队 → 已投递 → 已打开沟通 → 已回复 → 面试）；支持导出岗位明细 CSV / 统计汇总 CSV / 统计报表 PDF（A4 横版） |
| 外部 Agent | 内置控制桥（白名单动作、本地令牌、默认关闭）+ 零依赖 MCP 服务器（8 工具 / 3 组）；未配置 API Key 时可交由在线外部 Agent 代答 |
| 可选桥接 / 增强 | OpenClaw 本地 Node 桥接（扫描版 PDF 的 OCR、求职日报、任务状态恢复与日志，可选）；隐身引擎（Camoufox）/ 隐身浏览器（CloakBrowser），设置页默认关闭，**不绕过**验证码与账户验证 |

> 端口协议、目录结构、回归脚本与排障细节见 [`desktop-app/README.md`](desktop-app/README.md) 与 [Wiki](https://github.com/YanQuan-dozzy/Boss-Claw/wiki)。

## 架构与布局

- **技术栈**：Electron `^31` + React 18 + TypeScript + Vite + Ant Design 5 + Zustand（persist → localStorage），本地数据零后端依赖。
- **进程模型**：主进程（CommonJS）+ 预加载脚本（`contextBridge` 安全 IPC）+ React 渲染层；`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: true`。
- **界面**：顶部标题栏 + 左侧 11 入口侧栏 + 底部状态栏；「工作台」为三栏，其余页面为双栏。
- **内置浏览器**：Electron `<webview>`，默认加载 BOSS 直聘，可切换各已启用平台首页；登录态按平台本地持久化（免重复登录）。
- **多平台口径**：平台差异集中在 `electron/preload/platform-adapters.cjs`（纯数据 + 纯函数）；BOSS 是唯一「列表内联详情」形态，非 BOSS 列表级采集的详情 JD 由内置浏览器按**平台同源**接口补齐（智联 = 详情 JSON、猎聘 = 同源 SSR 详情页 HTML，**与是否安装 Camoufox 无关**）。
- **故障隔离**：平台级故障（未登录 / 4xx·5xx）只收口当前平台、后续平台继续；队列级故障（风控码 32·35·36、环境异常 37·38、未知码 fail-safe）立即中止整批交人工。

## 快速开始

### 1. 环境与依赖

需要 Node.js 20+（推荐 22）；隐身引擎需 Python 3.10+。仓库**不含**运行时依赖（`node_modules` / Electron 二进制 / Python 包均需自行下载）。

```bash
# 方式一（推荐，Windows）：双击仓库根目录的 install-deps.cmd（自动处理镜像与重试；
#   可选安装 Python 隐身引擎 camoufox + playwright）
# 方式二（手动）：
cd desktop-app
npm install           # 安装依赖（含 Electron 二进制）
npm run dev           # 启动 Vite dev server
npm run dev:electron  # 构建 renderer 并以 Electron 打开
```

> 国内网络：`npm install` 失败时加 `--registry=https://registry.npmmirror.com`；Electron 二进制下载失败时执行 `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js`。

也可以双击仓库根目录的 `start-bossclaw.cmd` 一键启动：默认走「快速路径」直接运行 `dist/` 产物（检测到源码改动会先重建），`--dev` 改用 Vite dev server，`--visible` 保留控制台日志，`--no-agent` 不开启本地控制桥。

### 2. 首次配置

1. 「设置」页填写求职条件与 AI API Key（预设 OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟，或自定义 OpenAI 兼容端点）→ 测试连接并保存
2. 「简历中心」导入并核对简历原文 → 生成、检查并编辑职业画像（**删除任何不准确、无证据或夸大的内容**）
3. 「投递方向」勾选要投的方向并点「确认方向」（未确认不会建立任务）
4. 「工作台」打开岗位详情页 → 「加入任务」→ 中栏核对后批准 → 人工确认发送

### 3. 首次执行应完成单条验收

第一次使用半自动 / 自动辅助时，**只处理一个由自己确认的岗位**，逐项确认：打开的是所选岗位、沟通对象与岗位一致、沟通文字基于真实简历、页面出现完整的**已发送文字气泡**、任务状态记录正确、无登录异常或安全验证。任何一步无法确认都应立即暂停并查看原因，不要连续重复执行 —— 系统在首次成功投递后也会**强制暂停**待你验收。

## 使用流程

- **人工确认**（适合首次）：AI 完成岗位分析与沟通草稿后，由用户逐条检查、修改并决定是否继续。
- **半自动投递**：中栏批准岗位 → 浏览器跳转对应页 → AI 草稿预填沟通框 → **用户点发送**。
- **自动辅助**：按匹配优先级依次投递 `approved_queue` 队列，失败自动暂停交人工核对。
- **自动沟通**：按匹配优先级依次处理队列岗位，在真实浏览器中打开沟通窗口并发送，发送结果确认后才计成功；BOSS 可另开「AI 跟聊监听」（冷却期或未登录时不可开启）。

> **多平台投递**：工作台「一键投递 / 开始投递」按岗位所属平台分派通道 —— BOSS 走内置浏览器详情页真实 DOM 沟通（开启「优先隐身通道」时改走 Camoufox）；猎聘 / 智联 / 前程无忧在各自平台的标签页内投递，外部网申 / 已投递岗位自动跳过；「自动沟通」引擎是另一条批量通道。
>
> **多平台采集**：引擎闸门只看是否启用隐身引擎 —— 开启走 Camoufox（列表 + 详情 JD + 词级断点续采），未开启走内置浏览器可视化采集（BOSS 详情级，其余平台列表级，详情 JD 按平台同源接口补齐），因此**未装 Camoufox 内核也能采集非 BOSS 平台**。各平台按优先级串行采集，遇队列级阻断即中止整批交人工。

遇到安全验证、登录异常、对象不确定、页面结构异常或结果无法确认时，应立即暂停。进度与异常任务在「任务进度」页查看：任务级进度条 + 阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递）与实时日志流，历史失败任务可打开原岗位后决定单条重试、忽略或继续。

## 外部 Agent 接入（可选）：控制桥 · MCP · 代答

BossClaw 自带一条面向外部 Agent 的本地控制通道，供 Claude / WorkBuddy / Cursor 等任意 MCP 客户端读取实时状态并驱动白名单动作。**默认关闭，必须显式开启**，无需任何云端服务。

| 组成 | 位置 / 端点 | 说明 |
| --- | --- | --- |
| 应用内控制桥 | `127.0.0.1:17650`（`electron/control-bridge.cjs`） | 仅监听本机回环；除 `/health` 外全部要求 `x-bossclaw-token`，令牌写入 `<userData>/control-bridge.json` |
| 开启方式 | `BOSSCLAW_CONTROL=1` 或 `--control-bridge` | 仓库根 `start-bossclaw.cmd` 启动默认开启（`--no-agent` 可关）；裸 `electron .` 与打包版默认关闭 |
| MCP 服务器 | `mcp/bossclaw-mcp`（零依赖 stdio） | **8 个工具 / 3 组**：运行控制 · 应用控制 · agent 代答 |

**动作边界（硬约束）**：动作由渲染层白名单（`src/lib/controlRuntime.ts`）强制，只有状态读取、切页、主题、暂停 / 恢复投递、平台与调度配置、数据写入、AI 生成、浏览器只读 + 白名单操作等；**不提供任何发消息、批量投递、绕过验证码或速率限制的能力**，也不会放开 `SAFETY_LIMITS`。

**Agent 代答**：当用户**未配置 AI API Key** 时，应用内 AI 调用（岗位分析 / 职业画像 / 打招呼语 / 定制简历）会把「完整提示词 + 用途 + 是否要 JSON」挂进本地待答队列，由在线外部 Agent 用自有模型回答后回填：

```text
应用（无 apiKey）→ 入队等待
  → Agent：bossclaw_agent_tasks（长轮询领取，领取即心跳）→ 用自有模型生成
  → Agent：bossclaw_agent_submit 回填 → 应用按与真实模型调用相同口径解析并继续自身校验链
  （答不出可 bossclaw_agent_cancel，应用立刻回落本地规则）
```

- **在线判定 / 时限**：最近 90s 内调用过 `bossclaw_agent_tasks` 才算在线（应用无法主动调用 stdio MCP）；单任务等待 30s ~ 240s，超时即回落本地规则，JSON 纠偏最多 1 次。
- **只搬运「提示词 ↔ 生成文本」**：不涉及投递、发送、验证码、速率限制或安全参数；回填内容仍要过全部校验链（事实与口吻、校名披露、招呼语长度截断等），不合规照样被本地规则替换 —— 这是预期行为。
- 用户**配置了 API Key** 即直连自己的模型，不走代答。

## 安全与使用边界

BossClaw 官方版本不应实现、宣传或用于：

- 绕过验证码、登录验证、安全提示、访问限制或平台技术管理措施
- 导出、共享、出售或远程托管登录 Cookie、Token、Session 等会话凭证
- 未经授权调用内部接口、突破鉴权，或访问普通用户无权查看的数据
- 使用代理池、账号池、设备指纹伪装、账号轮换等反检测手段逃避限制
- 在账号受到限制后自动重新登录、自动换号或继续执行任务
- 多账号群控、骚扰式重复发送、虚假信息投递或极端高频操作
- 建立跨用户的招聘联系人 / 聊天记录 / 个人信息数据库，或伪造简历能力、经历、学历、薪资、到岗时间与面试安排
- 干扰网站正常运行，或将本项目用于违反适用法律和网站规则的行为

**出现以下任一情况应立即停止并由用户处理**：验证码 / 安全验证 / 账号异常；登录受限、访问受限或频率限制；当前岗位、公司或沟通对象无法确认；页面结构变化导致执行目标不明确；沟通内容或附件的发送结果无法确认；用户未明确选择当前岗位或未授权本次操作。

**关键安全不变量**（贯穿所有投递环节）：

- 未确认右侧聊天**文字气泡**时：不发送附件、不计成功、不跳下一岗位
- 目标 HR 或会话明确冲突时：不发送；**外部网申岗位**：跳过；同一任务重复重试会被锁定
- **首次成功投递一条后必须暂停验收**，让用户核对聊天对象、文字气泡与附件
- 不得替用户承诺薪资、到岗时间、面试时间或不存在的经历
- 所有提示词与招呼语必须使用求职者口吻，仅引用真实简历事实
- 外部 Agent 通道（控制桥 / MCP / agent 代答）**只读写提示词与生成文本**，不得代替用户确认或触发发送、投递，也不得改动安全参数

> **关于可选增强「隐身引擎 / 隐身浏览器」**：设置页默认关闭，需用户主动启用，且**仅使用 Camoufox 原生隐身内核**（本地 Chrome / Edge 因无法通过反爬识别不可复用），目的是降低「正常操作被误判为机器人（环境异常 code 37）」的概率。它**不绕过**验证码 / 账户验证（code 35/36/32 仍立即停止并交人工），不自动换号，不突破任何平台限制；涉及风控码、首次投递验收、招呼语非空等安全不变量与内置浏览器通道完全一致。

## 数据与隐私

- 简历、职业画像、筛选条件、API Key 和任务记录默认保存在**用户本机**（localStorage）；项目不要求导出、上传或共享登录 Cookie、Token 和会话文件；各平台登录态仅在本地持久化用于免重复登录，不上传。
- 不应持久化与求职任务无关的招聘联系人个人信息或完整聊天记录；AI 功能可能将必要的简历摘要与岗位信息发送给**用户自行配置**的模型服务商，请按自身隐私要求选择服务，并在不需要时删除本地数据。
- 请勿把真实简历、API Key、手机号、邮箱、身份证信息或完整运行日志提交到公开仓库和 Issue；导出诊断信息前应检查并隐藏个人身份、联系方式、聊天内容、账号信息与密钥。

## 项目结构

```
Boss-claw/
├── desktop-app/               当前主应用（Electron + React，v2.5.6）
│   ├── electron/              主进程 main.cjs + control-bridge.cjs + preload/（app / webview / platform-adapters）
│   ├── bridge/  camoufox/     OpenClaw Node 桥接后端 · Python 隐身引擎桥（camoufox_server.py + platforms/ 多平台采集层）
│   ├── skills/  src/          AI 技能库（SKILL.md 内置 7 项）· React 渲染进程（store / components / pages / lib）
│   └── resources/  package.json   应用图标与随包文档 · 依赖、scripts 与 electron-builder 打包目标
├── mcp/bossclaw-mcp/          可选：零依赖 stdio MCP 服务器（8 工具 / 3 组）
├── docs/                      **本地内部文档，未随仓库分发**（`.gitignore` 忽略）
├── install-deps.cmd           一键安装依赖（Node + Electron，可选 Python 隐身引擎）
├── start-bossclaw.cmd         一键启动脚本（默认开启控制桥，`--dev` / `--visible` 可选）
├── ATTRIBUTION.md / NOTICE    署名与 Apache-2.0 通知
└── LICENSE                    Apache License 2.0
```

完整目录说明见 [`desktop-app/README.md`](desktop-app/README.md)。

## 本地开发

```bash
cd desktop-app
npm install             # 安装依赖
npm run dev             # Vite dev server（http://localhost:5173）
npm run build           # tsc 类型检查 + vite 构建到 dist/
npm run verify          # typecheck + build 组合
npm run package         # 打包 Windows 安装包（NSIS + 便携版，产出到 release/）
npm run package:linux   # 打包 Linux（AppImage + deb）
npm run package:mac     # 打包 macOS（dmg + zip，需在 macOS 上执行）
```

打包格式由 `desktop-app/package.json` 的 `build.*.target` 决定，需要 rpm / pacman 等其它格式时自行补充目标后重新打包。开发模式加载 `http://localhost:5173`，生产模式加载 `dist/index.html`。

涉及业务逻辑改动时，请优先回查 `desktop-app/` 下的既有实现与 [Wiki](https://github.com/YanQuan-dozzy/Boss-Claw/wiki) 文档，对齐既定口径，禁止凭空重写。

## 反馈与联系

遇到问题时，建议先查阅 [Wiki](https://github.com/YanQuan-dozzy/Boss-Claw/wiki) 与 [`desktop-app/README.md`](desktop-app/README.md) 的「常见问题」。提交 Issue 时请包含：BossClaw 版本（桌面版 v2.5.6）、操作系统与 Electron 版本、出错步骤、**已隐藏隐私信息**的截图、完整错误信息。

## 开源许可与署名

BossClaw 采用 [Apache License 2.0](LICENSE) 开源。复制、修改和再分发时，请保留 `LICENSE` 与 `NOTICE`，并清晰说明所作的实质性修改。详细署名要求见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 免责声明

BossClaw 是独立开发的开源求职辅助项目，与任何招聘网站、招聘服务商及其运营主体均不存在隶属、合作、代理、授权或背书关系。本项目仅提供本地简历整理、岗位信息分析、沟通草稿生成、任务记录及用户侧操作辅助能力；不保证第三方岗位信息的真实性、准确性、有效性或持续可用性，也不保证任何投递、沟通、面试或录用结果。

用户应当：仅操作本人有权使用的账号与数据；自行核实岗位、公司、联系人和沟通内容；遵守适用法律、网站服务协议、社区规则和账号使用要求；对是否启用自动辅助、是否发送内容及由此产生的账号和求职结果负责；在出现验证码、安全验证、账号限制或其他异常时立即停止使用相关自动化功能。

本 README 中的安全边界是官方版本的设计与维护原则，不构成对任何具体使用场景的法律意见，也不能替代用户对适用规则的独立判断。
