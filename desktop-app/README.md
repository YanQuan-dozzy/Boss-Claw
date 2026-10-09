# BossClaw 桌面版（Electron + React）

> 面向求职者的**本地 AI 投递助手**，**独立桌面应用，不占用你的浏览器**。单窗口桌面应用：固定功能侧栏 + 工作台三栏（侧栏 + 中栏消息进度 + 右栏内置浏览器） + 其余页面双栏；应用后台自动投递简历的同时，你的 Chrome / Edge / Firefox 照常使用。

> 功能指南见仓库根 [`README.md`](../README.md) 与本文「功能闭环」「公开架构」「常见问题」三节；需求与决策文档位于本地 `docs/`（`.gitignore` 忽略，**未随仓库分发**）。

***

## 功能闭环

* **岗位来源**：内置浏览器打开招聘平台岗位 → 中栏点「加入任务」→ 自动识别 HR 活跃度（在线 / 刚刚活跃 / N 日内活跃）作为匹配判断依据；岗位详情自动清洗页面噪音（`jdCleaner.ts` 渲染层 + `webview.cjs` 同步）；采集同时透传岗位**发布时间**（`publishTime`），供「新鲜度」维度参与排序。岗位卡片带**平台标识 chip**（BOSS 直聘绿 / 智联招聘蓝 / 猎聘橙 / 前程无忧紫，`PlatformChip` 组件，配色集中定义于 `platforms.ts`）。

* **多平台（BOSS 直聘 / 猎聘 / 智联招聘 / 前程无忧 51Job）**：设置页「招聘平台」分区启用平台、调整平台优先级（数字 1 = 最高，决定工作台搜索顺序与自动沟通先完成高优先级平台再切换）、配置每平台「每日投递目标」（BOSS / 猎聘 / 前程无忧默认 120/日，智联 100/日，0 = 不限，均受平台侧上限 / `MAX_SAFE_DAILY=150` 收窄，智联平台侧约 100/日）并查看两通道登录状态。各平台登录态本地独立持久化：内置浏览器经 Electron 分区会话（工作台扫码登录），Camoufox 自动沟通经 `~/.bossclaw/camoufox-cookies-{platform}.json`（BOSS 保持 `camoufox-cookies.json`）。至少保留一个启用平台（唯一启用平台不可取消）。

* **半自动投递**：中栏批准岗位 → 浏览器跳转 → AI 草稿预填沟通框 → 用户发送。

* **AI 匹配与评分（v2.5.3）**：岗位匹配改为 **AI 四层整体裁决**（硬门槛 → 优先条件 → 职责信号 → 团队信号，一次判断给出 `fitLevel` 档位：strong / match / cautious / unfit），**分数由档位映射、不跨档，AI 分即最终分**（本地五维仅用于界面展示与 AI 不可用时兜底，不再做融合或降级调整）；五维语义锚点与「仅显著命中才给高分」的反通胀口径全链路统一；入队门槛改为设置页可配 `minQueueScore`；工作台会话级去重 + `addSkipLogOnce` 合并重复跳过日志。

* **多平台投递入口**：工作台「一键投递 / 开始投递」按岗位平台**分派三条通道**（`runNext` 只做「选岗位 + 预检 + 分派」，三条通道各自 try/finally 持有投递锁）：**通道 A 非 BOSS DOM** —— 猎聘 / 智联 / 前程无忧，新建该平台自己的标签页打开岗位详情后下发 `platform-apply`（猎聘 = 点「聊一聊」`a.btn-main[data-selector="chat-chat"]` + 等 IM 窗口就绪；智联 = 投递按钮 + 简历面板二次确认，命中「继续沟通」→ 岗位移交自动沟通队列；前程无忧 = 投递按钮 + 成功弹层），外部网申 / 已投递 / 平台上限一律收口为跳过；**通道 B Camoufox** —— 仅 BOSS，且需设置页开启「优先走隐身通道」；**通道 C BOSS DOM** —— 内置浏览器详情页真实 DOM 沟通（默认路径）。

* **多平台搜索采集**（引擎闸门 = `config.camoufox.enabled`，全平台统一语义）：开启隐身引擎 → Camoufox 通道（列表 + 详情 JD + 词级断点续采，profile 存 `~/.bossclaw/collection-progress.json`，TTL 24h）；未开启 → **内置浏览器可视化采集**（`visual-collect` / `collect-control` 全平台注册；BOSS 详情级、其余平台列表级）。**列表级平台的详情 JD 由内置浏览器自己的详情补齐通道 `webview.cjs::enrichJobDetail()` 按能力表 `PLATFORM_DETAIL_API_FILL` 拉取**（智联 = 同源详情 JSON 接口；猎聘 = 同源 SSR 详情页 HTML，由 `platform-adapters.cjs::parseLiepinJobDetailHtml()` 纯函数解析；前程无忧暂无同源通道，只有列表字段）——**与是否安装 Camoufox 无关**；护栏：单次上限 300 条 / 连败 4 次熔断 / 失败保留卡片文本不丢岗位。各平台按设置页优先级**串行**采集；**故障范围**由 `platforms.ts::collectFaultScope()` 统一裁定 —— 平台级（31 未登录 / 4xx·5xx）只收口当前平台、后续平台继续，队列级（风控 32·35·36、环境异常 37·38、未知码 fail-safe）**立即中止整批**交人工。

* **自动辅助**：启动后按匹配优先级依次投递 `approved_queue` 队列；webview 回传投递阶段（打开沟通 → 填写 → 发送 → 确认文字气泡 → 确认结果），失败自动暂停交人工核对；**首次成功投递后强制暂停验收**（安全不变量）。

