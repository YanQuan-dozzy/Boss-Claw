// BossClaw 内置浏览器封装（重写版）：多标签页 <webview>，默认加载 BOSS 直聘。
//
// 相比旧版的关键修复：
//   1. 标签切换不再用 display:none 隐藏 webview（会销毁/暂停 webContents，导致切回无法恢复、
//      后台标签投递失效），改用 visibility:hidden + z-index 堆叠，webview 始终存活。
//   2. 移除 pendingLoads / pendingSends / preloadReady 的复杂缓存状态机，改由 webview src
//      属性独立驱动首载，send 前做最小就绪判断，显著降低竞态。
//   3. 新增 promise 化 bossApi(action, params, tabId)：在指定标签页面上下文执行 BOSS 官方
//      API（joblist / jobCard / jobDetail / friendAdd），seq 机制路由回包。
//
// 对外 apiRef 契约（Workbench 使用）：send / loadURL / closeTab / openInNewTab / openEngineTab /
// loadURLInTab / sendInTab / hasTab / isPreloadReady / getActiveTabId / getFirstTabId / bossApi。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip } from 'antd';
import {
  ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined,
  PlusCircleOutlined, ThunderboltOutlined, PlusOutlined, CloseOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import CloakView from '@/components/CloakView';

const BOSS_HOME = 'https://www.zhipin.com';
const MAX_TABS = 15;

export interface NavInfo {
  url: string;
  title: string;
}

export interface WebviewApi {
  send: (channel: string, ...args: any[]) => void;
  loadURL: (url: string) => void;
  closeTab: (id?: string) => void;
  openInNewTab: (url?: string, title?: string) => string;
  openEngineTab: () => string;
  loadURLInTab: (id: string, url: string) => void;
  sendInTab: (id: string, channel: string, ...args: any[]) => void;
  hasTab: (id: string) => boolean;
  isPreloadReady: (id: string) => boolean;
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
  apiRef?: React.MutableRefObject<WebviewApi | null>;
}

interface TabState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  lastUsed: number;
}

let tabSeq = 0;
const makeTab = (url: string, title = ''): TabState => ({
  id: `tab_${Date.now().toString(36)}_${(tabSeq += 1).toString(36)}`,
  url,
  title,
  canGoBack: false,
  canGoForward: false,
  lastUsed: Date.now(),
});

export default function BrowserView(props: Props) {
  const engineMode = useSettingsStore((s) => s.config.engineMode);
  if (engineMode === 'cloak') {
    return <CloakView {...props} />;
  }
  return <BrowserViewImpl {...props} />;
}

