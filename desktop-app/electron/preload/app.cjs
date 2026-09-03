// electron/preload/app.cjs —— 主窗口预加载（contextBridge 安全接口）
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
  // 订阅窗口最大化状态变化（maximize/unmaximize 事件），返回取消订阅函数
  onWindowMaximized: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on('jc:window-maximized-changed', listener);
    return () => ipcRenderer.removeListener('jc:window-maximized-changed', listener);
  },

  // 打开外部链接
  openExternal: (url) => ipcRenderer.send('jc:open-external', url),

  // 检查 BOSS 直聘登录态（主进程读 persist:bossclaw 会话 wt2 cookie）
  bossLogin: () => ipcRenderer.invoke('jc:boss-login'),

  // 内置浏览器 webview 预加载脚本绝对路径（由 BrowserView 组件读取后设置到 <webview>）
  // 注意：webview 标签的 preload 属性协议必须是 file:（Electron 文档硬性要求，反斜杠绝对路径会被拒绝加载）
  webviewPreload: pathToFileURL(path.join(__dirname, 'webview.cjs')).href,

  // CORS 无关的 URL 抓取（主进程转发，供获取 BOSS 公开接口如城市编码表）
  fetchUrl: (url) => ipcRenderer.invoke('jc:fetch-url', url),

  // LLM 主进程代理（P05）：渲染层经此转发 OpenAI 兼容请求，规避渲染层 CORS，超时/错误到主进程统一处理
  llmProxy: (url, payload, apiKey, timeoutMs) => ipcRenderer.invoke('jc:llm-proxy', url, payload, apiKey, timeoutMs),

  // 保存定制简历 PDF：渲染进程传 A4 打印 HTML，主进程 printToPDF 后弹出保存对话框写盘
  savePdf: (defaultName, html) => ipcRenderer.invoke('jc:save-pdf', defaultName, html),

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
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('electron', api);
