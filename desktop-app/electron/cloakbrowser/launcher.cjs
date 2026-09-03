// electron/cloakbrowser/launcher.cjs — CloakBrowser 隐身浏览器启动器
// 相比 Electron <webview>，它更贴近真实浏览器指纹（防检测），并原生支持多 Page（多标签）
// 复用 camoufox.py 提供的隐身内核（可选增强），同时保留 webviewTag 路径供回退
//
// 执行计划（对齐 AGENTS.md 第 2 节）：
//  - launchPersistentContext 使用 userDataDir，持久化登录态（wt2 cookie 等）
//  - 每个标签 = 一个 Playwright Page
//  - 通过 page.addInitScript 注入 cloakPreload.cjs,由 console.log / window.__bossclaw_emit 上报给 launcher，转发为 jc:cloak-event
//  - 由 launcher 代理 jc:cloak-page-input，调用 page.keyboard.type / delete / press('Enter')
//
// 安全不变量见 AGENTS.md 2.1：涉及验证码/账户验证（code 35/36/32）时立即停止并交人工，不得自动重试/换号
'use strict';

const path = require('node:path');
const fs = require('node:fs');

let mod = null; // dynamic import cache: { launchPersistentContext, launch, binaryInfo, ensureBinary, ... }

async function loadMod() {
  if (mod) return mod;
  // cloakbrowser 是 ESM 包（type:"module"），CJS 需用动态 import 引入
  mod = await import('cloakbrowser');
  return mod;
}

// ===== 运行时状态 =====
const state = {
  ready: false,
  starting: false,
  startingPromise: null,
  context: null,
  /** tabId -> { page, url, title, listeners } */
  pages: new Map(),
  /** binary info from binaryInfo() */
  binary: null,
  lastError: null,
};

/** 由 main.cjs 注入外部回调 */
let onEvent = null;        // (event) => void，转发页面事件
let onStatus = null;       // (status) => void，汇报启动状态/异常
let resolveProfileDir = null; // (dir) => string，由 main.cjs 决定 userDataDir

function _emit(event) {
  try { onEvent && onEvent(event); } catch (e) { /* ignore */ }
}
function _emitStatusImmediate() {
  try {
    onStatus && onStatus({
      ready: state.ready,
      starting: state.starting,
      binary: state.binary,
      lastError: state.lastError,
    });
  } catch (e) { /* ignore */ }
}

// _emitStatus 做防抖，避免高频触发 UI 重渲染；同时透传最新 state 快照
let _statusFlushTimer = null;
let _statusPendingPayload = null;
function _emitStatusDebounced() {
  _statusPendingPayload = {
    ready: state.ready,
    starting: state.starting,
    binary: state.binary,
    lastError: state.lastError,
  };
  if (_statusFlushTimer) return;
  _statusFlushTimer = setTimeout(() => {
    _statusFlushTimer = null;
    const p = _statusPendingPayload;
    _statusPendingPayload = null;
    try { onStatus && onStatus(p); } catch (e) { /* ignore */ }
  }, 80);
}

/** 供 main.cjs 通过 require 调用 */
function setCallbacks({ onEvent: oe, onStatus: osCb, resolveProfileDir: rpd }) {
  if (oe) onEvent = oe;
  if (osCb) onStatus = osCb;
  if (rpd) resolveProfileDir = rpd;
}

// ===== 检查隐身内核二进制是否就绪 =====
async function checkBinary() {
  try {
    const m = await loadMod();
    state.binary = m.binaryInfo();
    _emitStatusDebounced();
    return state.binary;
  } catch (e) {
    state.binary = { installed: false, error: String(e && e.message || e) };
    _emitStatusDebounced();
    return state.binary;
  }
}

// ===== 启动 / 停止 =====
async function start(opts = {}) {
  if (state.ready) return { ok: true, ready: true };
  if (state.starting) return state.startingPromise;

  const profileDir = resolveProfileDir ? resolveProfileDir() : null;
  if (!profileDir) return { ok: false, error: 'profile dir not configured' };

  state.starting = true;
  state.lastError = null;
  _emitStatusDebounced();

  state.startingPromise = (async () => {
    try {
      const m = await loadMod();
      // 首次启动会自动下载本地隐身 Chromium（约 200MB），缓存于 ~/.cloakbrowser/
      state.binary = m.binaryInfo();
      _emitStatusDebounced();

      // launchPersistentContext 使用 userDataDir，持久化 cookies / localStorage 登录态
      // licenseKey 可选（来自 camoufox.cloakLicenseKey），缺省 key 走 free 档
      const launchOpts = {
        userDataDir: profileDir,
        headless: false, // 有头模式（真实可见窗口，headed）
        humanize: true,  // 混淆行为/时序/交互，模拟 human-like
        timezone: 'Asia/Shanghai',
        locale: 'zh-CN',
        // 代理 / 许可证等可选参数透传
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
        ...(opts.licenseKey ? { licenseKey: opts.licenseKey } : {}),
      };
      const ctx = await m.launchPersistentContext(launchOpts);
      state.context = ctx;
      state.ready = true;
      state.starting = false;
      _emitStatusDebounced();
      return { ok: true, ready: true };
    } catch (e) {
      state.lastError = String(e && e.message || e);
      state.starting = false;
      state.ready = false;
      _emitStatusDebounced();
      return { ok: false, error: state.lastError };
    }
  })();

  return state.startingPromise;
}

