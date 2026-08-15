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
  // Page → launcher / 渲染层：console.log('__bossclaw_emit__', JSON.stringify({channel,payload}))
  const channelHandlers = new Map();
  function emit(channel, payload) {
    try {
      console.log('__bossclaw_emit__' + JSON.stringify({ channel, payload: payload || {} }));
    } catch (e) { /* ignore */ }
  }
  window.__bossclaw_emit = emit;
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

  // ===== 占位：后续阶段从 webview.cjs 选择性搬入以下接口 =====
  // - visual-collect 循环（visualCollectLoop / collectCtl）
  // - start-apply 全流程（open chat → write greeting → send → verify bubble → resume image）
  // - collect-control 运行时控制
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
