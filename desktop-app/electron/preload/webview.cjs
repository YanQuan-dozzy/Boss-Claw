// electron/preload/webview.cjs —— BossClaw 内置浏览器 webview 预加载（重写版）
//
// 重写目标（对齐 F:\boss-auto-job-main 的官方接口链路，替代脆弱的 DOM 自动化）：
//   1. BOSS 官方 API 通道（boss-api）：在 zhipin.com 页面上下文执行 fetch，
//      自动携带登录 cookie + 页面 JS 生成的反爬 token，稳定拿到岗位列表 / 卡片 / 投递结果。
//      - 采集  : GET  /wapi/zpgeek/search/joblist.json?scene=1&query=..&city=..&page=..&pageSize=30
//      - 详情  : GET  /wapi/zpgeek/job/card.json?encryptJobId=..   （含 encryptUserId）
//      - 投递  : POST /wapi/zpgeek/friend/add.json { encryptJobId, encryptBossId, greeting }
//   2. 页面信息回传（nav / login-state）供地址栏、标签页、登录态显示。
//   3. 真实输入通道（jc:webview-input）——BOSS 受控 contenteditable 只认真实输入（isTrusted:true）。
//   4. DOM 兜底投递（start-apply 简化版）——仅当 API 返回未知码 / 网络异常时使用。
//
// 安全不变量（AGENTS.md 2.1）：未确认文字气泡不计成功；招呼语非空；验证码/风控立即停止交人工；
// 不绕过平台安全措施。code 36/32/35/37/38 统一映射风控码，由上层（Workbench + safety.ts）处理。
'use strict';

const { ipcRenderer } = require('electron');
// ===== 防重复注入保护（session.setPreloads 与元素 preload 属性双路径可能重复注入同一脚本）=====
(function () {
  if (typeof window !== 'undefined' && window.__bossclawWebviewPreload) return;
  try { window.__bossclawWebviewPreload = Date.now(); } catch {}

// ===== preload 注入 console 铁证（穿透 sandbox：console 会到达 guest console-message → main 诊断文件）=====
try { console.log('BOSS-CLAW-PRELOAD-INJECTED url=' + location.href); } catch {}

// ===== 基础工具 =====
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(channel, data) {
  try { ipcRenderer.sendToHost(channel, data); } catch {}
}

// ===== preload 健康探针：脚本一旦注入即回传（诊断「preload 未加载/崩溃」）=====
// 若日志区出现 [DOM-DUMP]{"type":"preload-alive"...} 说明 preload 注入成功、IPC 监听器已注册；
// 若完全没有，则 preload 未注入或注入前崩溃（配合 webview 的 preload-error 事件定位）。
try { notify('preload-alive', { url: location.href, time: Date.now() }); } catch {}

// ===== preload 注入标记（供主进程 dom-ready 后 executeJavaScript 检查，写入 diag 文件）=====
// sandboxed preload 与页面共享 window，此标记在页面上下文可见；无此标记 = preload 未注入
try { window.__bossclawPreload = Date.now(); } catch {}

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
}

function textOf(el) { return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim(); }
const all = (sel, root = document) => {
  try { return Array.from((root && root.querySelectorAll) ? root.querySelectorAll(sel) : document.querySelectorAll(sel)); }
  catch { return []; }
};
const $ = (sel, root = document) => { try { return (root && root.querySelector) ? root.querySelector(sel) : document.querySelector(sel); } catch { return null; } };

async function waitFor(check, timeout = 12000, label = '页面条件') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const v = await check(); if (v) return v; } catch {}
    await sleep(200);
  }
  return null;
}

function jitterDelay(baseMs) {
  return sleep(Math.round(baseMs * (0.8 + Math.random() * 0.4)));
}

// ===== 页面信息回传 =====
// SPA 历史栈：BOSS 直聘内部分页/岗位跳转走 history.pushState/replaceState，
// Electron <webview> 原生 goBack/goForward 只认「整页导航」，pushState 不计入，
// 导致内置浏览器前进/后退在 SPA 内失效。这里在页面上下文自维护 URL 栈 + 索引，
// 用 History API（history.back/forward，同时兼容 SPA 与整页导航）实现前进后退。
const spaHistory = [];
let spaIndex = -1;

function spaRecord() {
  try {
    const url = location.href;
    const existing = spaHistory.indexOf(url);
    if (existing >= 0) {
      spaIndex = existing;
    } else if (spaIndex < 0 && spaHistory.length === 0) {
      spaHistory.push(url);
      spaIndex = 0;
    } else {
      spaHistory.splice(spaIndex + 1); // 丢弃“前进历史”
      spaHistory.push(url);
      spaIndex = spaHistory.length - 1;
    }
  } catch {}
}

// 覆盖 pushState / replaceState，捕获 SPA 内部跳转
try {
  const _push = history.pushState.bind(history);
  history.pushState = function (...args) { _push(...args); spaRecord(); };
  const _replace = history.replaceState.bind(history);
  history.replaceState = function (...args) { _replace(...args); spaRecord(); };
} catch {}
window.addEventListener('popstate', () => spaRecord());
window.addEventListener('hashchange', () => spaRecord());

// 前进/后退命令：由渲染层经 webview.send 触发，页面内调用 History API
ipcRenderer.on('spa-back', () => { try { spaRecord(); history.back(); } catch {} });
ipcRenderer.on('spa-forward', () => { try { spaRecord(); history.forward(); } catch {} });
ipcRenderer.on('force-resize', () => { try { window.dispatchEvent(new Event('resize')); } catch {} });

function reportNav() {
  try {
    notify('nav', {
      url: location.href,
      title: document.title,
      canGoBack: spaIndex > 0,
      canGoForward: spaIndex >= 0 && spaIndex < spaHistory.length - 1,
    });
  } catch {}
}

// BOSS 登录态 DOM 检测（权威判断在 main.cjs jc:boss-login 读 wt2 cookie；此处做页面级实时回传）
function detectLogin() {
  try {
    const url = String(location.href || '');
    if (/\/web\/user\/|passport|security-check/i.test(url)) return { loggedIn: false, evidence: 'login-page' };
    const loggedSelectors = ['.avatar-content', '.user-name', '.nav-user', '[class*="avatar"]', 'a[ka*="geek-home"]', '.geek-nav .nav-user'];
    for (const sel of loggedSelectors) {
      const el = $(sel);
      if (el && textOf(el)) return { loggedIn: true, evidence: sel };
    }
    const header = $('header, .header, #header, .nav, .top-nav');
    const headerText = (header && header.textContent) || '';
    if (/登录\s*\/\s*注册|扫码登录|立即登录/.test(headerText)) return { loggedIn: false, evidence: 'header-login' };
    return { loggedIn: false, evidence: 'unknown', url };
  } catch (e) {
    return { loggedIn: false, error: String(e?.message || e) };
  }
}
function reportLogin() { notify('login-state', detectLogin()); }

// ===== 风控码 =====
function riskCodeMessage(code) {
  switch (Number(code)) {
    case 17: return '登录已失效，请重新登录';
    case 31: return '登录已失效，请重新登录';
    case 32: return '账户已被限制/封禁';
    case 35: return '需要安全验证（滑块/点选）';
    case 36: return '账户异常，需人工验证';
    case 37: return '检测到环境异常';
    case 38: return '检测到环境异常（未登录）';
    case 1006: return '请求过于频繁，已被限速';
    default: return '平台风控拦截';
  }
}

