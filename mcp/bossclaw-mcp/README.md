# bossclaw-mcp —— BossClaw 项目操作 MCP

让外部 agent（Claude / WorkBuddy / Cursor / 任意 MCP 客户端）能够**自主操作 BossClaw 项目**：
读约束、定位代码、构建验证、启动与停止应用、诊断状态、并驱动运行中的应用（切页、暂停投递、截图…）。

- **零依赖**：只用 Node 内置模块实现 JSON-RPC / stdio 协议，不需要 `npm install`，不会因依赖问题启动失败。
- **传输**：stdio（标准 MCP 传输）。
- **23 个工具**，分 5 组：项目认知 / 构建验证 / 运行控制 / 状态诊断 / 应用控制。
- **单向链路**：仅外部 agent → MCP → 应用（启动 / 状态 / 白名单动作）。应用内 AI 在未配置 API Key 时走**本地规则**兜底，不转交 agent（见 §4）。

---

## 1. 快速开始

### 1.1 前置

- Node ≥ 20（本机：`node -v` 应可用）。
- BossClaw 依赖已安装（`desktop-app/node_modules` 存在），否则构建/启动类工具会报缺依赖。

### 1.2 注册到 MCP 客户端

把下面这段合并进 `~/.workbuddy/mcp.json` 的 `mcpServers`（**绝对路径**，`args` 指向本仓库内的入口）：

```json
{
  "mcpServers": {
    "bossclaw": {
      "command": "C:\\Users\\DELL\\.workbuddy\\binaries\\node\\versions\\22.22.2-2\\node.exe",
      "args": ["F:\\projects\\Boss-claw\\mcp\\bossclaw-mcp\\bin\\bossclaw-mcp.mjs"],
      "env": {}
    }
  }
}
```

`command` 也可换成任意可用的 node（例如 `E:\Node.js\node.exe`）。

启用步骤（WorkBuddy）：连接器管理页 → 右上角「自定义连接器」→ 找到 `bossclaw` → 点「信任」。
其他客户端按各自 MCP 配置方式添加即可（stdio）。

> ⚠️ 注册的是 **MCP 服务进程**；要让 MCP 真正能操作应用，**应用侧还要开着控制桥**。
> 用仓库根目录的 `start-bossclaw.cmd` 启动即可（本地启动器默认已开启，见 §3.1）；
> 用 `bossclaw_app_start` 启动的实例同样默认开启。裸 `electron .` / 打包版默认关闭。
> **已安装的打包版**（如 `F:\BOSSClaw\BossClaw.exe`）可用 `bossclaw_app_start { installed: true }` 启动并自动开启控制桥，见 §3.3。

### 1.3 自检

```bash
cd mcp/bossclaw-mcp
node test/selftest.mjs          # 协议 + 只读工具（不需要应用在运行）
node test/bridge-e2e.mjs        # 全链路（自动起一个隔离实例，会跑一次 Electron）
```

环境变量（可选）：

| 变量 | 作用 |
| --- | --- |
| `BOSSCLAW_REPO` | 覆盖仓库根路径（默认由入口文件位置推导） |
| `BOSSCLAW_USERDATA` | 覆盖 Electron userData 目录（默认 `%APPDATA%\BossClaw`） |

---

## 2. 工具清单

### 2.1 项目认知（repo）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_project_info` | 项目总览：版本、Node/Electron、脚本、侧栏入口、dist/release 新旧、应用是否在跑、快照新鲜度 |
| `bossclaw_guidelines` | **开工必读**：AGENTS.md 全文 + 安全不变量 + 工程约定（命令 / 沙箱陷阱 / 主题 / 持久化键 / 关键文件地图） |
| `bossclaw_list_dir` | 目录树（默认跳过 node_modules / dist / release） |
| `bossclaw_read_file` | 读文件（支持行区间，返回带行号文本） |
| `bossclaw_search` | 正则检索源码，返回「文件:行号: 内容」+ 每文件命中汇总 |
| `bossclaw_git` | 只读 git：status / log / diff / show / branch |
| `bossclaw_ipc_surface` | 扫描并汇总 IPC 拓扑（主进程 handle/on、preload invoke/send/on、webview sendToHost），并提示两端配对缺口 |

### 2.2 构建验证（build）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_typecheck` | `tsc -b`，返回退出码 / 耗时 / **结构化 TS 错误列表**（`force:true` 可清增量缓存） |
| `bossclaw_build` | `vite build`，返回产物摘要（文件数 / 体积 / 最大的 N 个产物） |
| `bossclaw_verify` | `tsc -b` + `vite build`，输出结论表（等价 `npm run verify`） |
| `bossclaw_check_fresh` | 跑 `scripts/check-fresh.mjs`：dist 是否早于渲染层源码 |
| `bossclaw_package` | `vite build` + `electron-builder --win`，产物落 `release/`（**默认后台**） |
| `bossclaw_job` | 后台任务管理：list / output / kill |

