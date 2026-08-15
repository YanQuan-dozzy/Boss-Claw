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

// ===== 基础工具 =====
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(channel, data) {
  try { ipcRenderer.sendToHost(channel, data); } catch {}
}

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
function reportNav() {
  try {
    notify('nav', {
      url: location.href,
      title: document.title,
      canGoBack: history.length > 1,
      canGoForward: false,
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
      });
      return;
    }
    // code 37（环境异常）等风控码回传，让上层感知
    if (card && card.code && card.code !== 0) {
      notify('job-extracted', { url: location.href, title: document.title, error: `job/card 接口 code=${card.code}`, riskCode: card.code });
      return;
    }
  }
  // DOM 兜底
  try {
    notify('job-extracted', extractJobFromDom());
  } catch (e) {
    notify('job-extracted', { url: location.href, title: document.title, error: String(e?.message || e) });
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
    try { ipcRenderer.once('jc:webview-input-done', (_e, data) => done(data)); } catch {}
    try { ipcRenderer.send('jc:webview-input', { seq, action, text }); } catch { done({ ok: false, error: 'send failed' }); }
    setTimeout(() => done({ ok: false, error: 'timeout' }), 4000);
  });
}

// ===== DOM 兜底投递（简化版：API 失败 / 未知码时使用）=====
// 仅做「找沟通入口 → 进入沟通 → 找输入框 → 真实输入 → 发送 → 气泡确认」，
// 去除旧版复杂的会话绑定 / 断点续跑 / 评分排序，降低脆性。
const BOSS_SELECTORS = {
  chatButton: 'a.op-btn-chat, .btn-chat, .op-btn.chat, .btn-start-chat, [class*="start-chat"], [ka*="job-detail-chat"], a[href*="chat"]',
};