// ===== BOSS 官方 API =====
// 在 zhipin.com 页面上下文执行 fetch：登录 cookie 由 Electron persist:bossclaw 会话自动携带，
// 反爬 token（zp_stoken）由页面 JS 在导航时生成并随请求自动带上，无需手动提取。
async function zpFetch(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(path, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function handleBossApi(action, params = {}) {
  switch (action) {
    case 'joblist': {
      const query = String(params.query || '').trim();
      const city = String(params.city || '100010000');
      const page = Math.max(1, Number(params.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 30));
      const url = `/wapi/zpgeek/search/joblist.json?scene=1&query=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}&page=${page}&pageSize=${pageSize}`;
      return await zpFetch(url);
    }
    case 'jobCard': {
      const jid = String(params.encryptJobId || '').trim();
      if (!jid) return { error: 'missing encryptJobId' };
      return await zpFetch(`/wapi/zpgeek/job/card.json?encryptJobId=${encodeURIComponent(jid)}`);
    }
    case 'jobDetail': {
      const jid = String(params.encryptJobId || '').trim();
      if (!jid) return { error: 'missing encryptJobId' };
      return await zpFetch(`/wapi/zpgeek/job/detail.json?encryptJobId=${encodeURIComponent(jid)}`);
    }
    case 'friendAdd': {
      const encryptJobId = String(params.encryptJobId || '').trim();
      const encryptBossId = String(params.encryptBossId || '').trim();
      const greeting = String(params.greeting || '').trim();
      if (!encryptJobId) return { error: 'missing encryptJobId' };
      if (!greeting) return { error: 'missing greeting' };
      const body = { encryptJobId, greeting };
      if (encryptBossId) body.encryptBossId = encryptBossId;
      return await zpFetch('/wapi/zpgeek/friend/add.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    default:
      return { error: 'unknown action: ' + action };
  }
}

// ===== 岗位提取：URL 提取 jobId → card.json API（优先）→ DOM 兜底 =====
function extractEncryptJobIdFromUrl(url) {
  const m = String(url || location.href || '').match(/job_detail\/([^/?#.]+)/i);
  if (m) return m[1].replace(/\.html$/i, '');
  return '';
}

// DOM 兜底：从详情页 banner 提取岗位基本信息（API 失败时用）
function extractJobFromDom() {
  const banner = $('.job-banner, .job-detail-header, .job-header');
  const scopeText = ((banner && banner.textContent) || document.body.innerText || '').slice(0, 2000);
  const pick = (sels) => { for (const s of sels) { const t = textOf($(s)); if (t) return t; } return ''; };
  const title = pick(['.job-banner .name', 'h1.job-name', '.job-title', '.name']) || document.title;
  const company = pick(['.job-banner .company', '.company-name', '.business-name']);
  const salary = pick(['.job-banner .salary', '.salary', '[class*="salary"]']);
  const location = pick(['.job-banner .location', '.job-area', '[class*="location"]']);
  const description = ((banner && banner.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return { url: location.href, title, company, salary, location, description };
}

// 列表页判定：URL 是推荐/搜索列表页，或页面上存在 >1 张岗位卡片（供上层「加入任务」守卫用）
function listPageInfo() {
  const cardCount = (() => { try { return collectCards().length; } catch { return 0; } })();
  const isListUrl = /\/web\/geek\/(job|jobs|recommend)\/?/i.test(String(location.pathname || ''));
  return { isListPage: isListUrl && !/job_detail/i.test(location.href), listCardCount: cardCount };
}

async function extractJob() {
  const jid = extractEncryptJobIdFromUrl();
  // 优先走 API：岗位详情完整且稳定（含 encryptUserId 供投递用）
  if (jid) {
    const card = await zpFetch(`/wapi/zpgeek/job/card.json?encryptJobId=${encodeURIComponent(jid)}`);
    if (card && card.code === 0 && card.zpData) {
      const d = card.zpData;
      notify('job-extracted', {
        url: location.href,
        title: d.jobName || d.jobTitle || document.title,
        company: d.brandName || d.companyName || '',
        salary: d.salaryDesc || '',
        location: d.cityName || d.areaDistrict || '',
        description: d.jobDesc || d.postDescription || '',
        jobId: jid,
        encryptUserId: d.encryptUserId || '',
        bossName: d.bossName || d.recruiterName || '',
        bossTitle: d.bossTitle || '',
        skills: Array.isArray(d.skills) ? d.skills : [],
        labels: Array.isArray(d.jobLabels) ? d.jobLabels : [],
        scaleName: d.scaleName || '',
        typeName: d.typeName || '',
        ...listPageInfo(),
      });
      return;
    }
    // code 37（环境异常）等风控码回传，让上层感知
    if (card && card.code && card.code !== 0) {
      notify('job-extracted', { url: location.href, title: document.title, error: `job/card 接口 code=${card.code}`, riskCode: card.code, ...listPageInfo() });
      return;
    }
  }
  // DOM 兜底
  try {
    notify('job-extracted', { ...extractJobFromDom(), ...listPageInfo() });
  } catch (e) {
    notify('job-extracted', { url: location.href, title: document.title, error: String(e?.message || e), ...listPageInfo() });
  }
}

// ===== 可信输入通道（Electron 版 CDP 真实输入）=====
// BOSS 聊天框是 React/Slate/Lexical 受控 contenteditable，只认真实输入（isTrusted:true），
// dispatchEvent 合成事件会被丢弃。等价实现：main.cjs 的 webContents.insertText/selectAll/delete/sendInputEvent。
function trustedInput(action, text) {
  return new Promise((resolve) => {
    const seq = Date.now() + '_' + Math.floor(Math.random() * 1e6);
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result || {}); } };
    // 关键：按 seq 匹配回执——并发调用时避免收到别的请求的回执而串包
    const onDone = (_e, data) => { if (String(data?.seq || '') === seq) { ipcRenderer.removeListener('jc:webview-input-done', onDone); done(data); } };
    try { ipcRenderer.on('jc:webview-input-done', onDone); } catch { done({ ok: false, error: 'listener failed' }); }
    try { ipcRenderer.send('jc:webview-input', { seq, action, text }); } catch { ipcRenderer.removeListener('jc:webview-input-done', onDone); done({ ok: false, error: 'send failed' }); }
    setTimeout(() => { ipcRenderer.removeListener('jc:webview-input-done', onDone); done({ ok: false, error: 'timeout' }); }, 4000);
  });
}

// ===== DOM 兜底投递（简化版：API 失败 / 未知码时使用）=====
// 仅做「找沟通入口 → 进入沟通 → 找输入框 → 真实输入 → 发送 → 气泡确认」，
// 去除旧版复杂的会话绑定 / 断点续跑 / 评分排序，降低脆性。
const BOSS_SELECTORS = {
  // 对齐 job-claw-main communicateButton 的选择器集 + AI-BossJob-plus 的 a.op-btn-chat
  chatButton: 'a.op-btn-chat, .start-chat-btn, .btn-startchat, .btn-start-chat, .btn-chat, .op-btn.chat, .job-detail-op-btn, [class*="start-chat"], [class*="startChat"], [ka*="job-detail-chat"], a[href*="/web/geek/chat"], a[href*="/chat/"]',
};

function chatInput() {
  // 优先 contenteditable（BOSS 新版聊天输入框，AI-BossJob-plus 的 #chat-input 即 contenteditable），其次 textarea / input
  const candidates = [
    ...all('#chat-input'),
    ...all('[contenteditable="true"]'),
    ...all('[contenteditable="plaintext-only"]'),
    ...all('textarea'),
    ...all('input[type="text"]'),
  ];
  for (const el of candidates) {
    if (visible(el) && !el.disabled) {
      // 排除明显不是聊天输入框的（如搜索框：placeholder 含"搜索"）
      const ph = String(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '');
      if (/搜索|search/i.test(ph)) continue;
      // contenteditable 或 textarea 视为聊天输入区；input 需 placeholder 含"回复/消息/输入"等
      if (el.matches('textarea') || el.matches('[contenteditable]')) return el;
      if (/回复|消息|输入|打招呼|沟通/i.test(ph)) return el;
    }
  }
  return null;
}

// 沟通按钮文本匹配（对齐 job-claw-main：立即沟通/继续沟通/打招呼/去沟通/开始沟通）
const CHAT_LABEL_PATTERN = /立即\s*沟通|继续\s*沟通|立\s*刻\s*沟通|打个\s*招呼|打\s*招呼|聊\s*一\s*聊|去\s*沟通|开始\s*沟通/;
// 外部网申按钮文本（对齐 job-claw-main externalApplicationInfo：精确匹配，命中即跳过）
const EXTERNAL_LABEL_PATTERN = /^(立即网申|去网申|前往网申|立即申请|去申请|申请职位|立即投递|投递简历|前往申请)$/;

function buttonScore(el) {
  const label = textOf(el);
  let score = 0;
  if (label === '立即沟通') score += 40;
  else if (label === '继续沟通') score += 30;
  else if (CHAT_LABEL_PATTERN.test(label)) score += 10;
  // 详情区内的按钮优先（job-claw-main: 在详情内 +100）
  const detail = el.closest('[class*="job-detail"], .job-banner, .job-detail-box, .detail-content');
  if (detail) score += 100;
  // 靠右的操作按钮优先（BOSS 详情页主操作按钮在右侧）
  try { if (el.getBoundingClientRect().left > innerWidth * 0.5) score += 20; } catch {}
  return score;
}

// 在候选集中选最佳沟通按钮（打分取最高，对齐 job-claw-main communicateButton）
function pickChatButton(candidates) {
  let best = null;
  let bestScore = -1;
  for (const el of candidates) {
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const label = textOf(el);
    if (!CHAT_LABEL_PATTERN.test(label)) continue;
    const score = buttonScore(el);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function communicateButton() {
  const selectorCandidates = all(BOSS_SELECTORS.chatButton);
  const labelCandidates = all('button, a, [role="button"], span, div').filter((el) => CHAT_LABEL_PATTERN.test(textOf(el)) && textOf(el).length <= 12);
  return pickChatButton([...selectorCandidates, ...labelCandidates]);
}

// 外部网申按钮检测（安全不变量：外部网申岗位跳过，job-claw-main externalApplicationInfo 口径）
function externalApplicationButton() {
  return all('button, a, [role="button"]').find((el) => {
    if (!visible(el) || el.disabled) return false;
    return EXTERNAL_LABEL_PATTERN.test(textOf(el));
  }) || null;
}

// 沟通确认弹窗按钮（对齐 job-claw-main dialogConfirmButton + AI-BossJob-plus「留在此页」）：
// 点击「立即沟通」后 BOSS 可能弹「已开始沟通」确认框，需要点确认/留在此页才能继续。
// 只认弹窗容器内的按钮（dialog/modal/popover 或 BOSS 自家的 default-btn/btn-sure-v2），避免误点页面里的普通「确定」。
function dialogConfirmButton() {
  const pattern = /^(继续沟通|确认沟通|去沟通|确定|确认|我知道了|继续|留在此页|留在本页)$/;
  return all('button, [role="button"], .default-btn, .btn-sure-v2').find((el) => {
    if (!visible(el) || el.disabled) return false;
    if (!pattern.test(textOf(el))) return false;
    return Boolean(el.closest('[class*="dialog"], [class*="modal"], [class*="popover"]')) || el.matches('.default-btn, .btn-sure-v2, [class*="dialog"] *, [class*="modal"] *');
  }) || null;
}

function sendButton(input) {
  if (!input) return null;
  const labelMatch = all('button,[role="button"],[class*="send"]').find((el) => {
    if (!visible(el) || el.disabled) return false;
    const label = textOf(el);
    if (/发送简历|发送附件|发送在线简历|发简历|图片/.test(label)) return false;
    return /^发送$/.test(label) || /(chat[-_]?send|send[-_]?message|sendbtn|send[-_]?btn|btn[-_]?send)/i.test(String(el.className || ''));
  });
  if (labelMatch) return labelMatch;
  // 输入框右下方最近的「发送」按钮
  const inputRect = input.getBoundingClientRect();
  return all('button,[role="button"]').find((el) => {
    if (!visible(el) || el.disabled) return false;
    const rect = el.getBoundingClientRect();
    return /发送/.test(textOf(el)) && Math.abs(rect.top - inputRect.bottom) < 200 && rect.left > inputRect.left - 60;
  }) || null;
}

// 文字气泡确认：发送后聊天记录里出现刚发送的文字（安全不变量：未确认不计成功）
function confirmOwnMessage(greeting) {
  const needle = String(greeting || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!needle) return false;
  const transcript = all('.chat-conversation, .conversation, .message-list, [class*="message"], [class*="chat-content"], [class*="conversation"]');
  for (const root of transcript) {
    if (root.innerText && root.innerText.includes(needle)) return true;
  }
  return false;
}

async function enterChat() {
  const existing = chatInput();
  if (existing) return existing;
  const button = communicateButton();
  if (!button) return null;
  const anchor = button.matches('a') ? button : button.closest('a');
  const href = button.href || anchor?.href || '';
  if (href && /zhipin\.com/i.test(href)) {
    anchor?.removeAttribute?.('target');
    location.href = href; // 跨域导航到 app.zhipin.com，preload 会重新注入
    return null;
  }
  await clickElement(button);
  return await waitFor(() => chatInput(), 12000, '聊天输入框');
}

async function domApply({ job = {}, greeting = '' } = {}) {
  const safeGreeting = String(greeting || '').replace(/\s+/g, ' ').trim();
  try {
    if (safeGreeting.length < 8) {
      notify('apply-stage', { stage: 'failed', error: '求职招呼语为空或过短，已停止发送' });
      return;
    }
    notify('apply-stage', { stage: 'open_chat', label: '打开沟通窗口' });
    let input = chatInput();
    if (!input) input = await enterChat();
    if (!input) {
      notify('apply-stage', { stage: 'failed', error: '未找到真实可编辑的聊天输入框，已暂停' });
      return;
    }

    notify('apply-stage', { stage: 'fill_message', label: '填写招呼语' });
    // 聚焦编辑器并真实输入：先确认焦点在输入框，再 selectAll→delete→insertText，避免误删整页
    input.scrollIntoView({ block: 'center' });
    input.focus();
    await sleep(200);
    if (document.activeElement !== input && input.matches('[contenteditable]')) {
      // contenteditable 可能包裹子节点，向内找可聚焦节点
      const inner = input.querySelector('[contenteditable]') || input;
      inner.focus();
    }
    const sel = await trustedInput('selectAll');
    const del = await trustedInput('delete');
    const ins = await trustedInput('insertText', safeGreeting);
    if (!ins.ok) {
      notify('apply-stage', { stage: 'failed', error: '真实输入写入失败，已暂停' });
      return;
    }
    await sleep(250);

    notify('apply-stage', { stage: 'send_message', label: '发送招呼语' });
    const btn = sendButton(input);
    if (btn) {
      btn.click();
    } else {
      const enter = await trustedInput('pressEnter');
      if (!enter.ok) {
        notify('apply-stage', { stage: 'failed', error: '未找到发送按钮且回车发送失败，已暂停' });
        return;
      }
    }

    // 文字气泡确认（安全不变量）
    notify('apply-stage', { stage: 'verify_message', label: '确认文字已发送' });
    const confirmed = await waitFor(() => confirmOwnMessage(safeGreeting), 8000, '文字气泡确认');
    if (!confirmed) {
      notify('apply-stage', { stage: 'failed', error: '未能确认文字气泡已发送，请人工核对后重试' });
      return;
    }
    notify('apply-stage', { stage: 'verify_result', label: '确认投递结果', ok: true });
  } catch (error) {
    const errorText = String(error?.message || error);
    if (/安全验证|验证码|频繁|限速|登录|封禁|异常/.test(errorText)) {
      notify('apply-stage', { stage: 'risk', code: null, message: errorText });
    } else {
      notify('apply-stage', { stage: 'failed', error: errorText });
    }
  }
}

// ===== 工作台「点击立即沟通」：仅打开聊天窗口，不发送文字（发文字由「自动沟通」页负责）=====
// 对齐 job-claw-main enterChat + AI-BossJob-plus handleGreetingModal：
//   1. 文本匹配 + 打分选最佳沟通按钮（立即沟通/继续沟通/打招呼…）。
//   2. 外部网申按钮精确匹配 → 回传 external:true，由上层按安全规则跳过。
//   3. 「继续沟通」入口是 app.zhipin.com 链接：移除 target 后整页跳转，先回传 navigating 事件；
//      React 收到后等新页面 preload 就绪会重发 open-chat，新页面检测到聊天输入框即回传 opened（不挂起）。
//   4. 等待期间自动点掉「继续沟通/确定/留在此页」确认弹窗；命中安全验证立即上报 risk。
async function openChatOnly() {
  try {
    notify('apply-stage', { stage: 'open_chat', label: '点击立即沟通，打开聊天窗口' });
    // 已在聊天窗口（输入框已存在）直接成功（覆盖 navigating 后重发的场景）
    let input = chatInput();
    if (input) { notify('apply-stage', { stage: 'opened', ok: true }); return; }
    // 外部网申岗位：跳过（安全不变量：外部网申 -6000，不投递）
    if (externalApplicationButton() && !communicateButton()) {
      notify('apply-stage', { stage: 'failed', external: true, error: '该岗位为外部网申（站外申请），按安全规则自动跳过' });
      return;
    }
    const button = communicateButton();
    if (!button) {
      notify('apply-stage', { stage: 'failed', error: '未找到「立即沟通」按钮（岗位可能已下架或非招聘中）' });
      return;
    }
    const anchor = button.matches('a') ? button : button.closest('a');
    const href = String(button.href || anchor?.href || '');
    // 对齐 job-claw-main enterChat：移除 target=_blank，让沟通页在当前标签内打开（可跟踪结果）
    if (anchor) { try { anchor.removeAttribute('target'); } catch {} }
    // 需要整页跳转（app.zhipin.com 聊天页 / /web/geek/chat 链接）：
    // 先回传 navigating，让上层在新页面就绪后重发 open-chat；原文档就此销毁，不再回传
    if (href && /zhipin\.com/i.test(href) && !/job_detail|\/geek\/job/i.test(href)) {
      notify('apply-stage', { stage: 'navigating', message: '沟通入口需要跳转页面，正在打开…' });
      try { location.href = href; } catch {}
      return;
    }
    await clickElement(button);
    // 等待聊天输入框出现；期间自动点确认弹窗、检测安全验证
    const deadline = Date.now() + 12000;
    let riskHit = false;
    while (Date.now() < deadline) {
      if (/安全验证|访问过于频繁|请完成验证|验证码|异常请求/.test(String(document.body?.innerText || '').slice(0, 3000)) || /security-check/i.test(location.href)) {
        riskHit = true;
        break;
      }
      const dlg = dialogConfirmButton();
      if (dlg) { try { dlg.click(); } catch {} }
      input = chatInput();
      if (input) break;
      await sleep(300);
    }
    if (riskHit) {
      notify('apply-stage', { stage: 'risk', code: 35, message: '检测到安全验证/访问受限，已暂停，请人工完成验证' });
      return;
    }
    if (!input) {
      notify('apply-stage', { stage: 'failed', error: '点击「立即沟通」后未出现聊天输入框，打开聊天窗口失败' });
      return;
    }
    notify('apply-stage', { stage: 'opened', ok: true });
  } catch (error) {
    const errorText = String(error?.message || error);
    if (/安全验证|验证码|频繁|限速|登录|封禁|异常/.test(errorText)) {
      notify('apply-stage', { stage: 'risk', code: null, message: errorText });
    } else {
      notify('apply-stage', { stage: 'failed', error: errorText });
    }
  }
}

// ===== 可视化采集（对齐 F:\job-claw-main 的 cards → cardIdentity → openCard → extractJob）=====
// 逐岗位卡片平滑滚动 + 高亮动画 + 点击展开详情 + 提取完整信息。
// 关键口径：岗位详情链接从卡片 <a href*="job_detail"> 的真实 href 提取（job-claw-main 的
// cardIdentity / extractJob 口径），比 API 用 encryptJobId 拼 URL 更准确、含完整跳转参数。

function ensureCollectStyle() {
  if (document.getElementById('bossclaw-collect-style')) return;
  const style = document.createElement('style');
  style.id = 'bossclaw-collect-style';
  style.textContent = '.bossclaw-collect-hl{outline:2px solid #13b5ac!important;outline-offset:2px;box-shadow:0 0 0 4px rgba(19,181,172,.25)!important;border-radius:8px;transition:box-shadow .25s ease,outline .25s ease;}';
  (document.head || document.documentElement).appendChild(style);
}

function highlightElement(el, keepMs = 1200) {
  if (!el) return;
  ensureCollectStyle();
  try { el.classList.add('bossclaw-collect-hl'); } catch {}
  setTimeout(() => { try { el.classList.remove('bossclaw-collect-hl'); } catch {} }, keepMs);
}

async function smoothScrollIntoView(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
  await sleep(600);
}

// ===== 安全点击（对齐 job-claw-main clickElement：sanitize 危险属性 + 阻止默认跳转）=====
// 关键：点击岗位卡片 / 立即沟通按钮时，临时移除 javascript: href 和内联 onclick，
// 派发可取消的 click 事件，让 BOSS 的 React/Vue 监听器收到事件但默认导航被阻止，
// 从而「内联更新详情面板」而不是「跳转页面」，实现连续采集多个岗位。
const UNSAFE_NAV_ATTRS = ['href', 'xlink:href', 'formaction', 'action'];
const INLINE_ACT_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ontouchstart', 'ontouchend'];
const normalize = (value) => String(value || '').replace(/\s+/g, '').replace(/[·•｜|]/g, '').trim().toLowerCase();

function isJavascriptUrl(value) { return /^\s*javascript\s*:/i.test(String(value || '')); }

function resolveClickTarget(element) {
  let node = element;
  while (node && node !== document.documentElement) {
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'a' || tag === 'button' || tag === 'form' || node.getAttribute?.('role') === 'button') return node;
    node = node.parentElement;
  }
  return element;
}

function sanitizeUnsafeActivation(target) {
  const saved = [];
  const nodes = new Set([target]);
  const anc = target?.closest?.('a'); if (anc) nodes.add(anc);
  const form = target?.closest?.('form'); if (form) nodes.add(form);
  for (const node of nodes) {
    for (const name of UNSAFE_NAV_ATTRS) {
      const value = node?.getAttribute?.(name);
      if (!isJavascriptUrl(value)) continue;
      saved.push({ node, name, value });
      node.removeAttribute?.(name);
    }
    for (const name of INLINE_ACT_ATTRS) {
      const value = node?.getAttribute?.(name);
      if (value === null || value === undefined) continue;
      saved.push({ node, name, value });
      node.removeAttribute?.(name);
    }
  }
  return {
    unsafe: saved.length > 0,
    restore() { for (const { node, name, value } of saved.reverse()) node?.setAttribute?.(name, value); },
  };
}

async function clickElement(element) {
  const target = resolveClickTarget(element);
  if (!target) throw new Error('目标元素不存在');
  if (target.disabled || target.getAttribute?.('aria-disabled') === 'true') throw new Error('目标元素当前不可点击');
  try { target.scrollIntoView?.({ block: 'center', behavior: 'instant' }); } catch {}
  await sleep(120);
  const sanitized = sanitizeUnsafeActivation(target);
  try {
    if (sanitized.unsafe && typeof target.dispatchEvent === 'function') {
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 0 });
      const preventUnsafeDefault = (event) => event.preventDefault?.();
      target.addEventListener?.('click', preventUnsafeDefault, { capture: true, once: true });
      try { target.dispatchEvent(clickEvent); } finally { target.removeEventListener?.('click', preventUnsafeDefault, { capture: true }); }
    } else if (typeof target.click === 'function') {
      target.click();
    } else if (typeof target.dispatchEvent === 'function') {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 0 }));
    }
    await sleep(90);
  } finally {
    sanitized.restore();
  }
  await sleep(130);
}

// 岗位卡片提取（对齐 job-claw-main cards() + AI-BossJob-plus li.job-card-box）
// BOSS 新版列表 DOM 是 li.job-card-box（推荐/搜索页），旧版是 .job-card-wrapper，两者都收。
// quiet=true 时跳过诊断 notify（用于滚动加载期间的快速轮询，避免刷屏）。
function collectCards(quiet = false) {
  const selectors = [
    '.job-list-box .job-card-wrapper',
    'li.job-card-wrapper',
    '.search-job-result .job-card-wrapper',
    'li.job-card-box',
    '.job-card-box',
    '.job-list-box li',
    '.search-job-result li.job-card-box',
    'a[href*="/job_detail/"]',
  ];
  if (!quiet) {
    // 诊断：如果所有选择器都命中 0，就回传完整的 DOM 诊断信息帮助定位问题
    const diag = selectors.map((s) => {
      const hits = all(s);
      const sample = hits.slice(0, 2).map((el) => ({
        tag: el.tagName,
        className: el.className,
        id: el.id,
        innerText: String(el.innerText).slice(0, 100),
      }));
      return { selector: s, count: hits.length, sample };
    });
    if (diag.every((d) => d.count === 0)) {
      notify('collect-progress', { phase: 'collect-diag-fail', data: diag });
    } else {
      notify('collect-progress', { phase: 'collect-diag', data: diag });
    }
  }
  const candidates = selectors.flatMap((s) => all(s))
    .map((el) => el.closest('.job-card-wrapper, .job-card-box, li') || el)
    .filter(visible);
  // 诊断：再统计去重后的候选数
  if (!quiet) {
    notify('collect-progress', { phase: 'collect-candidates', count: candidates.length });
  }
  return [...new Set(candidates)].filter((el, i, items) => {
    const content = textOf(el);
    if (!content || content.length > 900) return false;
    // 必须是真实岗位卡：含 job_detail 链接或薪资文本（排除筛选栏 / 无关 li）
    const isJobCard = el.querySelector?.('a[href*="job_detail"]') || /\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上/.test(content);
    if (!isJobCard) return false;
    return !items.some((other, oi) => oi !== i && other.contains(el) && textOf(other).length < content.length);
  });
}

// 文本行启发式兜底（对齐 AI-BossJob-plus getCardLines / findCompanyFromLines）：
// 把卡片 innerText 按行拆开，用噪声词排除法找公司名
const CARD_LINE_NOISE = /立即沟通|继续沟通|打招呼|在线|刚刚活跃|今日活跃|昨日活跃|日内活跃|周内活跃|月内活跃|\d+\s*(?:分钟|小时|天|周|月)前?(?:活跃)?|[Kk]薪|薪[Kk]|元\/月|.BO.|应届|经验|学历|大专|本科|硕士|博士|全职|兼职|实习|招聘|急聘|猎头/i;

function pickFromCard(card, selectorCandidates) {
  for (const sel of selectorCandidates) {
    const el = card.querySelector(sel);
    const t = textOf(el);
    if (t) return t;
  }
  return '';
}

// 卡片身份（对齐 job-claw-main cardIdentity，多选择器候选 + 行兜底）
function cardIdentity(card) {
  const anchor = card.querySelector('a[href*="job_detail"]');
  const cardLines = textOf(card).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const title = pickFromCard(card, ['.job-name', '.job-title .job-name', '.job-title', '.position-name', '[class*="job-name"]', '[class*="job-title"]', '[class*="jobName"]', 'h3', 'h4'])
    || textOf(anchor)
    || cardLines[0]
    || '';
  let company = pickFromCard(card, ['.company-name', '.job-card-right .company-info h3', 'h3.company-name', 'a.company-name', '[class*="company-name"]', '[class*="companyName"]', '[class*="company"]']);
  if (!company) {
    for (const line of cardLines.slice(1)) {
      if (!CARD_LINE_NOISE.test(line) && line.length >= 3 && line.length <= 24) { company = line; break; }
    }
  }
  return { title: title.slice(0, 80), company: company.slice(0, 80), href: anchor?.href || '', raw: textOf(card).slice(0, 500) };
}

// 卡片结构化字段（对齐 AI-BossJob-plus recordApplication 的多选择器候选）：
// 薪资 / 地区 / 经验学历 / HR 职位 / HR 活跃度 / 猎头标记
function cardFields(card) {
  const cardText = textOf(card);
  const salary = pickFromCard(card, ['.salary', '.job-salary', '[class*="salary"]'])
    || cardText.match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/)?.[0]
    || '';
  const location = pickFromCard(card, ['.job-area', '.job-area-wrapper', '.job-address-desc', '.job-location', '.company-location', '[class*="job-area"]'])
    || cardText.match(/北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|全国/)?.[0]
    || '';
  const hrActive = cardText.match(/在线|刚刚活跃|今日活跃|昨日活跃|\d+\s*日内活跃|\d+\s*周内活跃|\d+\s*月内活跃|\d+\s*(?:分钟|小时)前活跃/)?.[0] || '';
  const recruiterTitle = pickFromCard(card, ['.boss-title', '.job-card-footer .boss-title', '[class*="boss-title"]', '.boss-info-attr']);
  const isHeadhunter = /猎头/.test(cardText);
  return { salary, location, hrActive, recruiterTitle, isHeadhunter };
}

// 去重 key（对齐 job-claw-main cardKey）
function collectCardKey(card) {
  const anchor = card.querySelector('a[href*="job_detail"]');
  return anchor?.href || card.getAttribute('data-jobid') || textOf(card).slice(0, 220);
}

// jobId token（对齐 job-claw-main jobUrlToken）：优先 pathname /job_detail/{id}，回退 query 参数
function jobUrlToken(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), location.href);
    const match = url.pathname.match(/\/job_detail\/([^/?#]+)/i);
    if (match?.[1]) return match[1].replace(/\.html$/i, '');
    for (const key of ['jobId', 'jobid', 'encryptJobId', 'securityId', 'lid']) {
      const value = url.searchParams.get(key);
      if (value) return `${key.toLowerCase()}=${value}`;
    }
    return '';
  } catch { return ''; }
}

// 详情根节点（对齐 job-claw-main detailRoot / detailReady）
function detailRoot() {
  const selectors = [
    '.job-detail-box', '.job-detail', '.job-detail-container', '.job-detail-content',
    '.job-detail-panel', '.job-detail-wrapper', '.job-detail-main',
    '[class*="job-detail"]', '[class*="jobDetail"]',
  ];
  const direct = selectors.flatMap((s) => all(s)).filter(visible)
    .sort((a, b) => textOf(b).length - textOf(a).length)
    .find((el) => detailReady(el));
  if (direct) return direct;
  return all('main,section,article,div').find((el) => {
    const rect = el.getBoundingClientRect();
    const content = textOf(el);
    return visible(el) && rect.left > innerWidth * 0.26 && rect.width > 280 && content.length > 100
      && /职位描述|职位要求|岗位职责|投递说明|公司文化|福利/.test(content);
  }) || null;
}

function detailReady(root) {
  if (!root || !visible(root)) return false;
  const content = textOf(root);
  if (content.length < 60) return false;
  return /职位描述|职位要求|岗位职责|投递说明|工作内容|任职要求|公司文化|福利|立即沟通|继续沟通|立即网申|去网申|立即申请/.test(content)
    || Boolean(root.querySelector('h1,h2,[class*="job-name"],[class*="job-title"],[class*="jobName"]'));
}

// 详情签名（对齐 job-claw-main detailSignature）：用于判断点击后详情是否变化
function detailSignature(root) {
  if (!root) return '';
  const title = textOf(root.querySelector('h1,h2,[class*="job-name"],[class*="job-title"],[class*="jobName"]'));
  const company = textOf(root.querySelector('[class*="company-name"],[class*="companyName"],[class*="company"]'));
  return normalize(`${title}|${company}|${textOf(root).slice(0, 700)}`);
}

// 卡片是否被选中（对齐 job-claw-main isSelectedCard）
function isSelectedCard(card) {
  if (!card) return false;
  const className = String(card.className || '');
  if (/(^|[-_\s])(active|selected|checked|current)([-_\s]|$)/i.test(className)) return true;
  if (card.getAttribute('aria-selected') === 'true') return true;
  return Boolean(card.querySelector('[class*="active"],[class*="selected"],[aria-selected="true"]'));
}

// 详情面板是否匹配卡片（对齐 job-claw-main detailMatchesCard）
function detailMatchesCard(root, card) {
  if (!detailReady(root) || !card) return false;
  const detail = normalize(textOf(root));
  const identity = cardIdentity(card);
  const title = normalize(identity.title);
  const company = normalize(identity.company);
  const titleMatch = title.length >= 3 && detail.includes(title);
  const companyMatch = company.length >= 2 && detail.includes(company);
  if (titleMatch && companyMatch) return true;
  if (titleMatch && (!company || isSelectedCard(card))) return true;
  if (companyMatch && (!title || isSelectedCard(card))) return true;
  return false;
}

// 点击展开详情（对齐 job-claw-main openCard：匹配 + 重试 + URL 变化检测）
async function openCardDetail(card) {
  if (!card) return null;
  const beforeRoot = detailRoot();
  const beforeSignature = detailSignature(beforeRoot);
  const beforeUrl = location.href;

  // 列表第一项常被默认选中，详情已存在：直接复用
  if (beforeRoot && detailMatchesCard(beforeRoot, card)) return beforeRoot;

  const anchor = card.querySelector('a[href*="job_detail"]');
  const targets = [...new Set([anchor, card].filter(Boolean))];
  // 关键修复：总超时收紧到 4.5s（之前 3*6500≈20s 是主循环卡死的元凶），
  // 仍走 sanitizeUnsafeActivation 让 BOSS 内联更新详情面板。
  const timeout = 3500;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = targets[Math.min(attempt, targets.length - 1)] || card;
    try { await clickElement(target); } catch { /* 虚拟列表滚动后节点可能失效，下一轮重试 */ }
    const root = await waitFor(() => {
      const current = detailRoot();
      if (!detailReady(current)) return null;
      const signature = detailSignature(current);
      const changed = Boolean(signature && signature !== beforeSignature);
      const urlChanged = location.href !== beforeUrl;
      const matches = detailMatchesCard(current, card);
      const selected = isSelectedCard(card);
      return (matches || changed || urlChanged || selected) ? current : null;
    }, timeout, '岗位详情').catch(() => null);
    if (root) return root;
    try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
    await sleep(200);
  }
  // 兜底：返回当前 detailRoot（即使没匹配），extractJobDetail 仍能拿到 card 文本
  return detailRoot();
}

