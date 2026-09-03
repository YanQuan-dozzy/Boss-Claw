// BossClaw CloakView —— CloakBrowser stealth browser engine mode.
// Renders tab strip + address bar + Join Task controls, identical to BrowserView's
// chrome but with page backing coming from main-process cloakLauncher (Playwright
// persistent Page) instead of Electron <webview>. API shape (WebviewApi) matches
// BrowserView so Workbench.tsx needs zero changes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tag, Tooltip, message } from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  ExportOutlined,
  PlusCircleOutlined,
  ThunderboltOutlined,
  PlusOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';

const BOSS_HOME = 'https://www.zhipin.com';
const MAX_TABS = 15;

// Single bridge object for all window.electron.* calls (vite-env.d.ts declares them optional).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const e: any = (typeof window !== 'undefined' ? window.electron : undefined) || {};

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
  // 指定标签的 webview preload 是否已注入（IPC 监听器就绪，可保证 send 不丢消息）
  isPreloadReady: (id: string) => boolean;
  getActiveTabId: () => string;
  getFirstTabId: () => string;
}

interface Props {
  onNavigate?: (info: NavInfo) => void;
  onJoinTask?: (info: { url: string; title: string }) => void;
  onJobExtracted?: (job: any) => void;
  onJobListExtracted?: (data: { url: string; count: number; jobs: any[] }) => void;
  onApplyStage?: (stage: string, data: any, tabId?: string) => void;
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
  events: Array<{ time: number; channel: string; payload: any }>;
}

let tabSeq = 0;
const makeTab = (url: string, title = ''): TabState => ({
  id: `cloak_${Date.now().toString(36)}_${(tabSeq += 1).toString(36)}`,
  url,
  title,
  canGoBack: false,
  canGoForward: false,
  lastUsed: Date.now(),
  events: [],
});

