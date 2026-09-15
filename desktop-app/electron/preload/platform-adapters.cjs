'use strict';
// electron/preload/platform-adapters.cjs —— 内置浏览器（webview）多平台适配表
// ============================================================================
// 职责分层（勿混淆）：
//   src/lib/bossclaw/platforms.ts  = **展示口径**（label / domain / 配色 / 投递语义 / 能力矩阵）—— 渲染层权威
//   本文件                          = **DOM 口径**（列表选择器 / 链接形态 / 字段抓取 / 页面形态判定）—— preload 权威
// 两者不得互相复制职责；渲染层的 `detectPlatform` 口径（hostname 后缀）与此处保持一致。
//
// 为什么单独成文件（而不是散在 webview.cjs 里）：
//   1. webview.cjs 有 2300+ 行且逐行耦合 DOM，无法单测；本文件**零 DOM 依赖**（纯数据 + 纯函数），
//      可直接 `node -e "require('./electron/preload/platform-adapters.cjs')"` 做回归
//      （见 desktop-app/tmp/probe-webview-platforms.cjs）。
//   2. 平台差异集中一处，新增平台只改本文件 + webview.cjs 的通道注册。
//
// ⚠️ 选择器可信度说明（真机校准前请保持「选择器优先 + 正则/文本兜底」的双通道）：
//   - BOSS：选择器为真机长期验证，**不得随意改动**（改动前先跑真机验收）。
//   - 猎聘：站点使用 CSS Modules **哈希类名**（如 `_40108E8PWS`，每次发布都变），
//     因此只使用稳定属性（`data-nick` / `data-tlg-ext`）与 URL 形态，**禁止**依赖哈希类名。
//   - 智联 / 前程无忧：类名为可读名（`joblist` / `joblist-item` / `j_joblist` / `sal` 等），
//     与 `camoufox/platforms/{zhaopin,job51}.py` 的 DOM 兜底选择器同源。
//   三类平台的字段抓取一律「选择器 → 文本正则兜底」，避免单一通道失效导致整链路空采。

const ALL_PLATFORMS = Object.freeze(['boss', 'liepin', 'zhaopin', 'job51']);

/**
 * hostname → 平台 id（与 `platforms.ts::resolvePlatform` 同口径：子域后缀匹配；未知回退 boss）。
 * @param {string} hostname
 * @returns {'boss'|'liepin'|'zhaopin'|'job51'}
 */
function detectPlatform(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'liepin.com' || host.endsWith('.liepin.com')) return 'liepin';
  if (host === 'zhaopin.com' || host.endsWith('.zhaopin.com')) return 'zhaopin';
  if (host === '51job.com' || host.endsWith('.51job.com')) return 'job51';
  return 'boss';
}

/** 岗位详情链接选择器（提取 jobId / 去重 key / 卡片判定共用） */
const PLATFORM_LINK_SELECTOR = Object.freeze({
  boss: 'a[href*="job_detail"]',
  liepin: 'a[href*="/job/"]',
  zhaopin: 'a[href*="/jobdetail/"]',
  job51: "a[href*='/pc/jobdetail'], a[href*='jobs.51job.com/']",
});

/**
 * 详情链接形态：
 *   'inline' = 列表页内联详情面板（master-detail，点卡片在同页展开）→ 可「点击展开 + 提取详情」
 *   'page'   = 独立详情页（点卡片会导航/开新页）→ **禁止点击**，只采列表字段
 * BOSS 是唯一 inline 形态；其余三个平台的详情 JD 由 Camoufox 隐身采集链路补齐
 * （`camoufox/platforms/{liepin,zhaopin,job51}.py` 已实现「列表 + 详情」两段采集）。
 */
const PLATFORM_LINK_KIND = Object.freeze({
  boss: 'inline',
  liepin: 'page',
  zhaopin: 'page',
  job51: 'page',
});