// 提取岗位信息（对齐 job-claw-main extractJob）：url/jobId 从 <a href*="job_detail"> 真实链接取
// 结构化字段（薪资/地区/HR活跃度/猎头）对齐 AI-BossJob-plus recordApplication 的多选择器候选
function extractJobDetail(card) {
  const root = detailRoot();
  const cardText = textOf(card);
  const detailText = textOf(root);
  const identity = cardIdentity(card);
  const fields = cardFields(card);
  // 优先卡片上真实的 job_detail 链接；其次详情面板内的 job_detail 链接；避免回退到列表页 URL
  const anchor =
    card.querySelector('a[href*="job_detail"]')
    || root?.querySelector('a[href*="job_detail"]')
    || document.querySelector('.job-detail-box a[href*="job_detail"], [class*="job-detail"] a[href*="job_detail"]');
  // 兜底：部分虚拟列表卡片不带真实 href，从 data 属性读取 encryptJobId
  const dataJobId =
    card.getAttribute('data-jobid') || card.getAttribute('data-encryptjobid')
    || root?.getAttribute('data-jobid') || root?.getAttribute('data-encryptjobid') || '';
  const title = textOf(root?.querySelector('h1,h2,[class*="job-name"],[class*="name"]'))
    || identity.title
    || '岗位';
  const company = textOf(root?.querySelector('[class*="company-name"],a[href*="gongsi"],[class*="company"]'))
    || identity.company
    || '';
  // HR 活跃度：卡片优先，详情面板兜底（对齐 AI-BossJob-plus boss-online-tag / boss-active-time）
  const hrActive = fields.hrActive
    || textOf($('.boss-online-tag') || $('.boss-active-time') || $('[class*="boss-active"]'))
    || detailText.match(/在线|刚刚活跃|今日活跃|\d+\s*日内活跃/)?.[0]
    || '';
  // 招聘方姓名（job-claw-main detailRecruiterIdentity 口径）
  const recruiterName = textOf(root?.querySelector('[class*="boss-name"],[class*="bossName"],[class*="recruiter-name"],[class*="job-boss"] [class*="name"],[class*="boss-info"] [class*="name"]'))
    || '';
  const salaryMatch = `${cardText} ${detailText}`.match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/);
  const token = jobUrlToken(anchor?.href || '');
  const jobId = token || dataJobId || '';
  const realUrl = anchor?.href
    || (dataJobId ? `https://www.zhipin.com/job_detail/${dataJobId}.html` : location.href);
  const chatBtn = communicateButton();
  const chatUrl = String(chatBtn?.href || chatBtn?.closest?.('a')?.href || '');
  return {
    title,
    company,
    salary: fields.salary || salaryMatch?.[0] || '',
    location: fields.location,
    description: detailText.slice(0, 9000),
    cardText: cardText.slice(0, 1000),
    url: realUrl,
    jobId,
    chatUrl,
    hrActive,
    isHeadhunter: fields.isHeadhunter,
    recruiterName,
    recruiterTitle: fields.recruiterTitle,
  };
}