* **任务进度**：中栏任务级进度条 + 阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递），日志流实时滚动；失败可重试 / 忽略 / 跳过。

* **简历中心**：PDF / DOCX / DOC / MD / TXT 本地解析（渲染进程内完成，无需桥接）：PDF 用自研解析器（Flate / ASCIIHex / ASCII85 / RunLength + ToUnicode / CMap），DOCX 用 mammoth 浏览器版 + 自研 ZIP/XML 双通道兜底，**旧版 `.doc` 用自研解析器**（OLE2/CFB 容器 + FIB/CLX 分片表，兼容「实为 RTF / HTML」的 `.doc`），**Markdown 走 `mdParser.ts`**，失败再走桥接转档；「工作台定制」打招呼语提示词可编辑（留空用系统默认，统一驱动工作台岗位招呼语 / 定制简历求职信 / JD 预览）。

* **AI 能力**：职业画像（AI 完整画像 → 精简重试 → 本地规则三级降级）；岗位匹配（**AI 五维评估 + 档位制裁决，AI 分即最终分**，本地多维评分仅作展示与兜底；评分 / 决策 / 硬条件拦截 / 沟通草稿）；**打招呼语（求职信）提示词优先级**：① greetings 技能（含用户自定义技能）→ ② 简历中心「打招呼语提示词」输入框内容 → ③ 本地规则；投递方向支持 **AI 生成/校准关键词**，并新增 **薪资校准模块** 与 **工作时间偏好** 供 AI 判断匹配与约束沟通内容；AI 生成 + 求职者口吻校验，失败回退本地规则。

* **定制简历**：侧栏「定制简历」页输入岗位 JD，AI 生成定制摘要 / 量化经历 / 求职信 / 技能缺口 / 优化建议，仅引用简历真实事实，AI 输出不达标回退本地规则兜底。

* **AI 技能体系**：`skills/` 内置 7 项（resume-profile / job-analysis / greetings / tailor-cv / jd-reading / great-resume / job-match，SKILL.md），按作用域注入 system prompt；greetings 即「工作台定制的打招呼语提示词」统一口径，驱动工作台岗位招呼语 / 简历中心 JD 预览 / 定制简历求职信；jd-reading（读 JD 四层拆解，assistant 作用域，默认开启）、great-resume（经历酥化，assistant 作用域）、job-match（证据驱动岗位匹配，job-analysis 作用域）为增强技能，可在设置页手动启用；技能入口每次从磁盘重读（`reloadSkills()`）；支持自定义技能导入 / 新建 / 删除（`userData/skills`，白名单防路径穿越）；设置页「AI 技能」卡片管理。

* **LLM 预设**：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟 / 自定义（OpenAI 兼容端点）。

* **OpenClaw 桥接**：本地 Node 服务（127.0.0.1:18765）提供状态 / 日报 / 指令控制 / OCR / 简历解析 / **日志查看**。

* **可选隐身增强（默认关闭）**：

  * **Camoufox** —— Python 桥（127.0.0.1:18767），**仅使用 Camoufox 原生隐身内核**（本地 Chrome / Edge 不可复用，需自行 `pip install "camoufox[geoip]" && camoufox fetch` 安装内核）。多平台采集层在 `camoufox/platforms/`：`models.py`（JobCandidate）/ `capabilities.py`（能力矩阵）/ `base.py`（搜索·投递·登录三段骨架唯一实现）/ `registry.py`（平台注册表）/ `progress.py`（词级断点续采）/ `filters.py`（求职条件码值映射），各平台文件（liepin / zhaopin / job51）**只声明差异**；Cookie 按平台独立持久化。

  > **注意（2026-09-15 起）**：搜索采集**不再要求非 BOSS 平台必须走 Camoufox**。引擎闸门只看 `config.camoufox.enabled` —— 开启则走 Camoufox（列表 + 详情 JD + 词级断点续采）；未开启则走**内置浏览器可视化采集**，且**全平台可用**（BOSS 详情级 / 其余平台列表级）。历史口径「webview 可视化采集为 BOSS 专属」已作废。

  * **CloakBrowser** —— Playwright 持久上下文 + 多 Page（需要时自动从 `~/.cloakbrowser/` 加载约 200MB 隐身 Chromium）；含健康检查（`jc:cloak-health`），进程被外部关闭 / 崩溃时 UI 自动重启。

  * **不绕过验证码 / 账户验证**：code 35/36/32 立即停止并交人工。

* **自动沟通**（「自动沟通」页）：Camoufox 隐身引擎**多平台批量沟通**，按平台优先级串行消费（先完成高优先级平台的全部已确认岗位，再切下一平台）。投递语义按平台适配：BOSS 输入并发送打招呼语（**文字气泡确认**）；猎聘点「聊一聊」→ 平台用 **App 预设招呼语自动发送**（须先在猎聘 App 设置招呼语文案，脚本不注入文本），确认聊天窗打开 / 按钮变「继续聊」即计成功；智联 / 前程无忧点「投递」（前程无忧按「批量投递」+ 成功数量确认），确认「投递成功」/「已投递」即计成功。**AI 跟聊仅 BOSS 支持**，其余平台回复请在平台 App 内人工跟进。**「AI 跟聊监听」**（自动沟通页开关，独立于批量投递）：开启后引擎用**单一常驻浏览器停在 BOSS 会话页**（Python `/chat-watch`：`start` / `scan` / `open` / `send` / `stop`，与批量投递**共用同一 pacer 与冷却不变量**，批量投递运行时本轮监听让路，避免两个隐身窗口争抢），每轮巡检间隔 2 分钟、每轮最多处理 6 个会话、两次回复最小间隔 20s；发现 HR 新消息即带**完整多轮聊天上下文**生成回复并发送，HR 明确拒绝则收口该会话（记指纹 + 拒绝时间）不再回复，系统提示 / 表情 / 无实质内容只记指纹、不重复调用 AI；回复类发送只记 `replySentAt`，**不计入单日投递上限**（不改 `sentAt`）。回复中可引用的薪资期望 / 面试时间 / 到岗时间等来自「沟通信息（AI 跟聊引用）」用户自填内容，留空则不作任何此类承诺；冷却期或 BOSS 未登录时不允许开启。平台卡片实时显示各平台引擎 / 登录状态，可逐平台「登录 / 退出」；未确认投递结果不计成功、code 35/36/32/37 立即停止交人工。

