// electron/cloakbrowser/cloakCollector.cjs —— CloakBrowser（Playwright Page）可视化采集页面脚本
//
// 由 launcher.cjs 通过 page.addInitScript({ content: ... }) 注入，**注入顺序**：
//   platform-adapters.cjs（挂到 window.__bossclawAdapters）→ 本文件（挂到 window.__bossclawCollector）
//   → cloakPreload.cjs（暴露 window.__bossclawEmitEvent / __bossclaw_listen / __bossclaw_dispatch）
//
// 职责：把 electron/preload/webview.cjs 的「可视化采集」链路搬到 CloakBrowser 引擎。
// 逐函数搬运，**只改传输层**：`notify(...)` 改为转发到 `window.__bossclawEmitEvent(...)`；
// 业务行为、选择器来源（一律取 window.__bossclawAdapters）、延迟、诊断文案、去重、熔断阈值全部保持一致。
//
// 本文件是纯页面脚本：不得引入 Electron / Node 侧依赖（只用浏览器 API 与 window 上的适配表/事件桥）。
//
// 安全不变量（AGENTS.md §5）：风控码 35/36/32 立即停交人工；登录墙即时收口不重试；
// 不给非 BOSS 加「逐卡点开详情」（非 BOSS 只做列表级采集）。
'use strict';

