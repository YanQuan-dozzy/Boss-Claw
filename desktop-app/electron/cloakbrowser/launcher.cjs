// electron/cloakbrowser/launcher.cjs —— CloakBrowser 隐身浏览器生命周期管理器
// 替代 Electron <webview> 作为内置浏览器；持久上下文模式 + 多 Page。
// 与 camoufox.py 平行运行（用户在设置切换），不取代；webviewTag 已从主进程移除。
//
// 设计要点（plan §2）：
//  - launchPersistentContext 启动一次，userDataDir 持久化登录态（wt2 cookie 等）
//  - 每标签 = 一个 Playwright Page
//  - 事件流：page.addInitScript 注入 cloakPreload.cjs → console.log / window.__bossclaw_emit → launcher 转发 jc:cloak-event
//  - 输入：launcher 收到 jc:cloak-page-input → page.keyboard.type/delete/press('Enter')
//
// 安全不变量（AGENTS.md §2.1）：不绕过验证码/账户验证；code 35/36/32 立即停止交人工。
'use strict';

const path = require('node:path');
const fs = require('node:fs');

let mod = null; // dynamic import cache: { launchPersistentContext, launch, binaryInfo, ensureBinary, ... }

async function loadMod() {
  if (mod) return mod;
  // cloakbrowser 是 ESM（type:"module"）；CJS 动态 import
  mod = await import('cloakbrowser');
  return mod;
}

// ===== 状态 =====
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

/** 通知渲染层（main.cjs 注入此回调） */
let onEvent = null;        // (event) => void — page 事件转发
let onStatus = null;       // (status) => void — 启动/关闭状态变化
let resolveProfileDir = null; // (dir) => string — 由 main.cjs 注入 userDataDir

function _emit(event) {
  try { onEvent && onEvent(event); } catch (e) { /* ignore */ }
}
function _emitStatus() {
  try {
    onStatus && onStatus({
      ready: state.ready,
      starting: state.starting,
      binary: state.binary,
      lastError: state.lastError,
    });
  } catch (e) { /* ignore */ }
}

/** 设置回调（main.cjs 在 require 时调用一次） */
function setCallbacks({ onEvent: oe, onStatus: osCb, resolveProfileDir: rpd }) {
  if (oe) onEvent = oe;
  if (osCb) onStatus = osCb;
  if (rpd) resolveProfileDir = rpd;
}

// ===== 二进制探测（首次启动前调用，不启动浏览器）=====
async function checkBinary() {
  try {
    const m = await loadMod();
    state.binary = m.binaryInfo();
    _emitStatus();
    return state.binary;
  } catch (e) {
    state.binary = { installed: false, error: String(e && e.message || e) };
    _emitStatus();
    return state.binary;
  }
}

// ===== 启动 / 关闭 =====
async function start(opts = {}) {
  if (state.ready) return { ok: true, ready: true };
  if (state.starting) return state.startingPromise;

  const profileDir = resolveProfileDir ? resolveProfileDir() : null;
  if (!profileDir) return { ok: false, error: 'profile dir not configured' };

  state.starting = true;
  state.lastError = null;
  _emitStatus();

  state.startingPromise = (async () => {
    try {
      const m = await loadMod();
      // 准备二进制（首次启动会下载 ~200MB，缓存到 ~/.cloakbrowser/）
      state.binary = m.binaryInfo();
      _emitStatus();

      // launchPersistentContext：持久 userDataDir，cookies/localStorage 跨重启保留
      // licenseKey 可选（来自设置 camoufox.cloakLicenseKey），无 key 走 free tier
      const launchOpts = {
        userDataDir: profileDir,
        headless: false, // 可见窗口（用户视觉确认）；后续可加 headed 切换
        humanize: true,  // 鼠标/键盘/滚动 human-like
        timezone: 'Asia/Shanghai',
        locale: 'zh-CN',
        // 离线/受限场景：允许用户配代理
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
        ...(opts.licenseKey ? { licenseKey: opts.licenseKey } : {}),
      };
      const ctx = await m.launchPersistentContext(launchOpts);
      state.context = ctx;
      state.ready = true;
      state.starting = false;
      _emitStatus();
      return { ok: true, ready: true };
    } catch (e) {
      state.lastError = String(e && e.message || e);
      state.starting = false;
      state.ready = false;
      _emitStatus();
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
    // 关闭异常不致命
  }
  // 关闭所有标签
  for (const [tabId, info] of state.pages) {
    try { info.listeners && info.listeners.dispose && info.listeners.dispose(); } catch {}
  }
  state.pages.clear();
  state.context = null;
  state.ready = false;
  _emitStatus();
  return { ok: true };
}

// ===== Page 操作 =====
// tabId 是渲染层给的稳定 ID（与 BrowserView 的 tabId 对齐）；pageId 是 Playwright Page 在 launcher 内的内部句柄（其实 tabId == pageId，因为一一对应）
async function newPage(tabId, url) {
  if (!state.context) return { ok: false, error: 'engine not started' };
  if (!tabId) return { ok: false, error: 'tabId required' };
  if (state.pages.has(tabId)) {
    const existing = state.pages.get(tabId);
    return { ok: true, tabId, url: existing.url, title: existing.title, reused: true };
  }
  try {
    const page = await state.context.newPage();
    // 注入 preInitScript：cloakPreload.cjs 通过 page.addInitScript 路径
    const preloadPath = path.join(__dirname, 'cloakPreload.cjs');
    if (fs.existsSync(preloadPath)) {
      // addInitScript 支持 file/function；读文件注入
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

    // 事件监听：导航 → nav 事件
    const onFramenavigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      const newUrl = frame.url();
      tab.url = newUrl;
      const title = page.title().catch(() => '');
      title.then((t) => {
        tab.title = t;
        _emit({ tabId, channel: 'nav', payload: { url: newUrl, title: t, canGoBack: false, canGoForward: false } });
      });
    };
    page.on('framenavigated', onFramenavigated);

    // console 桥接：cloakPreload.cjs 通过 console.log('__bossclaw_emit__', JSON.stringify({channel,payload}))
    // 输出 → launcher 解析 → 转发
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
    // 通过 window.__bossclaw_dispatch(channel, payload) 派发；cloakPreload.cjs 注册此函数
    await tab.page.evaluate((args) => {
      try { window.__bossclaw_dispatch && window.__bossclaw_dispatch(args.channel, args.payload); } catch (e) {}
    }, { channel, payload });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 输入：与原 jc:webview-input 等价；走 Playwright 真实键盘事件（isTrusted:true）
async function pageInput(tabId, action, text) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    const page = tab.page;
    switch (action) {
      case 'insertText':
        if (!text) return { ok: false, error: 'empty text' };
        // Playwright page.keyboard.type 底层是 CDP Input.dispatchKeyEvent，isTrusted:true
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
};
