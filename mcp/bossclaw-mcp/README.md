# bossclaw-mcp —— BossClaw 应用控制 MCP

让外部 agent（Claude / WorkBuddy / Cursor / 任意 MCP 客户端）能够**控制已安装的 BossClaw 桌面应用**（如 `<安装目录>`）：
启动/停止/运行状态、实时内存状态，并驱动运行中的应用（切页、暂停投递、AI 生成、截图…）。

- **零依赖**：只用 Node 内置模块实现 JSON-RPC / stdio 协议，不需要 `npm install`，不会因依赖问题启动失败。
- **传输**：stdio（标准 MCP 传输）。
- **8 个工具**，分 3 组：运行控制（3）/ 应用控制（2）/ agent 代答（3）。只面向「控制已安装应用」，不提供任何测试/开发类能力。
- **单向链路**：仅外部 agent → MCP → 应用（启动 / 状态 / 白名单动作）。应用内 AI 在未配置 API Key 时，若 agent 在线则交 **agent 代答**（见 §4），否则走**本地规则**兜底。

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
      "command": "<Node.js 可执行文件绝对路径>",
      "args": ["<本仓库绝对路径>\\mcp\\bossclaw-mcp\\bin\\bossclaw-mcp.mjs"],
      "env": {}
    }
  }
}
```

`command` 也可换成任意可用的 node（例如 `C:\Program Files\nodejs\node.exe`）。

启用步骤（WorkBuddy）：连接器管理页 → 右上角「自定义连接器」→ 找到 `bossclaw` → 点「信任」。
其他客户端按各自 MCP 配置方式添加即可（stdio）。

> ⚠️ 注册的是 **MCP 服务进程**；要让 MCP 真正能操作应用，**应用侧还要开着控制桥**。
> 用仓库根目录的 `start-bossclaw.cmd` 启动即可（本地启动器默认已开启，见 §3.1）；
> 用 `bossclaw_app_start` 启动的实例同样默认开启。裸 `electron .` / 打包版默认关闭。
> **已安装的打包版**（如 `<安装目录>\BossClaw.exe`）可用 `bossclaw_app_start { installed: true }` 启动并自动开启控制桥，见 §3.3。

### 1.3 自检

```bash
cd mcp/bossclaw-mcp
node test/selftest.mjs          # 协议 + 工具自检（不需要应用在运行）
node test/bridge-e2e.mjs        # 全链路（自动起一个隔离实例，会跑一次 Electron）
```

环境变量（可选）：

| 变量 | 作用 |
| --- | --- |
| `BOSSCLAW_REPO` | 覆盖应用根路径（安装版或开发仓库；默认由入口文件位置推导 + 已安装应用自探测） |
| `BOSSCLAW_USERDATA` | 覆盖 Electron userData 目录（默认 `%APPDATA%\BossClaw`） |

---

## 2. 工具清单

### 2.1 运行控制（runtime）

| 工具 | 用途 |
| --- | --- |
| `bossclaw_app_start` | 启动应用（默认同时开启控制桥），自动清理沙箱注入的 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` / `PYTHONPATH`。默认启动已安装的打包版（如 `<安装目录>`）；`installed:true` / `exe` 可显式指定（自动带 `--control-bridge`，见 §3.3） |
| `bossclaw_app_stop` | 按进程树结束 BossClaw 进程（只匹配本项目实例，不误伤其它 Electron 应用） |
| `bossclaw_app_status` | 是否运行 / 进程列表 / 控制桥 / Camoufox 端口 18767 / 日志新鲜度 |

### 2.2 应用控制（control，需控制桥）

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
| 模块级控制 | `profileRebuild`（重建职业画像）、`resumeTailor{job,saveTo?:none\|greetings\|resume}`（定制简历；缺省 none 不落盘）、`greetingsAppend{items}`、`directionPlanRebuild`、`directionItem{id,patch}`、`tasksGenerate`（按方向建任务卡片，不自动投递；**保留 `cr_` 采集任务** —— 与首页「新建任务」同口径，`taskRuns` 是投递/采集共用的单一数组） |
| 数据统计导出（**只读**） | `statsExport{range?:"7d"\|"30d"\|"all", kind?:"summary"\|"detail"\|"report"}`（与统计页同源口径，返回 `filename` + `content` 文本；**不落盘、不弹保存对话框** —— 落盘必须由人工在应用内完成，因为导出硬契约要求每次由用户自选位置；`detail` 已剔除 `chatUrl`/`encryptUserId`/招呼语正文） |
| 主进程 | `focusWindow`、`minimize`、`maximize`、`windowState`、`reloadRenderer`、`openDevTools`、`screenshot` |