(function () {
  'use strict';

  // ===== 传输层（唯一改动点）=====
  // webview.cjs 的 notify 走宿主 IPC；这里改为 cloakPreload 暴露的 emit 桥。
  // emit 在注入顺序上晚于本文件，故每次调用时动态取（不要缓存函数引用）。
  function notify(channel, data) {
    try {
      const fn = window.__bossclawEmitEvent;
      if (typeof fn === 'function') fn(channel, data);
    } catch (e) { /* ignore */ }
  }

  const ADAPTERS = window.__bossclawAdapters;

  // 适配表缺失（launcher 注入失败 / 顺序错）时也不能静默：立即回一条可定位的收口原因，
  // 避免宿主一直等到 15 分钟兜底超时。
  if (!ADAPTERS) {
    const fail = () => {
      notify('collect-progress', { phase: 'collect-error', status: '平台适配表未注入（window.__bossclawAdapters 缺失），无法采集' });
      notify('collect-done', { listUrl: location.href, processed: 0, total: 0, error: 'adapters-missing' });
    };
    window.__bossclawCollector = {
      visualCollect: async () => { fail(); },
      visualCollectListOnly: async () => { fail(); },
      // 适配表缺失时采集已不可能；仍回一个「页面已就绪」的事实，让宿主进入采集入口后
      // 立即收到 collect-error，而不是在 waitTabReady 白等到超时。
      pageStatusData: () => ({
        url: location.href,
        readyState: String(document.readyState || 'complete'),
        bodyLen: Number((document.body && document.body.innerText || '').length) || 0,
        cards: 0,
        loginWall: false,
        adapterMissing: true,
      }),
      setControl: () => {},
    };
    return;
  }

  // ===== 基础工具（webview.cjs 65-135）=====
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  }

  function textOf(el) { return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim(); }

  // 原始文本行（**未压平空白**）：`textOf()` 会把换行压成空格，凡是「按行取字段」的兜底（标题首行 /
  // 公司行）都不能用它拆行 —— 旧实现 `textOf(card).split(/\n+/)` 恒得到「整卡一行」。
  function rawLines(el) {
    return String(el?.innerText || el?.textContent || '')
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  // BOSS 直聘薪资「字体混淆」还原：平台把薪资里的数字替换为 Unicode 私有区（PUA）码位，
  // 实测为固定线性偏移（PUA = 数字 ASCII + 0xE001），还原后才能正常展示/解析薪资区间。
  function decodeSalaryDigits(s) {
    return String(s == null ? '' : s).replace(/[\uE02F\uE031-\uE03A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xE001));
  }

  // 岗位描述清洗：剔除页面级噪音（推荐区 / 标题行操作按钮 / 下载 App 引导等）。
  function cleanJobDescription(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const cutAt = text.search(
      /去App|前往App|与BOSS随时沟通|求职工具|升级VIP|去升级|热门职位|热门城市|热门企业|附近城市|点击查看地图|查看更多信息|查看地图|工作地址|下载BOSS直聘|下载App|打开App|扫码下载/
    );
    let cleaned = cutAt >= 0 ? text.slice(0, cutAt) : text;
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

  // 人类化延迟抖动：baseMs 为「标称间隔」，实际等待在 ±jitterRatio（默认 0.35）内随机。
  function jitterDelay(baseMs, jitterRatio = 0.35) {
    const base = Math.max(40, Number(baseMs) || 0);
    const span = base * jitterRatio;
    return sleep(Math.round(base + (Math.random() * 2 - 1) * span));
  }

  // ===== 平台分发（选择器一律取适配表，禁止在此复制选择器字面量）=====
  const PLATFORM = ADAPTERS.detectPlatform(location.hostname);
  const PLATFORM_LIST_SELECTORS = ADAPTERS.PLATFORM_CARD_SELECTORS;
  const LINK_SELECTOR = ADAPTERS.PLATFORM_LINK_SELECTOR[PLATFORM];
  const FIELD_SELECTORS = ADAPTERS.PLATFORM_FIELD_SELECTORS[PLATFORM] || ADAPTERS.PLATFORM_FIELD_SELECTORS.boss;
  const LIST_ROOT_SELECTORS = ADAPTERS.PLATFORM_LIST_ROOT_SELECTORS[PLATFORM] || ADAPTERS.PLATFORM_LIST_ROOT_SELECTORS.boss;
  const SCROLLER_SELECTORS = ADAPTERS.PLATFORM_SCROLLER_SELECTORS[PLATFORM] || ADAPTERS.PLATFORM_SCROLLER_SELECTORS.boss;

  /** 平台显示名（诊断文案用；webview.cjs 同口径的本地映射，适配表未提供 label） */
  const PLATFORM_LABEL = { boss: 'BOSS直聘', liepin: '猎聘', zhaopin: '智联', job51: '前程无忧' }[PLATFORM] || PLATFORM;

  function pickText(selectors, root = document) {
    for (const sel of selectors) {
      const el = $(sel, root);
      if (el) { const t = textOf(el); if (t) return t; }
    }
    return '';
  }

  // ===== BOSS 官方 API（webview.cjs 389-407）=====
  // 在 zhipin.com 页面上下文执行 fetch：登录 cookie / 反爬 token 由浏览器会话与页面 JS 自动携带。
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

  // ===== 福利 / 工作制度 / 风险信号（webview.cjs 528-713）=====
  const WELFARE_BENEFIT_RE =
    /(五险一金|六险一金|三险一金|五险|住房公积金|公积金|年终奖|年终分红|绩效奖金|带薪年假|带薪休假|定期体检|补充医疗|股票期权|股权激励|生日福利|节日福利|节假日福利|团建聚餐|团建|免费午餐|免费三餐|员工食堂|零食下午茶|全勤奖|加班补助|加班补贴|夜班补助|夜班补贴|交通补助|交通补贴|住房补贴|房补|餐补|饭补|有无线网|节假日加班费|企业年金|底薪加提成|保底工资|员工旅游|年度旅游|免费班车|弹性工作|人才公寓|提供宿舍|宿舍|包住|包吃|双休|大小周|单休|轮休)/;
  const WELFARE_WORK_RE = /休|班|工作制|弹性/;
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

  // 采集路径源码兜底：直接抓岗位详情页 HTML（同源 fetch + 登录态），从源码 meta description
  // 提取「福利：…」段与正/负信号关键字并入 welfare。抓取失败静默返回空，不阻塞采集主循环。
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

  // 潜在「陷阱」关键字（工作台标黄提示）。
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

  // 好工作「正面信号」关键字（工作台绿标）。
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

  // 岗位发布时间/更新时间归一（僵尸岗位过滤 + 新鲜度排序的唯一数据源）。
  function extractPublishTime(cardText, detailText) {
    const t = textOf($('[class*="job-update"],[class*="update-time"],[class*="publish"],[class*="job-time"]'))
      || String(cardText || '').match(/刚刚(?:更新|发布)|今日(?:更新|发布)|今天(?:更新|发布)|(?:昨天|昨日)(?:更新|发布)|\d+\s*(?:分钟|小时)前(?:更新|发布)|\d+\s*天前(?:更新|发布)|\d+\s*日内更新|本周更新|本月更新/)?.[0]
      || String(detailText || '').match(/发布于\s*[\d-]+|(?:更新|发布)于\s*\d+\s*(?:分钟|小时|天)前|(?:更新|发布)于\s*[\d]{1,2}[-/月]\d{1,2}/)?.[0]
      || '';
    return String(t || '').trim().slice(0, 40);
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
    const metaTags = extractBenefitsFromMeta();
    const bodyText = ((scope && scope.innerText) || document.body.innerText || '').slice(0, 3000);
    const positiveTags = scanPositiveKeywords(metaDescriptionText(), bodyText);
    const riskTags = scanRiskKeywords(metaDescriptionText(), bodyText);
    return [...new Set([...domTags, ...metaTags, ...positiveTags, ...riskTags])].slice(0, 16);
  }

  // ===== 沟通入口定位（extractJobDetail 的 chatUrl 依赖；webview.cjs 846-958）=====
  // 选择器字面量来自 webview.cjs 的 BOSS_SELECTORS.chatButton（适配表未提供沟通按钮选择器），
  // 搬运时逐字保留，改动须与内置浏览器侧同源同步。
  const BOSS_SELECTORS = {
    chatButton: 'a.op-btn-chat, .start-chat-btn, .btn-startchat, .btn-start-chat, .btn-chat, .op-btn.chat, .job-detail-op-btn, [class*="start-chat"], [class*="startChat"], [ka*="job-detail-chat"], a[href*="/web/geek/chat"], a[href*="/chat/"]',
  };
  const CHAT_LABEL_PATTERN = /立即\s*沟通|继续\s*沟通|立\s*刻\s*沟通|打个\s*招呼|打\s*招呼|聊\s*一\s*聊|去\s*沟通|开始\s*沟通/;

  // 廉价文本读取（不触发重排）：textContent 不做布局计算。
  function textRaw(el) { return String(el?.textContent || '').replace(/\s+/g, ' ').trim(); }

  // 真实可点击元素判定（a / button / [role=button]）。
  function isClickableEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toLowerCase();
    return tag === 'a' || tag === 'button' || el.getAttribute?.('role') === 'button';
  }

  // 把候选解析为「真正可点击」的元素（容器一律不返回）。
  function resolveChatClickable(el) {
    if (!el) return null;
    if (isClickableEl(el)) return el;
    const inner = el.querySelector?.('a, button, [role="button"]');
    return isClickableEl(inner) ? inner : null;
  }

  function buttonScore(el, label) {
    const text = label == null ? textOf(el) : label;
    let score = 0;
    if (text === '立即沟通') score += 40;
    else if (text === '继续沟通') score += 30;
    else if (CHAT_LABEL_PATTERN.test(text)) score += 10;
    const detail = el.closest('[class*="job-detail"], .job-banner, .job-detail-box, .detail-content');
    if (detail) score += 100;
    if (isClickableEl(el)) score += 60;
    try { if (el.getBoundingClientRect().left > innerWidth * 0.5) score += 20; } catch {}
    return score;
  }

  // 沟通按钮定位：精确选择器直命中 → 退化为可点击元素扫描 → 择优。
  function communicateButton() {
    const seen = new Set();
    const gather = (list, useInnerText) => {
      const out = [];
      for (const raw of list) {
        const el = resolveChatClickable(raw);
        if (!el || seen.has(el)) continue;
        if (!visible(el) || el.disabled || el.getAttribute?.('aria-disabled') === 'true') continue;
        const label = useInnerText ? textOf(el) : textRaw(el);
        if (!CHAT_LABEL_PATTERN.test(label)) continue;
        seen.add(el);
        out.push({ el, label });
      }
      return out;
    };
    let ranked = gather(all(BOSS_SELECTORS.chatButton), true);
    if (!ranked.length) ranked = gather(all('button, a, [role="button"]'), false);
    let best = null;
    let bestScore = -1;
    for (const { el, label } of ranked) {
      const score = buttonScore(el, label);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // ===== 采集交互（滚动 / 高亮 / 安全点击）=====
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
    await jitterDelay(600, 0.3); // 滚动停顿也要人肉化，避免固定 600ms 节奏
  }

  // ===== 安全点击（对齐 job-claw-main clickElement：sanitize 危险属性 + 阻止默认跳转）=====
  // ⚠️ 这里**不能**改用真实点击：核心是「让页面收到事件但**阻止默认导航**」，
  // 合成 cancelable 事件 + capture 阶段 preventDefault 才能实现（真实点击无法 preventDefault）。
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
      // 保持与参考实现一致的单一合成 click：不额外派发 pointerdown/mousedown。
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

  // ===== 岗位卡片（collectCards / 身份 / 字段）=====
  // 岗位卡片提取（对齐 job-claw-main cards() + AI-BossJob-plus li.job-card-box）
  // quiet=true 时跳过诊断 notify（用于滚动加载期间的快速轮询，避免刷屏）。
  function collectCards(quiet = false) {
    // 选择器来自适配表：BOSS = 真机验证过的 8 个候选（逐字未改）；其余平台 = 各自稳定选择器
    const selectors = PLATFORM_LIST_SELECTORS[PLATFORM] || PLATFORM_LIST_SELECTORS.boss;
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
      .map((el) => el.closest(ADAPTERS.PLATFORM_CARD_CONTAINER_SELECTOR[PLATFORM] || 'li') || el)
      .filter(visible);
    // 诊断：再统计去重后的候选数
    if (!quiet) {
      notify('collect-progress', { phase: 'collect-candidates', count: candidates.length });
    }
    const uniq = [...new Set(candidates)];
    // 有效性过滤：内容长度合理 + 是真实岗位卡
    const valid = uniq.filter((el) => {
      const content = textOf(el);
      if (!content || content.length > 900) return false;
      // 必须是真实岗位卡：含 job_detail 链接（智联无锚点变体则认主进程标注的详情 URL）
      // 或薪资文本（含「元」后缀，如智联「9000-10000元」——排除筛选栏 / 无关 li）
      return Boolean(el.querySelector?.(LINK_SELECTOR))
        || Boolean(el.getAttribute?.('data-bossclaw-jobdetail'))
        || SALARY_TEXT_RE.test(content);
    });
    // 「像列表容器」的候选：内部装着 **≥2 个互不包含** 的有效候选（即两张以上真卡）→ 它是列表/包装容器。
    // 这类元素**不允许吸收内层**，否则会把内层真卡并成一条、静默丢岗位（宁重复不遗漏）。
    const containerLike = new Set(valid.filter((el) => {
      const inner = valid.filter((o) => o !== el && el.contains(o));
      const outerMost = inner.filter((o) => !inner.some((p) => p !== o && o.contains(p)));
      return outerMost.length > 1;
    }));
    // 嵌套归并：**同一岗位的嵌套命中只保留最外层卡**（详见 webview.cjs 同函数的注释）。
    return valid.filter((el) => {
      const own = cardJobTokens(el);
      return !valid.some((other) => {
        if (other === el || containerLike.has(other) || !other.contains(el)) return false;
        if (own.size === 0) return true;
        const outer = cardJobTokens(other);
        for (const t of own) if (outer.has(t)) return true;
        return false;
      });
    });
  }

  // 元素承载的「岗位身份」集合（jobId / jobdetail 路径 / 主进程标注的详情 URL）。
  function cardJobTokens(el) {
    const out = new Set();
    const push = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return;
      // 岗位号提取统一走适配表（新增链接形态只需改 jobIdFromUrl）
      const id = ADAPTERS.jobIdFromUrl(s);
      out.add(id || s.split('?')[0]);
    };
    if (el.matches?.(LINK_SELECTOR)) push(el.getAttribute('href'));
    push(el.getAttribute?.('data-bossclaw-jobdetail'));
    for (const a of (el.querySelectorAll?.(LINK_SELECTOR) || [])) push(a.getAttribute('href'));
    return out;
  }

  // 文本行启发式兜底（对齐 AI-BossJob-plus getCardLines / findCompanyFromLines）
  const CARD_LINE_NOISE = /立即沟通|继续沟通|打招呼|在线|刚刚活跃|今日活跃|昨日活跃|日内活跃|周内活跃|月内活跃|\d+\s*(?:分钟|小时|天|周|月)前?(?:活跃)?|[Kk]薪|薪[Kk]|元\/月|.BO.|应届|经验|学历|大专|本科|硕士|博士|全职|兼职|实习|招聘|急聘|猎头/i;
  // 薪资形（行兜底排除用）：区间薪（15-25K / 6000-8000元 / 1.2-1.3万）、「20K以上」、日薪（140-150元/天）
  const SALARY_LINE_RE = /\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*[Kk万]|\d+\s*[Kk]\s*以上|\d+\s*[-–~]\s*\d+\s*元/;

  /**
   * 卡片文本里的薪资兜底提取正则（**浏览期唯一权威**，全部薪资兜底一律引用本常量）。
   * 形态说明与修复史见 webview.cjs 同常量注释（逐字保留，勿在此另写一套）。
   */
  const SALARY_TEXT_RE = /(\d+(?:\.\d+)?)(?:\s*([Kk]|万|千|元(?:\s*\/\s*(?:天|日|月|时|年))?))?\s*[-–~至到]\s*(\d+(?:\.\d+)?)\s*([Kk]|万|千|元(?:\s*\/\s*(?:天|日|月|时|年))?)\s*(以上|以下)?(?![人项岁个款次])|(\d+(?:\.\d+)?)\s*([Kk]|万|千|元(?:\s*\/\s*(?:天|日|月|时|年))?)\s*(以上|以下)?(?![人项岁个款次])/;

  /**
   * 从任意文本里提取薪资串（引用 {@link SALARY_TEXT_RE}）。取不到返回 ''。
   */
  function matchSalaryText(text) {
    return String(text == null ? '' : text).match(SALARY_TEXT_RE)?.[0] || '';
  }

  // 地名识别（修复「公司 Top」把地点误当公司名）
  const LOCATION_SEP = /[·・•]/;
  const CITY_KEYWORDS = /北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|常州|宁波|无锡|佛山|东莞|合肥|济南|沈阳|大连|哈尔滨|石家庄|太原|昆明|贵阳|南宁|南昌|福州|海口|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台湾/;
  const ORG_WORDS = /公司|集团|科技|技术|有限|工作室|研究所|研究院|厂|局|社|院|银行|大学|学院|医院|超市|酒店|传媒|网络|信息|软件|电子商务|股份|企业|中心|协会|事务所|律所|品牌/;
  // 整串「城市·区·街道」（首段必须是城市名，避免「华为·杭州研究所」这类「组织·地点」被误删）
  const LOCATION_ONLY_RE = new RegExp(`^(?:${CITY_KEYWORDS.source})(?:${LOCATION_SEP.source}[\\u4e00-\\u9fa5A-Za-z0-9]+){1,3}$`);
  function looksLikeLocation(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (LOCATION_ONLY_RE.test(t)) return true;
    if (LOCATION_SEP.test(t) && !ORG_WORDS.test(t)) return true;
    return false;
  }
  // 清洗公司名：剔除地名型/保留字型脏值；有效时返回 trim 后的串（最长 80），否则返回 ''
  function cleanCompanyName(raw) {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || s.length > 80) return '';
    if (/^(公司|企业|雇主|单位|招聘方|公司名)$/.test(s)) return '';
    // 含地点分隔符：先按首段提取公司名，再判断整串是否纯地点。
    let candidate = s;
    if (LOCATION_SEP.test(s)) {
      const firstSeg = s.split(LOCATION_SEP).shift().trim();
      if (CITY_KEYWORDS.test(firstSeg)) return ''; // 首段即城市 → 纯地点
      candidate = ORG_WORDS.test(s) ? s : (firstSeg || '');
    }
    if (looksLikeLocation(candidate)) return '';
    return candidate;
  }
  // 从页面标题兜底取公司名（BOSS 详情页标题固定为「职位名_公司名招聘-BOSS直聘」）。
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
    const anchor = card.querySelector(LINK_SELECTOR);
    // 智联无 jobdetail 锚点的渲染变体（标题为 span 而非 a）：主进程按 __INITIAL_STATE__
    // 匹配后标注的详情 URL 兜底（见 main.cjs ZP_DETAIL_NAV_SCRIPT 的 annotate）
    const href = anchor?.href || card.getAttribute?.('data-bossclaw-jobdetail') || '';
    // 行兜底必须取**原始行**（见 rawLines 注释）
    const cardLines = rawLines(card);
    const title = pickFromCard(card, FIELD_SELECTORS.title)
      || textOf(anchor)
      || cardLines[0]
      || '';
    let company = pickFromCard(card, FIELD_SELECTORS.company);
    if (!company) {
      for (const line of cardLines.slice(1)) {
        // 跳过地点串 / 薪资串 / 噪声行，避免把地名/薪资误判为公司名。
        if (CARD_LINE_NOISE.test(line) || SALARY_LINE_RE.test(line) || looksLikeLocation(line)) continue;
        if (line.length >= 3 && line.length <= 24) { company = line; break; }
      }
    }
    return { title: title.slice(0, 80), company: cleanCompanyName(company), href, raw: textOf(card).slice(0, 500) };
  }

  /**
   * 薪资串整体形态（用于兄弟节点筛选，必须整串匹配，避免把「16-20万」筛选栏等噪声纳入）。
   * 允许尾部「·13薪 / ×15薪 / 15薪」年终奖月数（猎聘常见「8-15k·15薪」）。
   */
  const SALARY_WHOLE_RE = /^\s*\d+(?:\.\d+)?(?:\s*[-–~至到]\s*\d+(?:\.\d+)?)?\s*(?:[Kk]|万|千|元(?:\s*\/\s*(?:天|日|月|时|年))?)\s*(?:以上|以下)?\s*(?:[·*＊xX×]\s*1[2-8]\s*薪)?\s*$/;

  /** 平台专属结构型薪资提取（当前仅猎聘需要；其余平台走选择器 + 文本兜底） */
  function platformSalaryFromCard(card) {
    if (PLATFORM !== 'liepin') return '';
    const titleBox = card.querySelector('[class*="jobTitleBox"]');
    const row = titleBox?.parentElement;
    if (!row) return '';
    for (const child of Array.from(row.children)) {
      if (child === titleBox) continue;
      if (child.querySelector?.('[class*="jobTitleBox"]')) continue;
      const t = textOf(child);
      if (t && SALARY_WHOLE_RE.test(t)) return decodeSalaryDigits(t);
    }
    return '';
  }

  // 卡片结构化字段（对齐 AI-BossJob-plus recordApplication 的多选择器候选）
  function cardFields(card) {
    const cardText = textOf(card);
    // 薪资：① 平台专属结构提取（猎聘）→ ② 选择器命中值 → ③ 整卡文本正则兜底
    // 兜底正则在「还原混淆后的文本」上跑，否则 PUA 数字永远匹配不到
    const salary = platformSalaryFromCard(card)
      || decodeSalaryDigits(pickFromCard(card, FIELD_SELECTORS.salary))
      || matchSalaryText(decodeSalaryDigits(cardText))
      || '';
    // 地点：选择器 → 平台特有形态（猎聘卡片把城市写成「【北京】」）→ 城市名正则
    const location = pickFromCard(card, FIELD_SELECTORS.location)
      || (PLATFORM === 'liepin' ? cardText.match(/【\s*([^】]{2,20})\s*】/)?.[1] : '')
      || cardText.match(/北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|全国/)?.[0]
      || '';
    const hrActive = cardText.match(/在线|刚刚活跃|今日活跃|昨日活跃|\d+\s*日内活跃|\d+\s*周内活跃|\d+\s*月内活跃|\d+\s*(?:分钟|小时)前活跃/)?.[0] || '';
    const recruiterTitle = pickFromCard(card, FIELD_SELECTORS.recruiterTitle);
    const isHeadhunter = /猎头/.test(cardText);
    return { salary, location, hrActive, recruiterTitle, isHeadhunter };
  }

  // 去重 key（对齐 job-claw-main cardKey）
  function collectCardKey(card) {
    const anchor = card.querySelector(LINK_SELECTOR);
    // 智联无锚点变体：认主进程标注的 data-bossclaw-jobdetail（保证 processed 去重与 URL 一致）
    return anchor?.href || card.getAttribute('data-bossclaw-jobdetail') || card.getAttribute('data-jobid') || card.getAttribute('data-tlg-ext') || textOf(card).slice(0, 220);
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

  // ===== 详情面板（detailRoot / openCardDetail / extractJobDetail）=====
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
    // 关键修复：总超时收紧到 3.5s/次（之前 3*6500≈20s 是主循环卡死的元凶），
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
    // 公司名：改为有序 pickText（优先精确的窄选择器：详情根 → 卡片 → 卡片身份），
    // 末了用 cleanCompanyName 兜掉仍漏网的地点串。
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
    // 岗位发布时间/更新时间（僵尸岗位过滤 + 新鲜度排序的唯一数据源，与「加入任务」链路同函数）
    const publishTime = extractPublishTime(cardText, detailText);
    // 招聘方姓名（job-claw-main detailRecruiterIdentity 口径）
    const recruiterName = textOf(root?.querySelector('[class*="boss-name"],[class*="bossName"],[class*="recruiter-name"],[class*="job-boss"] [class*="name"],[class*="boss-info"] [class*="name"]'))
      || '';
    // 薪资兜底正则同样跑在「还原混淆后」的文本上；title/company 亦做还原，避免把 PUA 写进库
    const salaryMatch = matchSalaryText(decodeSalaryDigits(`${cardText} ${detailText}`));
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
      salary: fields.salary || salaryMatch || '',
      location: fields.location,
      description: cleanJobDescription(decodeSalaryDigits(detailText)).slice(0, 9000),
      cardText: decodeSalaryDigits(cardText).slice(0, 1000),
      url: realUrl,
      jobId,
      chatUrl,
      hrActive,
      publishTime,
      isHeadhunter: fields.isHeadhunter,
      recruiterName,
      recruiterTitle: fields.recruiterTitle,
      // 工作制度/福利标签（「周末双休」等）：日薪折算月薪的工作日基数识别来源
      welfare: _welfare,
    };
  }

  // ===== 采集运行时控制 =====
  const collectCtl = { paused: false, stopped: false, settleMs: 1200 };
  async function waitWhilePaused() {
    while (collectCtl.paused && !collectCtl.stopped) await sleep(200);
  }

  // ===== 列表滚动加载更多（对齐 AI-BossJob-plus scrollToLoadMoreJobs / autoScrollJobList）=====
  // 滚动容器探测：BOSS 列表容器自身可滚动（scrollHeight > clientHeight）时优先滚容器，
  // 否则回退 window 滚动。返回 null 表示用 window。
  function findListScroller() {
    const candidates = all(SCROLLER_SELECTORS.join(', '));
    let hitCandidate = false;
    for (const el of candidates) {
      hitCandidate = true;
      if (el.scrollHeight > el.clientHeight + 20) return el;
    }
    // 兜底：扫描「非详情面板」中可滚动面积最大的容器（详情面板是独立滚动区，排除以免滚错）。
    // 对 `PLATFORM_FORCE_OVERFLOW_SCAN` 声明的平台，候选命中但都不可滚时也强制再扫一遍。
    if (ADAPTERS.PLATFORM_FORCE_OVERFLOW_SCAN[PLATFORM] || !hitCandidate) {
      let best = null;
      let bestOverflow = 0;
      for (const el of all('div,main,section,ul,li')) {
        if (el.closest('.job-detail, .job-detail-box, [class*="job-detail"]')) continue;
        // 强制扫描平台再排除「包着详情面板」的容器（如智联 .job-split-layout__right 内含
        // .job-detail-panel，若按祖先选择器只看自身/祖先会被当成可滚容器选中、滚错列）
        if (ADAPTERS.PLATFORM_FORCE_OVERFLOW_SCAN[PLATFORM]
          && el.querySelector?.('.job-detail-panel, [class*="job-detail"], [class*="jobDetail"]')) continue;
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow > 40 && overflow > bestOverflow) { best = el; bestOverflow = overflow; }
      }
      if (best) return best;
    }
    return null; // 有候选但都不可滚 / 无候选 → 用 window（维持既有行为）
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

  // 渐进式下拉加载更多：从当前滚动位置开始，每步向下滚一屏的 80%，
  // 等待渲染后检查是否出现新卡；出现新卡即返回 grew=true。
  // 返回 { grew, atBottom }（二者互斥）：
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

  // ===== 可视化采集主循环（BOSS 详情级）=====
  // 逐卡片 滚动 → 高亮 → 点击展开 → 提取，实时回传进度。
  // 关键（对齐 job-claw-main）：BOSS 使用虚拟列表，点击后卡片节点会被替换，
  // 每轮重新 collectCards()，用 cardKey 去重（processed Set），index 递增，避免持有失效 DOM。
  async function visualCollect(opts = {}) {
    // 平台自检：宿主传入的 platform 与页面 hostname 判定不一致时回传诊断（以页面事实为准，不阻断）
    if (opts.platform && opts.platform !== PLATFORM) {
      notify('collect-progress', { phase: 'platform-mismatch', status: `宿主指定平台 ${opts.platform} 与页面判定 ${PLATFORM} 不一致，已按页面判定为准` });
    }
    // 非 BOSS 平台没有「列表内联详情面板」，走列表级采集（见 visualCollectListOnly 头注释）
    if (!ADAPTERS.supportsInlineDetail(PLATFORM)) return visualCollectListOnly(opts);
    collectCtl.paused = false;
    collectCtl.stopped = false;
    collectCtl.settleMs = Math.max(400, Number(opts.settleMs) || 1200);
    // 采集节奏（ms/步）必须**每步实时读取** —— collect-control 的 speed（加速/减速）
    // 写的是 collectCtl.settleMs，捕获成局部常量会让「加速/减速」变成死控制。
    const settleMsNow = () => Math.max(400, Number(collectCtl.settleMs) || 1200);
    // 单次采集兜底上限（对齐 job-claw-main discoveryLimit:0 软上限；本机 1000 兜底防止失控）
    const maxJobs = Math.max(1, Number(opts.maxJobs) || 1000);
    // 设置约束（由宿主 Workbench 传入，见 Settings → 搜索采集范围控制）：
    //   autoScroll=false  → 只采首屏可见卡，不自动下拉加载更多；
    //   scrollRounds>0    → 每批「下拉加载更多」的轮数上限。
    const autoScroll = opts.autoScroll !== false;
    const scrollRounds = Math.max(0, Number(opts.scrollRounds) || 0);
    let scrollRoundsUsed = 0;
    const processed = new Set();
    let index = 0;
    let processedCount = 0;
    let emptyRounds = 0;
    notify('collect-progress', { phase: 'start', index: 0, total: 0, maxJobs, status: '准备中' });

    // 一次性 DOM 诊断：把每个选择器命中数和前若干节点 className 发给 React（只发一次）
    // P4-04：诊断口径统一读适配表（与非 BOSS 分支同源），不在此处硬编码选择器
    try {
      const diagSelectors = PLATFORM_LIST_SELECTORS[PLATFORM] || PLATFORM_LIST_SELECTORS.boss;
      const diagLines = diagSelectors.map((s) => `${s}=${all(s).length}`);
      const diagRoot = $(LIST_ROOT_SELECTORS.join(', '));
      const diagUrl = location.href;
      notify('collect-progress', { phase: 'dom-diag', index: 0, total: 0, processed: 0, maxJobs, status: `[DOM] ${diagLines.join(' | ')} | root=${diagRoot ? diagRoot.className : 'none'} | url=${diagUrl.slice(0, 80)}` });
    } catch {}

    // 关键修复：先等 BOSS 列表出现，避免初次 collectCards() 拿到 0 卡就 emptyRounds=2 提前结束。
    // 超时由宿主传入（默认 30s），等待期间按秒回传进度便于用户判断。
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
        await sleep(settleMsNow());
      }
      // 登录墙优先于「选择器失效」判定：等了足够久仍一张岗位卡都没有，且命中登录特征
      // → 属未登录 / 登录态失效，不是选择器问题。回传 login-required 让宿主立即收口本平台
      // （**不重试、不换组合**）。口径与 visualCollectListOnly 的 login-required 完全一致。
      if (Date.now() - listWaitStartedAt > earlyBreakAfterMs
        && String(document.readyState) === 'complete'
        && loginWallDetected()) {
        notify('collect-progress', { phase: 'login-required', index: 0, total: 0, processed: 0, maxJobs, status: `${PLATFORM} 未登录或登录态已失效：请先在该平台标签页扫码登录后再采集` });
        break;
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
      await sleep(settleMsNow() * 0.6);
    }

    while (!collectCtl.stopped) {
      await waitWhilePaused();
      if (collectCtl.stopped) break;
      if (processedCount >= maxJobs) break;
      let cards = [];
      try { cards = collectCards(); } catch (e) {
        notify('collect-progress', { phase: 'collect-error', index, total: 0, processed: processedCount, maxJobs, status: `卡片查询异常：${String(e?.message || e).slice(0, 80)}` });
        await sleep(settleMsNow());
        continue;
      }
      if (cards.length === 0 && processedCount === 0 && emptyRounds === 0) {
        // 首轮 cards 仍为空（列表还没出来）— 主动滚一次促加载（关闭自动下拉时仅等待列表渲染，不滚动）
        if (autoScroll) await scrollJobListLoadMore(processed, { settleMs: settleMsNow() });
        await sleep(settleMsNow() * 1.5);
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
        // 本批卡片已处理完：从当前滚动位置渐进下拉加载更多。
        // 对齐 AI-BossJob-plus autoScrollJobList：滚到物理底部即停止；连续 3 轮无新卡也停止。
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
        const { grew, atBottom } = await scrollJobListLoadMore(processed, { settleMs: settleMsNow() });
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
      // 1) 平滑滚动到卡片并高亮（可视化动画）
      await smoothScrollIntoView(card);
      highlightElement(card, settleMsNow());
      notify('collect-progress', { phase: 'scroll', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: '滚动中' });
      await sleep(settleMsNow());
      if (collectCtl.stopped) break;
      await waitWhilePaused();
      if (processedCount >= maxJobs) break;
      // 2) 点击展开详情
      notify('collect-progress', { phase: 'click', index, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: '点击中' });
      await openCardDetail(card);
      await sleep(Math.max(500, Math.round(settleMsNow() * 0.6)));
      if (collectCtl.stopped) break;
      // 3) 提取岗位信息并回传
      const job = extractJobDetail(card);
      // 采集路径福利兜底：当福利缺「社保信号」时，走 card.json API（与「加入任务」同源）补全
      // welfareList（含 五险一金/年终奖 等），保证工作台绿标可显示。
      try {
        let _jid = String(job.jobId || '').trim();
        // 归一化 jobId：jobUrlToken 对「路径无 job_detail、仅 query 携带 jobId/securityId/lid」的链接
        // 会返回 `jobid=xxx` 这类带前缀 token，直接拼进 ?encryptJobId= 会得到错误参数。
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
        // card.json 仍缺社保信号（API 风控/空壳/jobId 缺失）→ 直接从岗位详情页源码（meta description）补全。
        if (!(job.welfare || []).some((w) => /五险|六险|三险|公积金/.test(String(w)))) {
          const src = await fetchDetailSourceWelfare(job.url);
          if (src.length) {
            job.welfare = [...new Set([...(job.welfare || []), ...src])].slice(0, 16);
          }
        }
      } catch (e) {}
      processedCount += 1;
      notify('collect-progress', { phase: 'done', index, total: cards.length, processed: processedCount, maxJobs, title: job.title, company: job.company, status: '完成', job });
      await sleep(settleMsNow());
    }
    notify('collect-done', { listUrl: location.href, processed: processedCount, total: processedCount, maxJobs });
  }

  // ===== 页面状态探测（供宿主判定「搜索页是否真的加载完成」）=====
  // 直接读页面自身的事实：document.readyState / 正文长度 / 岗位卡片命中数 / 选择器逐一命中数 /
  // 列表容器 / 骨架屏启发式；宿主以这些事实为权威，遮罩状态只作参考。
  function pageStatusData() {
    // 选择器按平台取（BOSS 覆盖原 7 项，另多一项 .search-job-result li.job-card-box 诊断键）
    const selectors = [...new Set([...(PLATFORM_LIST_SELECTORS[PLATFORM] || []), LINK_SELECTOR])];
    const counts = {};
    for (const s of selectors) {
      try { counts[s] = all(s).length; } catch { counts[s] = -1; }
    }
    let cards = -1;
    try { cards = collectCards(true).length; } catch {}
    const bodyText = String(document.body?.innerText || '');
    const listRoot = $(LIST_ROOT_SELECTORS.join(', '));
    return {
      url: location.href,
      title: document.title,
      readyState: String(document.readyState || ''),
      bodyLen: bodyText.length,
      cards,
      counts,
      listRootCls: listRoot ? String(listRoot.className || '').slice(0, 120) : '',
      skeleton: all('[class*="skeleton"], [class*="loading"], [class*="spinner"], [class*="placeholder"]').length,
      // L-8：登录墙判定统一走 loginWallDetected()（URL 特征 或「正文命中登录文案 且 一条岗位链接都没有」）。
      // 原实现额外用「正文前 500 字含 请登录/扫码登录/安全验证/验证码」直接置位 ——
      // 风控类岗位 JD 里出现「验证码/安全验证」字样会被误报为登录墙。
      loginWall: loginWallDetected(),
    };
  }

  // ===== 非 BOSS 平台「列表级」可视化采集 =====
  // 为什么只做列表级（重要设计口径，勿「顺手」加成详情级「逐卡点开」）：
  //   猎聘 / 智联 / 前程无忧 的搜索页**没有可用的内联详情面板**（BOSS 独有的 master-detail 形态），
  //   点卡片会导航到独立详情页或开新标签页。在内置浏览器里逐卡点开会把「可视化采集」变成
  //   「逐页跳转」：既慢（每次导航都要重新等页面），又会把标签页带离搜索页（跨搜索组合串台）。
  //   因此本通道采集**卡片 DOM 字段**（标题 / 公司 / 薪资 / 地点 / 标签 / 链接）——但不再用
  //   「整卡文本」冒充 JD。
  //
  // 详情 JD 的来源（2026-09 更正，原注释称「由 Camoufox 补齐」不准确：camoufox/platforms/
  // {liepin,zhaopin,job51}.py 只做列表级，无详情段）：
  //   · 智联 zhaopin → **本文件 `enrichJobDetail()`**：按卡片链接里的 number 调平台自己的
  //     职位详情接口（`platform-adapters.cjs` 的 zhaopinJobDetailUrl）。
  //   · 猎聘 liepin → **本文件 `enrichJobDetail()`**：猎聘详情页是**服务端渲染**（JD 直接写在 HTML 里），
  //     按卡片链接的 jobId 取同源详情页 `/job/<id>.shtml` 的 HTML，交给
  //     `platform-adapters.cjs::parseLiepinJobDetailHtml()` 解析。
  //   · 前程无忧 → 目前只有列表字段（详情页形态需另行实测，勿照抄猎聘/智联参数）。
  // 复用件：collectCtl（暂停/继续/停止/调速）/ smoothScrollIntoView / highlightElement /
  //         scrollJobListLoadMore / collectCards / cardIdentity / cardFields / collectCardKey。

  // 登录墙判定：URL 命中登录页特征，或「正文命中登录文案 且 页面内没有任何本平台岗位链接」。
  // 后者是必须的守卫——页脚/导航常出现「登录」字样，只有「一条岗位链接都没有」时才能判定为登录墙。
  function loginWallDetected() {
    try {
      const loc = String(location.pathname || '') + String(location.search || '');
      if (ADAPTERS.LOGIN_WALL_URL_RE.test(loc)) return true;
      if (all(LINK_SELECTOR).length > 0) return false;
      const head = String(document.body?.innerText || document.body?.textContent || '').slice(0, 2000);
      return ADAPTERS.LOGIN_WALL_TEXT_RE.test(head);
    } catch { return false; }
  }

  // 稳定兜底身份：无真实 URL / jobId 的卡片（智联无锚点变体且主进程注解未命中）
  // 用「标题|公司|薪资|地点」生成确定性 FNV-1a 短哈希作为 jobId。
  function stableFallbackJobId(fields, identity) {
    const s = [identity.title, identity.company, fields.salary, fields.location].join('\u0001');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'f' + (h >>> 0).toString(36);
  }

  // 列表级字段提取（不点开详情）：选择器优先 + 文本正则兜底
  function extractJobFromCardOnly(card) {
    const identity = cardIdentity(card);
    const fields = cardFields(card);
    const url = String(identity.href || '');
    // jobId 统一走适配表唯一权威（猎聘 /job/xxx.shtml 与 SEO /a/xxx.shtml 都能取到并去后缀）
    let jobId = ADAPTERS.jobIdFromUrl(url);
    // 无真实 URL 也无平台 jobId（仅智联新增会出现）→ 用稳定哈希兜底，保证入库去重不失效
    if (!jobId && !url) jobId = stableFallbackJobId(fields, identity);
    return {
      platform: PLATFORM,
      title: identity.title || '岗位',
      company: identity.company || '',
      salary: fields.salary || '',
      location: fields.location || '',
      hrActive: fields.hrActive || '',
      isHeadhunter: Boolean(fields.isHeadhunter),
      // 列表级采集拿不到详情 JD：先用卡片文本占位（AI 评分至少不吃空），
      // 随后由 enrichJobDetail() 按平台详情通道覆盖为真实 JD
      description: textOf(card).slice(0, 800),
      // 列表级采集拿不到真实详情 URL 时（智联无 jobdetail 锚点变体且主进程注解未命中），
      // 落空字符串、不回退搜索页 URL：搜索页 URL 会让同批不同岗位折叠成同一链接。
      url: url || '',
      jobId,
      labels: [],
      skills: [],
      welfare: [],
    };
  }

  // ===== 非 BOSS 平台 JD 补齐：列表卡不带 JD，按卡片链接取平台自己的详情 =====
  // 两档获取策略（`PLATFORM_DETAIL_API_FILL` 声明哪些平台走本通道）：
    //   智联 zhaopin → 同源**JSON 详情接口**（跨域，需接口自身 CORS 放行）；
  //   猎聘 liepin  → 同源**详情页 HTML**（SSR，无跨域问题，由 parseLiepinJobDetailHtml 解析）。
  // 三档护栏（缺一不可）：
  //   ① 单次采集总量上限 —— 防 maxJobsPerRun=1000 时打出上千请求；
  //   ② 连续失败熔断 —— 接口/页面变更、需登录、被限流时立即停手并回传诊断；
  //   ③ 单请求超时 + 请求间隔抖动 —— 不并发打接口、不瞬间连发。
  // 失败一律**不改 job**：保留卡片文本兜底，岗位照常入库（宁缺 JD 不丢岗位）。
  const JD_FILL_MAX_PER_RUN = 300;
  const JD_FILL_TIMEOUT_MS = 12000;
  const JD_FILL_FAIL_STREAK_LIMIT = 4;
  const JD_FILL_GAP_MS = 180; // 请求间隔基准（另加 0~220ms 抖动）
  // JD 入库长度上限：与 BOSS 详情级采集同量级（详情提取 slice(0, 9000)）。
  const JD_FILL_DESCRIPTION_MAX = 9000;
  const jdFillState = { attempted: 0, filled: 0, failed: 0, skipped: 0, streak: 0, stopped: '', lastError: '' };
  /** 当前平台的补 JD 通道（'zhaopin-json' | 'liepin-html'）；能力表未声明的平台为 '' */
  const JD_FILL_CHANNEL = PLATFORM === 'zhaopin' ? 'zhaopin-json' : (PLATFORM === 'liepin' ? 'liepin-html' : '');

  function resetJdFillState() {
    jdFillState.attempted = 0;
    jdFillState.filled = 0;
    jdFillState.failed = 0;
    jdFillState.skipped = 0;
    jdFillState.streak = 0;
    jdFillState.stopped = '';
    jdFillState.lastError = '';
  }

  /**
   * 单次请求（**绝不抛出**）：超时 / 网络异常 / 非 2xx 一律返回 {ok:false,error}。
   * @param {string} url
   * @param {'json'|'text'} as
   * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
   */
  async function fetchDetailSource(url, as) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, JD_FILL_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        // 猎聘详情页 HTML：显式声明接受 HTML，且带 Accept 让平台按「站内跳转」处理
        headers: as === 'text'
          ? { Accept: 'text/html,application/xhtml+xml' }
          : { Accept: 'application/json' },
        credentials: 'include', // 同源带 Cookie：未登录时平台会回登录页 → 我们按「解析无 JD」静默跳过，不绕登录
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, data: as === 'text' ? await res.text() : await res.json() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 熔断 / 达上限时的一次性诊断回传（带上当前岗位，避免实时面板标题被清空） */
  function notifyJdFillStop(reason, job) {
    notify('collect-progress', {
      phase: 'jd-enrich-warn',
      index: jdFillState.attempted,
      title: String(job?.title || ''),
      company: String(job?.company || ''),
      status: `${PLATFORM_LABEL} JD 补齐已停止：${reason}（已补 ${jdFillState.filled} 条 / 尝试 ${jdFillState.attempted} 条，岗位仍按卡片文本入库）`,
    });
  }

  /**
   * 按岗位补齐 JD 与详情字段。返回是否补到 JD。
   * 只对能力表声明的平台生效（`ADAPTERS.PLATFORM_DETAIL_API_FILL`），调用点不硬编码平台名。
   * @param {object} job extractJobFromCardOnly 产出的卡片岗位对象（就地覆盖 description 等字段）
   * @returns {Promise<boolean>}
   */
  async function enrichJobDetail(job) {
    if (!job || !ADAPTERS.PLATFORM_DETAIL_API_FILL[PLATFORM]) return false;
    if (jdFillState.stopped || collectCtl.stopped) return false;
    if (jdFillState.attempted >= JD_FILL_MAX_PER_RUN) {
      jdFillState.stopped = `本次已达单次补齐上限 ${JD_FILL_MAX_PER_RUN} 条`;
      notifyJdFillStop(jdFillState.stopped, job);
      return false;
    }

    // ① 按平台取「详情来源 URL」与解析器；取不到岗位号（哈希兜底身份）→ 保持卡片文本
    let url = '';
    if (JD_FILL_CHANNEL === 'zhaopin-json') {
      const number = ADAPTERS.zhaopinJobNumber(job.jobId || job.url);
      if (!number) { jdFillState.skipped += 1; return false; }
      url = ADAPTERS.zhaopinJobDetailUrl(number);
    } else if (JD_FILL_CHANNEL === 'liepin-html') {
      url = ADAPTERS.liepinJobDetailUrl(job.jobId || job.url);
      if (!url) { jdFillState.skipped += 1; return false; }
    } else {
      return false;
    }

    jdFillState.attempted += 1;
    const as = JD_FILL_CHANNEL === 'liepin-html' ? 'text' : 'json';
    const r = await fetchDetailSource(url, as);
    if (!r.ok) {
      jdFillState.failed += 1;
      jdFillState.streak += 1;
      jdFillState.lastError = r.error;
      if (jdFillState.streak >= JD_FILL_FAIL_STREAK_LIMIT) {
        jdFillState.stopped = `连续 ${jdFillState.streak} 次请求失败（最后错误：${jdFillState.lastError}）`;
        notifyJdFillStop(jdFillState.stopped, job);
      }
      return false;
    }
    // 注意：请求成功**不代表这批 JD 可用** —— 连续失败计数只在「载荷可解析」后才重置（见下方）。
    await sleep(JD_FILL_GAP_MS + Math.random() * 220);

    const parsed = JD_FILL_CHANNEL === 'liepin-html'
      ? ADAPTERS.parseLiepinJobDetailHtml(r.data)
      : ADAPTERS.parseZhaopinJobDetail(r.data);
    if (!parsed) {
      // 通道通了但载荷结构不符（平台改版 / 登录墙 HTML / 该岗位没写 JD）→ 计入失败，连续多次即熔断
      jdFillState.failed += 1;
      jdFillState.streak += 1;
      jdFillState.lastError = JD_FILL_CHANNEL === 'liepin-html'
        ? '详情页未解析出 JD 正文（页面结构变更或登录墙）'
        : '详情接口载荷结构不符（无 detailedPosition）';
      // 熔断判据必须是**连续**失败（streak），不能用累计 failed —— 否则零星几条
      // 「平台本就没写 JD / 载荷缺字段」就足以把整批补 JD 提前熔断（见审查 #80）。
      if (jdFillState.streak >= JD_FILL_FAIL_STREAK_LIMIT && !jdFillState.stopped) {
        jdFillState.stopped = `连续 ${jdFillState.streak} 次载荷不可解析`;
        notifyJdFillStop(jdFillState.stopped, job);
      }
      return false;
    }
    jdFillState.streak = 0; // 载荷成功解析：重置连续失败计数
    const jd = String(parsed.description || '').trim().slice(0, JD_FILL_DESCRIPTION_MAX);
    if (jd) job.description = jd;
    // 技能 / 福利 / HR 只在详情确实给到时覆盖（DOM 侧这些字段本为空，不存在覆盖掉有效值的风险）
    // 标题 / 薪资 / 地点同理：只在详情页给到**非空**值时覆盖，避免把卡片已抓到的好值打回空。
    if (Array.isArray(parsed.skills) && parsed.skills.length) job.skills = parsed.skills;
    if (Array.isArray(parsed.welfare) && parsed.welfare.length) job.welfare = parsed.welfare;
    if (parsed.recruiterName) job.recruiterName = parsed.recruiterName;
    if (parsed.recruiterTitle) job.recruiterTitle = parsed.recruiterTitle;
    if (parsed.salary) job.salary = parsed.salary;
    if (parsed.location) job.location = parsed.location;
    if (parsed.company) job.company = parsed.company;
    if (!jd) { jdFillState.skipped += 1; return false; } // 该岗位本身没写 JD → 保留卡片文本兜底
    jdFillState.filled += 1;
    return true;
  }

  /** 采集收尾时汇总补 JD 结果（但凡有尝试或「无岗位号」都会回传，避免「这批岗位缺 JD」无解释） */
  function reportJdFillSummary() {
    if (!jdFillState.attempted && !jdFillState.skipped) return;
    notify('collect-progress', {
      phase: 'jd-enrich-summary',
      index: jdFillState.attempted,
      status: `${PLATFORM_LABEL} JD 补齐：成功 ${jdFillState.filled} 条 / 尝试 ${jdFillState.attempted} 条`
        + (jdFillState.failed ? `，失败 ${jdFillState.failed} 条` : '')
        // skipped = 卡片拿不到岗位号（如主进程注解未覆盖的滚动加载卡）或该岗位本身没写 JD
        + (jdFillState.skipped ? `，未补 ${jdFillState.skipped} 条（卡片无岗位号或岗位无 JD，已按卡片文本入库）` : '')
        + (jdFillState.stopped ? `｜已提前停止：${jdFillState.stopped}` : ''),
    });
  }

  async function visualCollectListOnly(opts = {}) {
    collectCtl.paused = false;
    collectCtl.stopped = false;
    collectCtl.settleMs = Math.max(400, Number(opts.settleMs) || 1200);
    // 采集节奏（ms/步）必须**每步实时读取** —— collect-control 的 speed（加速/减速）写的是 collectCtl.settleMs。
    const settleMsNow = () => Math.max(400, Number(collectCtl.settleMs) || 1200);
    const maxJobs = Math.max(1, Number(opts.maxJobs) || 1000);
    const autoScroll = opts.autoScroll !== false;
    const scrollRounds = Math.max(0, Number(opts.scrollRounds) || 0);
    const listTimeoutMs = Math.max(5000, Number(opts.listTimeoutMs) || 30000);
    let scrollRoundsUsed = 0;
    const processed = new Set();
    let processedCount = 0;
    let emptyRounds = 0;
    resetJdFillState(); // 每轮采集重置 JD 补齐计数 / 熔断状态
    notify('collect-progress', { phase: 'start', index: 0, total: 0, maxJobs, platform: PLATFORM, status: `准备中（${PLATFORM} · 列表级采集）` });

    // 一次性 DOM 诊断（与 BOSS 同口径，选择器取自适配表）
    try {
      const diagLines = (PLATFORM_LIST_SELECTORS[PLATFORM] || []).map((s) => `${s}=${all(s).length}`);
      const diagRoot = $(LIST_ROOT_SELECTORS.join(', '));
      notify('collect-progress', { phase: 'dom-diag', index: 0, total: 0, processed: 0, maxJobs, platform: PLATFORM, status: `[DOM] ${diagLines.join(' | ')} | root=${diagRoot ? String(diagRoot.className || '').slice(0, 60) : 'none'} | url=${location.href.slice(0, 80)}` });
    } catch {}

    // 列表首屏等待（含登录墙判定）：拿到卡片即进入主循环
    const listWaitStartedAt = Date.now();
    const listReadyDeadline = listWaitStartedAt + listTimeoutMs;
    let initialWaitCount = 0;
    while (Date.now() < listReadyDeadline && !collectCtl.stopped) {
      let cards = [];
      try { cards = collectCards(true); } catch (e) {
        notify('collect-progress', { phase: 'collect-error', index: 0, total: 0, processed: 0, maxJobs, status: `列表查询异常：${String(e?.message || e).slice(0, 80)}` });
      }
      if (cards.length > 0) {
        notify('collect-progress', { phase: 'list-ready', index: 0, total: cards.length, processed: 0, maxJobs, status: `列表就绪（${cards.length} 卡）` });
        break;
      }
      // 未登录：明确回传 login-required，由宿主提示用户去该平台标签页扫码登录（不猜、不绕过）
      if (loginWallDetected()) {
        notify('collect-progress', { phase: 'login-required', index: 0, total: 0, processed: 0, maxJobs, status: `${PLATFORM} 未登录或登录态已失效：请先在该平台标签页扫码登录后再采集` });
        notify('collect-done', { listUrl: location.href, processed: 0, total: 0, maxJobs, loginRequired: true });
        return;
      }
      initialWaitCount += 1;
      if (initialWaitCount === 1 || initialWaitCount % 4 === 0) {
        notify('collect-progress', { phase: 'waiting-list', index: 0, total: 0, processed: 0, maxJobs, status: `等待列表渲染（已 ${Math.round((Date.now() - listWaitStartedAt) / 1000)}s / 上限 ${Math.round(listTimeoutMs / 1000)}s，页面 ${String(document.readyState)}）` });
      }
      await sleep(settleMsNow() * 0.6);
    }

    // 主循环：逐卡滚动 + 高亮 + 回传（**不点击卡片** —— 见函数头注释）
    // 智联额外一步：入库前按 number 调平台详情接口补齐 JD（失败保留卡片文本兜底）。
    while (!collectCtl.stopped) {
      await waitWhilePaused();
      if (collectCtl.stopped) break;
      if (processedCount >= maxJobs) break;
      let cards = [];
      try { cards = collectCards(); } catch (e) {
        notify('collect-progress', { phase: 'collect-error', index: 0, total: 0, processed: processedCount, maxJobs, status: `卡片查询异常：${String(e?.message || e).slice(0, 80)}` });
        await sleep(settleMsNow());
        continue;
      }
      const pending = cards.filter((c) => {
        const k = collectCardKey(c);
        return Boolean(k) && !processed.has(k);
      });
      if (pending.length === 0) {
        // 本屏已采完 → 按设置渐进下拉加载更多（复用 BOSS 同一套滚动判定）
        if (!autoScroll) {
          notify('collect-progress', { phase: 'list-bottom', index: 0, total: cards.length, processed: processedCount, maxJobs, status: '已按「不自动下拉」设置采完首屏可见卡，停止加载' });
          break;
        }
        if (scrollRounds > 0 && scrollRoundsUsed >= scrollRounds) {
          notify('collect-progress', { phase: 'list-bottom', index: 0, total: cards.length, processed: processedCount, maxJobs, status: `已达到下拉轮数上限（${scrollRounds} 轮），停止加载` });
          break;
        }
        scrollRoundsUsed += 1;
        const { grew, atBottom } = await scrollJobListLoadMore(processed, { settleMs: settleMsNow() });
        if (atBottom) {
          notify('collect-progress', { phase: 'list-bottom', index: 0, total: cards.length, processed: processedCount, maxJobs, status: '已滚动到列表底部，加载完毕' });
          break;
        }
        if (!grew) emptyRounds += 1;
        else emptyRounds = 0;
        if (emptyRounds >= 3) {
          notify('collect-progress', { phase: 'list-bottom', index: 0, total: cards.length, processed: processedCount, maxJobs, status: '连续 3 轮无新卡，停止加载' });
          break;
        }
        continue;
      }
      const card = pending[0];
      const key = collectCardKey(card);
      processed.add(key);
      const identity = cardIdentity(card);
      await smoothScrollIntoView(card);
      highlightElement(card, settleMsNow());
      notify('collect-progress', { phase: 'scroll', index: processedCount + 1, total: cards.length, processed: processedCount, maxJobs, title: identity.title, company: identity.company, status: '滚动中' });
      await sleep(settleMsNow());
      if (collectCtl.stopped) break;
      await waitWhilePaused();
      const job = extractJobFromCardOnly(card);
      // 补齐详情 JD / 技能 / 福利 / HR（智联经 JSON 详情接口、猎聘经同源详情页 HTML；
      // 其它平台能力表未声明 → 直接返回 false）
      await enrichJobDetail(job);
      processedCount += 1;
      notify('collect-progress', { phase: 'done', index: processedCount, total: cards.length, processed: processedCount, maxJobs, title: job.title, company: job.company, status: '完成', job });
      await sleep(settleMsNow());
    }
    reportJdFillSummary();
    notify('collect-done', { listUrl: location.href, processed: processedCount, total: processedCount, maxJobs });
  }

  // ===== 采集运行时控制（与 webview.cjs 3140-3147 完全同口径）=====
  function setControl(arg) {
    const action = (arg && arg.action) || '';
    if (action === 'pause') collectCtl.paused = true;
    else if (action === 'resume') collectCtl.paused = false;
    else if (action === 'stop') { collectCtl.stopped = true; collectCtl.paused = false; }
    else if (action === 'speed') {
      const ms = Number((arg && arg.settleMs) || 0);
      if (ms >= 300) collectCtl.settleMs = Math.min(5000, ms);
    }
  }

  // ===== 对外暴露（cloakPreload 的 visual-collect / collect-control / page-status-probe 调用点）=====
  window.__bossclawCollector = {
    visualCollect,
    visualCollectListOnly,
    pageStatusData,
    setControl,
  };
})();
