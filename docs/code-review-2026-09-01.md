# BossClaw 桌面版 —— 架构与性能审查报告

- **审查日期**：2026-09-01

- **审查范围**（全量覆盖）：

  - Electron 主进程 / preload / CloakBrowser 引擎 / 本地桥接服务（bridge）

  - 渲染层 store（app / data / settings / autoChat）与全部页面（Home / Workbench / Resume / Directions / Tasks / Stats / OpenClaw / JobAssistant / AutoChat / Settings）

  - 全部组件（BrowserView / CloakView / 日志面板 / 侧栏 / 状态栏 / 标题栏 等）与 `src/lib`（含 `lib/bossclaw/` 全部业务模块）

  - Camoufox 隐身引擎（`camoufox.ts` + `camoufox_server.py`）、AI Skills 提示词（`skills/*/SKILL.md`）、构建配置（vite / tsconfig）、运维脚本（`*.cmd` / `check-fresh.mjs`）

- **方法**：code-review-skill 全流程（上下文收集 → 高层架构 → 逐文件逐行核对 → 汇总定级），并发子代理深挖 + 人工复核关键结论。

- **结论**：结构整体健康、与 job-claw-main 对齐良好；安全不变量与风控分级落实情况佳。核心问题集中于**运行并发竞争、隐身引擎安全、高频状态写入**。共 **🔴 3 / 🟡 30 / 🟢 若干**。

> 后续优化以本文档为清单，逐条核对严重级别与证据定位；修复后在「第 8 节进度记录」勾选。

***

## 1. 总体评价

### ✅ 做得好的方面

- **目录结构与 AGENTS.md 8.2 严格一致**：`electron/main.cjs`、`preload/*.cjs`、`src/{main,App,theme,store,components,pages,lib}` 齐整。

- **进程安全边界**：`contextIsolation:true`、`nodeIntegration:false`、`will-navigate` / `setWindowOpenHandler` 拦截外跳。

- **跨引擎投递锁**：`deliveryLock`（同步原子 `claim/release`）避免同一岗位重复投递；后台引擎只负责 `approved/opened`、工作台只负责 `approved_queue`，职责隔离，**无 TOCTOU 竞态**（filter→claim 之间无 await 间隙，JS 单线程原子）。

- **风控分级**：`safety.ts` 对 31/32/35/36/37/38/1006/5xxx 的分类 + 冷却，语义为「降频 / 即停 / 不绕过」。

- **优先级评分**：`priority.ts` 与参考实现 `job-priority.js` 逐项一致（recommend +900 / cautious -350 / reject -5000 / hardBlocks ×-2400 / 外部网申 -6000 / retryCount ×-120），无除零、无 NaN。

- **状态机对齐**：`taskState.ts` 阶段枚举与百分比与 job-claw-main `TASK_STAGE_META` 逐项一致（仅插入扩展阶段 `opened`(80)）。

- **事件订阅收敛**：IPC 订阅集中在 `BrowserView.tsx` 且 `return off` 清理正确；后台引擎用 `while+sleep` 低负载轮询而非空转 setInterval。

- **健壮性**：除零/NaN/空值/递归/可变默认参数防御全面；`searchUrl` 全走 `URLSearchParams` 编码无注入；组件无 `dangerouslySetInnerHTML`。

### ⚠️ 需要重视的三类问题

1. **运行并发竞争**：批量自动沟通 `chatRunning` 卡死、`runNext` 无互斥、连点「加入任务」竞态、`processedIds` 预占。
2. **隐身引擎安全**：Camoufox `page.evaluate` JS 注入、本地桥静态可预测 token、CloakBrowser 事件可伪造 / 主世界注入。
3. **安全面需收窄**：LLM 渲染层直连未按文档代理、不可信 JD 提示注入防护缺失、简历解析无体积上限、泛化 IPC 透传 + `sandbox:false`。

***

## 2. 严重级别图例

| 级别           | 含义       | 是否阻塞合并 |
| ------------ | -------- | ------ |
| 🔴 blocking  | 必须修复才能合并 | 是      |
| 🟡 important | 应修复，可讨论  | 否      |
| 🟢 nit       | 可选优化，不阻塞 | 否      |
| 💡/🎉        | 建议 / 肯定  | 非阻断    |

