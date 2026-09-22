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
  // 智联：兼容新版拆分布局（.job-list-panel / .jobs-list-sort-scroll）与旧版 .joblist / .joblist-box
  zhaopin: ['[class*="job-list-panel"]', '[class*="job-sort-scroll"]', '[class*="joblist-box"]', '[class*="joblist"]', '[class*="search-result"]', 'ul'],
  job51: ['.j_joblist', '.joblist', '[class*="joblist"]', '[class*="job-list"]'],
});

/** 可滚动容器候选（「加载更多」用；取不到时回落 document.scrollingElement） */
const PLATFORM_SCROLLER_SELECTORS = Object.freeze({
  // BOSS：与改造前 `findListScroller()` 的候选串逐字一致（不得删项，否则可能滚错容器）
  boss: ['.job-list-box', '.search-job-result', '.job-list', '[class*="job-list"]', '[class*="search-job"]'],
  liepin: ['[class*="job-list"]', '[class*="joblist"]', '[class*="search-result"]', 'main'],
  // 智联：新版拆分布局（2026-09 全站 jobs-split-page）的列表列由内部滚动容器承载
  // （.jobs-list-sort-scroll 是实际可滚容器，含置顶排序条 + .job-list-panel 卡片区），
  // 页面 body 不可滚 —— 若只认旧版 .joblist，findListScroller 会误回 window 导致下拉失效。
  zhaopin: ['[class*="job-sort-scroll"]', '[class*="job-list-panel"]', '[class*="job-split-layout"]', '[class*="joblist"]', '[class*="job-list"]', '[class*="search-result"]', 'main'],
  job51: ['.j_joblist', '.joblist', '[class*="joblist"]', '[class*="job-list"]', 'main'],
});

/**
 * 平台强制「容器溢出扫描」兜底：候选选择器全部命中但都不可滚时，也不回 window，
 * 而是再扫一遍「非详情面板」中可滚动面积最大的容器。
 * 适用场景：智联新版拆分布局 body `overflow:hidden`，window 不可滚，只能滚内部列表列。
 * （BOSS 的虚拟列表挂在 window 上，乱选容器会滚错位置，故不参与强制扫描。）
 */