function BrowserViewImpl({ onNavigate, onJoinTask, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, apiRef }: Props) {
  const [state, setState] = useState<{ tabs: TabState[]; activeId: string }>(() => {
    const tab = makeTab(BOSS_HOME, 'BOSS直聘');
    return { tabs: [tab], activeId: tab.id };
  });
  const { tabs, activeId } = state;

  const webviewEls = useRef<Record<string, any>>({});
  const preloadReady = useRef<Record<string, boolean>>({});
  const registeredTabs = useRef<Record<string, boolean>>({});
  // boss-api 的 seq → resolve 映射（promise 化）
  const apiResolvers = useRef<Map<string, (v: any) => void>>(new Map());
  const seqRef = useRef(0);

  // 供事件回调读取的最新引用
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const createTabRef = useRef<((url: string, title: string, activate: boolean) => string) | null>(null);

  // 更新单个 tab 字段
  const patchTab = useCallback((id: string, patch: Partial<TabState>) => {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const next = [...s.tabs];
      next[idx] = { ...next[idx], ...patch, lastUsed: Date.now() };
      return { ...s, tabs: next };
    });
  }, []);

  // 自动关闭闲置后台标签（可选，默认关闭）
  const autoCloseIdleTabs = useSettingsStore((s) => s.config.autoCloseIdleTabs);
  const idleCloseMinutes = useSettingsStore((s) => s.config.idleCloseMinutes);
  useEffect(() => {
    if (!autoCloseIdleTabs) return;
    const tick = () => {
      const now = Date.now();
      const cutoff = now - Math.max(1, idleCloseMinutes) * 60_000;
      setState((s) => {
        if (s.tabs.length <= 1) return s;
        const next = s.tabs.filter((t) => t.id === s.activeId || t.id === s.tabs[0]?.id || t.lastUsed >= cutoff);
        if (next.length === s.tabs.length) return s;
        for (const t of s.tabs) {
          if (!next.some((n) => n.id === t.id)) {
            try { webviewEls.current[t.id]?.remove?.(); } catch {}
            delete webviewEls.current[t.id];
            delete preloadReady.current[t.id];
            delete registeredTabs.current[t.id];
          }
        }
        let activeId = s.activeId;
        if (!next.some((t) => t.id === activeId)) activeId = next[0]?.id || activeId;
        return { tabs: next, activeId };
      });
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [autoCloseIdleTabs, idleCloseMinutes]);

  // 注册 webview 元素 + 绑定事件监听（每标签仅绑定一次，防 React ref 重渲染重复绑定）
  const handleRegister = useCallback((tabId: string, el: any) => {
    webviewEls.current[tabId] = el;
    if (!el) return;
    if (registeredTabs.current[tabId]) return;
    registeredTabs.current[tabId] = true;

    // webview preload（webview.cjs）回传的事件
    const handleIpc = (channel: string, ...args: any[]) => {
      const payload = args[0];
      if (channel === 'nav') {
        const nextUrl = payload?.url;
        const nextTitle = payload?.title;
        if (nextUrl || nextTitle) {
          patchTab(tabId, { url: nextUrl || undefined, title: nextTitle || undefined, canGoBack: Boolean(payload?.canGoBack), canGoForward: Boolean(payload?.canGoForward) });
        }
        if (tabId === activeIdRef.current && nextUrl) onNavigate?.({ url: nextUrl, title: nextTitle || '' });
      } else if (channel === 'login-state') {
        onLoginState?.(payload);
      } else if (channel === 'job-extracted') {
        onJobExtracted?.(payload);
      } else if (channel === 'apply-stage') {
        onApplyStage?.(payload?.stage, payload, tabId);
      } else if (channel === 'collect-progress') {
        onCollectProgress?.(payload);
      } else if (channel === 'collect-done') {
        onCollectDone?.(payload);
      } else if (channel === 'boss-api-result') {
        const resolve = apiResolvers.current.get(String(payload?.seq));
        if (resolve) {
          apiResolvers.current.delete(String(payload?.seq));
          resolve(payload);
        }
      }
    };
    el.addEventListener('ipc-message', (_: any, channel: string, ...args: any[]) => handleIpc(channel, ...args));

    // preload 就绪标记：dom-ready 即表示 webview.cjs 顶层已执行、IPC 监听器已注册。
    // did-start-navigation 时重置为 false——webview 导航后 preload 会重新注入，
    // 旧页面的 IPC 监听器已销毁，必须等新页面 dom-ready 后才能安全 send。
    const markReady = () => { preloadReady.current[tabId] = true; };
    el.addEventListener('did-start-navigation', () => { preloadReady.current[tabId] = false; });
    el.addEventListener('dom-ready', markReady);
    el.addEventListener('did-finish-load', markReady);

    // SPA 导航（history.pushState）同步 URL，避免地址栏/标签标题停在初始 URL
    const syncUrl = (event: any) => {
      const url = event?.url;
      if (!url) return;
      patchTab(tabId, { url });
      if (tabId === activeIdRef.current) onNavigate?.({ url, title: '' });
    };
    el.addEventListener('did-navigate', syncUrl);
    el.addEventListener('did-navigate-in-page', (event: any) => { if (event?.isMainFrame !== false) syncUrl(event); });

    // 页面标题同步到标签
    el.addEventListener('page-title-updated', (_: any, title: string) => {
      const t = String(title || '').trim();
      if (t) patchTab(tabId, { title: t });
    });

    // new-window：拦截 target=_blank / window.open，转交本标签系统统一管理
    el.addEventListener('new-window', ((event: any) => {
      const evt = event?.detail ?? event;
      const url = String(evt?.url || '');
      const disposition = String(evt?.disposition || '');
      try { event?.preventDefault?.(); } catch {}
      if (!url || !/^https?:\/\//i.test(url)) return;
      const active = disposition === 'foreground-tab' || disposition === 'new-window' || disposition === 'default' || disposition === '';
      createTabRef.current?.(url, String(evt?.frameName || '新标签页'), active);
    }) as any);
  }, [onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, patchTab]);

  const createTab = useCallback((url: string, title: string, activate: boolean): string => {
    const tab = makeTab(url, title);
    setState((s) => {
      let tabs = s.tabs;
      if (tabs.length >= MAX_TABS) {
        const candidates = tabs.filter((t) => t.id !== s.activeId && t.id !== tabs[0]?.id);
        if (candidates.length > 0) {
          const victim = candidates.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
          tabs = tabs.filter((t) => t.id !== victim.id);
          try { webviewEls.current[victim.id]?.remove?.(); } catch {}
          delete webviewEls.current[victim.id];
          delete preloadReady.current[victim.id];
          delete registeredTabs.current[victim.id];
        }
      }
      let activeId = activate ? tab.id : s.activeId;
      if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0]?.id ?? tab.id;
      return { tabs: [...tabs, tab], activeId };
    });
    return tab.id;
  }, []);

  useEffect(() => { createTabRef.current = (u, t, a) => createTab(u, t, a); }, [createTab]);

  const activateTab = useCallback((id: string) => {
    setState((s) => (s.activeId === id ? s : { ...s, activeId: id }));
  }, []);

  const addTab = useCallback(() => createTab(BOSS_HOME, '', true), [createTab]);
  const openInNewTab = useCallback((url?: string, title?: string): string => createTab(url || BOSS_HOME, title || 'BOSS直聘', true), [createTab]);
  const openEngineTab = useCallback((): string => createTab(BOSS_HOME, '采集', false), [createTab]);

  const loadURLInTab = useCallback((id: string, url: string) => {
    if (!id) return;
    const el = webviewEls.current[id];
    if (el) { try { el.loadURL(url); } catch {} }
    patchTab(id, { url });
  }, [patchTab]);

  const sendInTab = useCallback((id: string, channel: string, ...args: any[]) => {
    if (!id) return;
    const el = webviewEls.current[id];
    if (!el) return;
    try { el.send(channel, ...args); } catch {}
  }, []);

  const send = useCallback((channel: string, ...args: any[]) => sendInTab(activeIdRef.current, channel, ...args), [sendInTab]);

  const navigate = useCallback((raw: string) => {
    const target = raw.trim();
    if (!target) return;
    const finalUrl = /^https?:\/\//.test(target) ? target : 'https://' + target;
    loadURLInTab(activeIdRef.current, finalUrl);
  }, [loadURLInTab]);
  const loadURL = useCallback((url: string) => navigate(url), [navigate]);

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const tab = makeTab(BOSS_HOME, 'BOSS直聘');
        return { tabs: [tab], activeId: tab.id };
      }
      let activeId = s.activeId;
      if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)].id;
      try { webviewEls.current[id]?.remove?.(); } catch {}
      delete webviewEls.current[id];
      delete preloadReady.current[id];
      delete registeredTabs.current[id];
      return { tabs, activeId };
    });
  }, []);

  const closeTabById = useCallback((id?: string) => { const t = id || activeIdRef.current; if (t) closeTab(t); }, [closeTab]);
  const hasTab = useCallback((id: string) => Boolean(id && tabsRef.current.some((t) => t.id === id)), []);
  const isPreloadReady = useCallback((id: string) => Boolean(preloadReady.current[id]), []);

  // BOSS 官方 API：在指定标签页面上下文执行，seq 路由回包（promise 化）
  const bossApi = useCallback((action: string, params: Record<string, any> = {}, tabId?: string): Promise<any> => {
    return new Promise((resolve) => {
      const target = tabId || activeIdRef.current;
      const seq = String((seqRef.current += 1));
      const timer = setTimeout(() => {
        if (apiResolvers.current.has(seq)) {
          apiResolvers.current.delete(seq);
          resolve({ error: 'boss-api 超时（15s）' });
        }
      }, 16000);
      apiResolvers.current.set(seq, (payload: any) => { clearTimeout(timer); resolve(payload); });
      sendInTab(target, 'boss-api', { seq, action, params });
    });
  }, [sendInTab]);

  useEffect(() => {
    if (apiRef) apiRef.current = {
      send, loadURL, closeTab: closeTabById, openInNewTab, openEngineTab,
      loadURLInTab, sendInTab, hasTab, isPreloadReady, bossApi,
      getActiveTabId: () => activeIdRef.current,
      getFirstTabId: () => tabsRef.current[0]?.id || '',
    };
  }, [apiRef, send, loadURL, closeTabById, openInNewTab, openEngineTab, loadURLInTab, sendInTab, hasTab, isPreloadReady, bossApi]);

  const activeTab = tabs.find((t) => t.id === activeId) || tabs[0];
  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const updateActiveUrl = useCallback((url: string) => patchTab(activeId, { url }), [patchTab, activeId]);

  return (
    <div className="workbench-browser">
      <div className="browser-tabs-strip">
        <div className="browser-tabs-list" role="tablist" aria-label="Browser tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={t.id === activeId ? 0 : -1}
              className={'browser-tab' + (t.id === activeId ? ' is-active' : '')}
              onClick={() => activateTab(t.id)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activateTab(t.id); } }}
              title={t.title || t.url}
            >
              <span className="browser-tab-title">{t.title || t.url}</span>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Close tab ${t.title || t.url}`}
                title="Close tab"
                onClick={(ev) => { ev.stopPropagation(); closeTab(t.id); }}
              >
                <CloseOutlined />
              </button>
            </div>
          ))}
        </div>
        <Tooltip title="新标签页">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={addTab} aria-label="新标签页" />
        </Tooltip>
      </div>

      <div className="browser-bar">
        <Tooltip title="后退">
          <Button size="small" type="text" disabled={!activeTab?.canGoBack} onClick={() => activeTab && webviewEls.current[activeTab.id]?.goBack?.()} icon={<ArrowLeftOutlined />} />
        </Tooltip>
        <Tooltip title="前进">
          <Button size="small" type="text" disabled={!activeTab?.canGoForward} onClick={() => activeTab && webviewEls.current[activeTab.id]?.goForward?.()} icon={<ArrowRightOutlined />} />
        </Tooltip>
        <Tooltip title="刷新">
          <Button size="small" type="text" onClick={() => activeTab && webviewEls.current[activeTab.id]?.reload?.()} icon={<ReloadOutlined />} />
        </Tooltip>
        <Tooltip title="在系统浏览器中打开">
          <Button size="small" type="text" icon={<ExportOutlined />} onClick={() => activeTab && window.electron?.openExternal?.(activeTab.url)} />
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
          <Button size="small" icon={<PlusCircleOutlined />} onClick={() => activeTab && onJoinTask?.({ url: activeTab.url, title: activeTab.title })}>加入任务</Button>
        </Tooltip>
        <Tooltip title="投递引擎开关">
          <Button size="small" type={autoAssist ? 'primary' : 'default'} icon={<ThunderboltOutlined />} onClick={() => setAutoAssist(!autoAssist)}>
            {autoAssist ? '投递中' : '开始投递'}
          </Button>
        </Tooltip>
      </div>

      <div className="browser-viewport">
        {tabs.map((t) => (
          <div key={t.id} className={'browser-pane' + (t.id === activeId ? ' is-active' : '')}>
            <webview
              ref={(el: any) => handleRegister(t.id, el)}
              src={t.url}
              partition="persist:bossclaw"
              preload={(window as any).electron?.webviewPreload}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