***

## 3. 🔴 blocking（3 项，均已人工复核）

### B1 批量自动沟通 runloop 退出后 `chatRunning` 卡死，`start()` 被拦死

- **位置**：`src/store/useAutoChatStore.ts:374-514`

- **问题**：循环内每个提前退出路径（冷却 `:433`、每日上限 `:443`、首条验收暂停 `:480`、风控 `:486`）都在 `break` 前 `runToken += 1`，使 finally（`:494`）`isCurrent = runToken === myToken` 恒为 `false`，于是 `if(isCurrent){ set({chatRunning:false,...}) }`（`:501-511`）成为**死代码**。`busy` 已释放但 `chatRunning` 不回位；`start()`（`:375`）被 `chatRunning` 拦死。**最直接触发**：首条成功后的验收暂停是标准流程，提示文案（`:478`）让用户点「开始批量沟通继续」，但 `start()` 变 no-op，必须手动先「停止」再「开始」。`chatOne` 路径（`:530`）正常。

- **建议**：终止批量的退出逻辑不应依赖「自增 token 使 isCurrent=false」，应按 finally 语义正确复位 `chatRunning`。

### B2 Camoufox `page.evaluate` 的 JS 注入

- **位置**：`camoufox/camoufox_server.py:392-396,424-426,554-558,574-579,658,1417-1421`

- **问题**：`query`/`city`/`job_id` 来自 HTTP body（渲染层可控），以 f-string 原样拼进**单引号 JS 源码**再 `evaluate`。含 `'` / `` ` `` / 换行即可逃逸字符串，在已登录 BOSS 页面上下文执行任意 JS，进而读取会话 cookie（`wt2`）。

- **建议**：用 `json.dumps()` 序列化后注入，或 `page.evaluate(fn, ...args)` 以参数传参，禁止 f-string 拼 JS。

### B3 本地桥（bridge / camoufox）静态可预测 token + 无 Origin 校验

- **位置**：`camoufox_server.py:1813` + `main.cjs:318,546`；`bridge/config.json:3` + `bridge/server.cjs:123-132`；`src/pages/OpenClaw.tsx:7-9,21-29`

- **问题**：三处 token 全为静态、随渲染包/文档公开（`bossclaw-camoufox` / `bossclaw-desktop-bridge`）。camoufox 的 `/logout`、`/clear`（`:1734-1743`）是无 body 的 POST 简单请求（不触发 preflight）；bridge 的 `server.cjs:126` 返回**反射式** `Access-Control-Allow-Origin`。恶意本地网页拼对公开 token 即可跨源调 `/command`（改状态）、`/ocr`、`/resume-text`，或强制登出 / 清 Cookie。

- **建议**：三处桥统一改为**运行时随机 token + 经 IPC 下发**，并校验 Origin / Referer / Host 白名单；`server.cjs` 不再反射任意 Origin。

***

## 4. 🟡 important（30 项）

> 按模块分组；`#` 同时用作第 8 节进度表 ID。

### 4A. 并发与状态机（后台引擎 / 工作台）

| #   | 位置                                            | 问题                                                                                                                                                                                                      | 建议                                                           |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P01 | `Workbench.tsx:740-910` + `safety.ts:144-155` | **`runNext`** **无互斥守卫**，多入口（running effect/handleDelivered/失败分支/采集）`void` 触发可并发：`activeId`/`applyStage` 相互覆盖、看门狗绑错；`ActionPacer.waitForSlot` 走 await 等待后不重新 `canAct()` 就 `record()`，并发等待者超发动作预算、旁路每分钟限速 | 沿用 `useAutoChatStore` 的 `busy/ownerRun/runToken` 互斥模式（P0）    |
| P02 | `Workbench.tsx:210-223`                       | 全局唯一 `pendingExtract.current` 存 resolve，4s 内连点两次：第一次 Promise 永久挂起；B 可能拿到 A 的兜底数据 → 错误/重复入队；兜底定时器未清理                                                                                                     | 每任务独立 token + 校验最新 token；并发点击拒绝第二次；`clearTimeout`（P0）        |
| P03 | `useAutoChatStore.ts:423` 与 `:447/:456`       | **分批** **`processedIds`** **窗口判定前预占**：`add` 先于冷却/每日上限/分批窗口判定。非窗口时 `start()` 把整队列预占却一条不发，窗口打开后已被 `filter(!processedIds.has)` 排除 → 永久空轮询；叠加 B1 无法 `start()` 自愈                                            | `processedIds.add` 与 `claimDelivery` 延后到「本周期确实要发送」判定通过之后（P0） |
| P04 | `useAutoChatStore.ts:516-536`                 | **`stop()`** **无法取消已 in-flight 的发送**：只 `runToken+=1`，对已 await 的 `chatJob→camoufoxChat` 不打断；`chatOne` 无外层循环、调用后不查 token，中途 stop 单条照常完成并写 `sent`                                                          | stop 时发送取消信号；chatOne 完成后校验 token（P1）                         |