// 采集运行时控制
const collectCtl = { paused: false, stopped: false, settleMs: 1200 };
async function waitWhilePaused() {
  while (collectCtl.paused && !collectCtl.stopped) await sleep(200);
}

// ===== 列表滚动加载更多（对齐 AI-BossJob-plus scrollToLoadMoreJobs / autoScrollJobList）=====
// BOSS 无限加载必须「渐进式滚动」：从当前滚动位置（= 最后处理的岗位滑块位置）逐步向下滚
// 一屏的 80%，每步等待列表渲染后再滚下一步，直到触发加载或滚到物理底部。
// 一次性 scrollTop=scrollHeight 跳底不会持续触发加载（这是之前「下拉没有真正加载」的根因）。

// 滚动容器探测：BOSS 列表容器自身可滚动（scrollHeight > clientHeight）时优先滚容器，
// 否则回退 window 滚动。返回 null 表示用 window。
function findListScroller() {
  const candidates = all('.job-list-box, .search-job-result, .job-list, [class*="job-list"], [class*="search-job"]');
  let hitCandidate = false;
  for (const el of candidates) {
    hitCandidate = true;
    if (el.scrollHeight > el.clientHeight + 20) return el;
  }
  // 兜底：列表候选选择器全部失效（BOSS 改版）且页面没有命中任何候选时，
  // 扫描「非详情面板」中可滚动面积最大的容器（详情面板是独立滚动区，排除以免滚错）。
  if (!hitCandidate) {
    let best = null;
    let bestOverflow = 0;
    for (const el of all('div,main,section,ul,li')) {
      if (el.closest('.job-detail, .job-detail-box, [class*="job-detail"]')) continue;
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow > 40 && overflow > bestOverflow) { best = el; bestOverflow = overflow; }
    }
    return best || null;
  }
  return null; // 有候选但都不可滚 → 列表挂在 window 上
}

