// electron/cloakbrowser/cloakPreload.cjs
// 由 launcher.cjs 通过 page.addInitScript({ content: ... }) 注入到 CloakBrowser Page 内。
// 等价于原 electron/preload/webview.cjs 在 Electron <webview> 中的角色。
//
// 与 webview.cjs 的差异：
//  - 不依赖 electron.ipcRenderer；通过 console.log('__bossclaw_emit__', JSON.stringify(...))
//    把事件外抛到 launcher（launcher 监听 page.on('console')）
//  - 渲染层 → Page 的消息：launcher 调 page.evaluate 触发 window.__bossclaw_dispatch
//  - 输入（input/selectAll/delete/pressEnter）走 launcher 直接 page.keyboard.*，
//    本脚本不参与；保持 isTrusted:true。
//
// 安全不变量（AGENTS.md §2.1）：code 35/36/32 立即停止并交人工；招呼语非空、外部网申跳过。
// Boss 业务侧选择器（BossAdapter）由后续阶段从 webview.cjs 选择性搬入；本骨架先打通协议。
'use strict';

(function () {
  if (window.__bossclaw_installed__) return;
  window.__bossclaw_installed__ = true;

  // ===== 工具 =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  // ===== 事件桥接 =====
  // 渲染层 / launcher → Page：window.__bossclaw_dispatch(channel, payload)
  // Page → launcher / 渲染层：console.log('__bossclaw_emit__' + NONCE + JSON.stringify({channel,payload}))
  // M-7：NONCE 由 launcher 每次启动替换注入（本文件以 __BOSSCLAW_EMIT_NONCE__ 占位）；
  // 未携带正确 NONCE 的 `__bossclaw_emit__` 事件会被 launcher 丢弃，防页面盲伪造。
  const EMIT_NONCE = '__BOSSCLAW_EMIT_NONCE__';
  const channelHandlers = new Map();
  function emit(channel, payload) {
    try {
      console.log('__bossclaw_emit__' + EMIT_NONCE + JSON.stringify({ channel, payload: payload || {} }));
    } catch (e) { /* ignore */ }
  }
  window.__bossclaw_emit = emit;
  // 供 cloakCollector.cjs（先于本文件注入，晚于本文件执行）转交采集事件
  window.__bossclawEmitEvent = emit;
  window.__bossclaw_dispatch = function (channel, payload) {
    const list = channelHandlers.get(channel);
    if (!list) return false;
    for (const fn of list) {
      try { fn(payload || {}); } catch (e) { /* ignore */ }
    }
    return true;
  };
  window.__bossclaw_listen = function (channel, fn) {
    if (!channelHandlers.has(channel)) channelHandlers.set(channel, []);
    channelHandlers.get(channel).push(fn);
    return () => {
      const arr = channelHandlers.get(channel) || [];
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
  };

  // ===== 导航回传 =====
  function emitNav() {
    emit('nav', {
      url: location.href,
      title: document.title || '',
      canGoBack: history.length > 1,
      canGoForward: false, // Page 跨标签时不维护；launcher 端 goBack/forward 已实现
    });
  }
  window.addEventListener('popstate', emitNav);
  window.addEventListener('hashchange', emitNav);
  // 初始一次
  setTimeout(emitNav, 0);

  // ===== 登录态检测（与原 webview.cjs login-state 语义对齐）=====
  function checkLogin() {
    // BOSS 直聘登录主标志：wt2 cookie + 顶部导航头像/用户名；这里用轻量标志
    const cookies = document.cookie || '';
    const hasWt2 = /(?:^|;\s*)wt2=/.test(cookies);
    // 兜底：检测用户头像元素存在
    const hasAvatar = !!document.querySelector('.user-nav, .header-user, [class*="userAvatar"]');
    return hasWt2 || hasAvatar;
  }
  function emitLogin() {
    emit('login-state', { loggedIn: checkLogin() });
  }
  setTimeout(emitLogin, 800);
  // 路由变化后再次检测
  window.__bossclaw_listen('nav', () => setTimeout(emitLogin, 600));

  // ===== 任务阶段（apply-stage）通知辅助 =====
  function notifyStage(stage, extra) {
    emit('apply-stage', Object.assign({ stage }, extra || {}));
  }

  // ===== job-extracted：最简版提取（与 webview.cjs 行为一致：返回 {url, jobId, title, ...}）=====
  function extractJob() {
    const url = location.href;
    let jobId = '';
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/job_detail\/([^/?#]+)/i);
      if (m && m[1]) jobId = m[1].replace(/\.html$/i, '');
    } catch (e) { /* ignore */ }
    const title = document.querySelector('.job-banner .name, .job-title, h1')?.textContent?.trim() || document.title;
    const company = document.querySelector('.company-info a, .job-company .name, [class*="company"]')?.textContent?.trim() || '';
    const salary = document.querySelector('.job-banner .salary, .salary, [class*="salary"]')?.textContent?.trim() || '';
    return {
      url,
      jobId,
      title: textOf({ innerText: title }),
      company,
      salary,
      source: 'cloak-preload',
    };
  }
  window.__bossclaw_extractJob = extractJob;

  // 接收 extract-job 指令
  window.__bossclaw_listen('extract-job', () => {
    try { emit('job-extracted', extractJob()); }
    catch (e) { emit('apply-stage', { stage: 'log', message: 'extract-job 失败: ' + (e?.message || e) }); }
  });

  // ===== 页面状态探测（page-status-probe → page-status-result）=====
  // CloakView 没有 ipcRenderer.invoke，用 probeId 做一次性请求/响应配对。
  // 探测口径归 cloakCollector.cjs::pageStatusData（与 webview.cjs 同源，选择器取自
  // platform-adapters.cjs），本通道只负责配对回传，不复制选择器 / 卡片判定。
  window.__bossclaw_listen('page-status-probe', (payload) => {
    const probeId = String(payload?.probeId || '');
    try {
      const data = window.__bossclawCollector?.pageStatusData?.();
      if (!data) {
        // 采集器未注入（注入顺序 / 文件缺失）：回「页面已就绪」让宿主进入采集入口，
        // 由 visual-collect 分支立即回 collect-error，避免白等 waitTabReady 超时。
        emit('page-status-result', { probeId, url: location.href, readyState: String(document.readyState || 'complete'), bodyLen: 0, cards: 0, loginWall: false, collectorMissing: true });
        return;
      }
      emit('page-status-result', { probeId, ...data });
    } catch (e) {
      emit('page-status-result', { probeId, error: String(e?.message || e), url: location.href });
    }
  });

  // ===== 采集入口（visual-collect → cloakCollector 主循环）=====
  // 采集链路（逐卡滚动 / 高亮 / 详情提取 / 列表级采集 / JD 补齐）由 cloakCollector.cjs 承载
  // （由 launcher 先于本文件注入）。采集器缺失时立即回一条可定位的收口原因，
  // 不静默吞掉请求（否则宿主会一直等到 15 分钟兜底超时）。
  window.__bossclaw_listen('visual-collect', (arg) => {
    const opts = (arg && typeof arg === 'object') ? arg : {};
    const c = window.__bossclawCollector;
    if (!c) {
      emit('collect-progress', { phase: 'collect-error', status: '采集器未注入' });
      emit('collect-done', { processed: 0, total: 0, error: 'collector-missing' });
      return;
    }
    c.visualCollect(opts).catch((e) => emit('collect-done', { listUrl: location.href, processed: 0, total: 0, error: String(e?.message || e) }));
  });
  // 采集控制（暂停 / 继续 / 停止 / 调速）—— 与 webview.cjs 同口径，由采集器持有运行时状态
  window.__bossclaw_listen('collect-control', (arg) => { window.__bossclawCollector?.setControl(arg || {}); });

  // ===== 占位：后续阶段从 webview.cjs 选择性搬入以下接口 =====
  // - start-apply 全流程（open chat → write greeting → send → verify bubble → resume image）
  // （visual-collect 采集链路已由 cloakCollector.cjs 搬入，见上）
  //
  // 当前骨架已具备消息通道 + 阶段回传 + 提取基础接口；这些 Boss 业务侧方法
  // 由后续阶段按 webview.cjs 的 BossAdapter 类对照搬入，本文件不复制 2500 行
  // 选择器以避免一次性回归。launcher 已完整支持对应 IPC 与事件转发。

  // ===== 暴露给 launcher 的诊断钩子（用于 e2e 自检）=====
  window.__bossclaw_ping = function () {
    return { ok: true, url: location.href, title: document.title, login: checkLogin() };
  };

  // 简单存活心跳（用于 launcher 端检测 page 已就绪）
  setTimeout(() => emit('page-ready', { url: location.href }), 200);
})();