* **主题**：浅色 / 深色 / 跟随系统（antd + CSS 变量，状态持久化）。

* **定时任务**：侧栏「定时任务」页配置，按设定时刻（HH:mm + 星期，空 = 每天）自动触发「投递 / 采集 / 备份」三类动作；全局调度器每 15s 心跳扫描、按目标时刻去重（同一分钟只触发一次）。每条任务可圈定**目标平台**（留空 = 全部已启用平台）；「投递」任务可设**单轮条数上限**（>0 时成功满该数即结束本轮，等待下一触发时刻——多条限量定时投递即构成「分批投递」）；「分批投递模板」卡片一键创建 早间 09:00 / 午间 13:00 / 晚间 18:00 三条任务（默认每轮 40 条、全部启用平台）；旧版 `config.batchDelivery`（早中晚分批）启动时一次性迁移为「早/午/晚间限量投递」三条任务（幂等，仅迁移曾开启者）。投递复用自动投递引擎全部安全守卫（冷却 / 每日上限 / 平台配额 / 首条验收 / 风控交人工），引擎已在运行时跳过本次触发；「采集」经跨页标志（携带目标平台）交常驻工作台按平台逐一消费；最小化时仍触发（主进程关闭背景节流 `backgroundThrottling: false`）。

* **本地自动备份**：`localStorage` 为主存储，另按可配置目录（默认 `userData/backup`，写在 `userData/.backup-dir.txt` 指针）做周期写盘；每 5 分钟脏检查（序列化 keys 未变化则不重写文件），覆盖 `bossclaw-app / -settings-v2 / -data / -schedule` 四组键；`localStorage` 缺失或「清空全部数据」后，可从本地备份文件自动回签恢复。

* **开机自启动**：设置页开关，写入 Windows 登录项（`setLoginItemSettings`，打包安装版生效），配合定时任务实现应用运行期间自动投递 / 采集 / 备份。

* **首页「阅读使用文档」**：首页操作区提供「阅读使用文档」按钮，主进程读取用户文档 `resources/docs/使用前必读.md`（开发与打包同源，均指向应用 resources/docs/，`extraResources` 已配置）经 MarkdownView 抽屉渲染。

* **公司规模筛选**：设置页新增「公司规模」单选，映射 BOSS web 端 scale 参数（0-20人=301 … 10000人以上=306，不限 = 不附加过滤），参与搜索采集与搜索 URL 构造。

* **面试方式筛选**（`main` 新增）：设置页指定「线上 / 线下 / 不限」，由 `interviewMode.ts` 做**确定性**识别（优先本地关键词，宽松不误杀）：「加入任务」时按岗位标题 / 描述 / 卡片文本判定面试方式；**未明确披露一律判为合格**，不参与过滤、不误杀；出现「无需到场 / 线上即可」等否定表述不判为线下。目的是排除与设定冲突的岗位，避免浪费每日打招呼配额。

* **岗位过期判定**（`main` 新增，`jobExpiry.ts` 唯一权威）：JD 中**显式写出**投递截止日期（猎聘 JD 常见「截止日期：YYYY年MM月DD日」，也认 `2027-07-16` / `2027/7/16` / 缺年份的「07月16日」）的岗位做纯本地**确定性**判定 —— **截止日当天仍有效**，早于今天即判过期并硬性排除，不消耗 AI Token 与投递配额；**未写截止日期、写成「长期有效 / 招满即止」、或日期不可解析一律放行**（大多数岗位不写该字段 ⇒ 对其它平台零副作用）。判定输入为标题 + 描述 + 卡片文本，**不做全页扫描**；`ingestJob` 与「加入任务」两条入口同口径拦截。设置项 `excludeExpiredJobs` 默认按平台取值（`PLATFORM_EXPIRY_DEFAULT`：**仅猎聘默认开启**），用户在设置页的显式开关**优先于**平台默认值。回归：`scripts/liepin-jd-regression.mjs`。

* **外部 Agent 通道**（默认关闭）：应用内控制桥（`electron/control-bridge.cjs`，仅监听 `127.0.0.1:17650`，除 `/health` 外要求 `x-bossclaw-token`，令牌写入 `<userData>/control-bridge.json`）+ 零依赖 stdio MCP 服务器 `mcp/bossclaw-mcp`（**9 工具 / 3 组**：运行控制 3 · 应用控制 2 · agent 代答 4）。动作由渲染层白名单 `controlRuntime.ts` 强制，**不提供发消息 / 批量投递 / 绕过验证码 / 改安全参数的能力**。