/** 列表卡片候选选择器（按优先级；`.closest()` 归一到卡片容器） */
const PLATFORM_CARD_SELECTORS = Object.freeze({
  // BOSS：真机长期验证的 8 个候选，顺序与内容不得改动
  boss: [
    '.job-list-box .job-card-wrapper',
    'li.job-card-wrapper',
    '.search-job-result .job-card-wrapper',
    'li.job-card-box',
    '.job-card-box',
    '.job-list-box li',
    '.search-job-result li.job-card-box',
    'a[href*="/job_detail/"]',
  ],
  // 猎聘：只用稳定属性（哈希类名不可依赖）
  liepin: [
    'a[data-nick="job-detail-job-info"]',
    'li[data-tlg-ext]',
    'a[href*="/job/"]',
  ],
  zhaopin: [
    '[class*="joblist-box"] a',
    '[class*="joblist"] a',
    '[class*="job-card"]',
    'a[href*="/jobdetail/"]',
  ],
  job51: [
    "a[href*='/pc/jobdetail?jobId=']",
    "a[href*='jobs.51job.com/']",
    '[class*="j_joblist"] li',
    '.joblist li',
    '.j_joblist .joblist-item',
  ],
});

/** 卡片归一容器（`el.closest(...)` 用） */
const PLATFORM_CARD_CONTAINER_SELECTOR = Object.freeze({
  boss: '.job-card-wrapper, .job-card-box, li',
  liepin: 'li, [class*="job-card"], [class*="joblist"], [class*="jobItem"], [class*="job-list"]',
  zhaopin: 'li, [class*="job-card"], [class*="joblist"], [class*="jobItem"], [class*="job-list"]',
  job51: 'li, [class*="job-card"], [class*="joblist"], [class*="jobItem"], [class*="job-list"]',
});

/** 列表根节点候选（诊断 / 滚动容器定位用） */
const PLATFORM_LIST_ROOT_SELECTORS = Object.freeze({
  boss: ['.job-list-box', '.search-job-result', '.job-list', '[class*="job-list"]'],
  liepin: ['[class*="job-list"]', '[class*="joblist"]', '[class*="search-result"]', 'ul'],
  zhaopin: ['[class*="joblist-box"]', '[class*="joblist"]', '[class*="search-result"]', 'ul'],
  job51: ['.j_joblist', '.joblist', '[class*="joblist"]', '[class*="job-list"]'],
});

/** 可滚动容器候选（「加载更多」用；取不到时回落 document.scrollingElement） */
const PLATFORM_SCROLLER_SELECTORS = Object.freeze({
  // BOSS：与改造前 `findListScroller()` 的候选串逐字一致（不得删项，否则可能滚错容器）
  boss: ['.job-list-box', '.search-job-result', '.job-list', '[class*="job-list"]', '[class*="search-job"]'],
  liepin: ['[class*="job-list"]', '[class*="joblist"]', '[class*="search-result"]', 'main'],
  zhaopin: ['[class*="joblist"]', '[class*="job-list"]', '[class*="search-result"]', 'main'],
  job51: ['.j_joblist', '.joblist', '[class*="joblist"]', '[class*="job-list"]', 'main'],
});