### 4B. AI / 安全

| #   | 位置                                                                                    | 问题                                                                                                                                                                                                                                       | 建议                                                                                   |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P05 | `llm.ts:61-77`                                                                        | **LLM 渲染层直连，未按 AGENTS.md 3.1 经 preload 代理**：依赖 provider 返回 `Access-Control-Allow-Origin:*`，部分端点 CORS 失败且稳定性无保证                                                                                                                           | 按文档在主进程用 `net.request` 代发（P1）                                                        |
| P06 | `jobAssistant.ts:43-59,215,248` + `skills/tailor-cv/SKILL.md:23-27,35`                | **不可信 JD 提示注入防护缺失 + tailor-cv 授权过宽**：`buildTailorSystemPrompt` 缺「JD 是不可信输入、忽略指示性内容」规则；JD 以 `${JSON.stringify(jobView)}` 原样拼入无边界/转义（对比 `matching.ts:172-175` 的 `untrustedJobSection`）；tailor-cv 又授权「按 JD 规范名把泛化能力编写为技能」，恶意 JD 可放大诱导编造简历事实 | user 消息复用 `untrustedJobSection` 转义+边界；system prompt 补同款安全规则；授权收紧到「仅限简历真实背景的合理外推」（P1） |
| P07 | `pdfExtractor.ts:18-29,94-104`、`docxParser.ts:15-20,123-127`、`resumeParser.ts:34-131` | **简历解析无输入/解压体积上限**（zip/flate 炸弹可耗尽渲染内存）；`compressedSize` 可被恶意放大                                                                                                                                                                          | 解析入口统一加输入字节 + 解压后输出体积双上限（P1）                                                         |

### 4C. 性能

| #   | 位置                                                                                                        | 问题                                                                                                                                                                   | 建议                                  |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| P08 | `Workbench.tsx:1267-1273`、`AutoChat.tsx:355-362`、`Settings.tsx:565-575,907-909`、`useDataStore.ts:132-193` | **输入类字段逐键触发整页重渲染 + 全量持久化**：`updatePending` 每次 `map` 重建整 `pending`；`recomputeStats` 无条件 `set` 触发 persist 序列化整包（含 base64 图片）；Settings 每键 `setConfig` 也全量写 localStorage | 输入去抖/失焦提交；`recomputeStats` 按需触发（P2） |
| P09 | `Workbench.tsx:503-515` + `webview.cjs:1130/1135`                                                         | **`collect-progress`** **高频 setState 整页重渲染**；同卡片 `card-found` notify 两次、事件含完整 `job` 对象                                                                               | rAF 节流 + 进度面板抽独立子组件（P2）             |

### 4D. 隐身引擎（Camoufox / CloakBrowser）