### 2.3 agent 代答（agent，需控制桥）

应用**未配置 AI API Key** 时，它内部的 AI 能力（岗位分析 / 职业画像 / 打招呼语 / 定制简历）会等外部 agent 用自有模型作答。链路仍是单向的：应用把提示词放进本地待答队列，agent 领走再回填（详见 §4）。

| 工具 | 用途 |
| --- | --- |
| `bossclaw_agent_tasks` | 领取待代答任务（含完整提示词与期望输出格式）。**该调用同时是心跳**——应用只在最近 90s 内有过本调用时才把 AI 任务交给 agent。建议 `waitMs: 30000` 长轮询 |
| `bossclaw_agent_submit` | `{ id, content }` 回填回答：`jsonMode` 任务必须是合法 JSON 字符串，否则为纯文本；应用按与真实模型调用相同的口径解析并继续它自己的校验链 |
| `bossclaw_agent_cancel` | `{ id, reason? }` 放弃某任务，让应用**立刻**回落本地规则（不必等满超时） |

这三个动作同样存在于渲染层白名单里（`agentTasks` / `agentSubmit` / `agentCancel`），必要时也能通过 `bossclaw_app_action` 直接调用；常规用法请走上面的专用工具。

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

安装版应用（例如 `<安装目录>\BossClaw.exe`）与开发版共用同一套控制桥机制（默认关闭、同样受安全边界约束）。
MCP 直接启动它时会**自动带上 `--control-bridge`**，之后 `bossclaw_app_state` / `bossclaw_app_action` 即可照常操作：

```
bossclaw_app_start { installed: true }        # 自动探测安装位置并启动（BOSSCLAW_EXE / 注册表卸载项 / 常见目录）
bossclaw_app_start { exe: "<安装目录>\\BossClaw.exe" }   # 显式指定安装路径（优先级最高）
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

### 实时状态从哪里来？

MCP 的全部能力都指向**运行中的应用**：`bossclaw_app_status`（进程 / 控制桥探测）与 `bossclaw_app_state`（内存 store 实时状态）都经控制桥直达应用。
MCP 不提供「应用未运行时」的离线文件 / 快照诊断——安装包控制只需要实时数据，不需要 5 分钟前的备份快照。

---

## 4. agent 代答（应用未配置 API Key 时）

应用内的 AI 能力（岗位分析 / 职业画像 / 打招呼语 / 定制简历）在**用户未配置 API Key** 时，
若外部 agent 在线，就由 **agent 用自己的模型代答**；agent 不在线 / 超时未答 / 主动放弃，则照旧退回
**应用内本地规则**兜底（`buildLocalProfile`、`localFallback` 等）。两条路径的产出在业务侧是等价的，
只是来源不同（前者 `scoreSource` 等标记按 AI 结果走）。

### 4.1 工作流

```
1) 应用侧：某次 AI 调用发现没有 apiKey → 把「完整提示词 + 用途 + 是否要 JSON」挂进本地待答队列并等待
        （application 内实现：desktop-app/src/lib/bossclaw/agentAnswer.ts，由 llm.ts 的 callModel 触发）
2) agent：bossclaw_agent_tasks（建议 waitMs: 30000 长轮询）领取任务
3) agent：用自有模型生成回答（任务 jsonMode=true 时必须产出合法 JSON 字符串）
4) agent：bossclaw_agent_submit { id, content } 回填 → 应用按与真实模型调用相同的口径解析并继续自身校验链
   （答不出来就 bossclaw_agent_cancel { id, reason }，应用立刻回落本地规则）
