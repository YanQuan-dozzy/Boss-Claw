// electron/cloakbrowser/launcher.cjs ???CloakBrowser ????????????
// ?? Electron <webview> ????????????????+ ??Page??
// ??camoufox.py ??????????????????webviewTag ?????????
//
// ?????plan �2??
//  - launchPersistentContext ?????userDataDir ???????wt2 cookie ??
//  - ????= ???Playwright Page
//  - ????page.addInitScript ?? cloakPreload.cjs ??console.log / window.__bossclaw_emit ??launcher ?? jc:cloak-event
//  - ???launcher ?? jc:cloak-page-input ??page.keyboard.type/delete/press('Enter')
//
// ??????AGENTS.md �2.1????????/?????code 35/36/32 ?????????
'use strict';

const path = require('node:path');
const fs = require('node:fs');

let mod = null; // dynamic import cache: { launchPersistentContext, launch, binaryInfo, ensureBinary, ... }

async function loadMod() {
  if (mod) return mod;
  // cloakbrowser ??ESM?type:"module"??CJS ???import
  mod = await import('cloakbrowser');
  return mod;
}

// ===== ???=====
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

/** ??????main.cjs ?????? */
let onEvent = null;        // (event) => void ??page ????
let onStatus = null;       // (status) => void ????/???????
let resolveProfileDir = null; // (dir) => string ????main.cjs ?? userDataDir

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

// _emitStatus ?? tick ????????????? UI ?? + ??????? state ???
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

/** ?????main.cjs ??require ?????? */
function setCallbacks({ onEvent: oe, onStatus: osCb, resolveProfileDir: rpd }) {
  if (oe) onEvent = oe;
  if (osCb) onStatus = osCb;
  if (rpd) resolveProfileDir = rpd;
}

// ===== ??????????????????????====
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

// ===== ?? / ?? =====
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
      // ??????????????~200MB???? ~/.cloakbrowser/??
      state.binary = m.binaryInfo();
      _emitStatusDebounced();

      // launchPersistentContext????userDataDir?cookies/localStorage ??????
      // licenseKey ??????? camoufox.cloakLicenseKey????key ??free tier
      const launchOpts = {
        userDataDir: profileDir,
        headless: false, // ??????????????????headed ??
        humanize: true,  // ??/??/?? human-like
        timezone: 'Asia/Shanghai',
        locale: 'zh-CN',
        // ??/????????????
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
    // ????????
  }
  // ???????
  for (const [tabId, info] of state.pages) {
    try { info.listeners && info.listeners.dispose && info.listeners.dispose(); } catch {}
  }
  state.pages.clear();
  state.context = null;
  state.ready = false;
  _emitStatusDebounced();
  return { ok: true };
}

// ===== Page ?? =====
// tabId ???????? ID?? BrowserView ??tabId ????pageId ??Playwright Page ??launcher ??????????tabId == pageId?????????
async function newPage(tabId, url) {
  if (!state.context) return { ok: false, error: 'engine not started' };
  if (!tabId) return { ok: false, error: 'tabId required' };
  if (state.pages.has(tabId)) {
    const existing = state.pages.get(tabId);
    return { ok: true, tabId, url: existing.url, title: existing.title, reused: true };
  }
  try {
    const page = await state.context.newPage();
    // ?? preInitScript?cloakPreload.cjs ?? page.addInitScript ??
    const preloadPath = path.join(__dirname, 'cloakPreload.cjs');
    if (fs.existsSync(preloadPath)) {
      // addInitScript ?? file/function??????
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

    // ??????????nav ??
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

    // console ???cloakPreload.cjs ?? console.log('__bossclaw_emit__', JSON.stringify({channel,payload}))
    // ?? ??launcher ?? ????
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
    // ?? window.__bossclaw_dispatch(channel, payload) ???cloakPreload.cjs ??????
    await tab.page.evaluate((args) => {
      try { window.__bossclaw_dispatch && window.__bossclaw_dispatch(args.channel, args.payload); } catch (e) {}
    }, { channel, payload });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ??????jc:webview-input ???? Playwright ???????isTrusted:true??
async function pageInput(tabId, action, text) {
  const tab = state.pages.get(tabId);
  if (!tab) return { ok: false, error: 'tab not found' };
  try {
    const page = tab.page;
    switch (action) {
      case 'insertText':
        if (!text) return { ok: false, error: 'empty text' };
        // Playwright page.keyboard.type ????CDP Input.dispatchKeyEvent?isTrusted:true
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