| #   | 位置                                                             | 问题                                                                                                             | 建议                                         |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| P10 | `camoufox.ts:114-117` + `main.cjs:689`                         | 渲染层无超时/防重复；主进程 `AbortSignal.timeout` 只中止 fetch、**不取消 Python 侧操作**，客户端断连后服务端仍可能真实发送                             | 渲染层独立超时 + in-flight 锁；超时通知服务端取消（P1）        |
| P11 | `camoufox.ts:210-217`                                          | 风控码分类不全：`isCamoufoxStopCode` 仅 `36/32`、`isCamoufoxEnvCode` 仅 `38`，未覆盖 35/37                                    | 补齐 35/37 分类（P1）                            |
| P12 | `camoufox_server.py:1654-1658,1321-1333,339-478`               | 输入/输出无体积上限：`_read_body` 按 Content-Length 全读、`resumeImages` base64 无 cap、search jobs 无限累加                       | 三处统一加体积/条数上限（P1）                           |
| P13 | `camoufox_server.py:656-691`                                   | `/send` 兜底把「继续沟通」按钮文案当成功，未按 AGENTS 2.1 核对文字气泡（`/chat` 路径有气泡确认）                                                 | 对齐气泡确认口径（P1）                               |
| P14 | `camoufox_server.py:1745-1748,1823-1829`                       | 异常 `str(e)` 直接回传（可能含 URL/局部变量）；端口占用抛 `OSError` 崩溃；仅处理 `KeyboardInterrupt`，无优雅停机/僵尸清理                           | 客户端只返回通用错误；端口探测重试；补 SIGTERM/Windows 停机（P2） |
| P15 | `electron/cloakbrowser/launcher.cjs:113-114` + `main.cjs:1119` | CloakBrowser 二进制下载与 Ed25519 签名校验在仓库内无代码，全委托三方包 `cloakbrowser@0.5.7`，不可审计/不可控                                   | 封装下载+校验逻辑于仓库可见层（P1）                        |
| P16 | `launcher.cjs:208-221` + `cloakPreload.cjs:34-47`              | **页面内容可伪造事件回传**：`__bossclaw_emit__` 无 channel 白名单，任意被加载页可 `console.log` 伪造 `apply-stage/job-extracted` 干扰投递状态机 | 加 channel + 来源校验白名单（P1）                    |
| P17 | `launcher.cjs:181` + `cloakPreload.cjs:16-56`                  | 注入运行于**主世界**（`page.addInitScript`），`__bossclaw_dispatch/emit` 可被页面覆写，消息通道可信级等同于「页面即攻击者」                        | 改用 isolatedWorld 或事件签名校验（P1）               |

### 4E. 组件与页面

| #   | 位置                                                  | 问题                                                                                                                                                          | 建议                                                                     |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P18 | `CloakView.tsx:120-159`                             | `useEffect` 依赖 `[]`+`eslint-disable` 捕获首次回调 → **stale closure**；与 BrowserView 的 `callbacksRef` 做法不一致                                                        | 改 ref 模式或补齐依赖（P1）                                                      |
| P19 | `ChatLogPanel.tsx:191-193`、`LogConsole.tsx:109-112` | 大列表全量内联渲染、外层 maxHeight 滚动，长期运行可达数千条 DOM                                                                                                                     | 虚拟列表或对压入日志截断（P1）                                                       |
| P20 | `BrowserView.tsx:302-398`                           | webview 原生事件（13 种）靠 `registeredTabs` 守卫去重，卸载/标签重置不主动 `removeEventListener`；同 tabId 重建时可能「新元素不绑监听 + 旧元素残留」致 IPC 静默失效                                         | `handleRegister(tabId,null)` 分支同步清理并解绑（P1）                             |
| P21 | `bridgeClient.ts:14-21`                             | `bridgeParseResume` `fetch` 无超时/无 try/catch，与同文件 `bridgeStatus` 的兜底不一致；桥未启动时抛未处理异常                                                                          | 加 `AbortController` + 失败返回 `{ok:false,error}`（P1)                      |
| P22 | `storage.ts:35-39`                                  | `clearAllData` 与「完整清理」注释不符：漏 `bossclaw-city-codes` 与 `bossclaw-skills-v1`；且整键删 `bossclaw-settings-v2`（含 AI apiKey）需确认语义                                     | 补齐遗漏键；明确「恢复出厂」与「仅清任务」边界（P1）                                            |
| P23 | `statusMeta.ts:5-12`                                | `jobCardStatus` 未覆盖 `rejected`/`pending`（返回空色条）；`approved_queue`/`approved` 合并                                                                              | 补两状态视觉分支（P2）                                                           |
| P24 | `Home.tsx:79,89-95`                                 | `selectedCount`/`stepStates[0]` 用 `getState()` 直读，组件未订阅 `resumeText`，外部改简历后进度过期                                                                             | 将 `resumeText` 加入订阅（P2）                                                |
| P25 | `Tasks.tsx:295`                                     | `window.open(p.job.url)` 未校验 scheme，绕过「外部链接一律 `shell.openExternal`」的 AGENTS 约定；非 http(s) 有脚本执行注入面（Chromium 对 `javascript:` window\.open 多数已拦截，属边界项，合规性必须处理） | 跳转前做 `https:`/`http:` 白名单校验，命中再 `shell.openExternal` 或复用内置 webview（P0） |