async function stop() {
  if (!state.context) return { ok: true };
  try {
    await state.context.close();
  } catch (e) {
    // 资源关闭失败可忽略，交由系统回收
  }
  // 清理全部页面监听
  for (const [tabId, info] of state.pages) {
    try { info.listeners && info.listeners.dispose && info.listeners.dispose(); } catch {}
  }
  state.pages.clear();
  state.context = null;
  state.ready = false;
  _emitStatusDebounced();
  return { ok: true };
}

// ===== Page 管理 =====
// tabId 是渲染层分配的稳定 ID，BrowserView 的 tabId 即 pageId；Playwright Page 由 launcher 内部映射，保证 tabId == pageId 一一对应
async function newPage(tabId, url) {
  if (!state.context) return { ok: false, error: 'engine not started' };
  if (!tabId) return { ok: false, error: 'tabId required' };
  if (state.pages.has(tabId)) {
    const existing = state.pages.get(tabId);
    return { ok: true, tabId, url: existing.url, title: existing.title, reused: true };
  }
  try {
    const page = await state.context.newPage();
    // 通过 preInitScript / cloakPreload.cjs 以 page.addInitScript 方式注入
    const preloadPath = path.join(__dirname, 'cloakPreload.cjs');
    if (fs.existsSync(preloadPath)) {
      // addInitScript 支持 file / function 形式的注入
      const code = fs.readFileSync(preloadPath, 'utf8');
      await page.addInitScript({ content: code });
    }
    const targetUrl = (url && /^https?:\/\//.test(url)) ? url : 'https://www.zhipin.com';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const tab = {
      page,
      url: targetUrl,
      title: '',
      listeners: null,
    };

    // 监听主框架导航，上报 nav 事件
    const onFramenavigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      const newUrl = frame.url();
      tab.url = newUrl;
      const title = page.title().catch(() => '');
      title.then(async (t) => {
        tab.title = t;
        // P29：改用 Page 真实前后栈能力上报 canGoBack/canGoForward，不再硬编码 false（地址栏进退被禁用）
        let canGoBack = false;
        let canGoForward = false;
        try { canGoBack = await page.canGoBack(); canGoForward = await page.canGoForward(); } catch (e) { /* ignore */ }
        _emit({ tabId, channel: 'nav', payload: { url: newUrl, title: t, canGoBack, canGoForward } });
      });
    };
    page.on('framenavigated', onFramenavigated);

    // console 通道：cloakPreload.cjs 通过 console.log('__bossclaw_emit__', JSON.stringify({channel,payload})) 上报事件
    // 由 launcher 捕获解析后转发给上层
    const onConsole = async (msg) => {
      try {
        const text = msg.text();
        const marker = '__bossclaw_emit__';
        const idx = text.indexOf(marker);
        if (idx < 0) return;
        const json = text.slice(idx + marker.length).trim();
        const data = JSON.parse(json);
        if (data && data.channel) {
          _emit({ tabId, channel: data.channel, payload: data.payload || {} });
        }
      } catch (e) { /* ignore parse errors */ }
    };
    page.on('console', onConsole);

    // page close
    page.on('close', () => {
      state.pages.delete(tabId);
      _emit({ tabId, channel: 'closed', payload: {} });
    });

    tab.listeners = {
      dispose() {
        try { page.off('framenavigated', onFramenavigated); } catch {}
        try { page.off('console', onConsole); } catch {}
      },
    };

    state.pages.set(tabId, tab);
    return { ok: true, tabId, url: targetUrl, title: tab.title };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function navigatePage(tabId, url) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function goBackPage(tabId) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function goForwardPage(tabId) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function reloadPage(tabId) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function closePage(tabId) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    if (tab.listeners) tab.listeners.dispose();
    await tab.page.close();
  } catch (e) { /* ignore */ }
  state.pages.delete(tabId);
  return { ok: true };
}

async function sendToPage(tabId, channel, payload) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    // 调用 window.__bossclaw_dispatch(channel, payload)，由 cloakPreload.cjs 消费
    await tab.page.evaluate((args) => {
      try { window.__bossclaw_dispatch && window.__bossclaw_dispatch(args.channel, args.payload); } catch (e) {}
    }, { channel, payload });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 处理 jc:webview-input，改用 Playwright 重放输入以获得 isTrusted:true
async function pageInput(tabId, action, text) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    const page = tab.page;
    switch (action) {
      case 'insertText':
        if (!text) return { ok: false, error: 'empty text' };
        // Playwright page.keyboard.type 走 CDP Input.dispatchKeyEvent，可产出 isTrusted:true
        await page.keyboard.type(text, { delay: 12 });
        return { ok: true, action };
      case 'selectAll':
        await page.keyboard.press('Control+A');
        return { ok: true, action };
      case 'delete':
        await page.keyboard.press('Delete');
        return { ok: true, action };
      case 'pressEnter':
        await page.keyboard.press('Enter');
        return { ok: true, action };
      default:
        return { ok: false, error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function listPages() {
  return Array.from(state.pages.entries()).map(([tabId, t]) => ({ tabId, url: t.url, title: t.title }));
}

function getPageState(tabId) {
  const t = state.pages.get(tabId);
  if (!t) return null;
  return { tabId, url: t.url, title: t.title };
}

module.exports = {
  setCallbacks,
  checkBinary,
  start,
  stop,
  newPage,
  navigatePage,
  goBackPage,
  goForwardPage,
  reloadPage,
  closePage,
  sendToPage,
  pageInput,
  listPages,
  getPageState,
  get ready() { return state.ready; },
  get binary() { return state.binary; },
  get lastError() { return state.lastError; },
  get starting() { return state.starting; }, // P26：透传真实启动态
};