### 2.3 运行控制（runtime）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_app_start` | 启动应用（默认同时开启控制桥），自动清理沙箱注入的 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` / `PYTHONPATH`。默认启动开发目录 Electron；`installed:true` / `exe` 可启动**已安装的打包版**（自动带 `--control-bridge`，见 §3.3） |
| `bossclaw_app_stop` | 按进程树结束 BossClaw 进程（只匹配本项目实例，不误伤其它 Electron 应用） |
| `bossclaw_app_status` | 是否运行 / 进程列表 / 控制桥 / Camoufox 端口 18767 / 日志新鲜度 |
| `bossclaw_smoke` | Electron 冒烟：观察窗口内是否存活，随后整棵结束，附日志尾部 |

### 2.4 状态诊断（state）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_state_read` | 读本地备份快照中的持久化状态（支持点路径 + summary/raw 粒度） |
| `bossclaw_state_summary` | **排查「为什么不投递」首选**：队列分布、当日统计、暂停冷却、每日上限、平台开关、LLM 配置（key 打码）、素材就绪度、定时任务、引擎状态 |
| `bossclaw_logs` | 读 app / render / webview 三类日志尾部，支持正则过滤 |
| `bossclaw_engine_status` | 引擎探测：Camoufox 桥（端口 / Cookie / engine-state.json）、CloakBrowser profile、实时状态 |

### 2.5 应用控制（control，需控制桥）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_app_state` | **实时**状态（内存 store）：路由 / 主题 / 引擎开关 / 完整 config / 队列统计 / 定时任务 / 自动沟通运行态 / 日志尾部，支持 `path` 裁剪与 `includeEngine` |
| `bossclaw_app_action` | 白名单动作（见下）+ `screenshot` 截图（返回 PNG 图片内容块，agent 能「看见」界面） |

`bossclaw_app_action` 支持的动作：

| 类别 | 动作 |
| --- | --- |
| 界面 | `navigate`（切页）、`setTheme`、`setSidebarCollapsed` |
| 投递控制 | `pauseDelivery`（写 `config.pausedUntil`，默认 30 分钟）、`resumeDelivery`、`setAutoAssist`（= 标题栏「投递引擎」开关，**只切开关不会自行投递**） |
| 配置 | `patchConfig`（只能改**已存在**且非 `model` / `pausedUntil` / `platforms` 的字段）、`setPlatform`（平台开关 / 日目标（受 150 上限封顶）/ 优先级）、`deliverySetMode`（`mode:'auto'|'review'`，等价设置页「全自动」切换，便于 audit） |
| 数据 | `backupNow`、`restoreBackup`（恢复后自动重载）、`addLog`、`clearLogs` |
| 只读 | `engineStatus`（实测 Camoufox + CloakBrowser） |
| 业务数据 | `dataSetResume{text,file?}`、`dataSetProfile{profile}`、`dataSetDirectionPlan{plan}`、`dataSetGreetings{items}`（内部过滤过短项）、`dataSetGreetingPrompt`、`dataSetCommunicationInfo`、`dataPendingAdd{item}`、`dataPendingUpdate{id,patch}`、`dataTaskRunUpdate{id,patch}`、`dataAddChatLog{entry}`、`scheduleAdd/Update/Remove/Toggle`（定时任务 CRUD） |
| AI 按需生成 | `aiAnalyzeJob{job,...}`（复用工作台 `analyzeJob`）、`aiTailorResume{job,...}`（复用 `tailorForJob`；长耗时，MCP 已给宽超时） |
| 浏览器只读探索 | `browserSearch{query,...}`（BOSS 官方 joblist）、`browserOpenJob{url}`、`browserReadPage`（URL/标题/正文文本/列表卡）、`browserReadJob{encryptJobId}`、`browserDomDump`（需 webview 引擎；cloak 引擎返回明确不可用） |
| 投递（发送边界） | `deliveryDraft{greeting}`（半自动：开沟通+预填草稿**不发送**）；`deliverySendNow`（**仅 `executionMode==='auto'` 时生效**，复用应用自带安全引擎） |
| 主进程 | `focusWindow`、`minimize`、`maximize`、`windowState`、`reloadRenderer`、`openDevTools`、`screenshot` |

---

## 3. 应用内控制桥

`bossclaw_app_state` / `bossclaw_app_action` 依赖应用侧的**本地控制桥**：

```
MCP (stdio)  ──HTTP/127.0.0.1 + token──▶  electron/control-bridge.cjs（主进程）
                                              │  executeJavaScript（base64 传参，防注入）
                                              ▼
                                    src/lib/controlRuntime.ts（渲染层，白名单唯一权威实现）
```