### 4F. 内部状态 / 构建 / 主题

| #   | 位置                                                | 问题                                                                       | 建议                                                             |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| P26 | `main.cjs:1160` + `launcher.cjs:62-67`            | `jc:cloak-status` 的 `starting` 硬编码 `false`，与 launcher 真实状态不一致，误判「正在启动」   | 透传 launcher 状态（P2）                                             |
| P27 | `index.css:25,59` + `ThemeContext.tsx:38-45`      | **暗色首帧闪烁**：`:root` 默认浅色，`data-theme` 由 React effect 在 commit 后才写         | 在 `index.html` 内联读 localStorage 设 `data-theme`，React 挂载前锁定（P2） |
| P28 | `main.tsx:17-20` + `ThemeContext.tsx:17-24,31-45` | 系统主题**双监听冗余**：`useEffectiveTheme` 与 `ThemeProvider` 各持一份 `matchMedia` 监听 | 复用 `Root` 已算好的 `effective` 下传（P2）                              |
| P29 | `launcher.cjs:201` + `cloakPreload.cjs:64`        | 导航 `canGoBack/canGoForward` 恒为 `false` 且双源重复报 `nav`，地址栏前进后退长期禁用          | 由 launcher 统一维护栈并上报（P2）                                        |
| P30 | `package.json:33,38-49`                           | `asar:false` + files 白名单未显式含 `node_modules`，松散小文件多、体积大                   | 默认 `asar:true`，敏感项走 `extraResources` 白名单（P3）                   |

***

## 5. 🟢 nit（可选优化）