// 是否存在「未收集过」的新卡片。用 processed 去重判断而非卡片总数——
// BOSS 虚拟列表滚到底后上方卡片会被回收，总数可能不变甚至变少，不能据此判定「无增长」。
function hasUncollectedCards(processed) {
  try {
    return collectCards(true).some((card) => {
      const key = collectCardKey(card);
      return Boolean(key) && !processed.has(key);
    });
  } catch { return false; }
}

// 渐进式下拉加载更多：从当前滚动位置（= 上一个岗位的滑块位置）开始，每步向下滚一屏的 80%，
// 等待渲染后检查是否出现新卡；出现新卡即返回 grew=true。滚不动/滚完步数后做最终确认。
// 返回 { grew: 是否出现未收集新卡, atBottom: 是否已滚到列表物理底部 }（二者互斥）：
//   grew=true  → 有新卡待收集，主循环继续收集（atBottom=false）
//   atBottom=true → 确实到底且无新卡，主循环停止（grew=false）
async function scrollJobListLoadMore(processed, opts = {}) {
  const settleMs = Math.max(400, Number(opts.settleMs) || 1200);
  const scroller = findListScroller();
  const stepRatio = 0.8;
  const maxSteps = 6;
  let lastTop = scroller ? scroller.scrollTop : window.scrollY;
  for (let i = 0; i < maxSteps; i += 1) {
    if (collectCtl.stopped) return { grew: false, atBottom: true };
    const curTop = scroller ? scroller.scrollTop : window.scrollY;
    const client = scroller ? scroller.clientHeight : innerHeight;
    const total = scroller ? scroller.scrollHeight : document.documentElement.scrollHeight;
    const next = Math.min(curTop + Math.round(client * stepRatio), Math.max(0, total - client));
    if (next <= curTop + 5) break; // 已滚到物理底部，跳出做最终确认
    // 即时滚动（不用 smooth：smooth 是异步动画，会与下面的位置判定竞争）
    if (scroller) scroller.scrollTop = next;
    else window.scrollTo(0, next);
    await sleep(Math.max(500, Math.round(settleMs * 0.7)));
    if (hasUncollectedCards(processed)) return { grew: true, atBottom: false }; // 中途发现新卡
    const nowTop = scroller ? scroller.scrollTop : window.scrollY;
    if (nowTop <= lastTop + 5) break; // 滚不动了
    lastTop = nowTop;
  }
  // 到底 / 滚完步数后，多等一次渲染窗口做最终确认
  await sleep(settleMs);
  const grew = hasUncollectedCards(processed);
  return { grew, atBottom: !grew }; // 有新卡 → 继续收集；无新卡 → 确认为到底
}

