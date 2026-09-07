# BossClaw 桌面版 IPC / 注入接口参考

> 本文档描述 Electron **进程间通信（IPC）** 与 **页面注入桥** 接口。它们不是 HTTP 接口，
> 无法用 OpenAPI v3 表达，故单独成册；HTTP 接口见同目录 `openapi-bridge.yaml` 与
> `openapi-camoufox.yaml`。所有 IPC 通道名一律 `jc:*`（另有 webview 内部通道）。

代码来源：
- 主进程：`desktop-app/electron/main.cjs`（`safeHandle` = `ipcMain.handle` 包装，异常会 reject；`safeOn` = `ipcMain.on`）
- 主窗口 preload：`desktop-app/electron/preload/app.cjs` → 暴露 `window.electron`
- BOSS 页面 preload：`desktop-app/electron/preload/webview.cjs`（挂到 `persist:bossclaw` 会话，含 webview guest）
- CloakBrowser 页面注入：`desktop-app/electron/cloakbrowser/cloakPreload.cjs`

---

## 1. 总览：三条「接口面」

| 接口面 | 传输 | 对端 | 入口 | 典型调用方 |
|---|---|---|---|---|
| A. 主窗口 IPC | `ipcRenderer.invoke/send/on` | 渲染层 ⇄ 主进程 | `window.electron.*` | React 页面/组件 |
| B. BOSS 页面桥（webview） | `<webview>` host ⇄ guest | 渲染层 ⇄ 页面内 preload | guest 内 `ipcRenderer` + host 的 `webview.send()` | Workbench / 采集与投递逻辑 |
| C. CloakBrowser 页面桥 | launcher `page.evaluate` / console | 渲染层 ⇄ launcher ⇄ Page | `window.__bossclaw_dispatch/listen/emit` | AutoChat / 设置页 |

调用语义约定：
- `invoke`：请求-响应，返回 `Promise`；主进程 handler **抛错时 Promise reject**（统一错误不吞）。
- `send`：单向命令，无回执（fire-and-forget）。
- `on(channel, cb)`：订阅主进程推送事件，返回「取消订阅函数」。
- 业务方法多数返回 `{ ok: boolean, error?: string, ...字段 }`；`ok:false` 属正常业务分支而非异常。

---

## 2. `window.electron.*` 方法目录（preload app.cjs）

### 2.1 版本与应用信息

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `versions` | — | 常量 | `{ electron, chrome, node }` 版本号对象 |
| `getAppInfo()` | `jc:app-info` | invoke | 返回 `{ name: 'BossClaw', version }` |

### 2.2 窗口控制（frame:false 自绘标题栏）

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `winMinimize()` | `jc:window-minimize` | send | 最小化 |
| `winMaximize()` | `jc:window-maximize` | send | 最大化/还原切换 |
| `winClose()` | `jc:window-close` | send | 关闭窗口 |
| `winIsMaximized()` | `jc:window-is-maximized` | invoke | → `boolean` |
| `onWindowMaximized(cb)` | `jc:window-maximized-changed` | on | `cb(maximized: boolean)`；主进程 `maximize/unmaximize` 事件推送 |

另：主进程推送 `jc:window-focus-changed`（`boolean`），由 preload 的通用 `on` 订阅。