| #   | 事项                        | 位置                                                                         | 说明                                                                                                 | <br /> | <br />                             |
| --- | ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | :----- | :--------------------------------- |
| N01 | OpenClaw 异步刷新无卸载取消        | `OpenClaw.tsx:46,54,60,64`                                                 | `useEffect`+多个异步无 mounted 守卫；`setStatus(null)`（`:39-40`）会把曾连接误标断开                                  | <br /> | <br />                             |
| N02 | CloakView 每事件全量重建         | `CloakView.tsx:124-148,168-175`                                            | 事件数组全拷贝 `slice(-100)`、事件行未 memo；`engine.ready` effect 捕获 tabs 不随 tab 变动同步                          | <br /> | <br />                             |
| N03 | 定时器卸载后不清理                 | `BrowserView.tsx:335-342`、`TailorResultView.tsx:54-56`、`Tooltip.tsx:21-33` | `did-finish-load`/`markLoading`/复制/悬浮 timer 卸载后仍 setState（函数式更新兜底，无害）                              | <br /> | <br />                             |
| N04 | MetricCard 动画边界           | `MetricCard.tsx:21-22`                                                     | `diff===0` 提前 return 不校 end，动画中途取消时略有偏差                                                            | <br /> | <br />                             |
| N05 | Directions 优先级空洞          | `Directions.tsx:86-92,121,306,315`                                         | 用「交换 priority 数值」模拟上下移；优先级有空洞（如 1,5,7）时箭头禁用与实际位次不符；建议直接交换数组顺序                                      | <br /> | <br />                             |
| N06 | Resume 不回流 store          | `Resume.tsx:83-84`                                                         | `useState(initValue)` 跨页后不回填 store 最新值                                                             | <br /> | <br />                             |
| N07 | Stats 重复 filter           | `Stats.tsx:252`                                                            | `HBar` 对 8 状态各做一次全量 `filter`，可并入 `agg` 一次算好                                                        | <br /> | <br />                             |
| N08 | Settings 粗暴刷新             | `Settings.tsx:343,349,361`                                                 | `setTimeout(()=>location.reload(),600)` 瞬时白屏，可仅刷新 store                                            | <br /> | <br />                             |
| N09 | hooks.useInterval         | `hooks.ts:21-40`                                                           | `immediate:true` 且 delayMs 变化时 effect 重建会再触发一次立即 `run()`（当前常量调用不受影响）                               | <br /> | <br />                             |
| N10 | skills 空加载重复              | `skills.ts:116`                                                            | 磁盘无技能时 `loadedSkills` 保持 null 每次重载（有内置兜底）                                                          | <br /> | <br />                             |
| N11 | JobAssistant 防重入          | `JobAssistant.tsx:249-276`                                                 | `onGenerate` 仅靠按钮 loading，无二次守门；`jobDesc` 拼提示词缺边界标记                                                | <br /> | <br />                             |
| N12 | chatOne 丢返回值              | `useAutoChatStore.ts:522-525`                                              | 丢弃 `chatJob` 返回值，风控 stop 后日志/收尾与批量分支不一致                                                            | <br /> | <br />                             |
| N13 | camoufox 响应头泄漏            | `camoufox_server.py:1643`                                                  | `server_version` 泄露版本，无实害                                                                          | <br /> | <br />                             |
| N14 | launcher stop 残留状态        | `launcher.cjs:147-163`                                                     | `stop()` 不清 `state.starting/startingPromise`                                                       | <br /> | <br />                             |
| N15 | 登录启发式误报                   | `cloakPreload.cjs:73-80`                                                   | 以 cookie/头像元素判登录，可能误报                                                                              | <br /> | <br />                             |
| N16 | 泛化 IPC 透传 + sandbox:false | `preload/app.cjs:104-110`、`main.cjs:723`                                   | 暴露裸 `invoke/send/on`（任意 channel）+ 主窗 `sandbox:false`；`safeHandle` 无 `senderFrame` 白名单，建议收窄为白名单 API | <br /> | <br />                             |
| N17 | conversationIdentity 未接线  | 全局（仅定义处）                                                                   | `deriveConversationReservationKey`/`sameRecruiterReservation` 无调用方，应用层 HR+公司 防重投未启用                | <br /> | <br />                             |
| N18 | `jc:fetch-url` 无来源白名单     | `main.cjs:965-984`                                                         | 渲染层可请求任意 http(s) 全文；当下仅本地，未来 load 远端内容即为 SSRF 面                                                    | <br /> | <br />                             |
| N19 | API key 明文存 localStorage  | `useSettingsStore.ts:75-119`                                               | 桌面应用常见；可考虑系统钥匙串                                                                                    | <br /> | <br />                             |
| N20 | main.cjs 单片过大             | `main.cjs`（\~1200 行）                                                       | skills/隐身引擎/webview/打印全挤主进程，建议按域拆分                                                                 | <br /> | <br />                             |
| N21 | 全局异常静默吞错                  | `main.cjs:45-50`                                                           | 需确保不在状态不一致时继续运行                                                                                    | <br /> | <br />                             |
| N22 | 桥接每请求同步读写全库               | `bridge/server.cjs`                                                        | `readFileSync` + 全量 JSON 读写，数据大时阻塞事件循环                                                             | <br /> | <br />                             |
| N23 | 临时产物未清理                   | `desktop-app/scripts-tmp/`、`main.cjs:841`                                  | 大量临时 html/pdf/png；webview 诊断日志无条件写盘                                                                | <br /> | <br />                             |
| N24 | jobMatch 阈值口径             | `jobMatch.ts:211/217`                                                      | 经验硬拦差值≥1年、学历硬拦严格超，口径可统一                                                                            | <br /> | <br />                             |
| N25 | 依赖版本漂移                    | `camoufox/requirements.txt`                                                | `camoufox[geoip]>=0.5` 未锁小版本；`playwright>=1.40,<1.61` 已锁 ✅                                         | <br /> | <br />                             |
| N26 | 启动脚本清理过宽                  | `start-bossclaw.cmd:57`                                                    | 批量清理击杀任意监听 5173–5179 的进程（可能与无关 dev server 冲突）                                                      | <br /> | <br />                             |
| N27 | 启动脚本回显/插值                 | `start-bossclaw.cmd:98`、`echo %*`                                          | PowerShell MessageBox 单引号内字符串插值、未加引号回显，含特殊字符会错乱                                                    | <br /> | <br />                             |
| N28 | resumeMatch 匹配精度          | `resumeMatch.ts:90-99,164-177`                                             | JD 多次 match O(40×                                                                                  | JD     | ) 可接受；`profileBlob` 整体匹配可能引入轻微无关提示 |