* **Agent 代答**（`main` 新增）：用户**未配置 AI API Key** 时，应用内 AI 调用（岗位分析 / 职业画像 / 打招呼语 / 定制简历）由 `agentAnswer.ts` 挂入本地待答队列并等待，在线外部 Agent 经 `bossclaw_agent_tasks`（长轮询，**领取即心跳**）领取、用自有模型生成、`bossclaw_agent_submit` 回填；超时 / 取消 / 无心跳则回落应用内本地规则。心跳窗口 90s，单任务等待 30~240s，JSON 纠错最多 1 次。**只搬运「提示词 ↔ 生成文本」**，回填仍走应用既有校验链。

* **数据统计与导出**：`Stats` 页由 `statsAggregate.ts` 聚合（趋势「已投递」按投递成功时间归桶），含**投递漏斗**转化看板（采集入队 → 已投递 → 已打开沟通 → 已回复 → 面试，并给出占采集比、打开率 / 回复率），支持导出**岗位明细 CSV / 统计汇总 CSV / 统计报表 PDF（A4 横版）**，每次导出都由系统保存对话框选择位置。

* **数据**：设置页可导出 / 导入 / 清空本地数据（localStorage），并支持「立即备份 / 从本地备份恢复」。

***

## 技术栈

* **Electron** `^31`（主进程 CommonJS：`electron/main.cjs` + `electron/preload/*`）

* **React 18 + TypeScript + Vite 5**（渲染进程：`src/`）

* **Ant Design 5**（UI）+ **Zustand**（状态，persist 接 localStorage）

* 打包：**electron-builder**（目标由 `package.json` 的 `build.*.target` 决定：Windows NSIS + 便携版，Linux AppImage + deb，macOS dmg + zip）

***

## 目录结构

```
desktop-app/
├── package.json / vite.config.ts / tsconfig*.json / index.html
├── .nvmrc                            # Node 22
├── .editorconfig                     # 跨编辑器编码风格
├── electron/
│   ├── main.cjs                      # 主进程：单窗口 + webview + IPC + CloakBrowser
│   ├── control-bridge.cjs            # 本地控制桥（外部 Agent / MCP 用，127.0.0.1:17650，默认关闭）
│   ├── preload/
│   │   ├── app.cjs                   # 主窗口安全接口（contextBridge）
│   │   ├── webview.cjs               # 内置浏览器 guest 页回传 + 真实输入 + 采集
│   │   └── platform-adapters.cjs     # 多平台 DOM 适配表（纯数据 + 纯函数，零 DOM 依赖，可 require 单测）
│   └── cloakbrowser/
│       ├── launcher.cjs              # CloakBrowser 生命周期管理（启动/标签/CDP输入）
│       └── cloakPreload.cjs          # CloakBrowser 页面预加载
├── bridge/                           # Node 桥接服务（mammoth / 文件 / 任务恢复）
├── camoufox/
│   ├── camoufox_server.py            # Python 隐身搜索/发送桥（多平台调度基座 + BOSS 既有链路 + `/chat-watch` 常驻 AI 跟聊会话监听）
│   ├── platforms/
│   │   ├── models.py                 # JobCandidate 等统一数据模型
│   │   ├── capabilities.py           # 平台能力矩阵（与 platforms.ts 双源同口径）
│   │   ├── base.py                   # 搜索 / 投递 / 登录三段骨架唯一实现
│   │   ├── registry.py               # 平台注册表
│   │   ├── progress.py               # 词级断点续采（TTL 24h）
│   │   ├── filters.py                # 「基础求职条件」跨平台码值映射唯一权威
│   │   ├── common.py                 # 公共基座（人类化行为 / Cookie 按平台持久化）
│   │   └── liepin.py / zhaopin.py / job51.py   # 各平台差异声明（搜索 URL 附加 / 投递 / 登录）
│   └── requirements.txt
├── resources/
│   ├── icon.ico / icon.png
│   └── docs/                         # 「使用前必读」等随包文档（extraResources）
├── skills/                          # AI 技能库（SKILL.md，内置 7 项）
│   ├── resume-profile/SKILL.md
│   ├── job-analysis/SKILL.md
│   ├── greetings/SKILL.md
│   ├── tailor-cv/SKILL.md
│   ├── jd-reading/SKILL.md
│   ├── great-resume/SKILL.md
│   └── job-match/SKILL.md
└── src/
    ├── main.tsx / App.tsx / theme.ts / index.css
    ├── store/                        # useAppStore / useDataStore / useSettingsStore / useScheduleStore
    ├── lib/                          # storage / electronApi / bridgeClient / controlRuntime / localBackup / scheduler / bossclaw/*（platforms 平台注册与能力矩阵 / platformUrls 各平台搜索 URL 构造 / matching / fitLevel / profile / greetings / schoolTier / jobMatch / jobExpiry 岗位过期判定 / jobAssistant / jdCleaner / docParser 旧版 .doc 解析 / skills / agentAnswer / statsAggregate / interviewMode 等）
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
npm run package:linux      # 打包 Linux（build.linux.target = AppImage + deb）
npm run package:all        # 打包 Windows + Linux
```