### 2.3 平台能力

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `openExternal(url)` | `jc:open-external` | send | 系统浏览器打开 `http(s)` 链接（非 http(s) 忽略） |
| `fetchUrl(url)` | `jc:fetch-url` | invoke | 主进程 Node fetch 抓取 URL（绕渲染层 CORS，15s 超时）→ `{ ok, status, text }` 或 `{ ok:false, error }` |
| `llmProxy(url, payload, apiKey, timeoutMs=90000)` | `jc:llm-proxy` | invoke | OpenAI 兼容补全代理（POST）。超时统一返回 `error:'timeout'`。→ `{ ok, status, text }` |
| `savePdf(defaultName, html)` | `jc:save-pdf` | invoke | 定制简历 PDF：校验文件名（`<120` 字符、`.pdf` 结尾）与 HTML 完整性 → 隐藏窗口 `printToPDF`（A4、无页边距、printBackground）→ 保存对话框写盘。→ `{ ok, filePath }` 或 `{ ok:false, canceled:true }` / `{ ok:false, error }` |
| `clipboardWrite(text)` | `jc:clipboard-write` | invoke | 剪贴板写文本 → `{ ok }`（`file://` 下渲染层 clipboard 不可靠时的替代） |
| `bossLogin()` | `jc:boss-login` | invoke | 读 `persist:bossclaw` 会话 `wt2` cookie → `{ loggedIn: boolean, cookie: boolean }` |

### 2.4 AI Skills 层

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `skillsList()` | `jc:skills-list` | invoke | 内置（`appPath/skills`，只读）+ 自定义（`userData/skills`）技能元数据 → `[{ id, name, description, scope, defaultEnabled, custom }]` |
| `skillsRead(id)` | `jc:skills-read` | invoke | 读技能正文 → `{ id, body }`；非法 id 返回空 body |
| `skillsImport(payload)` | `jc:skills-import` | invoke | `payload = { raw }`（SKILL.md 全文）或 `{ fields: { name, description?, scope, instructions } }`；scope ∈ `profile/job-analysis/greetings/assistant`。→ `{ ok:true, skill }` 或 `{ ok:false, error }` |
| `skillsDelete(id)` | `jc:skills-delete` | invoke | 删除自定义技能；**内置技能拒绝**。→ `{ ok }` / `{ ok:false, error }` |

示例（新建技能）：

```jsonc
// window.electron.skillsImport({ fields: { name: "Java 岗位分析", description: "…",
//   scope: "job-analysis", instructions: "分析 JD 时重点标注 Spring 技术栈要求…" } })
// → { ok: true, skill: { id: "java-job-analysis", name: "Java 岗位分析",
//     description: "…", scope: "job-analysis", defaultEnabled: true, custom: true } }
```

### 2.5 Camoufox 隐身引擎（Python 桥 → HTTP 18767 的中继）

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `camoufoxStatus()` | `jc:camoufox-status` | invoke | 探测 python → 自愈依赖（后台安装）→ 拉桥 → GET `/status`。→ `{ python, pythonCmd, camoufox, running, ready, installing?, message?, engine? }` |
| `camoufoxCall(action, payload)` | `jc:camoufox-call` | invoke | `action ∈ search/send/chat/login/logout/clear`；主进程自愈依赖并拉起桥后转发到对应端点。→ HTTP 桥响应对象（见 `openapi-camoufox.yaml`）。登录请求超时 360s，其余 240s |
| `camoufoxStop()` | `jc:camoufox-stop` | send | 停桥 |
| `camoufoxRestart()` | `jc:camoufox-restart` | invoke | 停→拉→探测，返回与 `camoufoxStatus()` 同构状态（自动沟通误触关闭后自愈） |

### 2.6 CloakBrowser 隐身浏览器（可选增强）

