# bossclaw-mcp —— BossClaw 项目操作 MCP

让外部 agent（Claude / WorkBuddy / Cursor / 任意 MCP 客户端）能够**自主操作已安装的 BossClaw 桌面应用**（如 `F:\BOSSClaw`）：
读取应用文件、建立安全约束认知、启停与状态诊断、并驱动运行中的应用（切页、暂停投递、截图…）。

- **零依赖**：只用 Node 内置模块实现 JSON-RPC / stdio 协议，不需要 `npm install`，不会因依赖问题启动失败。
- **传输**：stdio（标准 MCP 传输）。
- **15 个工具**，分 5 组：应用认知 / 运行控制 / 状态诊断 / 应用控制 / 工作区路径。
- **单向链路**：仅外部 agent → MCP → 应用（启动 / 状态 / 白名单动作）。应用内 AI 在未配置 API Key 时走**本地规则**兜底（见 §4）。
- **面向已安装打包版**：默认只读取 `F:\BOSSClaw` 等**安装包**内的文件；不提供 git / 构建 / 冒烟等开发类内容。

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

### 2.1 应用认知（repo）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_project_info` | 应用总览：版本、Node/Electron、脚本、侧栏入口、dist/release 新旧、应用是否在跑、快照新鲜度 |
| `bossclaw_guidelines` | **开工必读**：安全不变量 + 工程约定（命令 / 沙箱陷阱 / 主题 / 持久化键 / 关键文件地图） |
| `bossclaw_list_dir` | 目录树（默认跳过 node_modules / dist / release） |
| `bossclaw_read_file` | 读文件（支持行区间，返回带行号文本） |
| `bossclaw_search` | 正则检索文本，返回「文件:行号: 内容」+ 每文件命中汇总 |

### 2.2 运行控制（runtime）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_app_start` | 启动应用（默认同时开启控制桥），自动清理沙箱注入的 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` / `PYTHONPATH`。默认启动已安装的打包版（如 `F:\BOSSClaw`）；`installed:true` / `exe` 可显式指定（自动带 `--control-bridge`，见 §3.3） |
| `bossclaw_app_stop` | 按进程树结束 BossClaw 进程（只匹配本项目实例，不误伤其它 Electron 应用） |
| `bossclaw_app_status` | 是否运行 / 进程列表 / 控制桥 / Camoufox 端口 18767 / 日志新鲜度 |

### 2.3 状态诊断（state）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_state_read` | 读本地备份快照中的持久化状态（支持点路径 + summary/raw 粒度） |
| `bossclaw_state_summary` | **排查「为什么不投递」首选**：队列分布、当日统计、暂停冷却、每日上限、平台开关、LLM 配置（key 打码）、素材就绪度、定时任务、引擎状态 |
| `bossclaw_logs` | 读 app / render / webview 三类日志尾部，支持正则过滤 |
| `bossclaw_engine_status` | 引擎探测：Camoufox 桥（端口 / Cookie / engine-state.json）、CloakBrowser profile、实时状态 |

### 2.4 应用控制（control，需控制桥）

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
| 通用 UI 接管 | `uiSnapshot{scope?}`、`uiClick{selector?/label?}`、`uiType{into,value}`（contenteditable 聊天框走 `deliveryDraft`）、`uiSubmit`、`uiScroll{selector?/dy?/to?}`、`uiWait{ms?\|selector?}`；`scope:'app'` 操作应用界面，`scope:'webview'` 操作右栏 BOSS 页（白名单 query/click/type/scroll，禁止任意脚本/跳转） |
| 自动沟通引擎 | `autochatStart{platforms?,maxCount?}`（冷却/每日上限保护）、`autochatStop`、`autochatStep{id?}`（单步，含冷却/上限/招呼语守卫）、`autochatStatus` |
| 完整数据读取 | `appDataFull{sections?,maxPending?,maxLogs?}`（简历/画像/方向/招呼语/pending/taskRuns/schedule/沟通日志全文；不含 base64 图片） |
| 队列与任务接管 | `pendingApprove{id\|ids}`、`pendingReject{id\|ids}`、`pendingRerank`、`pendingPromote{ids?}`（只升 `approved→approved_queue`）、`pendingRemove{id}`、`taskStage{id,direct:next\|prev\|阶段}`（不改 `status` 为 success） |
| 模块级控制 | `profileRebuild`（重建职业画像）、`resumeTailor{job,saveTo?:none\|greetings\|resume}`（定制简历；缺省 none 不落盘）、`greetingsAppend{items}`、`directionPlanRebuild`、`directionItem{id,patch}`、`tasksGenerate`（按方向建任务卡片，不自动投递） |
| 主进程 | `focusWindow`、`minimize`、`maximize`、`windowState`、`reloadRenderer`、`openDevTools`、`screenshot` |

### 2.5 工作区路径（workspace）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_workspace` | 工作区根「自寻路径 / 询问修改」：`action=list` 列出安装版与开发仓库候选及完整度，高亮当前根是否健康（如旧副本 `F:\BOSSClaw` 缺 `resources/app/package.json` 会被标为不完整）；`action=prefer <path>` 持久化指定工作区根，使后续多次调用一致；`action=clear` 清除返回自寻路径 |

- **自寻路径**：启动解析链为 `BOSSCLAW_REPO`（立即生效）> 持久化覆盖（`.workspace-root`）> 优先「完整 bundle」的候选（安装版需含 `resources/app/package.json`；开发仓库需含 `desktop-app/package.json`），避免选到残缺旧副本。
- **注意**：`REPO_ROOT` 是 MCP 进程启动时的常量，`prefer` 写入的覆盖在**下次启动 MCP 进程**生效；要立即生效可设 `BOSSCLAW_REPO` 环境变量。

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
2) bossclaw_search / read_file / list_dir                理解应用文件
3) bossclaw_app_start → bossclaw_app_state               观察真实运行态
4) bossclaw_app_action { screenshot }                    让 agent 看见界面
5) bossclaw_logs / bossclaw_state_summary                排查现场
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
│   ├── schema.mjs              JSON Schema 片段助手 + 工具注解
│   ├── knowledge.mjs           操作手册（约束摘要 / 命令 / 沙箱陷阱 / 关键文件地图）
│   └── tools/                  repo / runtime / state / control + index.mjs
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

- `bridge-e2e` 会真实启动 Electron；无 GPU 环境请用默认的 `noGpu: true`。
- 进程探测依赖 PowerShell CIM（Windows）。**CIM 不可用时不再退回「名称匹配」**（那会误杀用户的其它 Electron 应用），而是返回「未运行」+ 警告。
- `bossclaw_state_*` 的数据新鲜度取决于应用的备份心跳（5 分钟）；要实时数据请走控制桥。
- **工作区自动探测**：MCP 默认面向已安装的打包版应用（如 `F:\BOSSClaw`，含 `resources\app`）；找不到时回退到开发仓库。
  用 `BOSSCLAW_REPO` 环境变量可显式指定工作区根（如开发仓库 `F:\projects\Boss-claw`）。
- **不提供开发类能力**：git / tsc / vite 构建 / 冒烟 / 打包等一律删除；只读工具（`read_file` / `search` / `list_dir`）仅在安装包或显式指定的工作区根内生效。
- 应用内 AI 未配置 API Key 时走本地规则兜底（不转交 agent），因此 `bossclaw_app_action` 的 AI 动作在无密钥时会返回本地生成结果。