> **macOS 安装包**受 electron-builder 限制，只能在 macOS 上构建（dmg 依赖 macOS 系统工具）；Windows / Linux 可在本机直接打包。
> **打包格式**由 `package.json` 的 `build.*.target` 决定（Windows = nsis + portable，Linux = AppImage + deb，macOS = dmg + zip）；需要 rpm / pacman / tar.gz 等其它格式时，向 `build.linux.target` 补充目标后重新执行 `npm run package:linux`。
> **已发布的 v2.5.3** 另附 `BossClaw-2.5.3-mac.tar.gz` 源码打包档案（内含该版本的 `build-mac.sh`）；`main` 分支已移除源码打包脚本，Mac 用户直接用 `npm run package:mac`。

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
├── BossClaw-<version>-x64.exe           # Windows NSIS 安装包（推荐发行）
├── BossClaw-<version>-portable.exe      # Windows 绿色便携版（无需安装、解压即用）
├── BossClaw-<version>-x64.exe.blockmap  # NSIS 增量更新 blockmap（electron-builder 自动生成）
└── win-unpacked/                     # Windows 解压目录（可手工分发的文件夹）
```

> `<version>` 取 `desktop-app/package.json` 的 `version`（单一来源；安装包名由 electron-builder 按同一字段生成）。
> 示例：`version` = `2.5.6` → `BossClaw-2.5.6-x64.exe`。

### Linux（`npm run package:linux` 或 `package:all`）

按 `build.linux.target` 产出 **AppImage + deb** 两种格式：

```
release/
├── BossClaw-2.5.3-x86_64.AppImage   # Linux 通用（跨发行版可执行单文件）
├── BossClaw-2.5.3-amd64.deb         # Debian / Ubuntu / Linux Mint 等 deb 系
└── linux-unpacked/                   # Linux 解压目录
```

> 已发布的 v2.5.3 另附 `BossClaw-2.5.3-x64.tar.gz` 通用压缩包。需要 rpm（RHEL / Fedora / CentOS）或 pacman（Arch / Manjaro）时，向 `build.linux.target` 补充 `rpm` / `pacman` 后重新打包。

### macOS（`npm run package:mac`，只能在 macOS 系统执行）

```
release/
├── BossClaw-2.5.3-x64.dmg / .zip    # Intel Mac（x86_64）
├── BossClaw-2.5.3-arm64.dmg / .zip  # Apple Silicon（M1/M2/M3/M4）
└── mac/                              # macOS 解压目录（.app）
```

> `main` 分支不再提供「源码打包档案」脚本（历史 `package:source` / `build-mac.sh` 已移除）；无 Mac 环境时可下载已发布的 `BossClaw-2.5.3-mac.tar.gz`（内含该版本脚本），或交给有 Mac 的协作者直接用本源码执行 `npm run package:mac`。

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

### 本地控制桥（不走 IPC）

外部 Agent / MCP 不走 IPC，而是应用内起一个**只监听回环**的 HTTP 控制桥（`electron/control-bridge.cjs`）：

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 存活探测（唯一免令牌端点） |
| `GET /state[?path=a.b.c]` | 渲染层实时状态快照（可点路径裁剪），含 `agentAnswer` 代答统计 |
| `POST /action` | `{ action, params }` → 渲染层白名单动作（`src/lib/controlRuntime.ts`） |

- **开启条件**：`BOSSCLAW_CONTROL=1` 或 `--control-bridge`（`start-bossclaw.cmd` 默认带上，`--no-agent` 关闭）；显式关闭优先；未提供则完全不启动。
- **端口**：默认 `17650`（`BOSSCLAW_CONTROL_PORT` 可覆盖，被占用自动 +1…+9）；除 `/health` 外必须带 `x-bossclaw-token`，令牌写入 `<userData>/control-bridge.json`。
- **边界**：白名单只覆盖状态读取、切页、主题、暂停 / 恢复投递、平台与调度配置、数据写入、AI 生成、浏览器只读与白名单操作、agent 代答收发；主进程侧仅窗口控制与截图。**无发送消息 / 批量投递 / 绕过验证码 / 改 `SAFETY_LIMITS` 的能力。**

### 渲染层状态分层

* **运行时状态**（`useAppStore`）：主题、活动路由、桥状态、BOSS 登录态、引擎状态——**不持久化**（每次启动重置）。

* **业务数据**（`useDataStore`）：岗位 / 任务 / 日志 / 画像——**持久化到 localStorage**（带 `bossclaw-data-version` 重置）。

* **用户配置**（`useSettingsStore`）：LLM 密钥、过滤规则、招呼语、引擎模式——**持久化**（设置页可导出/导入）。

***

## 常见问题

* **白屏**：`set BOSSCLAW_DEBUG=1` 后启动，查看 `userData/debug-render.log` 内 DOM 检查 / 浏览器状态。

* **首次启动登录态丢失**：v3 重建后首次启动会清空旧 `persist:bossclaw` 会话与 Camoufox 缓存（`DATA_VERSION='v3-rebuild-20260815'`）。需重新扫码登录。

* **隐身引擎报错** **`未检测到可用内核`**：安装 Chrome / Edge / Firefox 任一，或 `pip install 'camoufox[geoip]' && python -m camoufox fetch`。

* **没配 AI API Key，AI 相关功能还能用吗？**：能。三条路径按顺序生效 —— ① 外部 Agent 代答（需开启控制桥且有 agent 在线，见「本地控制桥」）；② 应用内**本地规则**兜底（职业画像 `buildLocalProfile`、匹配、招呼语等）；③ 纯本地确定性能力（简历解析、噪音清洗、排序）不受影响。用户配了 API Key 即直连自己的模型，不会走代答。

* **非 BOSS 平台采集不到详情 JD？**：内置浏览器链路对非 BOSS 平台只做**列表级**采集（这些平台搜索页没有内联详情面板，点卡片会导航走），列表卡本身**不含 JD 正文**；拿到列表后由 `webview.cjs::enrichJobDetail()` 按能力表 `PLATFORM_DETAIL_API_FILL` 调**平台同源**通道补齐 —— 智联 = 详情 JSON 接口（按卡片 number 取 `jobDesc`，滚动加载出的卡由主进程旁路监听页面自身的 `POST /c/i/search/positions` 并入注解索引）、猎聘 = **同源 SSR 详情页 HTML**（`parseLiepinJobDetailHtml()`，JD 在 `<dd data-selector="job-intro-content">`，同页顺带取标题 / 薪资 / 地点 / 公司 / HR）；前程无忧暂无同源通道，只有列表字段。**该补齐不需要 Camoufox**（未装内核也能拿到 JD）；护栏：单次上限 300 条 / 连败 4 次熔断，失败保留卡片文本、绝不丢岗位。BOSS 是唯一「列表内联详情」形态。

* **采集卡住很久才报超时？**：先确认 `visual-collect` / `collect-control` 是否已注册（全平台注册是硬约束，漏注册会静默等到最长 15 分钟兜底超时）；preload 改动后必须重启 Electron（`webview.cjs` 是 CommonJS，HMR 不覆盖）。

***

## 变更记录

* **v2.5.6（2026-10-09 发布）** — 内核升级 Electron 31 → 42 + 内置浏览器反检测增强 + 猎聘 / 前程无忧全链路 + 岗位过期判定 + AI 跟聊监听 + 代码审查修复：
  * **内置浏览器「主世界」反检测补丁**（新增 `electron/preload/stealth.cjs`）：`<webview>` 的 preload 与 `session.setPreloads` 均运行在**隔离世界**，改不了主世界 `navigator` —— 故补丁以源码字符串导出，由主进程 `executeJavaScript` 注入**主世界**（`did-start-loading` + `dom-ready` 双时机、内建幂等守卫）。补丁项 `uaCh` / `languages` / `notification` / `chromeObject` / `toStringGuard` 可用环境变量 `BOSSCLAW_STEALTH`（`off` / `only=a,b` / `skip=a,b`）单项开关；`webdriver` / `plugins` 经实测原生即正常，默认不改（盲改反会引入新破绽）。内置 11 类指纹自检探针 + 不变量断言（改补丁后必跑，防「修一个洞、开两个洞」）。
  * **请求头层与真机画像对齐**：一份 `TARGET_PROFILE` 同时驱动 `setUserAgent` / `webRequest.onBeforeSendHeaders` / 主世界补丁三处（**禁止各写一份**，否则产生「JS 说一套、请求头说另一套」的新矛盾）。依据真机抓包样本对齐 `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` / `Accept-Language` / UA —— 实测原生导航请求**完全不发送 `Sec-CH-UA` 系列头**，而 JS 层 `navigator.userAgentData` 却存在，属服务端直接可见的自相矛盾，现已补齐。
  * **JD 学历解析修正**（`jobMatch.ts`）：「本科及以上」不再被升档成「要求硕士」，「X 优先」等语气词不计入要求，薪酬福利句不再被误采信；`score-regression.mjs` 扩至 44 项。
  * **猎聘 / 前程无忧全链路补齐**：`platformUrls.ts` 新增猎聘筛选码表与 `appendLiepinCriteria`（经验 / 学历 / 规模 / 公司性质 / HR 活跃度 / 融资阶段）、前程无忧 `buildJob51SearchUrl`；`liepin.py` / `job51.py` / `filters.py` / `common.py` / `base.py` 收敛「搜索 · 投递 · 登录」三段差异声明；新增三支回归 `scripts/liepin-url-regression.mjs`（筛选码值 ↔ `filters.py` 双源同步守卫）· `liepin-jd-regression.mjs`（详情页 HTML → 字段补齐，JD 保真保留分段）· `liepin-apply-regression.mjs`（「聊一聊」`a.btn-main[data-selector="chat-chat"]` + IM 就绪信号 `#im-c-entry` 等，纠正旧错误的 `.__im_basic__*` 命名）。
  * **岗位过期判定**：新增 `jobExpiry.ts`（纯函数、零依赖、可离线回归）—— 仅当 JD **显式写出**截止日期时判定，过期即硬性排除、无信号一律放行；设置项 `excludeExpiredJobs` 默认仅猎聘开启（`PLATFORM_EXPIRY_DEFAULT`），`ingestJob` 与「加入任务」两条入口同口径拦截。
  * **AI 跟聊监听**：Camoufox 新增常驻 `/chat-watch`（单一常驻浏览器停在 BOSS 会话页；`start` / `scan` / `open` / `send` / `stop`），渲染层 `useAutoChatStore` 新增监听循环（2 分钟一轮、每轮 ≤6 会话、最小间隔 20s、批量投递让路、代际 token 防串台）；HR 明确拒绝则收口会话，回复类发送不计入单日投递上限；自动沟通页新增「AI 跟聊监听」开关与「沟通信息（AI 跟聊引用）」输入卡。
  * **投递链路**：工作台非 BOSS DOM 投递（`platform-adapters.cjs::PLATFORM_APPLY_SPEC` + `webview.cjs::platformApply`）补齐猎聘「聊一聊」分支，四个平台全部可在工作台一键投递；`jobIdFromUrl()` 收口为唯一权威（`/job/xxx.shtml` 排除点号、`jobs.51job.com` 取末段）；猎聘卡片容器归一 + CSS Modules 驼峰类名口径校验（`[class*=]` 区分大小写，写错会静默把整页卡塌成 1 条候选）。
  * **统计与首页**：`Stats` 页新增**投递漏斗**（采集入队 → 已投递 → 已打开沟通 → 已回复 → 面试 + 打开率 / 回复率）；首页补齐投递步骤归因（进度不再无声停在 80%）。
  * **岗位发布时间透传**：`camoufox_server.py` / `webview.cjs` / `camoufox.ts` 贯通 `publishTime`，修复「新鲜度」维度恒失效。
  * **界面**：新增 `index.polish.css` 组件级 polish 样式层与组件级主题 token；设置页「硬性过滤 / 求职偏好」栅格改零留白排布（开关类字段内联同行）；修复工作台事件回调被冻结导致 `apply-stage` 全量丢弃。
  * **内核升级 Electron 31 → 42**（Chromium 126 → 148，`electron-builder` 24 → 26）：真机实测 `<webview>` 四项关键能力（`did-attach-webview` 触发 / preload 注入 / `sendToHost` 路由 / 主进程 `executeJavaScript` 往返）全部可用，`display:flex` 渲染未受影响（「改 block 会缩到约 150px」这个坑未被破坏）。两处 API 适配：`console-message` 首参在 42 起变为对象（统一 `parseConsoleMessage()` 收敛，旧位置参数取法虽仍可用但已 deprecated）、`session.setPreloads` / `getPreloads` 弃用（改 `registerPreloadScript`，双版本兼容）。升级后 UA / UA-CH 版本号由内核真实产生，反检测补丁从「伪造版本」退化为「只补真实缺口」。
  * **输入通道收口（第一期）**：BOSS 聊天链路改**真实事件优先** + 人类化鼠标轨迹 —— 把 `isTrusted:false` 的 `el.click()` / `dispatchEvent` 迁往真事件通道（`isTrusted:true`）的第一步；新增**活跃时段与批次休息**，按真人作息分布安排投递节奏（**不改变**速率上限与安全不变量）。
  * **代码审查修复（批次 1-14）**：AI 管线缓存污染与画像前置（`aiAnalyzeJob` 前必须 `dataSetProfile`）、安全不变量（投递守卫判定顺序纠偏 / 账号级额度与用量口径**同源收敛** / 风控冷却改**单调合并**写入，禁裸 `Date.now() + cooldownMs`）、并发限速（双引擎共享同一 `ActionPacer` 与计数）、主进程通道分桶与诊断日志门控、`chat-watch` 超时与 stdio 背压、设置页「节奏设置」三处修正（含**风控冷却实为死设置**）；新增静态守卫 `scripts/css-guard-regression.mjs`（12 项，拦截未定义 `className` 工具类等）与 `scripts/theme-vars-regression.mjs`（主题变量悬空）。
  * **修复简历中心 PDF 解析卡死**：根因三层 —— ① 解析器无差别解码所有 `stream` 对象，**字体程序二进制**被当作文本候选；② 回退扫描仅凭「含 `BT`」判断像内容流（随机二进制常含该字节）；③ 数组文本算子正则在 `<` / `(` 上存在多条可覆盖同一字符的回溯路径 → **灾难性回溯**（实测 329KB 字体流单次分词 **81,281ms**，1MB 以上卡死渲染进程）。处置：正则消歧（单字符类排除 `<` `(`，退化为线性）、字体 / 图像 / 元数据 / 交叉引用流一律不解码、新增内容流**形状闸门**（尺寸上限 + 文本算子存在 + 可读字符占比）。1MB 字体流 4603ms → 48ms，2MB 从置死 → 86ms；并修正「扫描件 PDF 把字体垃圾当简历正文」的内容质量缺陷。新增 `scripts/pdf-parse-regression.mjs`（31 项，含反向自证）。
  * 门禁：`tsc -b` + `vite build` 通过；`scripts/` 全量静态回归通过。

