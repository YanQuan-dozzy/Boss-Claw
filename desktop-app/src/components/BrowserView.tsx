// BossClaw 内置浏览器封装（多标签版）：<webview> 标签栏，默认加载 BOSS 直聘。
//
// 相比旧版的关键修复（2026-08-16）：
//   1. 前进/后退/刷新按钮：状态由 webview preload 的 SPA 历史栈经 'nav' 消息实时上报，
//      canGoBack/canGoForward 基于真实索引；按钮经 preload 调 history.back/forward，
//      兼容 BOSS 这类 pushState 单页应用（原生 webview.goBack 在 SPA 内无效）。
//   2. 网站点击无反应：handleRegister 改用 useCallback ref 模式，
//      确保所有事件回调始终引用最新版本的 patchTab/onNavigate 等函数，
//      避免闭包捕获首次渲染时的旧引用。
//   3. preload 路径：模块顶层一次性读取，(window as any).electron 在 app.cjs 注入后即固定，
//      不会因 React 重渲染导致 undefined。
//   4. 多标签：main 标签永存（采集页），detail 标签为沟通详情页（自动开/自动关）。
//      多标签堆叠采用 visibility:hidden + z-index（CSS .browser-pane），
//      禁止 display:none（会销毁 webContents，导致 IPC 监听器失效）。
//   5. 加载状态遮罩（2026-08-28）：每个标签独立维护 loading 状态，
//      初始加载期间显示 spinner 覆盖层，防止用户在 webview 未完全就绪时误操作；
//      did-stop-loading 后进入淡出动画再移除，避免闪烁。
//      同时修复 webview CSS display:block（Electron webview 不能使用 flex），
//      强制 will-change:transform 触发 GPU 合成层，解决 offscreen 初始点击无响应问题。
//
// 对外 apiRef 契约（Workbench 使用）：send / loadURL / closeTab / openInNewTab / openEngineTab /
// loadURLInTab / sendInTab / hasTab / isPreloadReady / getActiveTabId / getFirstTabId / bossApi。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Tooltip, message } from 'antd';
import {
  ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined,
  PlusCircleOutlined, ThunderboltOutlined, CloseOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import electronApi from '@/lib/electronApi';
import CloakView from '@/components/CloakView';

const BOSS_HOME = 'https://www.zhipin.com';

// ===== preload 路径：模块顶层一次性读取，避免 React 重渲染导致 undefined =====
// webview 标签 preload 属性协议必须是 file:（Electron 硬性要求）；Windows 反斜杠绝对路径会被拒绝加载，
// 这里做协议规范化兜底（兼容旧 app.cjs 返回的裸路径）
const toFileUrl = (p: string): string => {
  if (!p) return '';
  if (/^file:/i.test(p)) return p;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return 'file:///' + p.replace(/\\/g, '/');
  return p;
};
const WEBVIEW_PRELOAD = toFileUrl(electronApi.webview.preloadPath());

export interface NavInfo {
  url: string;
  title: string;
}

export interface WebviewApi {
  send: (channel: string, ...args: any[]) => void;
  loadURL: (url: string) => void;
  /** 关闭指定标签（main 标签不会真正删除，仅清空重置；detail 标签完整移除并 webview.remove()） */
  closeTab: (id?: string) => void;
  /** 在新标签打开 URL（默认 kind=detail，自动关闭；返回新 tabId） */
  openInNewTab: (url?: string, title?: string, kind?: 'main' | 'detail') => string;
  openEngineTab: () => string;
  loadURLInTab: (id: string, url: string) => void;
  sendInTab: (id: string, channel: string, ...args: any[]) => void;
  hasTab: (id: string) => boolean;
  isPreloadReady: (id: string) => boolean;
  /** 主标签（采集页，永不被自动关闭） */
  getMainTabId: () => string;
  /** 所有 detail 标签 id */
  getDetailTabIds: () => string[];
  getActiveTabId: () => string;
  getFirstTabId: () => string;
  /** 在指定标签页面上下文执行 BOSS 官方 API，返回原始响应（{code, zpData, ...} 或 {error}） */
  bossApi: (action: string, params?: Record<string, any>, tabId?: string) => Promise<any>;
}

interface Props {
  onNavigate?: (info: NavInfo) => void;
  onJoinTask?: (info: { url: string; title: string }) => void;
  onJobExtracted?: (job: any) => void;
  onApplyStage?: (stage: string, data: any, tabId?: string) => void;
  onLoginState?: (data: any) => void;
  onCollectProgress?: (data: any) => void;
  onCollectDone?: (data: any) => void;
  onDomDump?: (data: any) => void;
  apiRef?: React.MutableRefObject<WebviewApi | null>;
}

interface TabState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** main = 采集主标签，永不被自动关闭；detail = 沟通详情标签（自动开/自动关） */
  kind: 'main' | 'detail';
}