| 方法 | 通道 | 类型 | 说明 |
|---|---|---|---|
| `cloakBinary()` | `jc:cloak-binary` | invoke | 探测二进制 → `{ ok, binary }` |
| `cloakStart(opts)` | `jc:cloak-start` | invoke | 启动（`opts: { proxy?, licenseKey? }`；首次自动下载 ~200MB 内核，持久 profile 于 `userData/cloakbrowser-profile`）→ `{ ok, ready }` / `{ ok:false, error }` |
| `cloakStop()` | `jc:cloak-stop` | invoke | 停止并清页面监听 → `{ ok }` |
| `cloakStatus()` | `jc:cloak-status` | invoke | → `{ ready, starting, binary, lastError }` |
| `cloakPageNew(tabId, url)` | `jc:cloak-page-new` | invoke | 新标签。`tabId` 由渲染层分配并保持与页面一一对应；url 省略时默认 BOSS 首页。→ `{ ok, tabId, url, title, reused? }` |
| `cloakPageClose(tabId)` | `jc:cloak-page-close` | invoke | 关标签 → `{ ok }` |
| `cloakPageNavigate(tabId, url)` / `cloakPageBack` / `cloakPageForward` / `cloakPageReload` | `jc:cloak-page-*` | invoke | 导航/后退/前进/刷新（`domcontentloaded`、30s 超时）→ `{ ok }` / `{ ok:false, error:'tab not found' }` |
| `cloakPageSend(tabId, channel, payload)` | `jc:cloak-page-send` | invoke | 向标签页派发消息 → launcher `page.evaluate(window.__bossclaw_dispatch(channel, payload))` → `{ ok }` |
| `cloakPageInput(tabId, action, text)` | `jc:cloak-page-input` | invoke | 真实键盘输入（Playwright CDP `keyboard.type/press`，`isTrusted:true`）：`action ∈ insertText/selectAll/delete/pressEnter` |
| `cloakPageList()` | `jc:cloak-page-list` | invoke | → `{ ok, pages: [{ tabId, url, title }] }` |
| `onCloakEvent(cb)` | `jc:cloak-event` | on | `cb({ tabId, channel, payload })`；页面事件（nav/登录态/`__bossclaw_emit` 上抛等） |
| `onCloakStatusChanged(cb)` | `jc:cloak-status-changed` | on | `cb(status)`；启动态变化（80ms 防抖） |

### 2.7 通用透传

| 方法 | 说明 |
|---|---|
| `invoke(channel, ...args)` | 任意 `invoke`（供后续/扩展通道） |
| `send(channel, ...args)` | 任意单向命令 |
| `on(channel, cb)` | 任意事件订阅，返回取消函数 |

---

## 3. 主进程 → 渲染层主动推送事件（汇总）

| 通道 | 负载 | 说明 |
|---|---|---|
| `jc:window-maximized-changed` | `boolean` | 最大化/还原 |
| `jc:window-focus-changed` | `boolean` | 窗口聚焦/失焦 |
| `jc:webview-open-link` | `{ url }` | webview 右键「在新标签打开链接」 |
| `jc:webview-source` | `{ url, html, error? }` | 右键「查看网页源码」（主进程抓取 outerHTML 回传） |
| `jc:webview-diag` | `{ type: 'attach'\|'preload-error'\|'preload-check', … }` | webview preload 诊断（BOSSCLAW_DEBUG=1 时同步写 `userData/bossclaw-webview-diag.log`） |
| `jc:cloak-event` | `{ tabId, channel, payload }` | CloakBrowser 页面事件 |
| `jc:cloak-status-changed` | 状态对象 | CloakBrowser 启动状态（防抖 80ms） |

---

## 4. BOSS 页面桥（webview.cjs，挂 `persist:bossclaw`）

webview.cjs 通过 `session.setPreloads` 注入到 BOSS 域下每个页面（含 `<webview>` guest）。
注入标记：`window.__bossclawPreload`（时间戳）与 `window.__bossclawWebviewPreload`（防重复）。

### 4.1 host → guest（渲染层经 `<webview>.send()` / 主进程 `wc.send()`）