| 项 | 说明 |
| --- | --- |
| 启用 | 二选一（**默认关闭**）：<br>① 环境变量 `BOSSCLAW_CONTROL=1`（`bossclaw_app_start` 用这种）<br>② 命令行开关 `--control-bridge`（`start-bossclaw.cmd` 用这种，见 §3.1）<br>显式关闭优先：`BOSSCLAW_CONTROL=0` / `--no-control-bridge` |
| 端口 | `127.0.0.1:17650`（可用 `BOSSCLAW_CONTROL_PORT` 覆盖；被占用自动 +1…+9） |
| 鉴权 | 除 `/health` 外都要求 `x-bossclaw-token`；token 随机生成，写入 `<userData>/control-bridge.json` |
| 端点 | `GET /health`、`GET /state[?path=a.b]`、`POST /action` |
| 端口回退 | 17650 被占用时依次尝试 +1…+9（多实例并存时不至于整个桥不可用），实际端口写入 info 文件 |
| 竞态处理 | 冷启动 / 渲染层重载期间，桥内部最多等 25s 等 `window.__bossclawControl` 就绪后再执行 |
| 关闭 | 应用退出（`window-all-closed`）时关闭并删除 info 文件，避免留下 stale 记录 |

### 3.1 为什么要支持命令行开关

本地启动脚本 `start-bossclaw.cmd` 是通过**快捷方式**拉起 electron 的（这样 Windows 任务栏显示 "BossClaw" 而不是 "Electron"）。
经快捷方式启动时，环境变量是否被继承取决于 shell 行为，而**命令行参数一定会出现在 `process.argv` 里**，
因此脚本把开关写进快捷方式的参数中，更可靠。

`start-bossclaw.cmd` 现在**默认开启**本地控制桥（本地启动器专属行为，打包版/裸 `electron .` 仍默认关闭）——这样 MCP 才能操作该实例：

```
start-bossclaw.cmd              # 默认：控制桥 ON（MCP 可操作该实例）
start-bossclaw.cmd --no-agent   # 关闭：回到不带 MCP 能力的纯启动
```

### 3.2 怎么确认已经开起来了

```bash
# 1) 看 info 文件（含实际端口 / token / 开启方式）
type "%APPDATA%\BossClaw\control-bridge.json"

# 2) 或者直接问 MCP
#    bossclaw_app_status  → 应显示「控制桥：:17650 ✅ 健康」
```

### 3.3 已安装的打包版（BossClaw.exe）

安装版应用（例如 `F:\BOSSClaw\BossClaw.exe`）与开发版共用同一套控制桥机制（默认关闭、同样受安全边界约束）。
MCP 直接启动它时会**自动带上 `--control-bridge`**，之后 `bossclaw_app_state` / `bossclaw_app_action` 即可照常操作：

```
bossclaw_app_start { installed: true }        # 自动探测安装位置并启动（BOSSCLAW_EXE / 注册表卸载项 / 常见目录）
bossclaw_app_start { exe: "F:\\BOSSClaw\\BossClaw.exe" }   # 显式指定安装路径（优先级最高）
```

- 安装版的进程（`BossClaw.exe`）同样会被 `bossclaw_app_status` / `bossclaw_app_stop` 识别。
- userData 与开发版一致（`%APPDATA%\BossClaw`），控制桥 info 文件路径相同。
- 手动双击安装版启动时控制桥**保持关闭**（默认关闭是硬约束）；要让 MCP 控制，请经 `bossclaw_app_start` 启动，
  或为该 exe 创建带 `--control-bridge` 参数的自定义快捷方式。

### 安全边界（硬约束）

控制桥**只提供**「读状态 + 白名单动作」，明确**不提供**：

- ✅ 保持硬约束：绕过验证码、绕过速率限制、多城市轮询
- ✅ 保持硬约束：修改 `SAFETY_LIMITS` 或把每日目标抬到 150 以上
- ✅ 保持硬约束：写 `config.model`（apiKey）、`config.pausedUntil`（走专用动作）、`config.platforms`（走 `setPlatform`）
- ⚠️ **跟随「全自动」开关（用户授权放宽）**：发送类能力默认不提供；但**当用户在应用内开启全自动（`config.executionMode === 'auto'`）时**，
  `deliverySendNow` / 引擎全自动对 agent 开放。任何发送仍**复用应用自带安全投递引擎**
  （招呼语非空、外部网申跳过、文字气泡确认、风控码立即停止交人工），**不绕过任何平台安全措施**。
  在 `review`（人工确认）模式下，`deliverySendNow` 一律拒绝，agent 只能 `deliveryDraft` 草拟 + 人工发送。