const PLATFORM_FORCE_OVERFLOW_SCAN = Object.freeze({
  zhaopin: true,
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
    /**
     * 2026-09 新版卡片（`div.job-card`）标题在
     * `.job-card__title-main > .job-card__title-clamp > span > span.vue-clamp__text`，
     * 且**没有** jobdetail 锚点（标题是 span 不是 a）——旧选择器在它上面全部落空，
     * title 于是退化到「整卡文本」（含薪资/标签/公司/地点），实测日志出现
     * 「开发实习生 2000-3000元 本科JavaScript计算机软件…用友网络科技股份有限公司厦门分公司 厦门 思明」
     * 这类标题，既影响入库展示也污染 AI 评分输入。
     * ⚠️ 不要放 `[class*="job-card__title"]`：它会先命中 `.job-card__title-row`（标题+薪资）。
     */
    title: [
      '[class*="job-card__title-main"]',
      '[class*="vue-clamp__text"]',
      '[class*="job-name"]',
      '[class*="job-title"]',
      '[class*="jobname"]',
      'h3',
      '.job_title',
    ],
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
  // 智联：旧路径式 /sou/（应用自身搜索 URL）与新版 /jobs/?pageMode=search|recommend
  // （2026-09 起官网跳转/用户手输的规范形态，如 https://www.zhaopin.com/jobs/?pageMode=recommend）
  zhaopin: /\/(sou|jobs)\//i,
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

/**
 * 平台「一键投递」DOM 动作规格（由 webview.cjs 的 platformApply 消费，**禁止在 webview.cjs 内联平台选择器**）。
 *
 * 口径来源（2026-09 真机详情页源码 + 平台投递组件 bundle，非猜测）：
 *   智联详情页 `https://www.zhaopin.com/jobdetail/*.htm` 的投递入口是
 *   `.summary-planes__action > button.a-button`（文案「立即投递」）；另有平台组件挂载点
 *   `.job-apply-button`（内含 `.job-apply-button__btn`，异步渲染，可能为空）。
 *   点击后由投递组件（`/widgets/job-apply`，工作流根节点 `.a-job-apply-workflow`）接续，
 *   可能先弹「选择简历」面板（`.a-job-apply-resume-selection-panel__actions` 的「确定投递」）
 *   或「附件简历」面板（`.a-attachment-select__action-btn__delivery` 的「投递简历」）；
 *   阻断态面板：`.a-job-apply-{not-login,resume-creation,block,error-message,invite-code}-panel`。
 *   文案表：确定投递 / 暂不投递 / 同意并投递 / 投递简历 / 立即申请 / 一键申请 / 继续投递 /
 *   请选择简历 / 您还没有填写简历… / 您的账户存在行为异常，已禁止您的投递行为。
 *
 * 双通道原则：每个动作都「专用选择器优先 → 文案兜底」，任一通道单独失效都不至于整链路哑火。
 */
const PLATFORM_APPLY_SPEC = Object.freeze({
  zhaopin: {
    /** 主投递按钮候选（顺序 = 优先级，前两个是详情页真机结构） */
    buttonSelectors: [
      '.summary-planes__action button',
      '.job-apply-button__btn',
      '.a-job-apply-button__btn',
      '.job-apply-button .a-button',
      '[class*="job-apply"] button',
      'button',
      'a',
    ],
    /** 主按钮文案（命中其一即认定为目标按钮） */
    applyLabels: ['立即投递', '投递简历', '立即申请', '投递'],
    /**
     * 已投递态判定用的「专用选择器」（**不含泛化 button/a**）。
     * 只认投递入口自身的按钮态，避免导航里的「已申请职位」等链接把整个岗位误判成本已投递而跳过。
     */
    appliedSelectors: [
      '.summary-planes__action button',
      '.job-apply-button__btn',
      '.a-job-apply-button__btn',
      '.job-apply-button .a-button',
      '.a-job-apply-button',
    ],
    /** 已投递态文案（配合 appliedSelectors；另有精确文案兜底在 webview 侧） */
    appliedLabels: ['已投递', '已申请'],
    /**
     * 已投递/已建会话岗位的「继续沟通」入口（真机源码 `.summary-planes__action button`，文案「继续沟通」）。
     * 命中即知该岗位此前已投递过 —— 不必再走立即投递，直接点「继续沟通」进入聊天并补发 AI 招呼语。
     */
    continueChatSelectors: [
      '.summary-planes__action button',
      '.summary-planes__right button',
      '[class*="deliver-greeting-modal"] [class*="--primary"]',
      '[class*="deliver-greeting-modal"] button',
      '.job-apply-button button',
    ],
    continueChatLabels: ['继续沟通'],
    /** 投递成功后弹出的「打招呼弹窗」（真机源码 `.deliver-greeting-modal`，标题「已向对方发送简历和打招呼语」）。 */
    deliverGreetingModalSelectors: ['.deliver-greeting-modal'],
    /** 打招呼弹窗主按钮（「继续沟通」，代表「发送简历并继续沟通」） */
    deliverGreetingSendSelectors: ['[class*="deliver-greeting-modal"] [class*="--primary"]'],
    /** 弹层二次确认按钮（点击后出现） */
    confirmSelectors: [
      '.a-job-apply-resume-selection-panel__actions .a-button',
      '.a-job-apply-resume-selection-panel__actions button',
      // ATTACHMENT_SELECT 步骤：附件简历面板的确认入口是 <a>（不是 button），必须单列
      '.a-attachment-select__action-btn__delivery',
      '[class*="attachment-select"] a',
      '.a-job-apply-workflow .a-button--primary',
      '.a-job-apply-workflow button',
      '.a-modal .a-button--primary',
      '[class*="apply-workflow"] button',
    ],
    confirmLabels: ['确定投递', '同意并投递', '投递简历', '立即申请', '继续投递', '确定'],
    /** 成功面板 / 成功文案（文案取「足够特异」的长词，避免详情页其它文本误命中） */
    successSelectors: ['.a-job-apply-success-message-panel', '[class*="apply-success"]', '[class*="deliver-success"]', '[class*="deliver-greeting-modal"]'],
    successTexts: ['投递成功', '申请成功', '简历投递成功', '投递完成', '投递申请已提交', '已向对方发送简历和打招呼语'],
    /** 阻断态面板：命中即读面板文案交人工，绝不尝试绕过 */
    blockedSelectors: [
      '.a-job-apply-not-login-panel',
      '.a-job-apply-resume-creation-panel',
      '.a-job-apply-block-panel',
      '.a-job-apply-error-message-panel',
      '.a-job-apply-invite-code-panel',
      '[class*="not-login-panel"]',
    ],
    /** 登录墙文案（归入「未登录」而非普通失败，便于立即收口本平台） */
    loginTexts: ['扫码登录', '请先登录', '登录后', '立即登录', '登录/注册'],
    /** 平台侧每日上限 */
    limitTexts: ['达到上限', '已达上限', '投递次数', '今日投递'],
    /** 风控信号：命中立即暂停交人工（`行为异常` = 投递组件「已禁止您的投递行为」阻断面板文案） */
    riskTexts: ['安全验证', '请完成验证', '验证码', '行为异常'],
    /**
     * 风控文案的**判定范围**（容器选择器）。
     * 只在这些容器内查风控文案，**不做全页正文扫描**：岗位描述里出现「验证码」「行为异常」
     * 等词是常见业务诉求（反欺诈 / 风控开发岗），全页扫描会把正常岗位误判成风控并暂停引擎。
     * 覆盖：投递工作流弹层、通用弹层/toast/提示、风控告警挂件（页面会加载
     * `//i.zhaopin.com/widgets/c-pcweb-risk-warning`）、人机校验挂件。
     */
    riskScopeSelectors: [
      '.a-job-apply-workflow',
      '.a-modal',
      '[class*="dialog"]',
      '[class*="toast"]',
      '[class*="message-"]',
      '[class*="risk"]',
      '[class*="warning"]',
      '[class*="alert"]',
      '[class*="verify"]',
      '[class*="captcha"]',
      '[class*="waf"]',
    ],
  },
});

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

// ============================================================================
// 文案匹配谓词（纯函数，零 DOM 依赖）—— webview.cjs 的按钮定位与离线回归共用同一实现，
// 避免「回归脚本抄一份判定、线上跑另一份」的口径漂移。
// ============================================================================

/** 文案归一：去掉所有空白字符（「立即 投递」「已\u00a0投递」等渲染形态都能对齐） */
function normLabelText(t) {
  return String(t == null ? '' : t).replace(/\s+/g, '').trim();
}

/** 子串命中：候选文案任一被包含即算命中（用于「找按钮」这类宽松定位） */
function labelHit(text, labels) {
  const t = normLabelText(text);
  if (!t) return false;
  return (labels || []).some((l) => {
    const n = normLabelText(l);
    return Boolean(n) && t.includes(n);
  });
}

/** 精确命中：整串相等（用于「已投递态」这类判定——避免「已申请职位」导航链接被误判） */
function labelExactHit(text, labels) {
  const t = normLabelText(text);
  if (!t) return false;
  return (labels || []).some((l) => Boolean(normLabelText(l)) && t === normLabelText(l));
}

/**
 * 投递阻断面板的文案归类：'risk' | 'login' | 'blocked'（纯函数，webview 与离线回归共用）。
 *
 * 为什么按文案而非面板类名归类：智联 `.a-job-apply-block-panel` **一个面板承载多种原因**——
 * 「您的账户存在行为异常，已禁止您的投递行为」（账号级，必须整体暂停交人工）与
 * 「您已屏蔽这家公司，如需投递简历请先解除屏蔽」（单岗位，跳过即可）。按类名一刀切
 * 会把「屏蔽了某家公司」升级成全局风控暂停；按文案分级才是正确粒度。
 */
function classifyBlockedText(platform, text) {
  const spec = PLATFORM_APPLY_SPEC[platform] || {};
  const t = normLabelText(text);
  if (!t) return 'blocked';
  if (labelHit(t, spec.riskTexts)) return 'risk';
  if (labelHit(t, spec.loginTexts) || /登录|注册/.test(t)) return 'login';
  return 'blocked';
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
  PLATFORM_FORCE_OVERFLOW_SCAN,
  PLATFORM_FIELD_SELECTORS,
  PLATFORM_LIST_URL_RE,
  PLATFORM_DETAIL_URL_RE,
  DETAIL_URL_ANY_RE,
  LOGIN_WALL_URL_RE,
  LOGIN_WALL_TEXT_RE,
  PLATFORM_APPLY_SPEC,
  normLabelText,
  labelHit,
  labelExactHit,
  classifyBlockedText,
  supportsInlineDetail,
  isListPage,
  isDetailPage,
};