* **v2.5.5（2026-09-22 发布）** — 智联招聘全链路接入 + 多平台基础求职条件扩展 + MCP 全自动投递：
  * **智联招聘全链路接入（筛选 / 搜索 / 投递）**：`camoufox/platforms/zhaopin.py` 按差异声明补齐筛选参数拼接与投递链路；递送 `filters.py` ↔ `platformUrls.ts` 双源同步，六大筛选维度（职位类型 et / 学历 el / 经验 we / 公司性质 ct / 融资阶段 fs / 规模 cs）码值**按实测链接逐档校准**（公司性质：中外合资=4 / 港澳台=16 / 机关事业单位=6;10 / 其他=7;14;15；多值拼接规则 = 同类型 `;` 分隔、跨类型 `,` 分隔）；新增 `companyType` / `financing` 求职条件配置项并接入智联；新增 `scripts/zhaopin-url-regression.mjs`（32 项断言）守护拼接口径。
  * **多平台基础求职条件扩展**：设置页新增公司性质 / 融资阶段字段（含 Tooltip 释码），投递方向 / 搜索词校验同步放宽。
  * **MCP 新增 `bossclaw_agent_send` 全自动投递工具**：代答组唯一发送能力，复用应用自带安全投递引擎，白名单与主进程 `MAIN_ACTIONS` 同步（`mcp/bossclaw-mcp`）。
  * **上下文预算统一口径**：`contextBudget.ts` 改为「模型窗口 × 用量档位」动态测定（下限 32K），替换各处理位置硬编码字数截断；新增 `scripts/context-budget-regression.mjs` 回归脚本。
  * **非 BOSS 一键投递就绪判定修复**：身份稳定 `ref` + 页面事实探测取代宿主标记；`target=_blank` 弹窗改主进程 `setWindowOpenHandler` 处理（http(s) → 当前标签 loadURL，其余 deny）；各平台登录态探测 `platformLogins` 与状态栏短标签。
  * 首页「配置 AI 模型」步骤判定纳入当前 LLM 配置，并修正「未配置 API Key」的日志归因。