// 可视化采集主循环：逐卡片 滚动 → 高亮 → 点击展开 → 提取，实时回传进度。
// 关键（对齐 job-claw-main）：BOSS 使用虚拟列表，点击后卡片节点会被替换，
// 每轮重新 collectCards()，用 cardKey 去重（processed Set），index 递增，避免持有失效 DOM。
// 当本批卡片处理完（index 越界）时，从最后岗位滑块位置渐进下拉加载更多，直到达到 maxJobs
// 兜底上限，或滚到列表物理底部则停止（对齐 AI-BossJob-plus autoScrollJobList 的 maxHistory=3 判定）。
async function visualCollect(opts = {}) {
  collectCtl.paused = false;
  collectCtl.stopped = false;
  collectCtl.settleMs = Math.max(400, Number(opts.settleMs) || 1200);
  const settleMs = collectCtl.settleMs;
  // 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 软上限；本机 1000 兜底防止失控）
  const maxJobs = Math.max(1, Number(opts.maxJobs) || 1000);
  const processed = new Set();
  let index = 0;
  let processedCount = 0;
  let emptyRounds = 0;
  notify('collect-progress', { phase: 'start', index: 0, total: 0, maxJobs, status: '准备中' });

  // 一次性 DOM 诊断：把每个选择器命中数和前若干节点 className 发给 React（只发一次）
  try {
    const diagSelectors = ['.job-list-box .job-card-wrapper', 'li.job-card-wrapper', '.search-job-result .job-card-wrapper', '.job-list-box li', 'a[href*="/job_detail/"]'];
    const diagLines = diagSelectors.map((s) => `${s}=${all(s).length}`);
    const diagRoot = $('.job-list-box, .search-job-result, .job-list, [class*="job-list"]');
    const diagUrl = location.href;
    notify('collect-progress', { phase: 'dom-diag', index: 0, total: 0, processed: 0, maxJobs, status: `[DOM] ${diagLines.join(' | ')} | root=${diagRoot ? diagRoot.className : 'none'} | url=${diagUrl.slice(0, 80)}` });
  } catch {}

  // 关键修复：先等 BOSS 列表出现，避免初次 collectCards() 拿到 0 卡就 emptyRounds=2 提前结束。
  // BOSS 列表通常在搜索 URL load 完后 ~2-4s 才渲染完成。
  const listReadyDeadline = Date.now() + 15000;
    let initialWaitCount = 0;
  while (Date.now() < listReadyDeadline && !collectCtl.stopped) {
    try {
      const initial = collectCards();
      if (initial.length > 0) {
        notify('collect-progress', { phase: 'list-ready', index: 0, total: initial.length, processed: 0, maxJobs, status: `列表就绪（${initial.length} 卡）` });
        break;
      }
    } catch (e) {
      notify('collect-progress', { phase: 'collect-error', index: 0, total: 0, processed: 0, maxJobs, status: `列表查询异常：${String(e?.message || e).slice(0, 80)}` });
      await sleep(settleMs);
    }
    initialWaitCount += 1;
    if (initialWaitCount === 1 || initialWaitCount % 4 === 0) {
      notify('collect-progress', { phase: 'waiting-list', index: 0, total: 0, processed: 0, maxJobs, status: '等待列表渲染' });
    }
    await sleep(settleMs * 0.6);
  }

    while (!collectCtl.stopped) {
    await waitWhilePaused();
    if (collectCtl.stopped) break;
    if (processedCount >= maxJobs) break;
    let cards = [];
    try { cards = collectCards(); } catch (e) {
      notify('collect-progress', { phase: 'collect-error', index, total: 0, processed: processedCount, maxJobs, status: `卡片查询异常：${String(e?.message || e).slice(0, 80)}` });
      await sleep(settleMs);
      continue;
    }
    if (cards.length === 0 && processedCount === 0 && emptyRounds === 0) {
      // 首轮 cards 仍为空（列表还没出来）— 主动滚一次促加载
      await scrollJobListLoadMore(processed, { settleMs });
      await sleep(settleMs * 1.5);
      emptyRounds += 1;
      continue;
    }
    if (index >= cards.length) {
      // 诊断：本轮 cards 长度为 0 → 把当前页面可能相关的 li/a 标签统计回传，帮助定位选择器问题
      if (cards.length === 0) {
        const fallbackDiag = {
          bodyLength: String(document.body?.innerText || '').length,
          allLiCount: all('li').length,
          allJobDetailLinks: all('a[href*="job_detail"]').length,
          sampleAnchors: all('a[href*="job_detail"]').slice(0, 3).map((a) => ({ href: a.href.slice(0, 80), innerText: a.innerText.slice(0, 50) })),
        };
        notify('collect-progress', { phase: 'no-cards-diag', index, total: 0, processedCount, maxJobs, status: JSON.stringify(fallbackDiag) });
      }
      // 本批卡片已处理完：从当前滚动位置（= 最后处理的岗位滑块位置）渐进下拉加载更多。
      // 对齐 AI-BossJob-plus autoScrollJobList：滚到物理底部即停止；连续 3 轮无新卡也停止。
      // 增长判定基于「是否出现未收集的新 key」，不能用卡片总数——虚拟列表回收上方卡片
      // 后 cards.length 可能不变甚至变小，会误判「无增长」导致列表中间被截断。
      const { grew, atBottom } = await scrollJobListLoadMore(processed, { settleMs });
      if (atBottom) {
        // 已滚到列表物理底部且无新卡 → 本搜索组合加载完毕，直接停止
        notify('collect-progress', { phase: 'list-bottom', index, total: cards.length, processed: processedCount, maxJobs, status: '已滚动到列表底部，加载完毕' });
        break;
      }
      if (!grew) emptyRounds += 1;
      else emptyRounds = 0;
      if (emptyRounds >= 3) {
        notify('collect-progress', { phase: 'list-bottom', index, total: cards.length, processed: processedCount, maxJobs, status: '连续 3 轮无新卡，停止加载' });
        break;
      }
      index = 0;
      continue;
    }
    const card = cards[index];
    index += 1;
    const key = collectCardKey(card);
    if (!key || processed.has(key)) continue;
    processed.add(key);
    const identity = cardIdentity(card);
    // 诊断：每张卡片的去重 key 与身份立即回传（让 React 能确认 select 命中且 key 提取成功）
    notify('collect-progress', { phase: 'card-found', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: `命中卡片 key=${String(key).slice(0, 60)}` });
    // 诊断：每 10 轮回传一次「当前卡片数和索引」，确认循环在跑但可能只是找不到卡片
    if (index % 10 === 0) {
      notify('collect-progress', { phase: 'heartbeat', index, total: cards.length, processedCount, maxJobs });
    }
    notify('collect-progress', { phase: 'card-found', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: `命中卡片 key=${String(key).slice(0, 60)}` });
    // 1) 平滑滚动到卡片并高亮（可视化动画）
    await smoothScrollIntoView(card);
    highlightElement(card, settleMs);
    notify('collect-progress', { phase: 'scroll', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: '滚动中' });
    await sleep(settleMs);
    if (collectCtl.stopped) break;
    await waitWhilePaused();
    if (processedCount >= maxJobs) break;
    // 2) 点击展开详情
    notify('collect-progress', { phase: 'click', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: '点击中' });
    await openCardDetail(card);
    await sleep(Math.max(500, Math.round(settleMs * 0.6)));
    if (collectCtl.stopped) break;
    // 3) 提取岗位信息并回传
    const job = extractJobDetail(card);
    processedCount += 1;
    notify('collect-progress', { phase: 'done', index, total: cards.length, processed: processedCount, maxJobs, title: job.title, company: job.company, status: '完成', job });
    await sleep(settleMs);
  }
  notify('collect-done', { listUrl: location.href, processed: processedCount, total: processedCount, maxJobs });
}

