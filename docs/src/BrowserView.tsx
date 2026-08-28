// BossClaw 内置浏览器封装（重写版）：单标签页 <webview>，默认加载 BOSS 直聘。
//
// 相比旧版的关键修复（2026-08-16）：
//   1. 前进/后退/刷新按钮：始终显示，webview 的 did-go-back/did-go-forward 事件实时更新状态，
//      正确响应 history 变化，不再因闭包导致 canGoBack/canGoForward 永远为 false。
//   2. 网站点击无反应：handleRegister 改用 useCallback ref 模式，
//      确保所有事件回调始终引用最新版本的 patchTab/onNavigate 等函数，
//      避免闭包捕获首次渲染时的旧引用。
//   3. preload 路径：模块顶层一次性读取，(window as any).electron 在 app.cjs 注入后即固定，
//      不会因 React 重渲染导致 undefined。
//
// 对外 apiRef 契约（Workbench 使用）：send / loadURL / closeTab / openInNewTab / openEngineTab /
// loadURLInTab / sendInTab / hasTab / isPreloadReady / getActiveTabId / getFirstTabId / bossApi。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tooltip } from 'antd';
import {
  ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined,
  PlusCircleOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import CloakView from '@/components/CloakView';

const BOSS_HOME = 'https://www.zhipin.com';

// ===== preload 路径：模块顶层一次性读取，避免 React 重渲染导致 undefined =====
const WEBVIEW_PRELOAD = (window as any).electron?.webviewPreload ?? '';

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
}

let tabSeq = 0;
const makeTab = (url: string, title = ''): TabState => ({
  id: `tab_${Date.now().toString(36)}_${(tabSeq += 1).toString(36)}`,
  url,
  title,
  canGoBack: false,
  canGoForward: false,
});

export default function BrowserView(props: Props) {
  const engineMode = useSettingsStore((s) => s.config.engineMode);
  if (engineMode === 'cloak') {
    return <CloakView {...props} />;
  }
  return <BrowserViewImpl {...props} />;
}