```

### 4.2 心跳与时限（重要）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 在线判定 | 最近 **90s** 内调用过 `bossclaw_agent_tasks` | 应用**无法主动调用** stdio MCP，因此「有没有 agent」只能靠心跳。**首次**任务只会在心跳有效时入队 |
| 单任务等待 | 30s ~ 240s（由业务侧超时推导，`AGENT_ANSWER_MIN_WAIT_MS` / `AGENT_ANSWER_MAX_WAIT_MS` 夹定） | 超时 → 抛错回落本地规则；`bossclaw_agent_cancel` 可让应用立刻结束等待 |
| JSON 纠偏 | 1 次 | 首次回填不是合法 JSON 会再派发一次任务（`attempt: 2`，附「只输出 JSON」提示）；仍失败才判无效 |
| 长轮询上限 | `waitMs` ≤ 55s | MCP 侧工具超时按 `waitMs + 20s` 放宽 |

### 4.3 边界（硬约束不变）

- **只搬运「提示词 ↔ 生成文本」**：不提供投递 / 发送 / 验证码 / 速率限制 / `SAFETY_LIMITS` 相关能力。
- 回填内容仍要过应用既有校验链（事实与口吻、校名披露、招呼语长度截断等），不合规照样被本地规则替换 —— 这是**预期行为**。
- 代答结果同样进入应用本地 AI 缓存（`cachedCallModel`），相同输入不会反复占用 agent。
- 用户**配置了 API Key** 就直连真模型，不会走代答（此时 `bossclaw_agent_tasks` 一直是空队列）。
- 代答状态可在 `bossclaw_app_state` 的 `agentAnswer` 字段查看：`online` / `lastSeenAgoMs` / `pending` /
  `claimed` / `answered` / `timeouts` / `cancelled` / `unavailable` / `events`（最近 20 条）。

---

## 5. 推荐工作流

```
1) bossclaw_app_status          应用是否在跑 / 控制桥是否就绪
2) bossclaw_app_start           启动（默认开启应用内控制桥）
3) bossclaw_app_state           实时状态：路由 / 队列 / 统计 / 投递安全参数 / 日志尾部 / 代答状态 agentAnswer
4) bossclaw_app_action { screenshot }   让 agent 看见界面
5) bossclaw_app_action { navigate / pauseDelivery / … }   驱动应用
6) bossclaw_agent_tasks → bossclaw_agent_submit   应用未配置 API Key 时接管其 AI 生成（见 §4）
```

---

## 6. 目录结构

```
mcp/bossclaw-mcp/
├── bin/bossclaw-mcp.mjs        入口（stdio）
├── src/
│   ├── server.mjs              MCP JSON-RPC 骨架（initialize / tools/list / tools/call / ping）
│   ├── context.mjs             路径解析（含已安装版应用自动探测）、进程执行器（env 清理 + 超时）、控制桥客户端
│   ├── procs.mjs               进程探测（CIM 命令行匹配，避免误伤其它 Electron 应用）
│   ├── schema.mjs              JSON Schema 片段助手 + 工具注解
│   └── tools/                  runtime / control / agent + index.mjs
└── test/
    ├── selftest.mjs            协议 + 工具自检
    ├── bridge-e2e.mjs          全链路端到端（隔离实例，含 HOME 隔离与备份兜底）
    └── live-acceptance.mjs     面向运行中应用的真机验收（含 agent 代答队列）
```

应用侧对应文件：

```
desktop-app/
├── electron/control-bridge.cjs   控制桥（HTTP + token；仅 /state、/action；单向 agent→应用）
└── src/lib/
    ├── controlRuntime.ts         渲染层白名单动作（唯一权威实现）
    └── bossclaw/
        ├── llm.ts                模型调用层；无 apiKey 时转入 agent 代答
        └── agentAnswer.ts        代答待答队列 / 心跳 / 超时 / 取消 / 统计
```

---

## 7. 已知边界

- `bridge-e2e` 会真实启动 Electron；无 GPU 环境请用默认的 `noGpu: true`。
- 进程探测依赖 PowerShell CIM（Windows）。**CIM 不可用时不再退回「名称匹配」**（那会误杀用户的其它 Electron 应用），而是返回「未运行」+ 警告。
- MCP 只服务「控制已安装的应用」：实时状态 / 动作一律经应用内控制桥；**不提供** git / tsc / vite 构建 / 冒烟 / 打包等任何测试与开发类能力。
- 应用根解析链：`BOSSCLAW_REPO`（显式）> 已安装应用自探测（检测到 `BossClaw.exe` 的安装根）> 开发仓库兜底。
- 应用内 AI 未配置 API Key 时：agent 在线（最近 90s 内调用过 `bossclaw_agent_tasks`）则交给 agent 代答；否则回落本地规则。
  因此无密钥时 `bossclaw_app_action` 的 AI 动作既可能是 agent 代答结果、也可能是本地结果，取决于当时有没有心跳；
  具体来源可在日志与 `bossclaw_app_state.agentAnswer` 里看到。