// ===== DOM 诊断（右键菜单「BossClaw 诊断：Dump DOM」触发）=====
// 内置浏览器无 DevTools、无右键菜单，BOSS 改版后选择器失效只能靠 dump 真实 DOM 取证。
// 输出当前页面：元素统计 / 列表容器候选 / li·a 样本 / 详情面板 / 「查看更多信息」按钮候选，
// 供上层（Workbench 日志区）复制给开发者对齐新版选择器。
function domDump() {
  const clamp = (v, n) => String(v || '').slice(0, n);
  const out = {
    time: Date.now(),
    url: location.href,
    title: document.title,
    stats: {
      li: all('li').length,
      ul: all('ul').length,
      a: all('a').length,
      aJobDetail: all('a[href*="job_detail"]').length,
      aJobLike: all('a[href*="/job/"], a[href*="job_detail"], a[href*="geek/job"]').length,
      button: all('button').length,
      textLen: String(document.body?.innerText || '').length,
    },
    containers: [
      '.job-list-box', '.search-job-result', '.job-list', '[class*="job-list"]', '[class*="jobList"]',
      '[class*="search-job"]', '[class*="job-card"]', '[class*="jobCard"]', 'ul', '[role="list"]',
    ].map((sel) => {
      const els = all(sel);
      return {
        sel,
        count: els.length,
        sample: els.slice(0, 2).map((el) => ({ tag: el.tagName, cls: clamp(el.className, 140), id: el.id })),
      };
    }),
    liSample: all('li').slice(0, 15).map((el) => ({
      cls: clamp(el.className, 140),
      text: textOf(el).slice(0, 80),
      anchor: (() => { const a = el.querySelector('a'); return a ? a.href.slice(0, 140) : ''; })(),
    })),
    aSample: all('a').slice(0, 15).map((a) => ({ href: a.href.slice(0, 150), cls: clamp(a.className, 100), text: textOf(a).slice(0, 50) })),
    detail: (() => {
      const root = detailRoot();
      if (!root) return { found: false };
      const btns = all('button,span,div,a', root)
        .filter((el) => {
          const t = textOf(el);
          if (!t || t.length > 8) return false;
          if (/^(查看更多|查看全部|展开|收起|更多|全部|阅读全文|显示更多)/.test(t)) return true;
          const cls = String(el.className || '');
          return /more|expand|unfold|see-all|see_more|text-more|show-more/.test(cls);
        })
        .slice(0, 15)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: clamp(el.className, 120),
            text: textOf(el).slice(0, 20),
            onclick: clamp(el.getAttribute?.('onclick'), 80),
            disabled: Boolean(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 },
            parentCls: clamp(el.parentElement?.className, 100),
          };
        });
      return {
        found: true,
        cls: clamp(root.className, 140),
        textLen: textOf(root).length,
        hasJobDesc: /职位描述|职位要求|岗位职责|任职要求|工作内容/.test(textOf(root)),
        buttons: btns,
      };
    })(),
  };
  notify('dom-dump', out);
}