function chatInput() {
  // 优先 contenteditable（BOSS 新版聊天输入框），其次 textarea / input
  const candidates = [
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

function communicateButton() {
  const labelPattern = /立即\s*沟通|继续\s*沟通|立\s*刻\s*沟通|打个\s*招呼|打\s*招呼|聊\s*一\s*聊|去\s*沟通|开始\s*沟通/;
  const candidates = [
    ...all(BOSS_SELECTORS.chatButton),
    ...all('button,a,[role="button"],span,div').filter((el) => labelPattern.test(textOf(el))),
  ];
  return candidates.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') || null;
}

function sendButton(input) {
  if (!input) return null;
  const labelMatch = all('button,[role="button"],[class*="send"]').find((el) => {
    if (!visible(el) || el.disabled) return false;
    const label = textOf(el);
    if (/发送简历|发送附件|发送在线简历|发简历|图片/.test(label)) return false;
    return /^发送$/.test(label) || /(chat[-_]?send|send[-_]?message|sendbtn|send-btn)/i.test(String(el.className || ''));
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

// 岗位卡片提取（对齐 job-claw-main cards()）
function collectCards() {
  const selectors = [
    '.job-list-box .job-card-wrapper',
    'li.job-card-wrapper',
    '.search-job-result .job-card-wrapper',
    '.job-list-box li',
    'a[href*="/job_detail/"]',
  ];
  const candidates = selectors.flatMap((s) => all(s))
    .map((el) => el.closest('.job-card-wrapper, li') || el)
    .filter(visible);
  return [...new Set(candidates)].filter((el, i, items) => {
    const content = textOf(el);
    if (!content || content.length > 900) return false;
    return !items.some((other, oi) => oi !== i && other.contains(el) && textOf(other).length < content.length);
  });
}

// 卡片身份（对齐 job-claw-main cardIdentity）
function cardIdentity(card) {
  const anchor = card.querySelector('a[href*="job_detail"]');
  const title = textOf(card.querySelector('[class*="job-name"],[class*="job-title"],[class*="jobName"],h3,h4'))
    || textOf(anchor)
    || textOf(card).split(/\s{2,}|\n/)[0]
    || '';
  const company = textOf(card.querySelector('[class*="company-name"],[class*="companyName"],[class*="company"]')) || '';
  return { title: title.slice(0, 80), company: company.slice(0, 80), href: anchor?.href || '', raw: textOf(card).slice(0, 500) };
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = targets[Math.min(attempt, targets.length - 1)] || card;
    try { await clickElement(target); } catch { /* 虚拟列表滚动后节点可能失效，下一轮重试 */ }
    const timeout = attempt === 0 ? 6500 : 4500;
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
    await sleep(260 + attempt * 180);
  }
  const fallback = detailRoot();
  if (fallback && (detailMatchesCard(fallback, card) || isSelectedCard(card))) return fallback;
  return null;
}

// 提取岗位信息（对齐 job-claw-main extractJob）：url/jobId 从 <a href*="job_detail"> 真实链接取
function extractJobDetail(card) {
  const root = detailRoot();
  const cardText = textOf(card);
  const detailText = textOf(root);
  const anchor = card.querySelector('a[href*="job_detail"]') || root?.querySelector('a[href*="job_detail"]');
  const title = textOf(root?.querySelector('h1,h2,[class*="job-name"],[class*="name"]'))
    || cardText.split(' ').slice(0, 4).join(' ')
    || '岗位';
  const company = textOf(root?.querySelector('[class*="company-name"],a[href*="gongsi"],[class*="company"]'))
    || textOf(card.querySelector('[class*="company"]'))
    || '';
  const salaryMatch = `${cardText} ${detailText}`.match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/);
  const locationMatch = `${cardText} ${detailText}`.match(/北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛/);
  const realUrl = anchor?.href || location.href;
  const chatBtn = communicateButton();
  const chatUrl = String(chatBtn?.href || chatBtn?.closest?.('a')?.href || '');
  return {
    title,
    company,
    salary: salaryMatch?.[0] || '',
    location: locationMatch?.[0] || '',
    description: detailText.slice(0, 9000),
    cardText: cardText.slice(0, 1000),
    url: realUrl,
    jobId: jobUrlToken(realUrl),
    chatUrl,
  };
}

// 采集运行时控制
const collectCtl = { paused: false, stopped: false, settleMs: 1200 };
async function waitWhilePaused() {
  while (collectCtl.paused && !collectCtl.stopped) await sleep(200);
}

// 可视化采集主循环：逐卡片 滚动 → 高亮 → 点击展开 → 提取，实时回传进度。
// 关键（对齐 job-claw-main）：BOSS 使用虚拟列表，点击后卡片节点会被替换，
// 每轮重新 collectCards()，用 cardKey 去重（processed Set），index 递增，避免持有失效 DOM。
async function visualCollect(opts = {}) {
  collectCtl.paused = false;
  collectCtl.stopped = false;
  collectCtl.settleMs = Math.max(400, Number(opts.settleMs) || 1200);
  const settleMs = collectCtl.settleMs;
  const processed = new Set();
  let index = 0;
  let processedCount = 0;
  notify('collect-progress', { phase: 'start', index: 0, total: 0, status: '准备中' });
  while (!collectCtl.stopped) {
    await waitWhilePaused();
    if (collectCtl.stopped) break;
    const cards = collectCards();
    if (index >= cards.length) break;
    const card = cards[index];
    index += 1;
    const key = collectCardKey(card);
    if (!key || processed.has(key)) continue;
    processed.add(key);
    const identity = cardIdentity(card);
    // 1) 平滑滚动到卡片并高亮（可视化动画）
    await smoothScrollIntoView(card);
    highlightElement(card, settleMs);
    notify('collect-progress', { phase: 'scroll', index, total: cards.length, title: identity.title, company: identity.company, status: '滚动中' });
    await sleep(settleMs);
    if (collectCtl.stopped) break;
    await waitWhilePaused();
    // 2) 点击展开详情
    notify('collect-progress', { phase: 'click', index, total: cards.length, title: identity.title, company: identity.company, status: '点击中' });
    await openCardDetail(card);
    await sleep(Math.max(500, Math.round(settleMs * 0.6)));
    if (collectCtl.stopped) break;
    // 3) 提取岗位信息并回传
    const job = extractJobDetail(card);
    processedCount += 1;
    notify('collect-progress', { phase: 'done', index, total: cards.length, title: job.title, company: job.company, status: '完成', job });
    await sleep(settleMs);
  }
  notify('collect-done', { listUrl: location.href, processed: processedCount, total: processedCount });
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

// ===== 页面监听 =====
reportNav();
reportLogin();
const obs = new MutationObserver(() => { reportNav(); reportLogin(); });
obs.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', () => { reportNav(); reportLogin(); });
setTimeout(() => { reportNav(); reportLogin(); }, 1200);
setTimeout(() => { reportNav(); reportLogin(); }, 4000);