/** 卡片内字段选择器（命中优先；未命中走文本正则兜底） */
const PLATFORM_FIELD_SELECTORS = Object.freeze({
  boss: {
    title: ['.job-name', '.job-title .job-name', '.job-title', '.position-name', '[class*="job-name"]', '[class*="job-title"]', '[class*="jobName"]', 'h3', 'h4'],
    company: ['.company-name', '.job-card-right .company-info h3', 'h3.company-name', 'a.company-name', '[class*="company-name"]', '[class*="companyName"]', '[class*="company-brand"]', 'a[href*="gongsi"]'],
    salary: ['.salary', '.job-salary', '[class*="salary"]'],
    location: ['.job-area', '.job-area-wrapper', '.job-address-desc', '.job-location', '.company-location', '[class*="job-area"]'],
    recruiterTitle: ['.boss-title', '.job-card-footer .boss-title', '[class*="boss-title"]', '.boss-info-attr'],
  },
  liepin: {
    title: ['[class*="job-title"]', '[class*="ellipsis-1"]', 'h3', '.job-name'],
    company: ['[class*="company-name"]', '[class*="comp-name"]', '[data-nick="job-detail-company-info"] .ellipsis-1', '[class*="company"]'],
    salary: ['[class*="job-salary"]', '[class*="salary"]'],
    location: ['[class*="job-dq"]', '[class*="dq"]', '[class*="area"]'],
    recruiterTitle: ['[class*="recruiter"]', '[class*="hr-name"]', '[class*="recruiter-title"]'],
  },
  zhaopin: {
    title: ['[class*="job-name"]', '[class*="job-title"]', '[class*="jobname"]', 'h3', '.job_title'],
    company: ['[class*="company-name"]', '[class*="companyname"]', '[class*="company"] .name', '.cname'],
    salary: ['[class*="salary"]', '[class*="em"]'],
    location: ['[class*="job-area"]', '[class*="area"]', '[class*="address"]', '[class*="location"]'],
    recruiterTitle: ['[class*="hr-name"]', '[class*="recruiter"]'],
  },
  job51: {
    title: ['.jname', '[class*="job-title"]', '[class*="jobName"]', 'h3', '.job_name'],
    company: ['.cname', '[class*="company-name"]', '[class*="company"] .cname', '[class*="company"]'],
    salary: ['.sal', '[class*="salary"]', '[class*="sal"]'],
    location: ['.area', '[class*="area"]'],
    recruiterTitle: ['[class*="hr-name"]', '[class*="recruiter"]'],
  },
});

/** 列表页 URL 形态（与既有 platformListPage 口径一致） */
const PLATFORM_LIST_URL_RE = Object.freeze({
  boss: /\/web\/geek\/(jobs|job|recommend)/i,
  liepin: /\/zhaopin\//i,
  zhaopin: /\/sou\//i,
  job51: /\/pc\/search/i,
});

/** 详情页 URL 形态 */
const PLATFORM_DETAIL_URL_RE = Object.freeze({
  boss: /\/job_detail\//i,
  liepin: /\/job\/[^/]*\d/i,
  zhaopin: /jobdetail\//i,
  job51: /jobdetail|jobs\.51job\.com\//i,
});

/** 详情页 URL 通用否定形态（列表页判定用：命中即非列表页） */
const DETAIL_URL_ANY_RE = /job_detail|jobdetail|\/job\/\d+/i;

/** 登录墙 URL 形态（命中即视为登录页） */
const LOGIN_WALL_URL_RE = /\/login|passport|signin|sign-in|verify/i;

/** 登录墙正文文案（仅在「列表无任何岗位链接」时才作为判据，避免页脚「登录」字样误判） */
const LOGIN_WALL_TEXT_RE = /登录后查看|请先登录|扫码登录|立即登录|账号登录|登录\/注册|请登录后/;

/** 该平台是否为「列表页内联详情」形态（仅 BOSS） */
function supportsInlineDetail(platform) {
  return PLATFORM_LINK_KIND[platform] === 'inline';
}

/** 列表页判定（URL 形态 + 非详情页） */
function isListPage(platform, url) {
  const re = PLATFORM_LIST_URL_RE[platform];
  if (!re || !re.test(String(url || ''))) return false;
  return !DETAIL_URL_ANY_RE.test(String(url || ''));
}

/** 详情页判定 */
function isDetailPage(platform, url) {
  const re = PLATFORM_DETAIL_URL_RE[platform];
  return Boolean(re && re.test(String(url || '')));
}

module.exports = {
  ALL_PLATFORMS,
  detectPlatform,
  PLATFORM_LINK_SELECTOR,
  PLATFORM_LINK_KIND,
  PLATFORM_CARD_SELECTORS,
  PLATFORM_CARD_CONTAINER_SELECTOR,
  PLATFORM_LIST_ROOT_SELECTORS,
  PLATFORM_SCROLLER_SELECTORS,
  PLATFORM_FIELD_SELECTORS,
  PLATFORM_LIST_URL_RE,
  PLATFORM_DETAIL_URL_RE,
  DETAIL_URL_ANY_RE,
  LOGIN_WALL_URL_RE,
  LOGIN_WALL_TEXT_RE,
  supportsInlineDetail,
  isListPage,
  isDetailPage,
};