***

## 6. ✅ 已核实通过 / 值得肯定

### 安全不变量

- 外部网申 `-6000` + hardBlocks + 引擎 `code 600` 双重防线；招呼语非空多处校验；风险一票否决 + 冷却；首条全自动成功暂停验收；重试锁定 `riskBlocked`。

- **投递锁无 TOCTOU 竞态**：`claimDelivery` 同步原子，两引擎不重复认领同岗位；`batchSchedule.ts` 纯函数无竞态、无重复派发。

- **Camoufox 不变量**：仅监听 `127.0.0.1`；code 35/36 不自动重试、37 仅单次重试；`/chat` 有气泡确认；外部网申与目标冲突检测已实现。

### 与参考实现对齐

- **`priority.ts`** 评分公式与规格逐项一致；**`taskState.ts`** 阶段机与 job-claw-main `TASK_STAGE_META` 完全一致。

### 渲染层健壮

- **`llm.ts`**：超时/取消/JSON 回退/缓存正确，无硬编码 key、无日志泄露。

- **组件**：无 `dangerouslySetInnerHTML`（源码 Modal 用 `<pre>` 转义）；ResizeObserver 正确清理 + `cancelAnimationFrame` 且只走 `force-resize`、不触碰 webview `display`（符合 AGENTS 3.3）；WindowControls/ContextMenu 监听正确解绑；页面无 `electron.on` 泄漏。

- **`searchUrl`** 全走 `URLSearchParams`；**简历解析**对象流有界、递归截断、base64/`<img>` 无注入缺陷。

- **纯函数模块**（helpers/directions/hrActivity/locationFilter/companyFilter/interviewMode/jdCleaner/resumeContact/resumeMatch）无除零/NaN/越界/可变默认参数/比较器不一致。

### CloakBrowser & 构建

- CloakBrowser 通道契约与主进程 `jc:cloak-*`、preload 一一对应，`safeHandle` + try/catch 错误处理一致。

- `main.tsx` 正确挂载 + StrictMode；tsconfig `strict/noUnusedLocals/noUnusedParameters` 全开；依赖划分正确（`playwright-core` 不误下浏览器二进制）。

- **SKILL 提示词**：4 份均强制求职者第一人称、硬性事实红线、统一招呼语口径，frontmatter 分隔符与 `parseSkillFile` 兼容。

- **运维脚本**：`check-fresh.mjs` 新鲜度判断正确；`install-deps.cmd` 依赖版本与主进程自愈逻辑一致且有镜像回落；`start-bossclaw.cmd` 有 preflight/清理/双路径/沙箱检测。

***

## 7. 建议优化顺序（性价比排序）

1. **第一波（P0，正确性/安全必改）**：B1 chatRunning 卡死、B2 page.evaluate JS 注入、B3 静态 token；P01 runNext 互斥、P02 加入任务 token、P03 processedIds 预占、P25 Tasks window\.open。
2. **第二波（P1）**：P05 LLM 主进程代理、P06 JD 注入防护、P07 简历体积上限；隐身引擎 P10–P17；P04 chatOne stop、P18 CloakView、P19 日志虚拟化、P20 监听解绑、P21/P22。
3. **第三波（P2）**：P08 输入去抖/按需统计、P09 采集高频渲染、P23/P24、P26–P29、P14。
4. **第四波（P3）**：P30 asar、N 系列整洁性优化。

***

## 8. 负责人与进度记录

> 勾选状态：☐ 待办 / 🔧 进行中 / ✅ 完成

### 8.1 🔴 blocking

