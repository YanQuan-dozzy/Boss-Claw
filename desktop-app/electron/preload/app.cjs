// electron/preload/app.cjs —— 主窗口预加载（contextBridge 安全接口）
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// P4-09 → 审查 H-6：IPC 通道白名单（硬约束）。
// 原实现只 `console.warn` 不拦截 → 渲染层一旦 XSS 就能用通用逃生口 invoke/send/on
// 调用主进程**所有**已注册 handler、并订阅任意通道。现改为白名单：不在表内的通道直接抛错。
// 表 = main.cjs / electron/*.cjs 中出现的全部 `jc:` 通道（含主进程主动 push 的事件通道）。
const ALLOWED_IPC_CHANNELS = new Set([
  'jc:app-info', 'jc:autostart-get', 'jc:autostart-set',
  'jc:backup-delete', 'jc:backup-dir-get', 'jc:backup-dir-pick', 'jc:backup-dir-set', 'jc:backup-read', 'jc:backup-write',
  'jc:boss-login', 'jc:boss-logout', 'jc:bridge-control', 'jc:bridge-token',
  'jc:camoufox-call', 'jc:camoufox-restart', 'jc:camoufox-status', 'jc:camoufox-stop', 'jc:clipboard-write',
  'jc:cloak-binary', 'jc:cloak-event', 'jc:cloak-health', 'jc:cloak-page-back', 'jc:cloak-page-close',
  'jc:cloak-page-forward', 'jc:cloak-page-input', 'jc:cloak-page-list', 'jc:cloak-page-navigate',
  'jc:cloak-page-new', 'jc:cloak-page-reload', 'jc:cloak-page-send', 'jc:cloak-start', 'jc:cloak-status',
  'jc:cloak-status-changed', 'jc:cloak-stop',
  'jc:fetch-url', 'jc:llm-proxy', 'jc:material-pick', 'jc:material-read', 'jc:open-external',
  'jc:qualified-jobs-dir-get', 'jc:qualified-jobs-dir-pick', 'jc:qualified-jobs-dir-set', 'jc:read-doc',
  'jc:save-file', 'jc:save-pdf', 'jc:save-qualified-jobs', 'jc:save-report-pdf', 'jc:show-item',
  'jc:skills-delete', 'jc:skills-import', 'jc:skills-list', 'jc:skills-read',
  'jc:webview-diag', 'jc:webview-input', 'jc:webview-input-done', 'jc:webview-open-link', 'jc:webview-source',
  'jc:window-always-on-top', 'jc:window-always-on-top-changed', 'jc:window-always-on-top-set',
  'jc:window-close', 'jc:window-focus-changed', 'jc:window-is-maximized', 'jc:window-maximize',
  'jc:window-maximized-changed', 'jc:window-minimize',
]);

const assertIpcChannel = (method, channel) => {
  if (typeof channel !== 'string' || !ALLOWED_IPC_CHANNELS.has(channel)) {
    const msg = `[preload/app] 拒绝非白名单 IPC 通道 ${method}('${String(channel)}') —— 通道须在 ALLOWED_IPC_CHANNELS 表内`;
    console.error(msg);
    throw new Error(msg);
  }
  return channel;
};