export default function CloakView(props: Props) {
  const { onNavigate, onJoinTask, onJobExtracted, onJobListExtracted, onApplyStage, onCollectProgress, onCollectDone, apiRef } = props;
  const [state, setState] = useState<{ tabs: TabState[]; activeId: string }>(() => {
    const tab = makeTab(BOSS_HOME, 'BOSS zhipin');
    return { tabs: [tab], activeId: tab.id };
  });
  const { tabs, activeId } = state;

  // P18：回调 ref（与 BrowserView 一致）。订阅仅挂载一次，事件回调经 ref 取最新 props，避免 stale closure。
  const callbacksRef = useRef({ onNavigate, onJoinTask, onJobExtracted, onJobListExtracted, onApplyStage, onCollectProgress, onCollectDone });
  useEffect(() => {
    callbacksRef.current = { onNavigate, onJoinTask, onJobExtracted, onJobListExtracted, onApplyStage, onCollectProgress, onCollectDone };
  }, [onNavigate, onJoinTask, onJobExtracted, onJobListExtracted, onApplyStage, onCollectProgress, onCollectDone]);

  const [engine, setEngine] = useState<{ ready: boolean; binary: any; lastError: string | null }>({
    ready: false,
    binary: null,
    lastError: null,
  });
  const [starting, setStarting] = useState(false);

  // Start cloak engine lazily on mount (first run downloads ~200MB binary).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (e.cloakBinary) {
          const bin = await e.cloakBinary();
          if (!cancelled) setEngine((s) => ({ ...s, binary: bin?.binary || bin }));
        }
        if (!e.cloakStart) return;
        setStarting(true);
        const r = await e.cloakStart({});
        if (cancelled) return;
        setStarting(false);
        setEngine((s) => ({ ...s, ready: !!r?.ready, lastError: r?.ok ? null : r?.error || 'start failed' }));
      } catch (err: any) {
        if (!cancelled) {
          setEngine((s) => ({ ...s, ready: false, lastError: err?.message || String(err) }));
          setStarting(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to page events forwarded from main.
  useEffect(() => {
    if (!e.onCloakEvent) return;
    const off = e.onCloakEvent((event: { tabId: string; channel: string; payload: any }) => {
      const { tabId, channel, payload } = event;
      setState((s) => {
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return s;
        const next = [...s.tabs];
        const t = { ...next[idx] };
        const events = [...(t.events || []), { time: Date.now(), channel, payload }].slice(-100);
        if (channel === 'nav') {
          t.url = payload?.url || t.url;
          t.title = payload?.title || t.title;
          t.canGoBack = Boolean(payload?.canGoBack);
          t.canGoForward = Boolean(payload?.canGoForward);
          t.lastUsed = Date.now();
        }
        next[idx] = { ...t, events };
        return { ...s, tabs: next };
      });
      if (channel === 'nav' && tabId === activeIdRef.current) {
        callbacksRef.current.onNavigate?.({ url: payload?.url || '', title: payload?.title || '' });
      }
      if (channel === 'job-extracted') callbacksRef.current.onJobExtracted?.(payload);
      if (channel === 'job-list-extracted') callbacksRef.current.onJobListExtracted?.(payload);
      if (channel === 'apply-stage') callbacksRef.current.onApplyStage?.(payload?.stage, payload, tabId);
      if (channel === 'collect-progress') callbacksRef.current.onCollectProgress?.(payload);
      if (channel === 'collect-done') callbacksRef.current.onCollectDone?.(payload);
    });
    const offStatus = e.onCloakStatusChanged?.((status: any) => {
      setEngine((s) => ({
        ...s,
        ready: !!status?.ready,
        binary: status?.binary || s.binary,
        lastError: status?.lastError || null,
      }));
    });
    return () => { off(); offStatus && offStatus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // When engine becomes ready, sync pre-existing tabs (first run had a stub tab before start).
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (!engine.ready || ensuredRef.current) return;
    ensuredRef.current = true;
    for (const t of tabs) {
      e.cloakPageNew?.(t.id, t.url).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.ready]);

  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const autoAssist = useAppStore((s) => s.autoAssist);

  const activeTab = tabs.find((t) => t.id === activeId) || tabs[0];

  const navigate = useCallback(async (raw: string) => {
    let target = raw.trim();
    if (!target) return;
    if (!/^https?:\/\//.test(target)) target = 'https://' + target;
    const id = activeIdRef.current;
    if (!engine.ready) {
      message.warning('CloakBrowser engine not ready');
      return;
    }
    await e.cloakPageNew?.(id, target);
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, url: target, lastUsed: Date.now() } : t)) }));
  }, [engine.ready]);

  const updateActiveUrl = useCallback((url: string) => {
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, url } : t)) }));
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const tab = makeTab(BOSS_HOME, 'BOSS zhipin');
        return { tabs: [tab], activeId: tab.id };
      }
      let activeId = s.activeId;
      if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)].id;
      e.cloakPageClose?.(id);
      return { tabs, activeId };
    });
  }, []);

  const closeTabById = useCallback((id?: string) => {
    const target = id || activeIdRef.current;
    if (target) closeTab(target);
  }, [closeTab]);

  const createTab = useCallback((url: string, title: string, activate: boolean): string => {
    const tab = makeTab(url, title);
    setState((s) => {
      let tabs = s.tabs;
      if (tabs.length >= MAX_TABS) {
        const candidates = tabs.filter((_, i) => i > 0);
        if (candidates.length > 0) {
          const victim = candidates.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
          tabs = tabs.filter((t) => t.id !== victim.id);
          e.cloakPageClose?.(victim.id);
        }
      }
      let activeId = activate ? tab.id : s.activeId;
      if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0]?.id ?? tab.id;
      return { tabs: [...tabs, tab], activeId };
    });
    if (engine.ready) e.cloakPageNew?.(tab.id, url).catch(() => {});
    return tab.id;
  }, [engine.ready]);

  const addTab = useCallback(() => createTab(BOSS_HOME, '', true), [createTab]);

  const openInNewTab = useCallback((url?: string, title?: string): string => {
    return createTab(url || BOSS_HOME, title || 'BOSS zhipin', true);
  }, [createTab]);

  const openEngineTab = useCallback((): string => createTab(BOSS_HOME, 'collect', false), [createTab]);

  const loadURLInTab = useCallback((id: string, url: string) => {
    if (!id) return;
    e.cloakPageNavigate?.(id, url);
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, url, lastUsed: Date.now() } : t)) }));
  }, []);

  const sendInTab = useCallback((id: string, channel: string, ...args: any[]) => {
    if (!id) return;
    e.cloakPageSend?.(id, channel, args[0]);
  }, []);

  const send = useCallback((channel: string, ...args: any[]) => {
    sendInTab(activeIdRef.current, channel, ...args);
  }, [sendInTab]);

  const loadURL = useCallback((url: string) => navigate(url), [navigate]);

  const hasTab = useCallback((id: string) => Boolean(id && tabsRef.current.some((t) => t.id === id)), []);

  // CloakBrowser 通道：playwright 持久 Page 没有 preload 注入概念，
  // cloakPageSend 透过 CDP postMessage 直接打到目标 frame；
  // 这里用「标签页存在 + cloakPageSend 可用」近似等价 webview 的 preloadReady=true，
  // 让 Workbench 的 trySend 在第一帧就能完成发送，避免与 webview 路径出现行为差异。
  const isPreloadReady = useCallback((id: string) => Boolean(id && tabsRef.current.some((t) => t.id === id) && typeof e.cloakPageSend === 'function'), []);

  useEffect(() => {
    if (apiRef) apiRef.current = {
      send, loadURL, closeTab: closeTabById, openInNewTab, openEngineTab,
      loadURLInTab, sendInTab, hasTab, isPreloadReady,
      getActiveTabId: () => activeIdRef.current,
      getFirstTabId: () => tabsRef.current[0]?.id || '',
    };
  }, [apiRef, send, loadURL, closeTabById, openInNewTab, openEngineTab, loadURLInTab, sendInTab, hasTab, isPreloadReady]);

  const activateTab = useCallback((id: string) => {
    setState((s) => (s.activeId === id ? s : { ...s, activeId: id, tabs: s.tabs.map((t) => (t.id === id ? { ...t, lastUsed: Date.now() } : t)) }));
  }, []);

  const retryStart = useCallback(async () => {
    setStarting(true);
    try {
      const r = await e.cloakStart({});
      setEngine((s) => ({ ...s, ready: !!r?.ready, lastError: r?.ok ? null : r?.error || 'start failed' }));
    } finally { setStarting(false); }
  }, []);

  const activeEvents = useMemo(() => activeTab?.events?.slice(-30) || [], [activeTab]);

  return (
    <div className="workbench-browser cloak-view">
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
          <Button size="small" type="text" disabled={!activeTab?.canGoBack} onClick={() => activeTab && e.cloakPageBack?.(activeTab.id)} icon={<ArrowLeftOutlined />} />
        </Tooltip>
        <Tooltip title="前进">
          <Button size="small" type="text" disabled={!activeTab?.canGoForward} onClick={() => activeTab && e.cloakPageForward?.(activeTab.id)} icon={<ArrowRightOutlined />} />
        </Tooltip>
        <Tooltip title="刷新">
          <Button size="small" type="text" onClick={() => activeTab && e.cloakPageReload?.(activeTab.id)} icon={<ReloadOutlined />} />
        </Tooltip>
        <Tooltip title="在系统浏览器中打开">
          <Button size="small" type="text" icon={<ExportOutlined />} onClick={() => activeTab && e.openExternal?.(activeTab.url)} />
        </Tooltip>
        <Input
          size="small"
          value={activeTab?.url || ''}
          onChange={(ev) => updateActiveUrl(ev.target.value)}
          onPressEnter={() => activeTab && navigate(activeTab.url)}
          placeholder="输入网址后回车"
          prefix={<span style={{ fontSize: 11, opacity: 0.6 }}>链接</span>}
          disabled={!engine.ready}
        />
        <Button size="small" type="primary" onClick={() => activeTab && navigate(activeTab.url)} disabled={!engine.ready}>前往</Button>
        <Tooltip title="把当前页面加入投递任务">
          <Button size="small" icon={<PlusCircleOutlined />} onClick={() => activeTab && onJoinTask?.({ url: activeTab.url, title: activeTab.title })}>加入任务</Button>
        </Tooltip>
        <Tooltip title="投递引擎开关">
          <Button size="small" type={autoAssist ? 'primary' : 'default'} icon={<ThunderboltOutlined />} onClick={() => setAutoAssist(!autoAssist)}>
            {autoAssist ? '投递中' : '开始投递'}
          </Button>
        </Tooltip>
        <Tooltip title={engine.ready ? '隐身浏览器已就绪' : engine.lastError ? `启动失败：${engine.lastError}` : starting ? '正在启动（下载二进制中）...' : '未启动'}>
          <Tag color={engine.ready ? 'green' : engine.lastError ? 'red' : 'default'} style={{ margin: 0 }}>
            {engine.ready ? '隐身就绪' : starting ? '启动中' : engine.lastError ? '失败' : '未启动'}
          </Tag>
        </Tooltip>
        {!engine.ready && !starting && (
          <Button size="small" type="link" onClick={retryStart}>重试</Button>
        )}
      </div>

      {/* Engine status + event stream view (no pixel embedding in this phase; the Chromium
          window is independently visible at OS level; this pane shows URL/title/phase events). */}
      <div className="cloak-events">
        {!engine.ready ? (
          <div className="cloak-empty">
            <div style={{ marginBottom: 12 }}>
              <strong>CloakBrowser Stealth Engine</strong>
              {engine.lastError ? <div style={{ color: '#cf1322', marginTop: 8 }}>{engine.lastError}</div> : null}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
              {starting ? 'Preparing binary (first run downloads ~200MB from cloakbrowser.dev and verifies Ed25519 signature)...' : 'Click Retry, or switch engine back to WebView in Settings.'}
            </div>
            {engine.binary ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>
                installed: {String(Boolean(engine.binary.installed))} | version: {engine.binary.version || '-'} | tier: {engine.binary.tier || '-'}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="cloak-events-head">
              <span>Current tab event stream</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>{activeTab?.title || activeTab?.url}</span>
            </div>
            <div className="cloak-events-body">
              {activeEvents.length === 0 ? (
                <div className="cloak-empty">No events yet. Use the address bar or call sendInTab(channel) to see forwarded events from cloakPreload.cjs.</div>
              ) : (
                activeEvents.map((ev, i) => (
                  <div key={`${ev.time}-${i}`} className="cloak-event-line">
                    <span className="cloak-event-time">{new Date(ev.time).toLocaleTimeString()}</span>
                    <span className="cloak-event-channel">{ev.channel}</span>
                    <span className="cloak-event-payload">{JSON.stringify(ev.payload || {})}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
