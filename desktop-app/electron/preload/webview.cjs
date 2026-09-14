// electron/preload/webview.cjs —— BossClaw 内置浏览器 webview 预加载（重写版）
//
// 重写目标（对齐 boss-auto-job-main 的官方接口链路，替代脆弱的 DOM 自动化）：
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

// BOSS 直聘薪资「字体混淆」还原：平台把薪资里的数字替换为 Unicode 私有区（PUA）码位，
// 再用自定义字体渲染，DOM 文本因此不含可读数字（'0-9' → U+E031-U+E03A，'.' → U+E02F）。
// 实测为固定线性偏移（PUA = 数字 ASCII + 0xE001），还原后才能正常展示/解析薪资区间。
function decodeSalaryDigits(s) {
  return String(s == null ? '' : s).replace(/[\uE02F\uE031-\uE03A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xE001));
}

// 岗位描述清洗：DOM 兜底抓取详情容器时可能匹配到过大的节点（整页文本），
// 混入页面级噪音——「去App 与BOSS随时沟通」「求职工具 升级VIP」「热门职位/热门城市/
// 热门企业/附近城市」推荐区、以及标题行操作按钮「收藏/立即沟通/举报/微信扫码分享」。
// 统一在此剔除，只保留岗位相关信息（标题行 + 职位描述正文 + HR 信息）。
function cleanJobDescription(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // 终止锚点：首个命中位置之后均为页面级内容，直接截断
  const cutAt = text.search(
    /去App|前往App|与BOSS随时沟通|求职工具|升级VIP|去升级|热门职位|热门城市|热门企业|附近城市|点击查看地图|查看更多信息|查看地图|工作地址|下载BOSS直聘|下载App|打开App|扫码下载/
  );
  let cleaned = cutAt >= 0 ? text.slice(0, cutAt) : text;
  // 显式删除词：标题行/banner 的操作按钮与分享文案
  cleaned = cleaned
    .replace(/\s*收藏\s*/g, ' ')
    .replace(/\s*立即沟通\s*/g, ' ')
    .replace(/\s*举报\s*/g, ' ')
    .replace(/\s*微信扫码分享\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}
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

// 人类化延迟抖动：baseMs 为「标称间隔」，实际等待在 ±jitterRatio（默认 0.35，即 65%~135%）内随机。
// 用途：投递/点击动作链的所有固定等待必须用它——反复出现的固定毫秒间隔是机器人识别特征（对应
// job-claw-main 的 humanizeDelay 思路），每次取值都不同可显著降低被风控规律判定的概率。
function jitterDelay(baseMs, jitterRatio = 0.35) {
  const base = Math.max(40, Number(baseMs) || 0);
  const span = base * jitterRatio;
  return sleep(Math.round(base + (Math.random() * 2 - 1) * span));
}

// ===== 平台分发（多平台适配：BOSS + 猎聘 + 智联 + 51Job）=====
// BOSS 直聘走完整 boss-api / 视觉采集链路（下方原逻辑不变）；
// 其余平台提供轻量适配：列表页判定 + 卡片提取 + 详情提取 + 「加入任务」（手动浏览/采集）。
// 投递动作仍由 Camoufox Python 桥负责（本 preload 不重复实现）。
function detectPlatform() {
  const host = String(location.hostname || '').toLowerCase();
  if (host.includes('liepin.com')) return 'liepin';
  if (host.includes('zhaopin.com')) return 'zhaopin';
  if (host.includes('51job.com')) return 'job51';
  return 'boss';
}
const PLATFORM = detectPlatform();

const PLATFORM_LIST_SELECTORS = {
  liepin: ['li[data-tlg-ext]', '[class*="job-card"]', '[class*="jobCard"]', 'a[href*="/job/"]'],
  zhaopin: ['[class*="joblist-box"] a', '[class*="joblist"] a', '[class*="job-card"]', 'a[href*="/jobdetail/"]'],
  job51: ["a[href*='/pc/jobdetail?jobId=']", "a[href*='jobs.51job.com/']", '[class*="j_joblist"] li', '.joblist li', '.j_joblist .joblist-item'],
};

function pickText(selectors, root = document) {
  for (const sel of selectors) {
    const el = $(sel, root);
    if (el) { const t = textOf(el); if (t) return t; }
  }
  return '';
}

function platformCollectCards() {
  const sels = PLATFORM_LIST_SELECTORS[PLATFORM] || [];
  const out = [];
  const seen = new Set();
  for (const sel of sels) {
    for (const el of all(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const card = el.closest('li, [class*="job-card"], [class*="joblist"], [class*="jobItem"], [class*="job-list"]') || el;
      if (visible(card) && textOf(card).length > 5 && textOf(card).length <= 900) out.push(card);
    }
  }
  return [...new Set(out)];
}

function platformListPage() {
  const url = String(location.href || '');
  const count = (() => { try { return platformCollectCards().length; } catch { return 0; } })();
  let isList = false;
  if (PLATFORM === 'liepin') isList = /\/zhaopin\//.test(url);
  else if (PLATFORM === 'zhaopin') isList = /\/sou\//.test(url) || /sou\.zhaopin/.test(url);
  else if (PLATFORM === 'job51') isList = /\/pc\/search/.test(url);
  return { isListPage: isList && !/job_detail|jobdetail|\/job\/\d+/i.test(url), listCardCount: count };
}

// 非 BOSS 平台详情页岗位提取（URL jobId + 通用文本字段）
function platformExtractJob() {
  const url = location.href;
  let jobId = '';
  if (PLATFORM === 'liepin') {
    const m = url.match(/\/job\/(\d+)/i) || url.match(/jobId=(\d+)/i);
    if (m) jobId = m[1];
  } else if (PLATFORM === 'zhaopin') {
    const m = url.match(/jobdetail\/([^/?]+)/i);
    if (m) jobId = m[1];
  } else if (PLATFORM === 'job51') {
    const m = url.match(/jobId=(\d+)/i) || url.match(/jobs\.51job\.com\/([^/]+)/i);
    if (m) jobId = m[1];
  }
  const title = pickText(['h1', '[class*="job-title"]', '[class*="job-name"]', '[class*="position"] h3', 'title']) || document.title;
  // 公司名：窄选择器优先，避免 [class*="company"] 命中地点容器；cleanCompanyName 兜底
  const company = cleanCompanyName(pickText(['[class*="company-name"] .name', '[class*="company-name"]', '[class*="companyName"]', '[class*="comp-name"]', '.cname', 'a[href*="gongsi"]', 'a[href*="company"]']));
  const salary = decodeSalaryDigits(pickText(['[class*="salary"]', '[class*="sal"]', '[class*="price"]', '[class*="money"]']));
  const location = pickText(['[class*="job-area"]', '[class*="area"]', '[class*="address"]', '[class*="location"]']);
  const description = textOf(document.body).slice(0, 6000);
  notify('job-extracted', {
    platform: PLATFORM,
    url,
    title,
    company,
    salary,
    location,
    description,
    jobId,
    ...platformListPage(),
  });
}


// ===== 横向滚动兜底（修复智联等 PC 招聘站页面被截断、无法左右滑动）=====
// 根因：智联等站点 html/body 设了 overflow-x:hidden + 固定宽度布局，当内置 webview 视口
// 宽度小于其设计最小宽度时，右侧内容被裁剪且无横向滚动条，用户无法左右拖动。
// BOSS 直聘为响应式布局、已知可正常横向滚动，跳过避免回归。
// 修复：强制 html/body 允许横向滚动并显示滚动条；部分站点用 JS 反复重置 overflow，
// 用 MutationObserver 兜底覆盖。外部容器 .browser-viewport/.browser-pane 的 overflow:hidden
// 不影响 webview 内部 OOPIF 自身滚动，故此处从页面上下文修复。
function injectHorizontalScrollFix() {
  if (PLATFORM === 'boss') return; // BOSS 响应式，已知正常，跳过避免回归
  const CSS = [
    // 把 html 锁成视口高度的滚动容器：横向滚动条因此固定在 webview 视口底边（与纵向一致常驻），
    // 而非随文档流出现在整页底部（须拉到最底才出现）。body 的 overflow 设为 visible，
    // 让横向/纵向溢出统一由 html 处理（CSS overflow 传播规则）。
    'html {',
    '  height: 100% !important;',
    '  max-height: 100% !important;',
    '  overflow-x: auto !important;',
    '  overflow-y: auto !important;',
    '  -ms-overflow-style: auto !important;',
    '  scrollbar-width: auto !important;',
    '}',
    'body {',
    '  min-height: 100% !important;',
    '  max-width: none !important;',
    '  width: auto !important;',
    '  overflow-x: visible !important;',
    '  overflow-y: visible !important;',
    '}',
    '::-webkit-scrollbar { width: 11px !important; height: 11px !important; display: block !important; }',
    '::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.28) !important; border-radius: 6px !important; }',
    '::-webkit-scrollbar-track { background: rgba(0,0,0,0.04) !important; }',
  ].join('\n');

  const applyStyle = () => {
    if (document.getElementById('bossclaw-scrollfix')) return;
    const s = document.createElement('style');
    s.id = 'bossclaw-scrollfix';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  };

  // 兜底：部分站点用 JS 反复重置 html/body 的 overflow 为 hidden，强制改回
  // （html 改 auto 作为视口滚动容器，body 改 visible 让溢出传播给 html）
  const enforceOverflow = () => {
    try {
      const html = document.documentElement;
      const body = document.body;
      if (html && (html.style.overflowX === 'hidden' || html.style.overflow === 'hidden')) {
        html.style.overflowX = 'auto';
        html.style.overflow = 'auto';
      }
      if (body && (body.style.overflowX === 'hidden' || body.style.overflow === 'hidden')) {
        body.style.overflowX = 'visible';
        body.style.overflow = 'visible';
      }
    } catch {}
  };

  const start = () => {
    applyStyle();
    enforceOverflow();
    try {
      const obs = new MutationObserver(() => enforceOverflow());
      if (document.documentElement) obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    } catch {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  // SPA 路由切换 / 延迟脚本重置后二次兜底
  setTimeout(enforceOverflow, 800);
  setTimeout(enforceOverflow, 2000);
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

let lastNavSig = ''; // 导航状态变化去重：内容未变则不重复上报（BOSS 页 DOM 高频变动时防止每帧 IPC 风暴）
function reportNav() {
  try {
    const canGoBack = spaIndex > 0;
    const canGoForward = spaIndex >= 0 && spaIndex < spaHistory.length - 1;
    const sig = location.href + '\u0001' + document.title + '\u0001' + (canGoBack ? '1' : '0') + (canGoForward ? '1' : '0');
    if (sig === lastNavSig) return;
    lastNavSig = sig;
    notify('nav', { url: location.href, title: document.title, canGoBack, canGoForward });
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
let lastLoginSig = ''; // 登录态变化去重：结果与上次一致则不重复上报
function reportLogin() { try { const d = detectLogin(); const sig = JSON.stringify(d); if (sig === lastLoginSig) return; lastLoginSig = sig; notify('login-state', d); } catch {} }

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
// options.timeoutMs 可覆盖单次请求超时（默认 15s；「加入任务」提取链用 8s，确保 API 超时后
// DOM 兜底仍在渲染层 10s 解析预算内完成，避免超时兜底空卡）。
async function zpFetch(path, options = {}) {
  const { timeoutMs = 15000, ...fetchOpts } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(fetchOpts.headers || {}) },
      ...fetchOpts,
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

// 从详情页内嵌脚本中的 var _jobInfo = { job_id, user_id, job_name, job_salary, company, ... } 提取权威岗位数据。
// 该对象是页面自身渲染出来的，必然与网页展示一致；card.json API（缺 securityId 可能返回错岗）或
// DOM banner 选择器（新版页面不匹配）拿到与页面不符的数据时，用它覆盖，保证「加入任务」入队信息与网页一致。
// 用正则按 key 精确取值（不 eval 页面脚本，避免注入风险）。
function extractEmbeddedJobInfo() {
  const texts = [];
  document.querySelectorAll('script').forEach((s) => {
    const t = s.textContent || '';
    if (/_jobInfo\s*[:=]/.test(t)) texts.push(t);
  });
  const g = (key) => {
    for (const t of texts) {
      const m = t.match(new RegExp(key + '\\s*[:=]\\s*[\'“]([^\'”]*?)[\'“]'));
      if (m) {
        const v = m[1].trim();
        if (v) return v;
      }
    }
    return '';
  };
  return {
    title: g('job_name'),
    salary: g('job_salary'),
    company: g('company'),
    encryptUserId: g('user_id'),
    securityId: g('securityId'),
  };
}

// meta[name=description] 规格化职场信息（薪资/地点/要求），meta 必然反映当前岗位，作为权威兜底之一。
function metaJobBasics() {
  const c = metaDescriptionText();
  if (!c) return {};
  const out = {};
  const salary = c.match(/薪资\s*[:：]\s*([^，,。；]+)/);
  if (salary) out.salary = salary[1].trim();
  const loc = c.match(/地点\s*[:：]\s*([^，,。；]+)/);
  if (loc) out.location = loc[1].trim();
  const req = c.match(/(?:要求|经验)\s*[:：]\s*([^，,。；]+)/);
  if (req) out.requirement = req[1].trim();
  return out;
}

// meta[name=keywords] 第一个 token 即岗位名（如「中级JAVA工程师,…」）。
function titleFromMetaKeywords() {
  const k = document.querySelector('meta[name="keywords"]');
  const raw = k && k.content ? String(k.content) : '';
  const first = String(raw).split(',')[0].trim();
  if (first && first.length <= 80) return first;
  return '';
}

// 用页面权威数据覆盖 title/company/salary/location：优先 _jobInfo，回退 meta description/keywords 与 <title>。
// meta 与内嵌 _jobInfo 必然反映「当前详情页岗位」，可纠正 card.json API 缺 securityId 时返回的错岗（如把
//「中级JAVA工程师 7-12K」误报成「Java开发工程师 5-10K」），保证「加入任务」入队卡片信息与网页一致。
// 仅当当前页确为岗位详情页时才覆盖，避免列表页的通用 meta 误写。
function applyEmbeddedOverlay(job) {
  if (!/job_detail|jobdetail/i.test(String(location.href || ''))) return job;
  const embedded = extractEmbeddedJobInfo();
  const basics = metaJobBasics();
  const kwTitle = titleFromMetaKeywords();
  const out = { ...job };
  if (embedded.company) out.company = embedded.company;
  else { const ct = companyFromTitle(); if (ct) out.company = ct; }
  if (embedded.title || kwTitle) out.title = embedded.title || kwTitle;
  if (embedded.salary || basics.salary) out.salary = embedded.salary || basics.salary;
  if (basics.location) out.location = basics.location;
  if (!out.description && basics.requirement) out.description = basics.requirement;
  if (embedded.encryptUserId) out.encryptUserId = embedded.encryptUserId;
  if (embedded.securityId) out.securityId = embedded.securityId;
  return out;
}

// DOM 兜底：从详情页 banner 提取岗位基本信息（API 失败时用）
// 工作制度 / 福利标签提取（如「周末双休」「大小周」「单休」「做六休一」）。
// 用途：日薪（元/天）折算月薪时的月工作日基数（双休 22 / 大小周 24 / 单休 26），
// 见渲染层 src/lib/bossclaw/workSchedule.ts。只保留短标签，避免把整段 JD 文本混进来。
//
// 除工作制度外，还提取「有用福利」（五险一金 / 年终奖 / 带薪年假 等展示用福利），
// 供工作台中间「岗位进度」列表直接展示，替代干燥的 HR 活跃度。来源分两个：
//   1) BOSS meta[name=description] 规格化文案里的「福利：年终奖、员工旅游、五险，…」；
//   2) 详情页标签区（.job-tags span 等）。
const WELFARE_BENEFIT_RE =
  /(五险一金|六险一金|三险一金|五险|住房公积金|公积金|年终奖|年终分红|绩效奖金|带薪年假|带薪休假|定期体检|补充医疗|股票期权|股权激励|生日福利|节日福利|节假日福利|团建聚餐|团建|免费午餐|免费三餐|员工食堂|零食下午茶|全勤奖|加班补助|加班补贴|夜班补助|夜班补贴|交通补助|交通补贴|住房补贴|房补|餐补|饭补|有无线网|节假日加班费|企业年金|底薪加提成|保底工资|员工旅游|年度旅游|免费班车|弹性工作|人才公寓|提供宿舍|宿舍|包住|包吃|双休|大小周|单休|轮休)/;
// 工作制度信号（供日薪折算月工作日基数的 workSchedule 识别，见 workSchedule.ts）
const WELFARE_WORK_RE = /休|班|工作制|弹性/;
// 排除非福利噪声（活跃 / 开聊 / 招聘方措辞等）
const WELFARE_NOISE_RE = /在线|刚刚|开聊|随时随地|直接|招聘|hr|擅长|沟通/;

function metaDescriptionText() {
  const m = document.querySelector('meta[name="description"]');
  return m && m.content ? String(m.content) : '';
}

// 从 BOSS 规格化 meta description 提取「有用福利」（如「福利：年终奖、员工旅游、五险」）。
function extractBenefitsFromMeta() {
  const content = metaDescriptionText();
  if (!content) return [];
  const seg = content.match(/福利\s*[:：]\s*([^。；]+)/);
  if (!seg) return [];
  return seg[1]
    .split(/[、,，,;；]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 12 && !WELFARE_NOISE_RE.test(t) && WELFARE_BENEFIT_RE.test(t));
}

// 采集路径源码兜底（与「加入任务」同口径）：列表页当前文档的 meta description 是列表通用文案，
// 拿不到该岗位详情福利。直接抓岗位详情页 HTML（同源 fetch + 登录态），从源码 meta description
// 提取「福利：…」段与正/负信号关键字并入 welfare，保证工作台五险一金等标签可显示。
// 抓取失败（风控/网络/非详情链接）静默返回空，不阻塞采集主循环。
async function fetchDetailSourceWelfare(jobUrl) {
  try {
    const u = String(jobUrl || '');
    if (!/job_detail|jobdetail/i.test(u)) return [];
    const res = await fetch(u, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) return [];
    const html = await res.text();
    if (!html || html.length < 200) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const content = (doc.querySelector('meta[name="description"]')?.content || '').trim();
    if (!content) return [];
    const seg = content.match(/福利\s*[:：]\s*([^。；]+)/);
    const out = [];
    if (seg) {
      for (const t of seg[1].split(/[、,，,;；]/)) {
        const tt = String(t).trim();
        if (tt.length >= 2 && tt.length <= 12 && !WELFARE_NOISE_RE.test(tt) && WELFARE_BENEFIT_RE.test(tt)) out.push(tt);
      }
    }
    return [...new Set([...out, ...scanPositiveKeywords(content), ...scanRiskKeywords(content)])];
  } catch { return []; }
}

// 潜在「陷阱」关键字（工作台标黄提示）。不限于福利段——整段 meta description + JD 描述均参与命中，
// 命中即追加进 welfare 供黄标展示（如 高提成/底薪加提成/期权/押金/培训费/管培生/保录/直签 …）。
const RISK_KEYWORDS = [
  ['弹性工作/弹性工时', /弹性工作|弹性工时|弹性上下班|不定时工时|不固定工时/],
  ['不定时工作制', /不定时工作制|不定时工时制/],
  ['高提成', /高提成|提成上不封顶|上不封顶|提成不封顶/],
  ['底薪加提成', /底薪\s*[加和]?\s*提成|底薪提成/],
  ['有责底薪', /有责底薪/],
  ['无责底薪', /无责底薪/],
  ['期权/股权', /期权|股权激励|虚拟股权/],
  ['分红', /项目分红|事业合伙人|分红/],
  ['押金/培训费', /押金|培训费|岗前培训|服装费|保证金|实训|先交|先付费/],
  ['试岗', /无薪试岗|试岗/],
  ['管培生', /管培生/],
  ['储备干部', /储备干部/],
  ['保录/直签', /保录|直签/],
  ['抗压/吃苦', /抗压能力强|能吃苦耐劳|抗压/],
  // 发散补充的常见用工风险（与渲染层 welfareTag 同口径，确保 meta/JD 中命中即入库）
  ['无偿加班', /无偿加班|加班文化|强制加班|经常加班|加班较多|加班严重|加班多/],
  ['狼性/末位淘汰', /狼性文化|末位淘汰|末尾淘汰/],
  ['试用期不缴社保', /试用期不缴|试用期无社保|不缴社保|转正才缴/],
  ['长期试用期', /试用期\s*(?:[6-9]\d*|1[0-9]|一年|1年|半年)\s*个?月?/],
  ['长期出差/驻场', /长期出差|频繁出差|出差频繁|驻场/],
  ['无薪实习', /无薪实习|无工资实习|不给实习工资/],
  ['就业歧视', /限男性|限女性|限35岁|已婚已育优先|未婚未育优先/],
];
function scanRiskKeywords(...texts) {
  const t = texts.filter(Boolean).join(' ');
  if (!t) return [];
  return RISK_KEYWORDS.filter(([, re]) => re.test(t)).map(([label]) => label);
}

// 好工作「正面信号」关键字（工作台绿标）。不限于福利段——整段 meta description + JD 描述均参与命中，
// 命中即追加进 welfare 供绿标展示（如 六险二金/13薪/带薪病假/加班费/调休/免费班车/上市公司/不内卷 …）。
const POSITIVE_KEYWORDS = [
  ['六险二金', /六险二金|6险2金/],
  ['九险二金', /九险二金|9险2金/],
  ['六险一金', /六险一金/],
  ['五险一金', /五险一金/],
  ['三险一金', /三险一金/],
  ['五险', /[五5]险/],
  ['住房公积金', /住房公积金/],
  ['公积金', /公积金|住房公积金/],
  ['补充医疗', /补充医疗|补充商业保险|补充商业医疗/],
  ['补充养老', /补充养老|企业年金/],
  ['13薪', /13薪/],
  ['14薪', /14薪/],
  ['15薪', /15薪/],
  ['16薪', /16薪/],
  ['年底双薪', /年底双薪|年末双薪|十三薪/],
  ['年终奖', /年终奖/],
  ['绩效奖金', /绩效奖金|绩效奖/],
  ['带薪年假', /带薪年假|带薪休假/],
  ['带薪病假', /带薪病假|全薪病假/],
  ['加班补助', /加班补助|加班补贴|加班费|加班工资/],
  ['调休', /调休/],
  ['加班餐', /加班餐/],
  ['打车报销', /打车报销|车费报销/],
  ['免费三餐', /免费三餐|免费早午餐|免费工作餐|包三餐/],
  ['员工食堂', /员工食堂|食堂/],
  ['餐补', /餐补|饭补/],
  ['交通补助', /交通补助|交通补贴|通勤补助/],
  ['免费班车', /免费班车|班车/],
  ['住房补贴', /住房补贴|房补/],
  ['通讯补贴', /通讯补贴|话费补贴/],
  ['定期体检', /(免费|年度)?体检|年度体检/],
  ['健身房', /健身房/],
  ['节日福利', /节日福利|节假福利|节日礼物|过节费/],
  ['生日福利', /生日福利|生日礼/],
  ['员工旅游', /员工旅游|年度旅游|团建/],
  ['上市公司', /上市(公司)?/],
  ['500强', /500强|五百强/],
  ['不内卷', /不内卷|没有内卷|拒绝内卷/],
  ['无销售性质', /无销售性质|不含销售|纯文职|不推销/],
];
function scanPositiveKeywords(...texts) {
  const t = texts.filter(Boolean).join(' ');
  if (!t) return [];
  return POSITIVE_KEYWORDS.filter(([, re]) => re.test(t)).map(([label]) => label);
}

function extractWelfareTags(root) {
  const scope = root || document;
  // 详情页标签区：保留「有用福利」与工作制度短标签
  const nodes = all(
    '.job-tags span, .tag-all span, [class*="job-tag"] span, [class*="tag-list"] span, [class*="job-labels"] span, [class*="welfare"] span',
    scope
  );
  const domTags = nodes
    .map((el) => textOf(el))
    .filter((t) => t && t.length <= 12 && (WELFARE_BENEFIT_RE.test(t) || WELFARE_WORK_RE.test(t)) && !WELFARE_NOISE_RE.test(t));
  // meta description 兜底（BOSS 规格化文案里带「福利：…」）
  const metaTags = extractBenefitsFromMeta();
  // 「正面信号」与「陷阱」关键字：不限于福利段，整段 meta description + 页面正文均参与命中
  const bodyText = ((scope && scope.innerText) || document.body.innerText || '').slice(0, 3000);
  const positiveTags = scanPositiveKeywords(metaDescriptionText(), bodyText);
  const riskTags = scanRiskKeywords(metaDescriptionText(), bodyText);
  return [...new Set([...domTags, ...metaTags, ...positiveTags, ...riskTags])].slice(0, 16);
}

function extractJobFromDom() {
  const banner = $('.job-banner, .job-detail-header, .job-header');
  const scopeEl = banner || document.body;
  // 用「还原混淆后」的整段文本做兜底（PUA 数字先还原，否则薪资正则永远匹配不到）。
  // scopeText 覆盖更大范围（6000 字），避免薪资/城市出现在前 3000 字之外被漏掉。
  const scopeText = decodeSalaryDigits((scopeEl && scopeEl.innerText) || '').slice(0, 6000);
  const pick = (sels) => { for (const s of sels) { const t = textOf($(s)); if (t) return t; } return ''; };
  const title = pick(['.job-banner .name', 'h1.job-name', '[class*="job-title"] .name', '.job-title', '[class*="job-name"]', '.name', 'h1']) || document.title;
  // 公司名：精确窄选择器优先；末了用标题兜底（BOSS 标题固定含「_公司名招聘-BOSS直聘」），再用 cleanCompanyName 兜掉地点串
  const company = cleanCompanyName(pick(['.job-banner .company', '.company-name', '.company-info .name', '.company-brand', '.business-name', '[class*="company-name"]', '[class*="company"] .name', 'a[href*="gongsi"] .name', 'a[href*="gongsi"]']) || companyFromTitle());
  // 薪资：选择器优先；兜底正则在还原后的整段文本上跑（与采集 cardFields 同口径，
  // 新版页面/选择器不命中时也能从正文拿到薪资）
  const salary = decodeSalaryDigits(pick(['.job-banner .salary', '.salary', '.job-salary', '[class*="job-salary"]', '[class*="salary"]']))
    || scopeText.match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/)?.[0]
    || '';
  // 地点：选择器优先（含新版 a.text-city 城市链接）；兜底城市关键字正则（与采集 cardFields 同口径），
  // 之后 applyEmbeddedOverlay 还会用 meta「地点：」权威覆盖。
  const location = pick(['.job-banner .location', '.job-area', '.job-location .location-address', '.location-address', '[class*="job-address"]', '[class*="location"]', 'a.text-city'])
    || scopeText.match(/北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|全国/)?.[0]
    || '';
  const description = cleanJobDescription(scopeText).slice(0, 1500);
  // 内嵌 _jobInfo 为权威：覆盖 title/company/salary，meta「地点：」覆盖 location，保证与网页一致
  const job = applyEmbeddedOverlay({ url: location.href, title, company, salary, location, description, welfare: extractWelfareTags(banner || document) });
  // 诊断证据：关键字段全缺时带回「页面里到底有没有数据」，用于区分空壳页（未登录/被拦截）还是选择器不匹配
  if (!job.company && !job.salary && !job.location) {
    job.parseDiag = 'dom|' +
      `metaLen=${metaDescriptionText().length}|` +
      `embedded=${JSON.stringify(extractEmbeddedJobInfo())}|` +
      `titleLen=${String(document.title || '').length}|body=${String(scopeText || '').replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  return job;
}

// 列表页判定：URL 是推荐/搜索列表页，或页面上存在 >1 张岗位卡片（供上层「加入任务」守卫用）。
// 详情页 URL（job_detail 等）必须短路为非列表：详情页常带「相关推荐/猜你喜欢」区块，
// 其 a[href*="/job_detail/"] 会被 collectCards 计入，导致 listCardCount>1 被上层误判为列表页。
function listPageInfo() {
  const href = String(location.href || '');
  if (/job_detail|jobdetail|\/job\/\d+/i.test(href)) {
    return { isListPage: false, listCardCount: 0 };
  }
  const cardCount = (() => { try { return collectCards().length; } catch { return 0; } })();
  const isListUrl = /\/web\/geek\/(job|jobs|recommend)\/?/i.test(String(location.pathname || ''));
  return { isListPage: isListUrl && !/job_detail/i.test(href), listCardCount: cardCount };
}

async function extractJob() {
  const jid = extractEncryptJobIdFromUrl();
  // API 风控/异常码仅作元数据回传（供上层感知），不再因 API 被拦而早退——页面 DOM 仍可能渲染完整岗位信息。
  // 若 API 出错就直接以 error/riskCode 早退，会让「加入任务」卡片公司/地点/薪资全缺、长期停留在「信息补全」。
  let apiRiskCode = null;
  let apiError = '';
  if (jid) {
    const card = await zpFetch(`/wapi/zpgeek/job/card.json?encryptJobId=${encodeURIComponent(jid)}`, { timeoutMs: 8000 });
    if (card && card.code === 0 && card.zpData) {
      const d = card.zpData;
      const method = (s) => { try { return String(s || ''); } catch { return ''; } };
      const apiJob = applyEmbeddedOverlay({
        url: location.href,
        title: d.jobName || d.jobTitle || document.title,
        company: cleanCompanyName(d.brandName || d.companyName || companyFromTitle() || ''),
        salary: decodeSalaryDigits(method(d.salaryDesc)),
        location: method(d.cityName || d.areaDistrict),
        description: method(d.jobDesc || d.postDescription),
        jobId: jid,
        encryptUserId: method(d.encryptUserId),
        bossName: method(d.bossName || d.recruiterName),
        bossTitle: method(d.bossTitle),
        skills: Array.isArray(d.skills) ? d.skills : [],
        labels: Array.isArray(d.jobLabels) ? d.jobLabels : [],
        // 福利/工作制度标签（如「周末双休」）：日薪折算月薪的工作日基数识别来源之一
        welfare: [
          ...(Array.isArray(d.welfareList) ? d.welfareList.map(String) : []),
          // 「正面信号」与「陷阱」关键字：对整段 JD 描述 + meta description 扫描（供工作台绿/黄标提示）
          ...scanPositiveKeywords(method(d.jobDesc || d.postDescription), metaDescriptionText()),
          ...scanRiskKeywords(method(d.jobDesc || d.postDescription), metaDescriptionText()),
        ],
        scaleName: method(d.scaleName),
        typeName: method(d.typeName),
      });
      // API 数据残缺（连公司/薪资/地点都没有，常见于缺 securityId 或接口返回空壳）时不直接用，
      // 回退到 DOM 兜底：全文正则可补；仍缺则带回 parseDiag 供定位「空壳页 vs 选择器不匹配」。
      if (apiJob.company || apiJob.salary || apiJob.location) {
        try {
          console.log('BOSS-CLAW-WELFARE api descLen=' + method(d.jobDesc || '').length + ' metaLen=' + metaDescriptionText().length
            + ' welfare=' + JSON.stringify(apiJob.welfare));
        } catch (e) {}
        notify('job-extracted', { ...apiJob, ...listPageInfo() });
        return;
      }
    } else if (card && card.code && card.code !== 0) {
      // code 37（环境异常）/17（登录失效）等风控码：记录后仍继续 DOM 兜底（页面本身可能正常渲染）
      apiRiskCode = card.code;
      apiError = `job/card 接口 code=${card.code}`;
    }
  }
  // DOM 兜底：API 失败/空壳/风控码一律执行（避免早退导致「信息补全」）；风控码作为元数据带回，不丢失信号
  try {
    const _r = extractJobFromDom();
    try { console.log('BOSS-CLAW-WELFARE dom descLen=' + String(_r.description || '').length + ' metaLen=' + metaDescriptionText().length + ' welfare=' + JSON.stringify(_r.welfare)); } catch (e) {}
    const full = { ..._r, ...listPageInfo() };
    if (apiRiskCode != null) { full.riskCode = apiRiskCode; full.error = apiError; }
    notify('job-extracted', full);
  } catch (e) {
    const fullErr = { url: location.href, title: document.title, error: String(e?.message || e), ...listPageInfo() };
    if (apiRiskCode != null) fullErr.riskCode = apiRiskCode;
    notify('job-extracted', fullErr);
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
  // 优先 contenteditable（BOSS 新版聊天输入框，#chat-input 即 contenteditable）；其次「立即沟通」弹窗的
  // textarea.input-area（dialog/startchat 容器内），最后才是通用 textarea / input。
  const candidates = [
    ...all('#chat-input'),
    ...all('[contenteditable="true"]'),
    ...all('[contenteditable="plaintext-only"]'),
    ...all('[class*="dialog"] textarea, [class*="startchat"] textarea, [class*="chat"] textarea'),
    ...all('.input-area, [class*="input-area"]'),
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

// 「继续沟通」入口判定：主沟通按钮文本为「继续沟通」（而非「立即沟通」）——
// 说明该岗位已与 HR 建立过会话（此前已投递/已沟通过），不应再按新投递发送招呼语。
// 交上层将该岗位移入「自动沟通」队列继续跟进（防重复投递同一 HR、不占今日投递名额）。
// 对齐 job-claw-main conversation-identity：已建立会话的岗位不再走首次打招呼。
function isContinueChatEntry() {
  const button = communicateButton();
  if (!button) return false;
  const label = textOf(button).replace(/\s+/g, '');
  return label === '继续沟通';
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

// 判定元素是否处于「禁用」态：原生态 disabled、aria-disabled，或 BOSS 用 class `disable/disabled` 表达（如 .send-message.disable）
function isDisabledish(el) {
  if (!el) return true;
  return Boolean(el.disabled)
    || el.getAttribute?.('aria-disabled') === 'true'
    || /(^|\s)disable(d)?(\s|$)/i.test(String(el?.className || ''));
}

function sendButton(input, opts = {}) {
  const allowDisabled = Boolean(opts && opts.allowDisabled);
  if (!input) return null;
  // 「立即沟通」弹窗的发送是 <div class="send-message disable">发送</div>（非 button），
  // 初始带 disable 类、由页面框架在输入内容后移除；allowDisabled=true 时也返回该元素，
  // 由调用方 waitFor 其启用后再点击（默认 false 保持原有语义：只认已启用按钮）。
  const usable = (el) => visible(el) && (allowDisabled || !isDisabledish(el));
  const sels = '.send-message, [class*="send-message"], [class*="sendMessage"], .send-btn, .btn-send, [class*="sendBtn"], [class*="btn-send"], [class*="chatSend"], [class*="chat-send"]';
  // 优先输入框所属编辑区/弹窗内的按钮（避免被页面底部全局的「发送」误命中）
  const scope = input.closest('[class*="edit-area"], [class*="editArea"], .startchat-content, [class*="startchat"], [class*="chat-input"], [class*="input-box"], [class*="editor"]');
  const scoped = scope ? all(sels).filter((el) => scope.contains(el)).find(usable) : null;
  const labelMatch = scoped || all(sels).find(usable);
  if (labelMatch) {
    const label = textOf(labelMatch);
    if (!/发送简历|发送附件|发送在线简历|发简历|图片/.test(label) && (/^发送$/.test(label) || /send/i.test(String(labelMatch.className || '')))) return labelMatch;
  }
  // 兜底：输入框右下方最近的「发送」按钮
  const inputRect = input.getBoundingClientRect();
  return all('button,[role="button"],[class*="send"]').find((el) => {
    if (!usable(el)) return false;
    const rect = el.getBoundingClientRect();
    return /^发送$/.test(textOf(el)) && Math.abs(rect.top - inputRect.bottom) < 200 && rect.left > inputRect.left - 60;
  }) || null;
}

// 文本归一化：去掉零宽字符/统一空白，用于气泡级匹配招呼文案
function normalizeChatText(t) {
  return String(t || '').replace(/[\u200b\u200c\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}
// 聚焦聊天输入框并仅选中/清空「编辑区内」内容（严禁 webContents.selectAll——会把整页文本选中变蓝），
// 返回真实可编辑节点；后续仍用可信 insertText（isTrusted）在编辑区光标处插入。
function focusEditableScoped(input) {
  const editor = input && input.matches('[contenteditable]')
    ? (input.querySelector('[contenteditable]') || input)
    : input;
  if (!editor) return editor;
  try {
    editor.focus();
    if (editor.matches('[contenteditable]')) {
      const sel = window.getSelection && window.getSelection();
      // 范围内仅指向编辑区本身，绝不含页面其余文本
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel?.removeAllRanges?.();
      sel?.addRange?.(range);
      if (normalizeChatText(editor.innerText || '')) {
        try { document.execCommand?.('delete'); } catch {}
      }
      // 收敛为编辑区末尾光标，供 insertText 插入
      const caret = document.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      sel?.removeAllRanges?.();
      sel?.addRange?.(caret);
    } else {
      // 原生 input/textarea：直接置空再聚焦
      editor.focus();
      if ('value' in editor && editor.value) {
        editor.value = '';
        try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      }
    }
  } catch {}
  return editor;
}
// 文字气泡确认：发送后聊天记录里出现刚发送的文字（安全不变量：未确认不计成功）。
// BOSS 聊天 DOM 屡次改版，气泡节点语义类各不相同：按「气泡级选择器 + 文本归一化」匹配，
// 避免只按固定的容器选择器整段判断而漏掉（导致已成功发送却被误判失败、未写入已投递）。
function confirmOwnMessage(greeting) {
  const needle = normalizeChatText(greeting).slice(0, 30);
  if (!needle || needle.length < 12) return false;
  // 聊天气泡节点语义类（对齐 job-claw-main chatMessageNodes 的选择器集）
  const bubbleSelectors = [
    '.message-content', '.chat-message', '.message-item', '.message-text',
    '[class*="message-content"]', '[class*="messageContent"]',
    '[class*="chat-message"]', '[class*="chatMessage"]',
    '[class*="message-item"]', '[class*="messageItem"]',
    '[class*="message-text"]', '[class*="messageText"]',
    '[class*="bubble"]', '[class*="chat-record"]', '[class*="chatRecord"]',
    '[class*="item-myself"]', '[class*="itemMyself"]',
    '[class*="msg-item"]', '[class*="msgItem"]', '[data-message-id]',
    '[class*="conversation"] .msg', '[class*="chat-list"] [class*="item"]',
  ];
  // 1) 气泡级精确匹配：某个消息节点正文等于招呼语或其前 30 字
  const nodes = new Set();
  for (const sel of bubbleSelectors) { for (const el of all(sel)) nodes.add(el); }
  for (const el of nodes) {
    if (!visible(el)) continue;
    const t = normalizeChatText(el.innerText || el.textContent || '');
    if (t && t.includes(needle)) return true;
  }
  // 2) 兜底：整篇页面正文包含招呼语（发送成功后输入框已清空，正文仅剩发出的气泡；覆盖选择器未命中的改版 DOM）
  return normalizeChatText(document.body?.innerText).includes(needle);
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
    // 判断是否为「继续沟通」入口：主沟通按钮是「继续沟通」而非「立即沟通」——
    // 说明该岗位已与 HR 建立过会话，需移入自动沟通队列不再由工作台直接投招呼语
    if (isContinueChatEntry()) {
      notify('apply-stage', { stage: 'continue_chat', label: '已检测到继续沟通入口，移入自动沟通队列' });
      return;
    }
    notify('apply-stage', { stage: 'open_chat', label: '打开沟通窗口' });
    let input = chatInput();
    // 已进入聊天页但输入框未就绪（渲染慢）：给足等待，不立即失败
    if (!input && /(\/web\/geek\/chat|\/chat(?:\/|\?|$))/i.test(location.href)) {
      input = await waitFor(() => chatInput(), 30000, '聊天输入框就绪');
    }
    if (!input) input = await enterChat();
    if (!input) {
      // 仍有沟通按钮 → 属「立即沟通/继续沟通」整页跳聊天页（preload 将重注入、原 domApply 中断）：
      // 不在此立即判失败，交由上层检测到聊天页后重发 start-apply 续跑补写 AI 招呼语。
      if (communicateButton()) { notify('apply-stage', { stage: 'navigating', message: '沟通入口需要跳转聊天页，等待聊天窗口就绪…' }); return; }
      notify('apply-stage', { stage: 'failed', error: '未找到真实可编辑的聊天输入框，已暂停' });
      return;
    }

    notify('apply-stage', { stage: 'fill_message', label: '填写招呼语' });
    // 仅编辑区内清空/聚焦（严禁整页 selectAll）；随后可信 insertText 插入。
    input.scrollIntoView({ block: 'center' });
    const editor = focusEditableScoped(input);
    // 沟通窗口渲染慢时 Slate 编辑器可能未完全就绪，单次 insertText 易失权：带重试 + 落盘文本校验。
    const needle20 = normalizeChatText(safeGreeting).slice(0, 20);
    let ins = { ok: false };
    for (let i = 0; i < 3 && !ins.ok; i++) {
      if (i > 0) { focusEditableScoped(editor); await jitterDelay(400); }
      ins = await trustedInput('insertText', safeGreeting);
      if (ins.ok) {
        const got = normalizeChatText(editor?.innerText || editor?.value || '');
        if (got && got.includes(needle20)) break; // 已落盘 → 成功
        ins = { ok: false }; // 被 Slate 渲染清掉 → 重试
        await jitterDelay(300);
      }
    }
    if (!ins.ok) {
      notify('apply-stage', { stage: 'failed', error: '真实输入写入失败，已暂停' });
      return;
    }
    await jitterDelay(120);

    notify('apply-stage', { stage: 'send_message', label: '发送招呼语' });
    // 兜底：通知框架输入框内容已变化。弹窗（.startchat-content）发送按钮是
    // <div class="send-message disable">发送</div>，由框架按输入值把 disable 类切掉；
    // 可信 insertText 有时只更新了 value 而未触发组件重渲染，这里补派发事件让按钮启用。
    try {
      const fire = () => {
        try { input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch {}
        try { input.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch {}
        try { input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: safeGreeting, inputType: 'insertText' })); } catch {}
      };
      fire();
      setTimeout(fire, 200);
    } catch {}
    // 找发送按钮（含 disable 态），等待框架把按钮切为可用后点击；点击后仍以文字气泡确认兜底。
    const btn = sendButton(input, { allowDisabled: true });
    if (btn) {
      try { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
      await waitFor(() => !isDisabledish(btn), 4000, '发送按钮启用');
      btn.click();
    } else {
      // 未找到按钮：弹窗 textarea 内回车是换行、不会发送，直接交人工；
      // 其余输入（contenteditable 聊天页等）仍退回回车发送兜底。
      const isDialogTextarea = input.matches('textarea');
      if (!isDialogTextarea) {
        const enter = await trustedInput('pressEnter');
        if (!enter.ok) {
          notify('apply-stage', { stage: 'failed', error: '未找到发送按钮且回车发送失败，已暂停' });
          return;
        }
      } else {
        notify('apply-stage', { stage: 'failed', error: '未找到可用的发送按钮（发送按钮可能未随输入内容启用），已暂停请人工发送' });
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
      await jitterDelay(300); // 轮询等待聊天输入框出现（节奏人肉化）
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

// ===== 可视化采集（对齐 job-claw-main 的 cards → cardIdentity → openCard → extractJob）=====
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
  await jitterDelay(600, 0.3); // 滚动停顿也要人肉化（采集逐卡滚动），避免固定 600ms 节奏
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
  await jitterDelay(180);
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
    await jitterDelay(140);
  } finally {
    sanitized.restore();
  }
  await jitterDelay(200);
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

// 地名识别（修复「公司 Top」把地点误当公司名）：
// BOSS 卡片地点字段形如「城市·区·街道」（如「深圳·南山区·科技园」），与部分公司名容器
// 共用 company 类前缀，导致宽泛选择器 / 行兜底把地点串当公司名写库。
const LOCATION_SEP = /[·・•]/;
const CITY_KEYWORDS = /北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|常州|宁波|无锡|佛山|东莞|合肥|济南|沈阳|大连|哈尔滨|石家庄|太原|昆明|贵阳|南宁|南昌|福州|海口|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台湾/;
const ORG_WORDS = /公司|集团|科技|技术|有限|工作室|研究所|研究院|厂|局|社|院|银行|大学|学院|医院|超市|酒店|传媒|网络|信息|软件|电子商务|股份|企业|中心|协会|事务所|律所|品牌/;
// 整串「城市·区·街道」（首段必须是城市名，避免「华为·杭州研究所」这类「组织·地点」被误删）
const LOCATION_ONLY_RE = new RegExp(`^(?:${CITY_KEYWORDS.source})(?:${LOCATION_SEP.source}[\\u4e00-\\u9fa5A-Za-z0-9]+){1,3}$`);
function looksLikeLocation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 整串即地点（城市·区·街道，首段为城市名）
  if (LOCATION_ONLY_RE.test(t)) return true;
  // 含地点分隔符且全文不含任何组织词（公司/科技/集团…）→ 疑似纯地名，丢弃
  if (LOCATION_SEP.test(t) && !ORG_WORDS.test(t)) return true;
  return false;
}
// 清洗公司名：剔除地名型/保留字型脏值；有效时返回 trim 后的串（最长 80），否则返回 ''
function cleanCompanyName(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s || s.length < 2 || s.length > 80) return '';
  if (/^(公司|企业|雇主|单位|招聘方|公司名)$/.test(s)) return '';
  // 含地点分隔符：BOSS 公司容器常写成「公司名·城市」「公司名·城市·规模」（如「马上消费金融·深圳」）。
  // 先按首段提取公司名，再判断整串是否纯地点——避免把「公司名·城市」整串当地名丢弃。
  let candidate = s;
  if (LOCATION_SEP.test(s)) {
    const firstSeg = s.split(LOCATION_SEP).shift().trim();
    if (CITY_KEYWORDS.test(firstSeg)) return ''; // 首段即城市（深圳·南山区·科技园）→ 纯地点
    // 含组织词（华为·杭州研究所）保留整串；否则取公司名首段（马上消费金融·深圳 → 马上消费金融）
    candidate = ORG_WORDS.test(s) ? s : (firstSeg || '');
  }
  if (looksLikeLocation(candidate)) return '';
  return candidate;
}
// 从页面标题兜底取公司名：BOSS 详情页标题固定为「职位名」_公司名招聘-BOSS直聘 / 职位名_公司名-BOSS直聘。
// 这是比 DOM 选择器更稳的来源，避免选择器漏抓时 company 落空（如皓翊星辰这类不含组织词的短名）。
function companyFromTitle() {
  const t = String(document && document.title ? document.title : '').trim();
  const m = t.match(/_(.+?)(?:招聘)?\s*-?\s*BOSS直聘\s*$/i) || t.match(/_(.+?)-BOSS直聘\s*$/i);
  if (m) {
    const c = m[1].replace(/招聘$/, '').trim();
    if (c && !looksLikeLocation(c)) return c;
  }
  return '';
}

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
  let company = pickFromCard(card, ['.company-name', '.job-card-right .company-info h3', 'h3.company-name', 'a.company-name', '[class*="company-name"]', '[class*="companyName"]', '[class*="company-brand"]', 'a[href*="gongsi"]']);
  if (!company) {
    for (const line of cardLines.slice(1)) {
      // 跳过地点串（如「深圳·南山区·科技园」）与噪声行，避免把地名误判为公司名
      if (!CARD_LINE_NOISE.test(line) && !looksLikeLocation(line) && line.length >= 3 && line.length <= 24) { company = line; break; }
    }
  }
  return { title: title.slice(0, 80), company: cleanCompanyName(company), href: anchor?.href || '', raw: textOf(card).slice(0, 500) };
}

// 卡片结构化字段（对齐 AI-BossJob-plus recordApplication 的多选择器候选）：
// 薪资 / 地区 / 经验学历 / HR 职位 / HR 活跃度 / 猎头标记
function cardFields(card) {
  const cardText = textOf(card);
  // 薪资：选择器命中值优先；兜底正则在「还原混淆后的文本」上跑，否则 PUA 数字永远匹配不到
  const salary = decodeSalaryDigits(pickFromCard(card, ['.salary', '.job-salary', '[class*="salary"]']))
    || decodeSalaryDigits(cardText).match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/)?.[0]
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
  // 公司名：不用「详情根 querySelector(a,b,c)」——它的选择器并集会命中宽泛的
  // [class*="company"] 容器（如 .company-info，先于精确的 .company-name 出现），
  // 把「地点 · 公司规模」一并带出，导致「数据统计 · 公司 Top」把地点误当公司名。
  // 改为有序 pickText：优先精确的窄选择器（详情根 → 卡片 → 卡片身份）。
  // 卡片兜底也只用窄选择器，避免 [class*="company"] 命中 .company-info / .company-location；
  // 末了用 cleanCompanyName 兜掉仍漏网的地点串（如「深圳·南山区·科技园」）。
  const company = cleanCompanyName(
    pickText(['[class*="company-name"]', '[class*="companyName"]', '[class*="company-brand"]', 'a[href*="gongsi"]'], root)
      || pickText(['[class*="company-name"]', '[class*="companyName"]', 'a[href*="gongsi"]'], card)
      || identity.company
      || companyFromTitle()
      || ''
  );
  // HR 活跃度：卡片优先，详情面板兜底（对齐 AI-BossJob-plus boss-online-tag / boss-active-time）
  const hrActive = fields.hrActive
    || textOf($('.boss-online-tag') || $('.boss-active-time') || $('[class*="boss-active"]'))
    || detailText.match(/在线|刚刚活跃|今日活跃|\d+\s*日内活跃/)?.[0]
    || '';
  // 招聘方姓名（job-claw-main detailRecruiterIdentity 口径）
  const recruiterName = textOf(root?.querySelector('[class*="boss-name"],[class*="bossName"],[class*="recruiter-name"],[class*="job-boss"] [class*="name"],[class*="boss-info"] [class*="name"]'))
    || '';
  // 薪资兜底正则同样跑在「还原混淆后」的文本上；title/company 亦做还原，避免把 PUA 写进库
  const salaryMatch = decodeSalaryDigits(`${cardText} ${detailText}`).match(/\d+(?:\.\d+)?[-–~]\d+(?:\.\d+)?[Kk万]|\d+[Kk]以上|\d+[-–~]\d+元/);
  const token = jobUrlToken(anchor?.href || '');
  const jobId = token || dataJobId || '';
  const realUrl = anchor?.href
    || (dataJobId ? `https://www.zhipin.com/job_detail/${dataJobId}.html` : location.href);
  const chatBtn = communicateButton();
  const chatUrl = String(chatBtn?.href || chatBtn?.closest?.('a')?.href || '');
  const _welfare = extractWelfareTags(root || document);
  try { console.log('BOSS-CLAW-WELFARE list title=' + String(title || '').slice(0, 30) + ' descLen=' + String(detailText || '').length + ' metaLen=' + metaDescriptionText().length + ' welfare=' + JSON.stringify(_welfare)); } catch (e) {}
  return {
    title: decodeSalaryDigits(title),
    company,
    salary: fields.salary || salaryMatch?.[0] || '',
    location: fields.location,
    description: cleanJobDescription(decodeSalaryDigits(detailText)).slice(0, 9000),
    cardText: decodeSalaryDigits(cardText).slice(0, 1000),
    url: realUrl,
    jobId,
    chatUrl,
    hrActive,
    isHeadhunter: fields.isHeadhunter,
    recruiterName,
    recruiterTitle: fields.recruiterTitle,
    // 工作制度/福利标签（「周末双休」等）：日薪折算月薪的工作日基数识别来源
    welfare: _welfare,
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
  // 设置约束（由宿主 Workbench 传入，见 Settings → 搜索采集范围控制）：
  //   autoScroll=false  → 只采首屏可见卡，不自动下拉加载更多；
  //   scrollRounds>0    → 每批「下拉加载更多」的轮数上限（每轮一次 scrollJobListLoadMore），
  //                       轮数计满即便未到物理底部也停止（与物理底部 / 连续空轮判定取先到者）。
  const autoScroll = opts.autoScroll !== false;
  const scrollRounds = Math.max(0, Number(opts.scrollRounds) || 0);
  let scrollRoundsUsed = 0;
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
  // BOSS 列表通常在搜索 URL load 完后 ~2-4s 才渲染完成；页面较重（骨架屏 + 推荐接口 + 无限列表
  // 首屏）时会明显更久，因此超时改为由宿主传入（默认 30s），等待期间按秒回传进度便于用户判断。
  // 另：页面已 complete 且已有大量 li 但卡片命中 0 时，多半是列表选择器与新版 DOM 不匹配，
  // 不再空等到死——提前回传选择器诊断并交给主循环（主循环会滚动促加载并回传 no-cards-diag）。
  const listTimeoutMs = Math.max(5000, Number(opts.listTimeoutMs) || 30000);
  const listReadyDeadline = Date.now() + listTimeoutMs;
  const listWaitStartedAt = Date.now();
  const earlyBreakAfterMs = Math.max(8000, Math.round(listTimeoutMs * 0.4));
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
    // 页面自身已加载完（readyState=complete）且 DOM 已有内容，却仍然一张卡都命中不到 →
    // 判定为选择器不匹配，提前结束等待并回传诊断（避免日志长时间停在「等待列表渲染」）。
    if (Date.now() - listWaitStartedAt > earlyBreakAfterMs && String(document.readyState) === 'complete' && all('li').length > 5) {
      const diag = {
        readyState: String(document.readyState),
        liCount: all('li').length,
        selectorHits: {
          '.job-list-box .job-card-wrapper': all('.job-list-box .job-card-wrapper').length,
          'li.job-card-wrapper': all('li.job-card-wrapper').length,
          'li.job-card-box': all('li.job-card-box').length,
          '.job-card-box': all('.job-card-box').length,
          '.job-list-box li': all('.job-list-box li').length,
          'a[href*="/job_detail/"]': all('a[href*="/job_detail/"]').length,
        },
        listRootCls: String(($('.job-list-box, .search-job-result, .job-list, [class*="job-list"]') || {}).className || '').slice(0, 100),
        bodySnippet: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      };
      notify('collect-progress', { phase: 'list-selector-warn', index: 0, total: 0, processed: 0, maxJobs, status: `页面已加载完但未命中岗位卡片（选择器可能失效）：${JSON.stringify(diag)}` });
      break;
    }
    initialWaitCount += 1;
    if (initialWaitCount === 1 || initialWaitCount % 4 === 0) {
      const waitedSec = Math.round((Date.now() - listWaitStartedAt) / 1000);
      const state = String(document.readyState);
      notify('collect-progress', { phase: 'waiting-list', index: 0, total: 0, processed: 0, maxJobs, status: `等待列表渲染（已 ${waitedSec}s / 上限 ${Math.round(listTimeoutMs / 1000)}s，页面 ${state}）` });
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
      // 首轮 cards 仍为空（列表还没出来）— 主动滚一次促加载（关闭自动下拉时仅等待列表渲染，不滚动）
      if (autoScroll) await scrollJobListLoadMore(processed, { settleMs });
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
      // 设置约束：autoScroll=false → 只采首屏可见卡，到此结束；scrollRounds=N → 下拉轮数上限，
      // 轮数计满即便未到物理底部也停止（与物理底部 / 连续空轮判定取先到者）。
      // 增长判定基于「是否出现未收集的新 key」，不能用卡片总数——虚拟列表回收上方卡片
      // 后 cards.length 可能不变甚至变小，会误判「无增长」导致列表中间被截断。
      if (!autoScroll) {
        notify('collect-progress', { phase: 'list-bottom', index, total: cards.length, processed: processedCount, maxJobs, status: '已按「不自动下拉」设置采完首屏可见卡，停止加载' });
        break;
      }
      if (scrollRounds > 0 && scrollRoundsUsed >= scrollRounds) {
        notify('collect-progress', { phase: 'list-bottom', index, total: cards.length, processed: processedCount, maxJobs, status: `已达到下拉轮数上限（${scrollRounds} 轮），停止加载` });
        break;
      }
      scrollRoundsUsed += 1;
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
    // 采集路径福利兜底：列表页右侧面板/meta 是通用文案，往往拿不到该岗位详情福利；
    // 当福利缺「社保信号」（五险/六险/三险/公积金）时，走 card.json API（与「加入任务」同源）补全
    // welfareList（含 五险一金/年终奖 等），保证工作台绿标可显示；DOM 只命中双休/弹性这类非社保标签
    // 不算达标（五险一金只在 meta/_jobInfo/API 中）。
    try {
      let _jid = String(job.jobId || '').trim();
      // 归一化 jobId：jobUrlToken 对「路径无 job_detail、仅 query 携带 jobId/securityId/lid」的链接
      // 会返回 `jobid=xxx` 这类带前缀 token，直接拼进 ?encryptJobId= 会得到错误参数导致 card.json
      // 返回空壳/失败 → 五险一金补全静默失效（与「加入任务」extractEncryptJobId 同口径剥离前缀）。
      const _kv = _jid.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
      if (_kv) _jid = _kv[1];
      _jid = _jid.replace(/\.html$/i, '').trim();
      const _hasIns = (job.welfare || []).some((w) => /五险|六险|三险|公积金/.test(String(w)));
      if (_jid && !_hasIns) {
        const c = await zpFetch(`/wapi/zpgeek/job/card.json?encryptJobId=${encodeURIComponent(_jid)}`, { timeoutMs: 8000 });
        if (c && c.code === 0 && c.zpData) {
          const wl = Array.isArray(c.zpData.welfareList) ? c.zpData.welfareList.map(String) : [];
          const pos = scanPositiveKeywords(c.zpData.jobDesc || c.zpData.postDescription || '');
          const risk = scanRiskKeywords(c.zpData.jobDesc || c.zpData.postDescription || '');
          job.welfare = [...new Set([...(job.welfare || []), ...wl, ...pos, ...risk])].slice(0, 16);
        }
      }
      // card.json 仍缺社保信号（API 风控/空壳/jobId 缺失）→ 直接从岗位详情页源码（meta description）补全，
      // 与「加入任务」解析详情页源码同口径，保证采集卡片也能显示五险一金等福利标签。
      if (!(job.welfare || []).some((w) => /五险|六险|三险|公积金/.test(String(w)))) {
        const src = await fetchDetailSourceWelfare(job.url);
        if (src.length) {
          job.welfare = [...new Set([...(job.welfare || []), ...src])].slice(0, 16);
        }
      }
    } catch (e) {}
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

// ===== 页面状态探测（page-status）：供宿主判定「搜索页是否真的加载完成」=====
// 背景：宿主原先靠自身的加载遮罩状态机（webview 导航事件 + 定时器）判断页面是否就绪，
// 一旦事件序列异常（重定向/子框架/被新导航顶掉的定时器）就会一直判定「加载中」，
// 而页面其实早已可用 —— 日志刷「页面加载中…」但用户看到的页面是好的。
// 这里直接读页面自身的事实：document.readyState / 正文长度 / 岗位卡片命中数 / 选择器逐一命中数 /
// 列表容器 / 骨架屏启发式；宿主以这些事实为权威，遮罩状态只作参考。
function pageStatusData() {
  const selectors = [
    '.job-list-box .job-card-wrapper',
    'li.job-card-wrapper',
    '.search-job-result .job-card-wrapper',
    'li.job-card-box',
    '.job-card-box',
    '.job-list-box li',
    'a[href*="/job_detail/"]',
  ];
  const counts = {};
  for (const s of selectors) {
    try { counts[s] = all(s).length; } catch { counts[s] = -1; }
  }
  let cards = -1;
  try { cards = collectCards(true).length; } catch {}
  const bodyText = String(document.body?.innerText || '');
  const listRoot = $('.job-list-box, .search-job-result, .job-list, [class*="job-list"]');
  return {
    url: location.href,
    title: document.title,
    readyState: String(document.readyState || ''),
    bodyLen: bodyText.length,
    cards,
    counts,
    listRootCls: listRoot ? String(listRoot.className || '').slice(0, 120) : '',
    skeleton: all('[class*="skeleton"], [class*="loading"], [class*="spinner"], [class*="placeholder"]').length,
    loginWall: /请登录|扫码登录|安全验证|验证码/.test(bodyText.slice(0, 500)),
  };
}

// ===== 只读页面抽取（page-read）：供外部 agent 探索当前页面 =====
// 返回 URL/标题/正文文本（截断）+ 列表卡摘要（仅当前页面，不滚动、不点击）。
function pageReadData() {
  let cards = [];
  let count = 0;
  try {
    const allCards = collectCards(true) || [];
    count = allCards.length;
    cards = allCards.slice(0, 30).map((card) => {
      try {
        const id = cardIdentity(card);
        const f = cardFields(card);
        return { title: id.title, company: id.company, salary: f.salary, url: id.href || '', location: f.location };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {}
  return {
    url: location.href,
    title: document.title,
    bodyText: (() => { try { return String(document.body?.innerText || document.body?.textContent || '').slice(0, 12000); } catch { return ''; } })(),
    listCards: cards,
    listCount: count,
  };
}

// ===== 半自动预填（prefill-greeting）：打开沟通 + 填入草稿，绝不自动发送 =====
// 对齐 domApply 的 fill_message 步，但删除 send_message / verify_message —— 发送交给用户点。
async function prefillGreetingText(rawText) {
  const greeting = String(rawText || '').replace(/\s+/g, ' ').trim();
  try {
    if (greeting.length < 8) return { ok: false, reason: '招呼语为空或过短，无法预填' };
    let input = chatInput();
    if (!input) input = await enterChat();
    if (!input) {
      // enterChat 可能在需要跨域跳转时不返回输入框（新页面 preload 会重新注入）
      const btn = communicateButton();
      return { ok: false, reason: btn ? '沟通入口需要跳转页面，请在新页面重试' : '未找到聊天输入框，且无「立即沟通」入口（岗位可能已下架）' };
    }
    input.scrollIntoView({ block: 'center' });
    focusEditableScoped(input);
    const ins = await trustedInput('insertText', greeting);
    if (!ins.ok) return { ok: false, reason: '真实输入写入失败（无权限/输入框失焦），请人工发送' };
    // 兜底：触发 input 事件让「发送」按钮随内容启用（弹窗 send-message.disable 由框架按输入值切状态）
    try {
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } catch {}
    notify('apply-stage', { stage: 'prefill', label: '已预填招呼语草稿（未发送，请人工核对后发送）' });
    return { ok: true, href: location.href };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ===== IPC 通道注册 =====
// BOSS 专属通道仅在 BOSS 页面注册；其余平台注册轻量提取（多平台适配）
if (PLATFORM === 'boss') {
  // boss-api：BOSS 官方 API（joblist / jobCard / jobDetail / friendAdd），seq 用于上层 promise 化
  ipcRenderer.on('boss-api', async (_e, arg) => {
    const { seq, action, params } = (arg && typeof arg === 'object') ? arg : {};
    const result = await handleBossApi(action, params);
    notify('boss-api-result', { seq, ok: !result.error, code: result.code, data: result, error: result.error, riskCodeMessage: result.code ? riskCodeMessage(result.code) : '' });
  });

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
}

// extract-job：提取当前详情页岗位（BOSS=API 优先/DOM 兜底；其余平台=轻量通用提取）
ipcRenderer.on('extract-job', () => {
  if (PLATFORM === 'boss') extractJob();
  else platformExtractJob();
});

// page-read：只读抽取当前页面（URL/标题/正文文本/列表卡摘要），seq 供宿主 promise 化
ipcRenderer.on('page-read', (_e, arg) => {  const { seq } = (arg && typeof arg === 'object') ? arg : {};
  let data = { error: 'page-read 失败' };
  try { data = pageReadData(); } catch (e) { data = { error: String(e?.message || e), url: location.href }; }
  notify('page-read-result', { seq, ...data });
});

// prefill-greeting：半自动预填招呼语草稿（不发送），seq 供宿主 promise 化
ipcRenderer.on('prefill-greeting', (_e, arg) => {
  const { seq, greeting } = (arg && typeof arg === 'object') ? arg : {};
  prefillGreetingText(greeting).then((result) => notify('prefill-greeting-result', { seq, ...result }));
});

// page-status：页面自身的就绪事实（readyState / 卡片命中 / 选择器计数 / 骨架屏启发式），
// seq 供宿主 promise 化。宿主据此判定「搜索页是否真的加载完成」，不再只信加载遮罩状态机。
ipcRenderer.on('page-status', (_e, arg) => {
  const { seq } = (arg && typeof arg === 'object') ? arg : {};
  let data = { error: 'page-status 失败' };
  try { data = pageStatusData(); } catch (e) { data = { error: String(e?.message || e), url: location.href }; }
  notify('page-status-result', { seq, ...data });
});

// webview-command：主进程右键菜单触发的通用命令（dom-dump 等）
ipcRenderer.on('webview-command', (_e, arg) => {
  const action = (arg && arg.action) || '';
  if (action === 'dom-dump') {
    try { domDump(); } catch (e) { notify('dom-dump', { error: String(e?.message || e), url: location.href }); }
  }
});

// ===== 非 BOSS 平台投递（platform-apply）：猎聘/智联/51job 新标签页 DOM 投递 =====
// 口径对齐 get_jobs / Auto-JobHunter / AgentMesh-JobAgent（多项目交叉验证）：
//  - liepin greetAuto：点「聊一聊」即触发 App 预设招呼语（无需打字）；IM 会话打开=成功。
//  - zhaopin resume：点「投递」，投递弹层文本含「申请成功」=成功；「达到上限」→停。
//  - job51 resume：点「投递」，成功弹层=成功；「需要到企业招聘平台单独申请」=站外网申→跳过。
// 安全不变量：外部网申跳过、未确认不计成功、找不到目标→failed 交人工、绝不猜成功。
const PLATFORM_NORM = (t) => String(t || '').replace(/\s+/g, '').trim();
function findPlatformAction(selectors, labels) {
  for (const sel of selectors) {
    for (const el of all(sel)) {
      if (!visible(el) || el.disabled || el.getAttribute?.('aria-disabled') === 'true') continue;
      const t = PLATFORM_NORM(textOf(el));
      if (t && labels.some((l) => t.includes(PLATFORM_NORM(l)))) return el;
    }
  }
  return null;
}
// 外部网申检测：扫描可见按钮/链接文本 + 页面正文（hints 由渲染层按平台传入，校准 platforms.ts）
function externalApplyDetected(hints) {
  const normHints = (hints || []).map((h) => PLATFORM_NORM(h));
  if (!normHints.length) return false;
  for (const el of all('button,a,[role="button"],span,div')) {
    if (!visible(el)) continue;
    const t = PLATFORM_NORM(textOf(el));
    if (t && t.length <= 16 && normHints.some((h) => t.includes(h))) return true;
  }
  const body = PLATFORM_NORM(document.body ? document.body.innerText : '');
  return normHints.some((h) => body.includes(h));
}

async function platformApply(args = {}) {
  const { seq, job = {}, externalApplyHints = [] } = args;
  const platform = String(args.platform || PLATFORM || 'boss');
  const fail = (stage, extra = {}) => notify('platform-apply-result', Object.assign({ seq, ok: false, stage }, extra));
  const ok = (extra = {}) => notify('platform-apply-result', Object.assign({ seq, ok: true, stage: 'success', method: 'dom' }, extra));
  try {
    // 非终态进度（沿用 platforms.ts stageLabels），终态只经 platform-apply-result 回传
    if (platform === 'liepin') {
      notify('apply-stage', { stage: 'open_chat', label: '打开沟通窗口', platform });
    } else {
      notify('apply-stage', { stage: 'open_job', label: '打开岗位', platform });
    }
    // 外部网申：安全不变量，命中直接跳过
    if (externalApplyHints && externalApplyDetected(externalApplyHints)) {
      return fail('external', { external: true, message: '该岗位为外部网申，按安全规则自动跳过' });
    }

    if (platform === 'liepin') {
      // 已沟通/已投递过 → 直接跳过（不再点，避免重复打扰同一 HR）
      if (findPlatformAction(['.ant-btn-round', '[class*="btn"]', '[class*="chat"]', 'button', 'a'], ['已沟通', '已投递', '聊过', '已招满'])) {
        return fail('skip', { message: '该岗位已沟通/已投递过，跳过' });
      }
      const btn = findPlatformAction(['.ant-btn-round', '[class*="btn"]', '[class*="chat"]', 'button', 'a'], ['聊一聊']);
      if (!btn) return fail('failed', { error: '未找到「聊一聊」按钮（岗位可能已下架/非招聘中）' });
      notify('apply-stage', { stage: 'send_message', label: '平台自动打招呼', platform });
      await clickElement(btn);
      // 成功 = IM 会话窗口打开（猎聘 App 预设招呼语自动发送，无需本机输入）
      const okIm = await waitFor(() => $('.__im_basic__header-wrap, [class*="__im_basic__"]'), 15000, '猎聘 IM 会话窗口');
      if (!okIm) {
        if (/安全验证|验证码|请完成验证/.test(String(document.body?.innerText || ''))) return fail('risk', { code: 35, message: '检测到安全验证，已暂停，请人工完成' });
        return fail('failed', { error: '点击「聊一聊」后 IM 会话未打开，请人工核对' });
      }
      return ok({ method: 'dom' });
    }

    if (platform === 'zhaopin') {
      const btn = findPlatformAction(['.a-job-apply-button', '[class*="job-apply"]', '[class*="apply"]', 'button', 'a'], ['投递']);
      if (!btn) return fail('failed', { error: '未找到「投递」按钮（岗位可能已下架/非招聘中）' });
      notify('apply-stage', { stage: 'send_message', label: '投递简历', platform });
      await clickElement(btn);
      // 投递弹层/正文判定：申请成功 / 达到上限 / 安全验证
      const judge = await waitFor(() => {
        const body = PLATFORM_NORM(document.body ? document.body.innerText : '');
        const d = $('.deliver-dialog, [class*="deliver-dialog"], [class*="apply-dialog"]');
        if (d && textOf(d).includes('申请成功')) return 'success';
        if (d && textOf(d).includes('达到上限')) return 'stop';
        if (body.includes('申请成功') || body.includes('投递成功')) return 'success';
        if (body.includes('达到上限') || body.includes('已达上限')) return 'stop';
        if (/安全验证|请完成验证|验证码/.test(body) || /pwaf_challenge/.test(location.href) || /security-check/.test(location.href)) return 'risk';
        return null;
      }, 15000, '智联投递结果');
      if (judge === 'success') return ok({ method: 'dom' });
      if (judge === 'stop') return fail('stop', { message: '智联今日投递已达到上限，已停止该岗位' });
      if (judge === 'risk') return fail('risk', { code: 35, message: '检测到安全验证，已暂停，请人工完成' });
      return fail('failed', { error: '未确认「申请成功」，请人工核对' });
    }

    if (platform === 'job51') {
      const btn = findPlatformAction(['[class*="apply"]', '[class*="job-apply"]', 'button', 'a'], ['投递']);
      if (!btn) return fail('failed', { error: '未找到「投递」按钮（岗位可能已下架/非招聘中）' });
      notify('apply-stage', { stage: 'send_message', label: '投递简历', platform });
      await clickElement(btn);
      const judge = await waitFor(() => {
        const body = PLATFORM_NORM(document.body ? document.body.innerText : '');
        const sc = $('.successContent, [class*="successContent"], [class*="success-content"]');
        // 站外网申：独立申请信号（安全不变量：外部网申跳过）
        if (body.includes('需要到企业招聘平台单独申请') || body.includes('需要单独申请')) return 'external';
        if ((sc && textOf(sc).length > 0) || body.includes('投递成功') || body.includes('投递申请已提交') || body.includes('申请已投递')) return 'success';
        if (body.includes('安全验证') || body.includes('请完成验证') || body.includes('请输入验证码') || document.querySelector('.waf-nc-title, [class*="waf-nc"]')) return 'risk';
        return null;
      }, 15000, '51job 投递结果');
      if (judge === 'external') return fail('external', { external: true, message: '需要到企业招聘平台单独申请（外部网申），按安全规则跳过' });
      if (judge === 'success') return ok({ method: 'dom' });
      if (judge === 'risk') return fail('risk', { code: 35, message: '检测到安全验证，已暂停，请人工完成' });
      // 关闭常见的「扫码下载 App」弹层，避免残留影响下一岗位
      const closeBtn = $('[class*="van-popup__close"], [class*="van-icon-cross"], [class*="popup__close"]');
      if (closeBtn) { try { await clickElement(closeBtn); } catch {} }
      return fail('failed', { error: '未确认投递成功，请人工核对' });
    }

    return fail('failed', { error: `暂不支持的平台：${platform}` });
  } catch (e) {
    return fail('failed', { error: String((e && e.message) || e) });
  }
}

// platform-apply：非 BOSS 平台在自身标签页内 DOM 投递（终态经 platform-apply-result 回传）
ipcRenderer.on('platform-apply', (_e, arg) => {
  const a = (arg && typeof arg === 'object') ? arg : {};
  platformApply(a).catch((e) => notify('platform-apply-result', { seq: a.seq, ok: false, stage: 'failed', error: String((e && e.message) || e) }));
});

// ===== 通用 UI 接管（ui-eval）：仅 query/click/type/scroll 白名单，禁止任意脚本执行 / 跳转 =====
const UV_TEXT_MAX = 120;
function uvVisibleCheck(el) { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }
function uvText(el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, UV_TEXT_MAX); }
function uvPick(sel, label, index) {
  let nodes;
  if (typeof sel === 'string' && sel.trim()) {
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch { nodes = []; }
  } else {
    nodes = Array.from(document.querySelectorAll(
      'button,input,textarea,select,a[href],[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[data-testid]'
    ));
  }
  const visible = nodes.filter(uvVisibleCheck);
  let out = visible;
  if (typeof label === 'string' && label) {
    out = visible.filter((el) => uvText(el).includes(label) || (el.getAttribute('aria-label') || '').includes(label) || (el.placeholder || '').includes(label));
  }
  if (!out.length) return null;
  return out[Math.min(Math.max(Number(index) || 0, 0), out.length - 1)];
}
function uvSnapshot(sel, limit) {
  let nodes;
  if (typeof sel === 'string' && sel.trim()) {
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch { nodes = []; }
  } else {
    nodes = Array.from(document.querySelectorAll(
      'button,input,textarea,select,a[href],[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[data-testid]'
    ));
  }
  const cap = Math.min(Math.max(Number(limit) || 60, 1), 200);
  return nodes.filter(uvVisibleCheck).slice(0, cap).map((el) => {
    const tag = el.tagName.toLowerCase();
    return {
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      text: uvText(el),
      placeholder: el.placeholder || undefined,
      tag,
      type: el.type || undefined,
      id: el.id || undefined,
      visible: true,
    };
  });
}
ipcRenderer.on('ui-eval', (_e, arg) => {
  const { seq, op, selector, label, index } = (arg && typeof arg === 'object') ? arg : {};
  let res = { error: '未知操作' };
  try {
    if (op === 'query') {
      res = { elements: uvSnapshot(selector, arg.limit), count: uvSnapshot(selector, arg.limit).length };
    } else if (op === 'click') {
      const el = uvPick(selector, label, index);
      if (!el) res = { error: '未命中元素' };
      else { try { (typeof el.click === 'function') ? el.click() : el.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) { res = { error: '点击失败: ' + (e && e.message) }; } res = { ok: true }; }
    } else if (op === 'type') {
      const el = uvPick(selector, label, index);
      if (!el) res = { error: '未命中输入框' };
      else if (el.matches && el.matches('[contenteditable]')) res = { error: 'contenteditable 聊天框请用 deliveryDraft' };
      else if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') || el.disabled) res = { error: '目标不是可输入的 input/textarea' };
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.focus();
        if (setter) setter.call(el, String(arg.value == null ? '' : arg.value)); else el.value = String(arg.value || '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        res = { ok: true };
      }
    } else if (op === 'scroll') {
      const el = selector && typeof selector === 'string' ? uvPick(selector) : null;
      const target = el || document.scrollingElement || document.documentElement;
      if (arg.to === 'top' || arg.to === 'bottom') target.scrollIntoView({ block: arg.to === 'top' ? 'start' : 'end', behavior: 'smooth' });
      else if (Number(arg.dy)) target.scrollBy(0, Number(arg.dy));
      res = { ok: true };
    }
  } catch (e) { res = { error: String((e && e.message) || e) }; }
  notify('ui-eval-result', { seq, ok: !res.error, result: res });
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
// 横向滚动兜底：修复智联等 PC 站页面被截断、无法左右滑动（非 BOSS 平台生效）
injectHorizontalScrollFix();
// 节流：连续 mutation 合并到节流窗口（150ms）。相比 rAF 逐帧执行——
// BOSS 直聘首页 DOM 高频变动（骨架屏/懒加载/动画）时每帧都会触发上报，
// 而 URL/标题/登录态绝大多数帧并无变化；150ms 节流 + 变化去重后，
// 只有真正变化才产生 IPC，消除 guest → 宿主渲染层的持续消息与重渲染开销。
let obsTick = 0;
const obs = new MutationObserver(() => {
  if (obsTick) return;
  obsTick = 1;
  setTimeout(() => { obsTick = 0; safeReport('nav'); safeReport('login'); }, 150);
});
try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
document.addEventListener('DOMContentLoaded', () => { spaRecord(); safeReport('nav'); safeReport('login'); });
setTimeout(() => { safeReport('nav'); safeReport('login'); }, 1200);
setTimeout(() => { safeReport('nav'); safeReport('login'); }, 4000);

// 自身 IPC 监听兜底：底层事件回调抛错会污染 ipcRenderer 的事件循环，把每个 listener 包一层
const ipcChannels = PLATFORM === 'boss'
  ? ['boss-api', 'extract-job', 'start-apply', 'open-chat', 'visual-collect', 'collect-control', 'webview-command', 'page-read', 'page-status', 'prefill-greeting', 'ui-eval']
  : ['extract-job', 'platform-apply', 'webview-command', 'page-read', 'page-status', 'prefill-greeting', 'ui-eval'];
ipcChannels.forEach((channel) => {
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