* **v2.5.4（2026-09-17 发布）** — 全面优化审查落地 + 多平台采集 / agent 代答 / 面试方式筛选正式发布：
  * **全面优化审查落地**（`docs/code-review-2026-09-17/`，6 批 70 条）：AI 层（进程内一级缓存、换模型定向清理、JSON 修复链加固、apiKey 去空白）· 状态持久化（存储键单一登记表修复「导出漏定时任务」、运行时日志拆独立键 `bossclaw-runtime-logs`、备份写代数锚定）· 匹配评分（薪资解析唯一实现修复「8千-1.2万」误算、硬约束收集可单测）· Electron 层（投递通道拆分、素材白名单双端同源、webview 输入频率兜底）· 渲染层（`index.polish.css` 拆分、打招呼语本地态编辑、福利标签缓存、滚动状态机、设置页后台停轮询）· Python / MCP（未知风控码 fail-safe、兜底链崩溃修复、MCP 白名单断言 `test/whitelist-parity.mjs`、主题变量守卫 `scripts/theme-vars-regression.mjs`）· 自动沟通引擎运行态整合（P2-04）。
  * **多平台采集层（正式发布）**：新增 `camoufox/platforms/`（`models` / `capabilities` 能力矩阵 / `base` 三段骨架唯一实现 / `registry` 注册表 / `progress` 词级断点续采），liepin · zhaopin · job51 收敛为**差异声明**；断点续采只做词级（TTL 24h），命中风控 `clear_combo` 后重头采（宁重复不遗漏）。
  * **内置浏览器多平台打通（正式发布）**：新增 `electron/preload/platform-adapters.cjs`（纯数据 + 纯函数，可 require 单测），`webview.cjs` 移除内联平台选择器；`visual-collect` / `collect-control` 全平台注册；非 BOSS 列表级采集 + 页内 `loginWallDetected()` 判定登录态；BOSS 专属副作用按平台短路。**未安装 Camoufox 内核也能采集非 BOSS 平台。**
  * **agent 代答（正式发布）**：新增 `agentAnswer.ts`（待答队列 / 心跳 / 超时 / 取消 / 统计），`llm.ts` 在无 API Key 时走 `answerViaAgent`；MCP 新增 `tools/agent.mjs`（`agent_tasks` 领取即心跳 / `agent_submit` / `agent_cancel`），白名单同步 `agentTasks` / `agentSubmit` / `agentCancel`。心跳 90s、等待 30~240s，超时回落本地规则。
  * **面试方式筛选（正式发布）**：新增 `interviewMode.ts`，设置页指定线上 / 线下 / 不限，「加入任务」时确定性识别（未披露 = 合格，不误杀）。
  * 统计看板与 `statsAggregate.ts` 聚合；Workbench / Settings / Home / Stats UI 迭代；新增 `ChevronDown` 组件；移除跨平台源码打包脚本（`build-mac.sh` / `package:source`）。