`patchConfig` 采用「字段必须已存在 + 拒绝列表」双重校验（而非白名单枚举），因此对配置字段增删是健壮的；任何越界字段会被跳过并在返回里逐条说明原因。

### 为什么状态读的是快照，而写走控制桥？

`bossclaw_state_*` 读的是应用每 5 分钟脏检查写盘的本地备份快照（`bossclaw-local-backup.json`）——
它**只读**，不需要应用在运行，也不需要开启控制桥。

反过来说：**MCP 从不直接改写快照文件**。因为 localStorage 才是主存储，应用启动时仅在「主数据键缺失」时才从备份恢复，
直接改快照只会造成「改了但没生效」的假象。所有写操作统一走控制桥直达运行中的应用。

---

## 4. 单向链路（不反向调 agent）

BossClaw 的 MCP 通道是**单向**的：仅外部 agent **→** MCP **→** 应用（启动 / 状态 / 白名单动作）。

应用内的 AI 能力（岗位分析 / 职业画像 / 打招呼语 / 定制简历）在**用户未配置 API Key** 时**不再转交外部 agent**，
一律退回**应用内本地规则**兜底（`buildLocalProfile`、`localFallback` 等）——不会出现「等待 agent 生成」。
应用侧无 `agentTask` / `agent-broker`、无 `/agent-tasks` 接口，无「Agent 代答」UI；MCP 侧无
`bossclaw_agent_tasks` / `bossclaw_agent_submit` 工具。

要恢复完整的 AI 能力，请在「设置 → AI」配置 API Key（直连模型）。

---

## 5. 推荐工作流

```
1) bossclaw_guidelines  →  bossclaw_project_info        建立认知、对齐约束
2) bossclaw_search / read_file / ipc_surface            定位实现
3) （改代码）
4) bossclaw_verify                                       必做：tsc -b + vite build
5) bossclaw_smoke                                        主进程 / UI 改动后确认能起来
6) bossclaw_app_start → bossclaw_app_state               观察真实运行态
7) bossclaw_app_action { screenshot }                    让 agent 看见界面
8) bossclaw_logs / bossclaw_state_summary                排查现场
```

---

## 6. 目录结构

```
mcp/bossclaw-mcp/
├── bin/bossclaw-mcp.mjs        入口（stdio）
├── src/
│   ├── server.mjs              MCP JSON-RPC 骨架（initialize / tools/list / tools/call / ping）
│   ├── context.mjs             路径解析（含已安装版应用自动探测）、进程执行器（env 清理 + 超时 + 输出截断）、快照解析、控制桥客户端
│   ├── procs.mjs               进程探测（CIM 命令行匹配，避免误伤其它 Electron 应用）
│   ├── jobs.mjs                后台任务注册表（打包等长任务）
│   ├── schema.mjs              JSON Schema 片段助手 + 工具注解
│   ├── knowledge.mjs           操作手册（约束摘要 / 命令 / 沙箱陷阱 / 关键文件地图）
│   ├── runners/package.mjs     打包流水线（vite build → electron-builder）
│   └── tools/                  repo / build / runtime / state / control + index.mjs
└── test/
    ├── selftest.mjs            协议 + 只读工具自检
    └── bridge-e2e.mjs          全链路端到端（隔离实例，含 HOME 隔离与备份兜底）
```

应用侧对应文件：

```
desktop-app/
├── electron/control-bridge.cjs   控制桥（HTTP + token；仅 /state、/action；单向 agent→应用）
└── src/lib/
    └── controlRuntime.ts         渲染层白名单动作（唯一权威实现）
```

---

## 7. 已知边界

- `bossclaw_smoke` / `bridge-e2e` 会真实启动 Electron；无 GPU 环境请用默认的 `noGpu: true`。
- `bossclaw_package` 依赖 electron-builder 及其缓存，首次可能较慢；用 `bossclaw_job` 轮询。
- 进程探测依赖 PowerShell CIM（Windows）。**CIM 不可用时不再退回「名称匹配」**（那会误杀用户的其它 Electron 应用），而是返回「未运行」+ 警告。
- `bossclaw_state_*` 的数据新鲜度取决于应用的备份心跳（5 分钟）；要实时数据请走控制桥。
- **工作区自动探测**：MCP 默认面向已安装的打包版应用（如 `F:\BOSSClaw`，含 `resources\app`）；找不到时回退到开发仓库。
  用 `BOSSCLAW_REPO` 环境变量可显式指定工作区根（如开发仓库 `F:\projects\Boss-claw`）。
- 应用内 AI 未配置 API Key 时走本地规则兜底（不转交 agent），因此 `bossclaw_app_action` 的 AI 动作在无密钥时会返回本地生成结果。