| 通道 | 负载 | 说明 |
|---|---|---|
| `boss-api` | `{ seq, action, params }` | 调 BOSS 官方 API。`action ∈ joblist / jobCard / jobDetail / friendAdd`（另见 handleBossApi 支持面） |
| `extract-job` | — | 提取当前详情页岗位（API 优先，DOM 兜底） |
| `start-apply` | `{ ... }` | DOM 兜底投递（API 失败时启用） |
| `open-chat` | — | 工作台「立即沟通」：**只打开聊天窗不发文字**（发文字交 AutoChat） |
| `visual-collect` | `{ ... }` | 可视化采集（对齐 job-claw-main：逐卡片滚动/高亮/点击展开） |
| `collect-control` | `{ action: 'pause'\|'resume'\|'stop'\|'speed', settleMs? }` | 采集运行时控制（调速下限 300ms、上限 5000ms） |
| `webview-command` | `{ action: 'dom-dump' }` | 主进程右键触发的通用命令 |
| `spa-back` / `spa-forward` | — | 由主进程 `wc.send` 下发：走页面 history（SPA 历史栈） |
| `force-resize` | — | 布局变化时触发页面 resize 事件 |
| `jc:webview-input-done` | `{ seq, ok, action, error? }` | 可信输入回执（见下） |

### 4.2 guest → host（webview.cjs `sendToHost` 通知）

| 通道 | 负载 | 说明 |
|---|---|---|
| `preload-ready` | `{ url, ts }` | preload 启动握手 |
| `preload-alive` | — | 存活心跳 |
| `preload-error` | `{ channel?, message }` | preload 内部异常兜底 |
| `nav` | `{ url, title?, … }` | SPA/整页导航变化（MutationObserver + rAF 节流 + 定时兜底） |
| `login-state` | `{ loggedIn }` | BOSS 登录态变化 |
| `job-extracted` | `{ job, … }` | extract-job 结果 |
| `boss-api-result` | `{ seq, ok, code, data, error, riskCodeMessage }` | boss-api 回执（`seq` 用于 promise 化） |
| `apply-stage` | `{ … }` | 投递过程阶段事件 |
| `collect-progress` | `{ … }` | 采集进度 |
| `collect-done` | `{ listUrl, processed, total, error? }` | 采集完成 |
| `dom-dump` | `{ url, html?, error? }` | DOM 快照 |

### 4.3 可信输入（webview → 主进程）

webview preload 捕获用户在 BOSS 聊天框的输入意图后，经 `jc:webview-input` 送主进程执行
`webContents.insertText / selectAll / delete / sendInputEvent(Return)`（Electron 侧等价于 CDP 真实输入），
结果经 `jc:webview-input-done` 回 guest。`payload = { seq, action, text }`，
`action ∈ insertText / selectAll / delete / pressEnter`。

---

## 5. CloakBrowser 页面桥（cloakPreload.cjs）

以 `page.addInitScript` 注入每个 CloakBrowser 页面（不依赖 electron，纯浏览器 API）：

| 全局 | 说明 |
|---|---|
| `window.__bossclaw_dispatch(channel, payload)` | launcher / 渲染层 → 页面消息入口（页面脚本可 `__bossclaw_listen` 消费） |
| `window.__bossclaw_listen(channel, fn)` | 页面内订阅 dispatch 消息 |
| `window.__bossclaw_emit(channel, payload)` | 页面上抛事件：`console.log('__bossclaw_emit__' + JSON.stringify({channel,payload}))`，由 launcher 解析后转发为 `jc:cloak-event` |
| `window.__bossclaw_ping()` | 探测注入存在性 |
| `window.__bossclaw_extractJob` | DOM 提取当前岗位（job-claw-main 口径） |

内置事件通道：`nav`（导航/标题/前后退能力，含 popstate/hashchange 上报）、`closed`（页面关闭）、`extract-job`、登录态判定（页面内监听）。

---

## 6. 一致性要求（修改接口时）

1. 通道名以 `jc:` 开头；主窗口 preload 的暴露名与主进程 handler 一一对应。
2. `invoke` handler 内部**不要**把业务失败当异常抛出——返回 `{ ok:false, error }`；
   只有真正的异常才 `throw`（会 reject 调用方 Promise）。
3. webview/页面桥的命令如需回执，一律携带 `seq`，结果经 `<channel>-result`/`-done` 返回。
4. 修改任意一侧后，同步更新本目录三份接口文档（两 OpenAPI + 本册）。