* v2.5.3 — 评分裁决与简历定制收口：岗位匹配改为 AI 四层整体裁决（`fitLevel` 档位制，分随档走、AI 分即最终分），五维语义锚点与反通胀口径统一，入队门槛可配 `minQueueScore`；投递链路改走内置浏览器真实 DOM 沟通（单线性等终态、气泡级文字确认），自动沟通卡片新增「跳过」、附件按聊天页源码重构；定制简历保留能力描述语红线 + 七模块结构化文档 + 校名披露规则（仅 985/211 写校名）与目标城市同源；新增统计导出（CSV / PDF）、有界分析队列与新标签页管理。
* v2.5.2 — 采集评分优化与多页增强：岗位评分融合（AI×0.7 + 本地×0.3）、修正谨慎档、移除本地预筛开关、会话级去重；内置浏览器多页管理（browserRegistry）+ force-resize 重绘、修复页面加载崩溃；方向关键词 AI / 薪资校准 / 工作时间安排；内置 Agent 控制桥（白名单动作、本地令牌鉴权、默认关闭）+ MCP 服务器（`mcp/bossclaw-mcp`）。
* v2.5.0 — 多平台投递适配与安全加固：Camoufox 引擎按平台细分（job51 / liepin / zhaopin），「自动沟通」支持 BOSS 文字气泡、猎聘「聊一聊」、智联 / 前程无忧投递简历，各平台独立登录态与每日计数；HR 来消息后 AI 跟聊回复不再计入单日投递上限；会话去重 / 投递锁 / 持久化安全细节收敛。
* v2.4.0 — 定时任务（投递 / 采集 / 备份，HH:mm + 星期，心跳去重）；本地自动备份（5 分钟脏检查写盘 + 缺失自动回签恢复）；开机自启动（Windows 登录项）；首页「阅读使用文档」入口；公司规模筛选（BOSS scale）；新增 great-resume / job-match 增强技能；关闭后台节流保证最小化定时仍触发。
* v2.3.0 — 批量自动沟通引擎重构（遵循首次验收 / 打招呼语非空 / 频率限制等安全不变量）；隐身引擎（Camoufox）/ 隐身浏览器（CloakBrowser）与贡献模块细节优化；通信模块实现优化。
* v2.1.0 — AI 技能体系（内置 4 技能 + 自定义技能导入/新建/删除）；定制简历求职助手（JobAssistant，侧栏新增入口）；岗位匹配本地确定性多维匹配与 AI 融合；岗位采集页面噪音清洗（jdCleaner）；版本 / productName 统一为 BossClaw，新增 macOS / Linux 打包配置。

* v2.0.0 — 内置浏览器 + 收集投递沟通模块从零重建；统一 IPC 错误包装；Workbench 三栏拆分；CloakBrowser / Camoufox 可选隐身增强。