let tabSeq = 0;
const makeTab = (url: string, title = '', kind: 'main' | 'detail' = 'main'): TabState => ({
  id: `tab_${Date.now().toString(36)}_${(tabSeq += 1).toString(36)}`,
  url,
  title,
  canGoBack: false,
  canGoForward: false,
  kind,
});


export default function BrowserView(props: Props) {
  const engineMode = useSettingsStore((s) => s.config.engineMode);
  if (engineMode === 'cloak') {
    return <CloakView {...props} />;
  }
  return <BrowserViewImpl {...props} />;
}

function BrowserViewImpl({ onNavigate, onJoinTask, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump, apiRef }: Props) {
  const [tabs, setTabs] = useState<TabState[]>(() => {
    const tab = makeTab(BOSS_HOME, 'BOSS直聘', 'main');
    return [tab];
  });
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? '');

  // 每个标签独立的加载状态：加载中 = true，加载完成 = false
  // 初始时所有标签都处于加载中（BOSS_HOME 尚未加载完毕）
  const [loadingTabs, setLoadingTabs] = useState<Set<string>>(() => {
    const s = new Set<string>();
    tabs.forEach((t) => s.add(t.id));
    return s;
  });
  // 淡出动画阶段（已停止加载但遮罩还在淡出中）
  const [fadingTabs, setFadingTabs] = useState<Set<string>>(new Set());

  const markLoading = useCallback((id: string, loading: boolean) => {
    if (loading) {
      setLoadingTabs((prev) => { if (prev.has(id)) return prev; const s = new Set(prev); s.add(id); return s; });
      setFadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
    } else {
      // 先进入淡出阶段，400ms 后真正移除
      setFadingTabs((prev) => { const s = new Set(prev); s.add(id); return s; });
      setTimeout(() => {
        setLoadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
        setFadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
      }, 400);
    }
  }, []);

  // 确保 activeId 与 tabs 同步
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null, [tabs, activeId]);

  // ===== 事件回调全部用 ref，避免闭包捕获旧值 =====
  const callbacksRef = useRef({
    onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump,
  });
  useEffect(() => {
    callbacksRef.current = { onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump };
  });

  // 监听侧边栏收起/展开状态与 viewport 尺寸变化
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // ===== 强制重绘 webview 视口 Bounds（修复侧边栏收起/页面加载中 webview 未铺满问题）=====
  const forceResizeWebview = useCallback((targetTabId?: string) => {
    const idToResize = targetTabId || activeIdRef.current;
    if (!idToResize) return;
    const el = webviewEls.current[idToResize];
    if (!el) return;
    try {
      if (typeof el.send === 'function') {
        el.send('force-resize');
      }
    } catch {}
  }, []);

  // 侧边栏收起/展开状态改变时，触发 webview resize 重绘
  useEffect(() => {
    forceResizeWebview();
    const t1 = setTimeout(() => forceResizeWebview(), 100);
    const t2 = setTimeout(() => forceResizeWebview(), 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [sidebarCollapsed, forceResizeWebview]);

  // Viewport 容器 DOM 尺寸变化监听 (ResizeObserver)
  useEffect(() => {
    const container = viewportRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let rafId: number;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        forceResizeWebview();
      });
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [forceResizeWebview]);

  // ===== patchTab：更新单个 tab 字段（始终使用 setState 最新引用）=====
  const patchTab = useCallback((id: string, patch: Partial<TabState>) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  // ===== webview 元素注册表（ref 而非 state，避免触发重渲染）=====
  const webviewEls = useRef<Record<string, any>>({});
  // preload 就绪标记（ref 而非 state，避免触发重渲染）
  const preloadReady = useRef<Record<string, boolean>>({});
  // 事件绑定防重复（每个 tabId 只绑定一次）
  const registeredTabs = useRef<Record<string, boolean>>({});
  // boss-api 的 seq → resolve 映射
  const apiResolvers = useRef<Map<string, (v: any) => void>>(new Map());
  const seqRef = useRef(0);

  // ===== 活跃 tab 引用（始终是最新的）=====
  const activeIdRef = useRef(activeId);
  const tabsRef = useRef(tabs);
  // markLoading ref：handleRegister 内部通过 ref 调用，避免闭包捕获旧版本的 markLoading
  const markLoadingRef = useRef(markLoading);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { markLoadingRef.current = markLoading; }, [markLoading]);


  // ===== 注册 webview 元素 + 绑定事件监听 =====
  // 关键修复：handleRegister 内部不直接使用 useCallback 的回调函数，
  // 而是读取 callbacksRef.current，保证始终调用最新版本的 onNavigate 等。
  const handleRegister = useCallback((tabId: string, el: any) => {
    webviewEls.current[tabId] = el;
    if (!el) return;
    if (registeredTabs.current[tabId]) return;
    registeredTabs.current[tabId] = true;

    const cb = callbacksRef.current;

    // ===== preload 属性防御性修复 =====
    // 症状：preload 属性为空/协议非 file: → webview 所有 IPC（采集/Dump DOM）静默失效。
    // 根因：webview 标签 preload 属性协议必须是 file:（Electron 硬性要求）。
    // 修复：挂载时重新读取并补设 file:// 格式的 preload 属性（webview 重新导航时读取）。
    const existingPreload = String(el.getAttribute?.('preload') || '');
    const bridgePreload = String((window as any).electron?.webviewPreload || '');
    if (!/^file:/i.test(existingPreload) && bridgePreload) {
      try { el.setAttribute('preload', toFileUrl(bridgePreload)); } catch {}
    }

    // ===== IPC 消息处理（从 webview preload 回传）=====
    // 注意：Electron <webview> 的 ipc-message 事件只传单个 event 对象（event.channel / event.args），
    // 不能写成 (channel, payload) —— 那样 channel 永远是 undefined，所有 preload 回传会被静默丢弃。
    const handleIpc = (channel: string, payload: any) => {
      switch (channel) {
        case 'nav': {
          const nextUrl = payload?.url;
          const nextTitle = payload?.title;
          if (nextUrl || nextTitle) {
            patchTab(tabId, {
              url: nextUrl || undefined,
              title: nextTitle || undefined,
              canGoBack: Boolean(payload?.canGoBack),
              canGoForward: Boolean(payload?.canGoForward),
            });
          }
          if (tabId === activeIdRef.current && nextUrl) {
            cb.onNavigate?.({ url: nextUrl, title: nextTitle || '' });
          }
          break;
        }
        case 'login-state':
          cb.onLoginState?.(payload);
          break;
        case 'job-extracted':
          cb.onJobExtracted?.(payload);
          break;
        case 'apply-stage':
          cb.onApplyStage?.(payload?.stage, payload, tabId);
          break;
        case 'collect-progress':
          cb.onCollectProgress?.(payload);
          break;
        case 'collect-done':
          cb.onCollectDone?.(payload);
          break;
        case 'dom-dump':
          cb.onDomDump?.(payload);
          break;
        case 'boss-api-result': {
          const resolve = apiResolvers.current.get(String(payload?.seq));
          if (resolve) {
            apiResolvers.current.delete(String(payload?.seq));
            resolve(payload);
          }
          break;
        }
      }
    };

    el.addEventListener('ipc-message', (event: any) => {
      const channel = String(event?.channel || '');
      const payload = event?.args?.[0];
      handleIpc(channel, payload);
    });

    // ===== preload 加载失败诊断（webview 原生事件）=====
    // preload 脚本路径错误 / 语法错误 / sandbox 限制时触发，给出 Chromium 错误码
    el.addEventListener('preload-error', (event: any) => {
      cb.onDomDump?.({
        type: 'preload-error',
        error: String(event?.error || ''),
        errorCode: Number(event?.errorCode ?? -1),
      });
    });

    // ===== preload 就绪标记 =====
    // did-start-navigation 重置（新页面开始加载，preload 尚未就绪）
    // dom-ready 表示 preload 脚本顶层已执行完，IPC 监听器已注册
    const markReady = () => {
      preloadReady.current[tabId] = true;
      forceResizeWebview(tabId);
    };
    el.addEventListener('did-start-navigation', (_ev: any) => {
      preloadReady.current[tabId] = false;
      // 新导航开始时重新进入加载中状态
      markLoadingRef.current(tabId, true);
    });
    el.addEventListener('dom-ready', markReady);
    el.addEventListener('did-finish-load', () => {
      markReady();
      // 加载完成：先 resize，再关闭遮罩（确保 webview 尺寸已确定）
      forceResizeWebview(tabId);
      const t1 = setTimeout(() => { forceResizeWebview(tabId); markLoadingRef.current(tabId, false); }, 150);
      const t2 = setTimeout(() => forceResizeWebview(tabId), 600);
      // 超时保护：无论如何 3s 后强制移除加载遮罩
      const t3 = setTimeout(() => markLoadingRef.current(tabId, false), 3000);
      // 不需要清理这些 timeout，它们会自然过期
      void t1; void t2; void t3;
    });
    el.addEventListener('did-stop-loading', () => {
      forceResizeWebview(tabId);
      markLoadingRef.current(tabId, false);
    });
    el.addEventListener('did-frame-finish-load', () => forceResizeWebview(tabId));


    // ===== 前进/后退状态实时同步 =====
    // 状态由 preload 的 SPA 历史栈经 'nav' 消息上报（canGoBack/canGoForward 基于真实索引）；
    // 此处仅做 URL 兜底同步。did-go-back/did-go-forward 在 SPA 内基本不触发，留作整页导航兜底。
    el.addEventListener('did-navigate', (event: any) => {
      const url = event?.url;
      if (!url) return;
      patchTab(tabId, { url });
      if (tabId === activeIdRef.current) cb.onNavigate?.({ url, title: '' });
      forceResizeWebview(tabId);
    });
    el.addEventListener('did-navigate-in-page', (event: any) => {
      if (event?.isMainFrame !== false) {
        const url = event?.url;
        if (url) {
          patchTab(tabId, { url });
          if (tabId === activeIdRef.current) cb.onNavigate?.({ url, title: '' });
        }
        forceResizeWebview(tabId);
      }
    });
    el.addEventListener('did-go-back', () => {
      // SPA 内 goneBack 实际由 preload 的 history.back() 驱动；此处仅做兜底 URL 同步
      const url = (el as any).getURL?.() || '';
      if (url) patchTab(tabId, { url });
    });
    el.addEventListener('did-go-forward', () => {
      const url = (el as any).getURL?.() || '';
      if (url) patchTab(tabId, { url });
    });

    // ===== 页面标题同步 =====
    el.addEventListener('page-title-updated', (_: any, title: string) => {
      const t = String(title || '').trim();
      if (t) patchTab(tabId, { title: t });
    });

    // ===== new-window：拦截 target=_blank / window.open，转为本标签导航 =====
    el.addEventListener('new-window', ((event: any) => {
      const evt = event?.detail ?? event;
      const url = String(evt?.url || '');
      const disposition = String(evt?.disposition || '');
      try { event?.preventDefault?.(); } catch {}
      if (!url || !/^https?:\/\//i.test(url)) return;
      // 非前景标签的弹窗，直接在当前激活标签加载
      if (disposition === 'background-tab') {
        patchTab(activeIdRef.current, { url });
      }
      patchTab(activeIdRef.current, { url });
      patchTab(activeIdRef.current, { url, canGoBack: true, canGoForward: false });
    }) as any);
  }, [patchTab]); // 唯一依赖是最新的 patchTab

  // ===== 创建标签页（多标签版本）=====
  const createTab = useCallback((url: string, title: string, _activate: boolean, kind: 'main' | 'detail' = 'main'): string => {
    const tab = makeTab(url, title || 'BOSS直聘', kind);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    return tab.id;
  }, []);

  const activateTab = useCallback((id: string) => {
    setActiveId((prev) => (prev === id ? prev : id));
  }, []);

  // ===== 用户点 + 号：仅允许在已有 main 之外新建 main 标签（采集多任务并发用）=====
  const addTab = useCallback(() => {
    createTab(BOSS_HOME, 'BOSS直聘', true, 'main');
  }, [createTab]);

  // ===== 在新标签打开 URL：默认 detail（沟通详情页，完成后自动关闭）=====
  const openInNewTab = useCallback((url?: string, title?: string, kind: 'main' | 'detail' = 'detail'): string => {
    return createTab(url || BOSS_HOME, title || 'BOSS直聘', true, kind);
  }, [createTab]);

  // ===== 右键菜单「在新标签打开链接」→ 主进程经 jc:webview-open-link 转发到此处 =====
  useEffect(() => {
    if (!window.electron?.on) return;
    const off = window.electron.on('jc:webview-open-link', (payload: any) => {
      const url = String(payload?.url || '');
      if (url) openInNewTab(url, '', 'detail');
    });
    return off;
  }, [openInNewTab]);

  // ===== 右键菜单「查看网页源码」→ 主进程经 jc:webview-source 回传 outerHTML，本页 Modal 展示 =====
  const [srcModal, setSrcModal] = useState<{ url: string; html: string; error?: string } | null>(null);
  useEffect(() => {
    if (!window.electron?.on) return;
    const off = window.electron.on('jc:webview-source', (payload: any) => {
      setSrcModal({ url: String(payload?.url || ''), html: String(payload?.html || '') });
    });
    return off;
  }, []);

  const openEngineTab = useCallback((): string => {
    return createTab(BOSS_HOME, '采集', false, 'main');
  }, [createTab]);

  // ===== 在指定标签页加载 URL（按 tabId 真正派发）=====
  const loadURLInTab = useCallback((id: string, url: string) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    if (!tabId) return;
    const el = webviewEls.current[tabId];
    if (el) {
      try { el.loadURL(url); } catch {}
    }
    patchTab(tabId, { url, canGoForward: false });
  }, [patchTab]);

  // ===== 向指定标签页发送 IPC 消息（按 tabId 真正派发）=====
  const sendInTab = useCallback((id: string, channel: string, ...args: any[]) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    if (!tabId) return;
    const el = webviewEls.current[tabId];
    if (el) {
      try { el.send(channel, ...args); } catch {}
    }
  }, []);

  const send = useCallback((channel: string, ...args: any[]) => {
    // 默认行为：发给主标签（采集页），与旧单标签兼容
    sendInTab('', channel, ...args);
  }, [sendInTab]);

  const navigate = useCallback((raw: string) => {
    const target = raw.trim();
    if (!target) return;
    const finalUrl = /^https?:\/\//.test(target) ? target : 'https://' + target;
    // 用户输入的 URL 总是导航到主标签，避免 detail 标签被覆盖
    const mainId = tabsRef.current.find((t) => t.kind === 'main')?.id || activeIdRef.current;
    loadURLInTab(mainId, finalUrl);
  }, [loadURLInTab]);

  const loadURL = useCallback((url: string) => navigate(url), [navigate]);

  // ===== 关闭标签：main 标签仅返回首页保留 webContents；detail 标签真正 remove webview 释放 webContents =====
  const closeTab = useCallback((id: string) => {
    const target = tabsRef.current.find((t) => t.id === id);
    if (!target) return;
    if (target.kind === 'main') {
      // main 标签：不销毁 webContents（保住 BOSS 登录态与 IPC 监听），仅导航回首页关闭当前页面
      patchTab(id, { url: BOSS_HOME, title: 'BOSS直聘', canGoBack: false, canGoForward: false });
      const el = webviewEls.current[id];
      if (el) {
        try { el.loadURL(BOSS_HOME); } catch {}
      }
      return;
    }
    // detail 标签：从列表中移除，激活到主标签
    const el = webviewEls.current[id];
    if (el) {
      try { el.remove?.(); } catch {}
      delete webviewEls.current[id];
      delete preloadReady.current[id];
      delete registeredTabs.current[id];
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (activeIdRef.current === id) {
      const nextMain = tabsRef.current.find((t) => t.kind === 'main');
      setActiveId(nextMain?.id || tabsRef.current[0]?.id || '');
    }
  }, [patchTab]);

  const closeTabById = useCallback((id?: string) => {
    closeTab(id || activeIdRef.current);
  }, [closeTab]);

  const hasTab = useCallback((id: string) => {
    return tabsRef.current.some((t) => t.id === id);
  }, []);

  const isPreloadReady = useCallback((id: string) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    return Boolean(tabId && preloadReady.current[tabId]);
  }, []);

  const getMainTabId = useCallback(() => {
    return tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id || '';
  }, []);

  const getDetailTabIds = useCallback(() => {
    return tabsRef.current.filter((t) => t.kind === 'detail').map((t) => t.id);
  }, []);

  // ===== BOSS 官方 API（promise 化）=====
  const bossApi = useCallback((action: string, params: Record<string, any> = {}, tabId?: string): Promise<any> => {
    return new Promise((resolve) => {
      const tabIdToUse = tabId || tabsRef.current[0]?.id || '';
      const seq = String((seqRef.current += 1));
      const timer = setTimeout(() => {
        if (apiResolvers.current.has(seq)) {
          apiResolvers.current.delete(seq);
          resolve({ error: 'boss-api 超时（15s）' });
        }
      }, 16000);
      apiResolvers.current.set(seq, (payload: any) => { clearTimeout(timer); resolve(payload); });
      sendInTab(tabIdToUse, 'boss-api', { seq, action, params });
    });
  }, [sendInTab]);

  // ===== 暴露 apiRef（多标签版本）=====
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      send,
      loadURL,
      closeTab: closeTabById,
      openInNewTab,
      openEngineTab,
      loadURLInTab,
      sendInTab,
      hasTab,
      isPreloadReady,
      getMainTabId,
      getDetailTabIds,
      bossApi,
      getActiveTabId: () => activeIdRef.current || '',
      getFirstTabId: () => tabsRef.current[0]?.id || '',
    };
  }, [apiRef, send, loadURL, closeTabById, openInNewTab, openEngineTab, loadURLInTab, sendInTab, hasTab, isPreloadReady, getMainTabId, getDetailTabIds, bossApi]);

  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const updateActiveUrl = useCallback((url: string) => {
    // 地址栏编辑只更新当前激活标签 URL（用户操作）
    const tabId = activeIdRef.current;
    if (tabId) patchTab(tabId, { url });
  }, [patchTab]);

  // ===== 导航按钮处理函数 =====
  const handleGoBack = useCallback(() => {
    const tab = activeTab;
    if (!tab || !tab.canGoBack) return;
    const el = webviewEls.current[tab.id];
    // 走 preload 的 History API（history.back），兼容 SPA pushState 导航；
    // 原生 el.goBack() 只认整页导航，在 BOSS 这类 SPA 内无效。
    if (el) {
      try { el.send('spa-back'); } catch {}
    }
  }, [activeTab]);

  const handleGoForward = useCallback(() => {
    const tab = activeTab;
    if (!tab || !tab.canGoForward) return;
    const el = webviewEls.current[tab.id];
    if (el) {
      try { el.send('spa-forward'); } catch {}
    }
  }, [activeTab]);

  const handleReload = useCallback(() => {
    const tab = activeTab;
    if (!tab) return;
    const el = webviewEls.current[tab.id];
    if (el) {
      try { el.reload(); } catch {}
    }
  }, [activeTab]);

  const handleOpenExternal = useCallback(() => {
    const tab = activeTab;
    if (tab?.url) {
      electronApi.external.open(tab.url);
    }
  }, [activeTab]);

  // ===== 关闭 detail 标签（X 按钮）=====
  const handleCloseTab = useCallback((tabId: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    closeTab(tabId);
  }, [closeTab]);

  return (
    <div className="workbench-browser">
      {/* ===== 标签栏（多标签：main 永存，detail 自动关闭） ===== */}
      <div className="browser-tabs-strip">
        <div className="browser-tabs-list" role="tablist" aria-label="Browser tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={t.id === activeId ? 0 : -1}
              className={'browser-tab' + (t.id === activeId ? ' is-active' : '') + (t.kind === 'detail' ? ' is-detail' : '')}
              onClick={() => activateTab(t.id)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activateTab(t.id); } }}
              title={(t.title || t.url) + (t.kind === 'detail' ? '（沟通详情，完成后自动关闭）' : '')}
            >
              <span className="browser-tab-title">{t.title || 'BOSS直聘'}</span>
              <button
                type="button"
                className="browser-tab-close"
                aria-label="关闭标签"
                title={t.kind === 'main' ? '关闭当前标签（返回首页）' : '关闭标签'}
                onClick={(e) => handleCloseTab(t.id, e)}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <CloseOutlined />
              </button>
            </div>
          ))}
        </div>
        <Tooltip title="新标签页">
          <Button size="small" type="text" icon={<PlusCircleOutlined />} onClick={addTab} aria-label="新标签页" />
        </Tooltip>
      </div>

      {/* ===== 浏览器工具栏 ===== */}
      <div className="browser-bar">
        <Tooltip title="后退">
          <Button
            size="small"
            type="text"
            disabled={!activeTab?.canGoBack}
            onClick={handleGoBack}
            icon={<ArrowLeftOutlined />}
          />
        </Tooltip>
        <Tooltip title="前进">
          <Button
            size="small"
            type="text"
            disabled={!activeTab?.canGoForward}
            onClick={handleGoForward}
            icon={<ArrowRightOutlined />}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            onClick={handleReload}
            icon={<ReloadOutlined />}
          />
        </Tooltip>
        <Tooltip title="在系统浏览器中打开">
          <Button size="small" type="text" icon={<ExportOutlined />} onClick={handleOpenExternal} />
        </Tooltip>
        <Input
          size="small"
          value={activeTab?.url || ''}
          onChange={(ev) => updateActiveUrl(ev.target.value)}
          onPressEnter={() => activeTab && navigate(activeTab.url)}
          placeholder="输入网址后回车"
          prefix={<span style={{ fontSize: 11, opacity: 0.6 }}>链接</span>}
        />
        <Button size="small" type="primary" onClick={() => activeTab && navigate(activeTab.url)}>前往</Button>
        <Tooltip title="把当前页面加入投递任务">
          <Button
            size="small"
            icon={<PlusCircleOutlined />}
            onClick={() => activeTab && onJoinTask?.({ url: activeTab.url, title: activeTab.title })}
          >
            加入任务
          </Button>
        </Tooltip>
        <Tooltip title="投递引擎开关">
          <Button
            size="small"
            type={autoAssist ? 'primary' : 'default'}
            icon={<ThunderboltOutlined />}
            onClick={() => setAutoAssist(!autoAssist)}
          >
            {autoAssist ? '投递中' : '开始投递'}
          </Button>
        </Tooltip>
      </div>

      {/* ===== webview 视口 ===== */}
      <div ref={viewportRef} className="browser-viewport">
        {tabs.map((t) => {
          const isLoading = loadingTabs.has(t.id);
          const isFading = fadingTabs.has(t.id);
          return (
            <div key={t.id} className={'browser-pane' + (t.id === activeId ? ' is-active' : '')}>
              {/* ⚠️ 核心红线约束：<webview> 元素必须保持 display: flex 容器级联，严禁行内或 CSS 设置 display: block */}
              <webview
                ref={(el: any) => handleRegister(t.id, el)}
                preload={WEBVIEW_PRELOAD}
                partition="persist:bossclaw"
                // backgroundThrottling=no：工作台切到其它模块时隐藏但保持挂载，
                // 禁用 Chromium 后台节流，保证采集/投递的 guest 页 setTimeout/rAF 全速运行
                webpreferences="sandbox=no, backgroundThrottling=no"
                src={t.url}
              />
              {/* 加载中遮罩：仅在 active 标签且正在加载时可见，避免影响其他标签 */}
              {t.id === activeId && (isLoading || isFading) && (
                <div
                  className={
                    'browser-loading-overlay' +
                    (isFading && !isLoading ? ' is-fading' : '')
                  }
                  aria-hidden="true"
                >
                  <div className="browser-loading-spinner" />
                  <span className="browser-loading-text">正在加载 BOSS 直聘…</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== 右键「查看网页源码」Modal：主进程回传 outerHTML，本页弹窗展示（不跳新标签页）===== */}
      <Modal
        open={Boolean(srcModal)}
        onCancel={() => setSrcModal(null)}
        footer={null}
        width={960}
        title={
          <span style={{ fontSize: 13 }}>
            网页源码{srcModal?.url ? ` · ${srcModal.url.replace(/^https?:\/\//, '').slice(0, 80)}` : ''}
          </span>
        }
        styles={{ body: { padding: 12 } }}
      >
        {srcModal && (
          <div className="view-source-wrap">
            {srcModal.html ? (
              <>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      const html = srcModal?.html || '';
                      if (!html) return;
                      Promise.resolve(electronApi.ipc.invoke('jc:clipboard-write', html)).then((r: any) => {
                        if (r?.ok) message.success('源码已复制到剪贴板');
                        else message.error('复制失败');
                      });
                    }}
                  >
                    复制源码
                  </Button>
                </div>
                <pre
                  style={{
                    maxHeight: '62vh',
                    overflow: 'auto',
                    background: '#f6f8fa',
                    border: '1px solid #e5e6eb',
                    borderRadius: 6,
                    padding: 12,
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    margin: 0,
                  }}
                >
                  {srcModal.html}
                </pre>
              </>
            ) : (
              <div className="soft-block" style={{ padding: 24, textAlign: 'center' }}>
                源码获取失败{srcModal.error ? `：${srcModal.error}` : ''}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