const api = {
  // 版本信息（状态栏显示）
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // 应用信息（名称、版本号）— 标题栏使用
  getAppInfo: () => ipcRenderer.invoke('jc:app-info'),

  // 窗口控制（frame:false 自绘标题栏按钮）
  winMinimize: () => ipcRenderer.send('jc:window-minimize'),
  winMaximize: () => ipcRenderer.send('jc:window-maximize'),
  winClose: () => ipcRenderer.send('jc:window-close'),
  winIsMaximized: () => ipcRenderer.invoke('jc:window-is-maximized'),
  // 窗口置顶（标题栏图钉按钮）：查询状态 / 设置 / 订阅变化
  winAlwaysOnTop: () => ipcRenderer.invoke('jc:window-always-on-top'),
  winAlwaysOnTopSet: (value) => ipcRenderer.send('jc:window-always-on-top-set', Boolean(value)),
  // 订阅窗口最大化状态变化（maximize/unmaximize 事件），返回取消订阅函数
  onWindowMaximized: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on('jc:window-maximized-changed', listener);
    return () => ipcRenderer.removeListener('jc:window-maximized-changed', listener);
  },
  // 订阅窗口置顶状态变化，返回取消订阅函数
  onWindowAlwaysOnTopChanged: (callback) => {
    const listener = (_event, isOnTop) => callback(Boolean(isOnTop));
    ipcRenderer.on('jc:window-always-on-top-changed', listener);
    return () => ipcRenderer.removeListener('jc:window-always-on-top-changed', listener);
  },

  // 打开外部链接
  openExternal: (url) => ipcRenderer.send('jc:open-external', url),

  // 读取「使用前必读」文档（首页「阅读使用文档」入口；文档源 = 应用 resources/docs/，打包版由 extraResources 拷入）
  readDoc: () => ipcRenderer.invoke('jc:read-doc'),

  // 检查 BOSS 直聘登录态（主进程读 persist:bossclaw 会话 wt2 cookie）
  bossLogin: () => ipcRenderer.invoke('jc:boss-login'),
  // 清除指定平台在 persist:bossclaw 会话中的登录 cookie（设置页「退出登录」用）
  bossLogout: (platform) => ipcRenderer.invoke('jc:boss-logout', platform),

  // 本地桥（OpenClaw）访问令牌：随机生成、存于 ~/.bossclaw/bridge-token（C-2，不再随 bundle 分发）
  bridgeToken: () => ipcRenderer.invoke('jc:bridge-token'),

  // 内置浏览器 webview 预加载脚本绝对路径（由 BrowserView 组件读取后设置到 <webview>）
  // 注意：webview 标签的 preload 属性协议必须是 file:（Electron 文档硬性要求，反斜杠绝对路径会被拒绝加载）
  webviewPreload: pathToFileURL(path.join(__dirname, 'webview.cjs')).href,

  // CORS 无关的 URL 抓取（主进程转发，供获取 BOSS 公开接口如城市编码表）
  fetchUrl: (url) => ipcRenderer.invoke('jc:fetch-url', url),

  // LLM 主进程代理（P05）：渲染层经此转发 OpenAI 兼容请求，规避渲染层 CORS，超时/错误到主进程统一处理
  llmProxy: (url, payload, apiKey, timeoutMs) => ipcRenderer.invoke('jc:llm-proxy', url, payload, apiKey, timeoutMs),

  // ===== 开机自启动（Windows 登录项）=====
  autostartGet: () => ipcRenderer.invoke('jc:autostart-get'),
  autostartSet: (enabled) => ipcRenderer.invoke('jc:autostart-set', enabled),

  // ===== 本地数据备份目录（localStorage 主存储 + 周期脏检查写盘）=====
  backupDir: () => ipcRenderer.invoke('jc:backup-dir-get'),
  backupDirSet: (dir) => ipcRenderer.invoke('jc:backup-dir-set', dir),
  backupDirPick: () => ipcRenderer.invoke('jc:backup-dir-pick'),
  backupWrite: (bundle) => ipcRenderer.invoke('jc:backup-write', bundle),
  backupRead: () => ipcRenderer.invoke('jc:backup-read'),
  backupDelete: () => ipcRenderer.invoke('jc:backup-delete'),

  // 保存定制简历 PDF：渲染进程传 A4 打印 HTML，主进程 printToPDF 后弹出保存对话框写盘
  savePdf: (defaultName, html) => ipcRenderer.invoke('jc:save-pdf', defaultName, html),
  savePdfBatch: (items, requestId) => ipcRenderer.invoke('jc:save-pdf-batch', items, requestId),
  cancelPdfBatch: (requestId) => ipcRenderer.invoke('jc:save-pdf-batch-cancel', requestId),
  onPdfBatchProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('jc:save-pdf-batch-progress', handler);
    return () => ipcRenderer.removeListener('jc:save-pdf-batch-progress', handler);
  },
  // 通用文本导出（CSV）：主进程弹系统保存对话框由用户选位置后写盘（extWhitelist 默认 ['csv']）
  saveFile: (defaultName, content, extWhitelist) =>
    ipcRenderer.invoke('jc:save-file', defaultName, content, extWhitelist),
  // 统计数据报表 PDF：A4 横版 printToPDF + 系统保存对话框（与简历通道独立，标题不复用）
  saveReportPdf: (defaultName, html) => ipcRenderer.invoke('jc:save-report-pdf', defaultName, html),
  // 在系统文件管理器中定位到指定文件（导出后的「打开所在文件夹」）
  showItem: (filePath) => ipcRenderer.invoke('jc:show-item', filePath),
  // 保存「达标岗位」数据到本地：系统保存对话框（dir 为空）或导出目录（dir 为绝对路径，自动按天写文件）→ JSON 写盘
  saveQualifiedJobs: (defaultName, jsonText, dir) => ipcRenderer.invoke('jc:save-qualified-jobs', defaultName, jsonText, dir),
  // 达标岗位导出目录：读取 / 设置 / 系统目录选择对话框（选择即应用并持久化）
  qualifiedJobsDirGet: () => ipcRenderer.invoke('jc:qualified-jobs-dir-get'),
  qualifiedJobsDirSet: (dir) => ipcRenderer.invoke('jc:qualified-jobs-dir-set', dir),
  qualifiedJobsDirPick: () => ipcRenderer.invoke('jc:qualified-jobs-dir-pick'),

  // ===== 经历补充材料（只记文件路径；正文每次调用 AI 前现读，不缓存不持久化）=====
  // 系统文件选择对话框（多选）→ 返回 [{ path, name }]
  materialPick: () => ipcRenderer.invoke('jc:material-pick'),
  // 按绝对路径现读文件 → { ok, name, dataUrl, bytes }
  // 防护由主进程统一实施（扩展名白名单 + 敏感文件名/目录黑名单 + 20MB 上限）——
  // 刻意**不**在渲染层做「仅允许本次选过的路径」限制：历史素材只存在渲染层 localStorage，
  // 那样做会让升级后所有历史素材都需重新选择（UX 回归），且防护面并未真正收紧。
  materialRead: (filePath) => ipcRenderer.invoke('jc:material-read', filePath),

  // ===== AI Skills 层（skills/<id>/SKILL.md，调用 AI 时按作用域启用）=====
  // 技能元数据列表（id/name/description/scope/defaultEnabled/source/custom）
  skillsList: () => ipcRenderer.invoke('jc:skills-list'),
  // 读取指定技能 SKILL.md 的指令正文（body）
  skillsRead: (id) => ipcRenderer.invoke('jc:skills-read', id),
  // 导入 / 新建自定义技能：payload = { raw?: string }（SKILL.md 全文）或 { fields: {name, description?, scope, instructions, source?} }
  skillsImport: (payload) => ipcRenderer.invoke('jc:skills-import', payload),
  // 删除自定义技能（内置技能会拒绝）
  skillsDelete: (id) => ipcRenderer.invoke('jc:skills-delete', id),

  // ===== Camoufox 隐身引擎（可选，Python 桥）=====
  // 状态检测（探测 python + camoufox 包 + 桥运行态）；ready=true 表示可搜索/发送
  camoufoxStatus: () => ipcRenderer.invoke('jc:camoufox-status'),
  // 调用 Camoufox 桥：action ∈ search/send/login/logout/clear，payload 透传
  camoufoxCall: (action, payload) => ipcRenderer.invoke('jc:camoufox-call', action, payload),
  // 停止 Camoufox 桥（设置页用）
  camoufoxStop: () => ipcRenderer.send('jc:camoufox-stop'),
  // 重启 Camoufox 桥（自动沟通误触关闭后自愈用），返回最终状态
  camoufoxRestart: () => ipcRenderer.invoke('jc:camoufox-restart'),

  // ===== CloakBrowser 隐身浏览器（可选增强，Node + Playwright）=====
  // 探测二进制状态（不启动浏览器；首次启动会在 launcher.start 内部自动下载 ~200MB）
  cloakBinary: () => ipcRenderer.invoke('jc:cloak-binary'),
  // 启动 / 停止隐身浏览器；start 后才有 page 可用
  cloakStart: (opts) => ipcRenderer.invoke('jc:cloak-start', opts),
  cloakStop: () => ipcRenderer.invoke('jc:cloak-stop'),
  // 状态（ready / binary / lastError）
  cloakStatus: () => ipcRenderer.invoke('jc:cloak-status'),
  // 健康检查：探测 Playwright context 进程是否真的活着（防止 ready=true 但进程已死）。
  // alive=true：直接复用；alive=false：UI 走自动重启路径。
  cloakHealth: () => ipcRenderer.invoke('jc:cloak-health'),
  // 打开新标签（返回 tabId，浏览器内多 Page）
  cloakPageNew: (tabId, url) => ipcRenderer.invoke('jc:cloak-page-new', tabId, url),
  // 关闭标签
  cloakPageClose: (tabId) => ipcRenderer.invoke('jc:cloak-page-close', tabId),
  // 在指定标签内导航 / 后退 / 前进 / 刷新
  cloakPageNavigate: (tabId, url) => ipcRenderer.invoke('jc:cloak-page-navigate', tabId, url),
  cloakPageBack: (tabId) => ipcRenderer.invoke('jc:cloak-page-back', tabId),
  cloakPageForward: (tabId) => ipcRenderer.invoke('jc:cloak-page-forward', tabId),
  cloakPageReload: (tabId) => ipcRenderer.invoke('jc:cloak-page-reload', tabId),
  // 向指定标签页发送通道消息（等价于 webview.send；cloakPreload.cjs 通过 __bossclaw_dispatch 派发）
  cloakPageSend: (tabId, channel, payload) => ipcRenderer.invoke('jc:cloak-page-send', tabId, channel, payload),
  // 真实键盘输入（替换 jc:webview-input；走 Playwright CDP Input，天然 isTrusted:true）
  cloakPageInput: (tabId, action, text) => ipcRenderer.invoke('jc:cloak-page-input', tabId, action, text),
  // 列出所有打开的标签
  cloakPageList: () => ipcRenderer.invoke('jc:cloak-page-list'),
  // 订阅 Page 事件回传（{tabId, channel, payload}）
  onCloakEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('jc:cloak-event', listener);
    return () => ipcRenderer.removeListener('jc:cloak-event', listener);
  },
  // 订阅启动/状态变化
  onCloakStatusChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('jc:cloak-status-changed', listener);
    return () => ipcRenderer.removeListener('jc:cloak-status-changed', listener);
  },

  // 通用 IPC 调用（桥接 / LLM 代理等后续阶段使用）
  // @deprecated 仅桥接层遗留使用（P4-09），新代码请用具名方法（上方各具名通道均以 jc: 前缀规范命名）
  invoke: (channel, ...args) => {
    assertIpcChannel('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    assertIpcChannel('send', channel);
    return ipcRenderer.send(channel, ...args);
  },
  on: (channel, callback) => {
    assertIpcChannel('on', channel);
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('electron', api);