// ===== IPC 通道注册 =====
// boss-api：BOSS 官方 API（joblist / jobCard / jobDetail / friendAdd），seq 用于上层 promise 化
ipcRenderer.on('boss-api', async (_e, arg) => {
  const { seq, action, params } = (arg && typeof arg === 'object') ? arg : {};
  const result = await handleBossApi(action, params);
  notify('boss-api-result', { seq, ok: !result.error, code: result.code, data: result, error: result.error, riskCodeMessage: result.code ? riskCodeMessage(result.code) : '' });
});

// extract-job：提取当前详情页岗位（API 优先，DOM 兜底）
ipcRenderer.on('extract-job', () => { extractJob(); });

// start-apply：DOM 兜底投递（API 失败时由上层调用）
ipcRenderer.on('start-apply', (_e, arg) => { domApply(arg || {}); });

// open-chat：工作台「点击立即沟通」——仅打开聊天窗口（不发送文字，发文字交给「自动沟通」页）
ipcRenderer.on('open-chat', () => { openChatOnly(); });

// visual-collect：可视化采集（对齐 job-claw-main，逐卡片滚动高亮点击展开）
ipcRenderer.on('visual-collect', (_e, arg) => {
  const opts = (arg && typeof arg === 'object') ? arg : {};
  visualCollect(opts).catch((e) => notify('collect-done', { listUrl: location.href, processed: 0, total: 0, error: String(e?.message || e) }));
});
// collect-control：运行时控制（暂停 / 继续 / 停止 / 调速）
ipcRenderer.on('collect-control', (_e, arg) => {
  const action = (arg && arg.action) || '';
  if (action === 'pause') collectCtl.paused = true;
  else if (action === 'resume') collectCtl.paused = false;
  else if (action === 'stop') { collectCtl.stopped = true; collectCtl.paused = false; }
  else if (action === 'speed') {
    const ms = Number((arg && arg.settleMs) || 0);
    if (ms >= 300) collectCtl.settleMs = Math.min(5000, ms);
  }
});

// webview-command：主进程右键菜单触发的通用命令（dom-dump 等）
ipcRenderer.on('webview-command', (_e, arg) => {
  const action = (arg && arg.action) || '';
  if (action === 'dom-dump') {
    try { domDump(); } catch (e) { notify('dom-dump', { error: String(e?.message || e), url: location.href }); }
  }
});

// ===== 页面监听 =====
// MutationObserver 在跨域导航 / 文档撕裂时偶发抛错（document 状态切换的瞬间），
// 这里把回调包一层 try/catch，避免一条 MutationObserver 抛错后整个 preload 监听链路失效。
function safeReport(kind) {
  try { kind === 'nav' ? reportNav() : reportLogin(); } catch (e) {
    try { notify('preload-error', { kind, message: String(e?.message || e) }); } catch {}
  }
}
spaRecord(); // 种子：把初始页面加入历史栈
reportNav();
reportLogin();
let obsTick = 0;
const obs = new MutationObserver(() => {
  // 节流：连续 mutation 时合并到下一帧（rAF；退化环境下用 setTimeout 16ms）
  if (obsTick) return;
  obsTick = 1;
  const flush = () => { obsTick = 0; safeReport('nav'); safeReport('login'); };
  try {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  } catch { setTimeout(flush, 32); }
});
try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
document.addEventListener('DOMContentLoaded', () => { spaRecord(); safeReport('nav'); safeReport('login'); });
setTimeout(() => { safeReport('nav'); safeReport('login'); }, 1200);
setTimeout(() => { safeReport('nav'); safeReport('login'); }, 4000);

// 自身 IPC 监听兜底：底层事件回调抛错会污染 ipcRenderer 的事件循环，把每个 listener 包一层
['boss-api', 'extract-job', 'start-apply', 'open-chat', 'visual-collect', 'collect-control'].forEach((channel) => {
  const orig = ipcRenderer.listeners(channel).slice();
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, async (...args) => {
    for (const fn of orig) {
      try { await fn(...args); } catch (e) {
        try { notify('preload-error', { channel, message: String(e?.message || e) }); } catch {}
      }
    }
  });
});

// preload 启动握手：主进程 / 渲染层可借此探测 preload 是否就绪
notify('preload-ready', { url: location.href, ts: Date.now() });
})();