| ID | 条目                  | 级别 | 优先级 | 状态 | 备注                         |
| -- | ------------------- | -- | --- | -- | -------------------------- |
| B1 | chatRunning 卡死      | 🔴 | P0  | ☐  | 修复 runloop 退出复位            |
| B2 | page.evaluate JS 注入 | 🔴 | P0  | ☐  | json.dumps / arg 传参        |
| B3 | 静态 token + 无 Origin | 🔴 | P0  | ☐  | 随机 token + Origin 校验（三桥合并） |

### 8.2 🟡 important

| ID  | 条目                      | 级别 | 优先级 | 状态 | 备注                             |
| --- | ----------------------- | -- | --- | -- | ------------------------------ |
| P01 | runNext 互斥守卫            | 🟡 | P0  | ☐  | 复用 autochat 互斥模式               |
| P02 | 加入任务 token 竞态           | 🟡 | P0  | ☐  | 独立 token + clearTimeout        |
| P03 | processedIds 预占         | 🟡 | P0  | ☐  | 移到判定后                          |
| P25 | Tasks window\.open      | 🟡 | P0  | ☐  | scheme 校验 + shell.openExternal |
| P04 | stop 不取消 in-flight      | 🟡 | P1  | ☐  | 取消信号                           |
| P05 | LLM 主进程代理               | 🟡 | P1  | ☐  | 与 AGENTS 3.1 对齐                |
| P06 | JD 注入防护                 | 🟡 | P1  | ☐  | 复用 untrustedJobSection         |
| P07 | 简历体积上限                  | 🟡 | P1  | ☐  | 输入 + 解压双 cap                   |
| P10 | camoufox 超时/防重复         | 🟡 | P1  | ☐  | 防并发 + 服务端取消                    |
| P11 | 风控码 35/37 分类            | 🟡 | P1  | ☐  | 补分类                            |
| P12 | camoufox 体积上限           | 🟡 | P1  | ☐  | 三处加 cap                        |
| P13 | /send 无气泡确认             | 🟡 | P1  | ☐  | 对齐 /chat                       |
| P15 | 签名校验不可审计                | 🟡 | P1  | ☐  | 封装到可见层                         |
| P16 | 事件伪造                    | 🟡 | P1  | ☐  | 白名单                            |
| P17 | 主世界注入                   | 🟡 | P1  | ☐  | isolatedWorld                  |
| P18 | CloakView stale closure | 🟡 | P1  | ☐  | 改 ref 模式                       |
| P19 | 日志大列表虚拟化                | 🟡 | P1  | ☐  | 虚拟列表/截断                        |
| P20 | webview 监听解绑            | 🟡 | P1  | ☐  | handleRegister 清理              |
| P21 | bridgeParseResume 超时    | 🟡 | P1  | ☐  | AbortController                |
| P22 | clearAllData 补齐         | 🟡 | P1  | ☐  | 补漏键                            |
| P08 | 输入逐键持久化                 | 🟡 | P2  | ☐  | 去抖/按需统计                        |
| P09 | 采集高频渲染                  | 🟡 | P2  | ☐  | rAF 节流 + 抽子组件                  |
| P14 | camoufox 异常/停机          | 🟡 | P2  | ☐  | 通用错误 + 优雅停机                    |
| P23 | statusMeta 补状态          | 🟡 | P2  | ☐  | 补 rejected/pending             |
| P24 | Home 订阅 resumeText      | 🟡 | P2  | ☐  | 补订阅                            |
| P26 | cloak-status starting   | 🟡 | P2  | ☐  | 透传状态                           |
| P27 | 暗色首帧闪烁                  | 🟡 | P2  | ☐  | 内联脚本                           |
| P28 | 主题双监听                   | 🟡 | P2  | ☐  | 复用 effective                   |
| P29 | 前进后退禁用                  | 🟡 | P2  | ☐  | 统一栈                            |
| P30 | asar:false 健壮性          | 🟡 | P3  | ☐  | 建议开启 asar                      |

### 8.3 🟢 nit（按需跟进）

| ID      | 条目     | 级别 | 状态 | 备注       |
| ------- | ------ | -- | -- | -------- |
| N01–N28 | 见第 5 节 | 🟢 | ☐  | 各条目可独立安排 |

***

*审查完成。后续修复建议按第 7 节分波推进，修复后在 8.1/8.2/8.3 表中勾选。*