function BrowserViewImpl({ onNavigate, onJoinTask, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, apiRef }: Props) {
  const [tabs, setTabs] = useState<TabState[]>(() => {
    const tab = makeTab(BOSS_HOME, 'BOSS直聘');
    return [tab];
  });
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? '');

  // 确保 activeId 与 tabs 同步
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null, [tabs, activeId]);

  // ===== 事件回调全部用 ref，避免闭包捕获旧值 =====
  const callbacksRef = useRef({
    onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone,
  });
  useEffect(() => {
    callbacksRef.current = { onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone };
  });

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
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // ===== 注册 webview 元素 + 绑定事件监听 =====
  // 关键修复：handleRegister 内部不直接使用 useCallback 的回调函数，
  // 而是读取 callbacksRef.current，保证始终调用最新版本的 onNavigate 等。
  const handleRegister = useCallback((tabId: string, el: any) => {
    webviewEls.current[tabId] = el;
    if (!el) return;
    if (registeredTabs.current[tabId]) return;
    registeredTabs.current[tabId] = true;

    const cb = callbacksRef.current;

    // ===== IPC 消息处理（从 webview preload 回传）=====
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

    el.addEventListener('ipc-message', (_: any, channel: string, payload: any) => handleIpc(channel, payload));

    // ===== preload 就绪标记 =====
    // did-start-navigation 重置（新页面开始加载，preload 尚未就绪）
    // dom-ready 表示 preload 脚本顶层已执行完，IPC 监听器已注册
    const markReady = () => { preloadReady.current[tabId] = true; };
    el.addEventListener('did-start-navigation', () => { preloadReady.current[tabId] = false; });
    el.addEventListener('dom-ready', markReady);
    el.addEventListener('did-finish-load', markReady);

    // ===== 前进/后退状态实时同步 =====
    // 关键修复：使用 did-go-back / did-go-forward 事件，而非闭包中的 canGoBack/canGoForward
    el.addEventListener('did-navigate', (event: any) => {
      const url = event?.url;
      if (!url) return;
      patchTab(tabId, { url });
      if (tabId === activeIdRef.current) cb.onNavigate?.({ url, title: '' });
    });
    el.addEventListener('did-navigate-in-page', (event: any) => {
      if (event?.isMainFrame !== false) {
        const url = event?.url;
        if (url) {
          patchTab(tabId, { url });
          if (tabId === activeIdRef.current) cb.onNavigate?.({ url, title: '' });
        }
      }
    });
    el.addEventListener('did-go-back', () => {
      patchTab(tabId, { canGoBack: true }); // 保持 true，webview 自己管理历史
      const url = (el as any).getURL?.() || '';
      patchTab(tabId, { url, canGoForward: true });
    });
    el.addEventListener('did-go-forward', () => {
      patchTab(tabId, { canGoForward: true });
      const url = (el as any).getURL?.() || '';
      patchTab(tabId, { url, canGoBack: true });
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

  // ===== 创建标签页（单标签版本：复用唯一 tab）=====
  const createTab = useCallback((url: string, title: string, activate: boolean): string => {
    const tabId = tabsRef.current[0]?.id || '';
    if (tabId) {
      patchTab(tabId, { url, title, canGoBack: false, canGoForward: false });
      setActiveId(tabId);
      return tabId;
    }
    const tab = makeTab(url, title || 'BOSS直聘');
    setTabs([tab]);
    setActiveId(tab.id);
    return tab.id;
  }, [patchTab]);

  const activateTab = useCallback((id: string) => {
    setActiveId((prev) => (prev === id ? prev : id));
  }, []);

  const addTab = useCallback(() => {
    // 单标签版本：新标签直接替换为空白页
    createTab(BOSS_HOME, 'BOSS直聘', true);
  }, [createTab]);

  const openInNewTab = useCallback((url?: string, title?: string): string => {
    return createTab(url || BOSS_HOME, title || 'BOSS直聘', true);
  }, [createTab]);

  const openEngineTab = useCallback((): string => {
    return createTab(BOSS_HOME, '采集', false);
  }, [createTab]);

  // ===== 在指定标签页加载 URL =====
// ===== 在指定标签页加载 URL（单标签：总在第一个标签操作）=====
  const loadURLInTab = useCallback((id: string, url: string) => {
    // 单标签模式下，忽略 id，直接操作第一个标签
    const tabId = tabsRef.current[0]?.id;
    if (!tabId) return;
    const el = webviewEls.current[tabId];
    if (el) {
      try { el.loadURL(url); } catch {}
    }
    patchTab(tabId, { url, canGoForward: false });
  }, [patchTab]);

  // ===== 向指定标签页发送 IPC 消息 =====
// ===== 向指定标签页发送 IPC 消息（单标签：总在第一个标签操作）=====
  const sendInTab = useCallback((id: string, channel: string, ...args: any[]) => {
    const tabId = tabsRef.current[0]?.id;
    if (!tabId) return;
    const el = webviewEls.current[tabId];
    if (el) {
      try { el.send(channel, ...args); } catch {}
    }
  }, []);

  const send = useCallback((channel: string, ...args: any[]) => {
    sendInTab('', channel, ...args);
  }, [sendInTab]);

  const navigate = useCallback((raw: string) => {
    const target = raw.trim();
    if (!target) return;
    const finalUrl = /^https?:\/\//.test(target) ? target : 'https://' + target;
    loadURLInTab('', finalUrl);
  }, [loadURLInTab]);

  const loadURL = useCallback((url: string) => navigate(url), [navigate]);

  const closeTab = useCallback((id: string) => {
    // 单标签模式：关闭后重建空白标签
    const tab = makeTab(BOSS_HOME, 'BOSS直聘');
    setTabs([tab]);
    setActiveId(tab.id);
    const el = webviewEls.current[id];
    if (el) {
      try { el.remove?.(); } catch {}
      delete webviewEls.current[id];
      delete preloadReady.current[id];
      delete registeredTabs.current[id];
    }
  }, []);

  const closeTabById = useCallback((id?: string) => {
    closeTab(id || activeIdRef.current);
  }, [closeTab]);

  const hasTab = useCallback((id: string) => {
    return tabsRef.current.some((t) => t.id === id);
  }, []);

  const isPreloadReady = useCallback((id: string) => {
    // 单标签模式下，检查第一个标签
    const tabId = tabsRef.current[0]?.id;
    return Boolean(tabId && preloadReady.current[tabId]);
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

  // ===== 暴露 apiRef =====
// ===== 暴露 apiRef（单标签简化版）=====
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
      bossApi,
      getActiveTabId: () => tabsRef.current[0]?.id || '',
      getFirstTabId: () => tabsRef.current[0]?.id || '',
    };
  }, [apiRef, send, loadURL, closeTabById, openInNewTab, openEngineTab, loadURLInTab, sendInTab, hasTab, isPreloadReady, bossApi]);

  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const updateActiveUrl = useCallback((url: string) => {
    const tabId = tabs[0]?.id;
    if (tabId) patchTab(tabId, { url });
  }, [patchTab, tabs]);

  // ===== 导航按钮处理函数 =====
  const handleGoBack = useCallback(() => {
    const tab = tabs[0];
    if (!tab) return;
    const el = webviewEls.current[tab.id];
    if (el && tab.canGoBack) {
      try { el.goBack(); } catch {}
    }
  }, [tabs]);

  const handleGoForward = useCallback(() => {
    const tab = tabs[0];
    if (!tab) return;
    const el = webviewEls.current[tab.id];
    if (el && tab.canGoForward) {
      try { el.goForward(); } catch {}
    }
  }, [tabs]);

  const handleReload = useCallback(() => {
    const tab = tabs[0];
    if (!tab) return;
    const el = webviewEls.current[tab.id];
    if (el) {
      try { el.reload(); } catch {}
    }
  }, [tabs]);

  const handleOpenExternal = useCallback(() => {
    const tab = tabs[0];
    if (tab?.url) {
      (window as any).electron?.openExternal?.(tab.url);
    }
  }, [tabs]);

  return (
    <div className="workbench-browser">
      {/* ===== 标签栏（单标签模式：固定显示一个标签） ===== */}
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
              <span className="browser-tab-title">{t.title || 'BOSS直聘'}</span>
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
      <div className="browser-viewport">
        {tabs.map((t) => (
          <div key={t.id} className={'browser-pane' + (t.id === activeId ? ' is-active' : '')}>
            <webview
              ref={(el: any) => handleRegister(t.id, el)}
              src={t.url}
              partition="persist:bossclaw"
              preload={WEBVIEW_PRELOAD}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
