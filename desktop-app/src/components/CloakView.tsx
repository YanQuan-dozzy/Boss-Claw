// BossClaw CloakView —— CloakBrowser stealth browser engine mode.
// Renders tab strip + address bar + Join Task controls, identical to BrowserView's
// chrome but with page backing coming from main-process cloakLauncher (Playwright
// persistent Page) instead of Electron <webview>. API shape (WebviewApi) matches
// BrowserView so Workbench.tsx needs zero changes.
//
// 2026-09-08 增量：
//   1. 多平台适配：新标签/引擎标签跟随 Platforms 启用状态，可在 Boss/猎聘/智联/前程无忧间切换。
//   2. 事件流面板美化：标题渐变卡 + Empty 空状态 + 等宽 chip 事件行。
//   3. 自动启动引擎：刷新/前进/后退/新建标签/地址栏前往统一经 ensureCloakEngine()，
//      引擎关闭后再点任何操作都会自动拉起，不再因为 ready=false 报「未启动」。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tag, Tooltip, Select, Empty, Space, message } from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  ExportOutlined,
  PlusCircleOutlined,
  ThunderboltOutlined,
  PlusOutlined,
  CloseOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { PLATFORM_META, PLATFORM_IDS, platformEnabled, type JobPlatform } from '@/lib/bossclaw/platforms';

const BOSS_HOME = 'https://www.zhipin.com';
const MAX_TABS = 15;
const ENGINE_BOOT_TIMEOUT_MS = 30000;

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
  // ===== 多平台：按设置页启用状态生成可选列表 =====
  const config0 = useSettingsStore((s) => s.config);
  const enabledPlatforms = useMemo<JobPlatform[]>(
    () => PLATFORM_IDS.filter((p) => platformEnabled(config0, p)),
    [config0],
  );
  const [newTabPlatform, setNewTabPlatform] = useState<JobPlatform>('boss');
  useEffect(() => {
    if (!platformEnabled(config0, newTabPlatform)) setNewTabPlatform('boss');
  }, [config0, newTabPlatform]);

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

  // engine 状态同步到 ref（ensureCloakEngine 内 async 等待时读最新值，避免闭包旧值）
  const engineRef = useRef(engine);
  useEffect(() => { engineRef.current = engine; }, [engine]);
  // 启动锁：异步入口并发去重（多按钮同时点只触发一次 cloakStart）
  const startingRef = useRef(false);

  // ===== 核心封装：所有用户级入口都先调它 =====
  // 行为：
  //   1. 引擎 ready=true 时先做 1.5s 健康检查，探测 Playwright context 进程是否真的活着；
  //      防止 launcher 内存态 ready=true 但进程已被外部关闭（点 + 时 ctx.newPage() 静默 hang）。
  //   2. 启动中 → 轮询直到 ready / 失败；
  //   3. 未启动 / 进程已死 → 自动 cloakStart。
  const ensureCloakEngine = useCallback(async (): Promise<boolean> => {
    // —— 阶段 1：活体探测（仅在本地缓存 ready=true 时复核；非ready 直接走阶段 2）
    if (engineRef.current.ready && typeof e.cloakHealth === 'function') {
      let hc: { ok?: boolean; alive?: boolean; reason?: string; error?: string } | null = null;
      try {
        hc = await e.cloakHealth();
      } catch {
        hc = null;
      }
      if (hc?.alive) {
        // alive=true：把 launcher 兜底状态同步到本地（防止 onCloakStatusChanged 漏触发导致 UI 缓存 stale）
        if (!engineRef.current.ready) {
          setEngine((s) => ({ ...s, ready: true, lastError: null }));
        }
        return true;
      }
      // alive=false：把本地状态翻成未就绪，进入阶段 2 自动重启
      setEngine((s) => ({
        ...s,
        ready: false,
        lastError: hc?.reason || hc?.error || '隐身浏览器进程已断开，将在本次操作中自动重启',
      }));
      message.warning('隐身浏览器已断开，正在自动重启…');
    } else if (engineRef.current.ready) {
      // 没有 health API 但 ready=true 时保守返回（保持向后兼容，理想路径会带 healthCheck）
      return true;
    }

    // —— 阶段 2：启动 / 重启 ——
    if (startingRef.current) {
      const t0 = Date.now();
      while (Date.now() - t0 < ENGINE_BOOT_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 200));
        if (engineRef.current.ready) return true;
        if (engineRef.current.lastError && !startingRef.current) return false;
      }
      return engineRef.current.ready;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      const r = await e.cloakStart({});
      const nextReady = !!r?.ready;
      setEngine((s) => ({
        ...s,
        ready: nextReady,
        lastError: r?.ok ? null : r?.error || 'start failed',
      }));
      if (nextReady) message.success('隐身浏览器已重启就绪');
      return nextReady;
    } catch (err: any) {
      setEngine((s) => ({ ...s, ready: false, lastError: err?.message || String(err) }));
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, []);

  // 启动 cloak engine —— 装载：探测二进制状态 → 自动启动（首启下载 ~200MB）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (e.cloakBinary) {
          const bin = await e.cloakBinary();
          if (!cancelled) setEngine((s) => ({ ...s, binary: bin?.binary || bin }));
        }
        if (!e.cloakStart) return;
        await ensureCloakEngine();
      } catch {
        // 启动失败由 ensureCloakEngine 内部写入 lastError，UI 走空状态卡兜底
      }
    })();
    return () => { cancelled = true; };
  }, [ensureCloakEngine]);

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
      // 主进程兜底关闭（如外部停止）→ 同步翻转 starting 锁
      if (!status?.ready) {
        startingRef.current = false;
        setStarting(false);
      }
    });
    return () => { off(); offStatus && offStatus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // ===== 按 tab 跟踪同步状态：engine 新 ready 时把未同步的标签 page 推到 launcher =====
  // 取代原先一次性 ensuredRef 标志，避免「新加 tab 在 not ready 阶段 → ready 后漏 sync」的问题。
  const syncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!engine.ready) return;
    for (const t of tabs) {
      if (syncedRef.current.has(t.id)) continue;
      syncedRef.current.add(t.id);
      e.cloakPageNew?.(t.id, t.url).catch(() => {
        // 同步失败时不放进 synced，下次 effect 重试
        syncedRef.current.delete(t.id);
      });
    }
  }, [engine.ready, tabs]);

  const setAutoAssist = useAppStore((s) => s.setAutoAssist);
  const autoAssist = useAppStore((s) => s.autoAssist);

  const activeTab = tabs.find((t) => t.id === activeId) || tabs[0];

  // ===== 用户级入口：地址栏前往 =====
  const navigate = useCallback(async (raw: string) => {
    let target = raw.trim();
    if (!target) return;
    if (!/^https?:\/\//.test(target)) target = 'https://' + target;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，请稍后重试或前往设置页排查');
      return;
    }
    const id = activeIdRef.current;
    await e.cloakPageNew?.(id, target);
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, url: target, lastUsed: Date.now() } : t)) }));
  }, [ensureCloakEngine]);

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
      syncedRef.current.delete(id);
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
          syncedRef.current.delete(victim.id);
        }
      }
      let activeId = activate ? tab.id : s.activeId;
      if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0]?.id ?? tab.id;
      return { tabs: [...tabs, tab], activeId };
    });
    // 若引擎已就绪，立即推到 launcher；否则交给 syncedRef effect 在 ready 后兜底
    if (engineRef.current.ready) {
      e.cloakPageNew?.(tab.id, url).catch(() => {
        syncedRef.current.delete(tab.id);
      });
      syncedRef.current.add(tab.id);
    }
    return tab.id;
  }, []);

  // ===== 多平台：跟随选择器平台的新建标签 =====
  const addTab = useCallback(async () => {
    const meta = PLATFORM_META[newTabPlatform] || PLATFORM_META.boss;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，新标签会在引擎就绪后自动同步');
    }
    createTab(meta.homeUrl, meta.label, true);
  }, [createTab, newTabPlatform, ensureCloakEngine]);

  // openInNewTab 也跟随平台（被 Workbench 等调用开新 tab 用）
  const openInNewTab = useCallback((url?: string, title?: string): string => {
    const meta = PLATFORM_META[newTabPlatform] || PLATFORM_META.boss;
    return createTab(url || meta.homeUrl, title || meta.label, true);
  }, [createTab, newTabPlatform]);

  const openEngineTab = useCallback((): string => {
    const meta = PLATFORM_META[newTabPlatform] || PLATFORM_META.boss;
    return createTab(meta.homeUrl, meta.label, false);
  }, [createTab, newTabPlatform]);

  const loadURLInTab = useCallback(async (id: string, url: string) => {
    if (!id) return;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，无法加载链接');
      return;
    }
    e.cloakPageNavigate?.(id, url);
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, url, lastUsed: Date.now() } : t)) }));
  }, [ensureCloakEngine]);

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
    if (startingRef.current) return;
    await ensureCloakEngine();
  }, [ensureCloakEngine]);

  // ===== 用户级入口：刷新 / 前进 / 后退 =====
  const handleReload = useCallback(async () => {
    if (!activeTab) return;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，请稍后重试');
      return;
    }
    e.cloakPageReload?.(activeTab.id);
  }, [activeTab, ensureCloakEngine]);

  const handleGoBack = useCallback(async () => {
    if (!activeTab?.canGoBack) return;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，请稍后重试');
      return;
    }
    e.cloakPageBack?.(activeTab.id);
  }, [activeTab, ensureCloakEngine]);

  const handleGoForward = useCallback(async () => {
    if (!activeTab?.canGoForward) return;
    const ready = await ensureCloakEngine();
    if (!ready) {
      message.warning('CloakBrowser 引擎启动失败，请稍后重试');
      return;
    }
    e.cloakPageForward?.(activeTab.id);
  }, [activeTab, ensureCloakEngine]);

  const handleOpenExternal = useCallback(() => {
    if (activeTab?.url) e.openExternal?.(activeTab.url);
  }, [activeTab]);

  const activeEvents = useMemo(() => activeTab?.events?.slice(-30) || [], [activeTab]);

  // 简化展示用的引擎状态文案
  const engineStatusLabel = engine.ready
    ? '隐身就绪'
    : starting
    ? '启动中'
    : engine.lastError
    ? '启动失败'
    : '未启动';
  const engineStatusColor = engine.ready ? 'green' : engine.lastError ? 'red' : 'default';
  const engineStatusTip = engine.ready
    ? '隐身浏览器已就绪'
    : engine.lastError
    ? `启动失败：${engine.lastError}`
    : starting
    ? '正在启动（首次下载二进制中）…'
    : '点击任意按钮（刷新/新建标签/地址栏前往）都会自动拉起引擎';

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
        <Tooltip title="选择新标签平台">
          <Select
            size="small"
            className="cloak-newtab-select"
            value={newTabPlatform}
            onChange={(v) => setNewTabPlatform(v as JobPlatform)}
            options={enabledPlatforms.map((p) => ({ value: p, label: PLATFORM_META[p].label }))}
          />
        </Tooltip>
        <Tooltip title="新建标签页（自动启动引擎）">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={addTab} aria-label="新标签页" />
        </Tooltip>
      </div>

      <div className="browser-bar">
        <Tooltip title="后退">
          <Button size="small" type="text" disabled={!activeTab?.canGoBack} onClick={handleGoBack} icon={<ArrowLeftOutlined />} />
        </Tooltip>
        <Tooltip title="前进">
          <Button size="small" type="text" disabled={!activeTab?.canGoForward} onClick={handleGoForward} icon={<ArrowRightOutlined />} />
        </Tooltip>
        <Tooltip title="刷新（自动启动引擎）">
          <Button size="small" type="text" onClick={handleReload} icon={<ReloadOutlined />} />
        </Tooltip>
        <Tooltip title="在系统浏览器中打开">
          <Button size="small" type="text" icon={<ExportOutlined />} onClick={handleOpenExternal} />
        </Tooltip>
        <Input
          size="small"
          value={activeTab?.url || ''}
          onChange={(ev) => updateActiveUrl(ev.target.value)}
          onPressEnter={() => activeTab && navigate(activeTab.url)}
          placeholder="输入网址后回车（首次回车会拉起隐身引擎）"
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
        <Tooltip title={engineStatusTip}>
          <Tag color={engineStatusColor} style={{ margin: 0 }}>{engineStatusLabel}</Tag>
        </Tooltip>
        {!engine.ready && !starting && (
          <Button size="small" type="link" onClick={retryStart}>启动引擎</Button>
        )}
      </div>

      {/* 事件流面板：ready=true 时显示历史事件；ready=false 时显示引导卡（不再只是 plain 英文） */}
      <div className="cloak-events">
        {!engine.ready ? (
          <div className="cloak-status-card" data-state={engine.lastError ? 'error' : starting ? 'starting' : 'idle'}>
            <div className="cloak-events-head-icon" style={{ background: 'rgba(13,148,136,0.12)', color: '#0D9488' }}>
              <MessageOutlined />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cloak-status-card-title">
                {starting ? '正在启动 CloakBrowser 隐身引擎…' : engine.lastError ? '隐身引擎启动失败' : '隐身引擎未启动'}
              </div>
              <div className="cloak-status-card-desc">
                {starting
                  ? '首次启动将下载隐身 Chromium 二进制（约 200MB）并校验签名，请稍候…'
                  : engine.lastError
                  ? `错误：${engine.lastError}。可点击下方「启动引擎」重新拉起。`
                  : '点击「刷新」「新建标签页」或在地址栏按回车，都会自动拉起隐身引擎。'}
              </div>
            </div>
            <Space>
              <Button type="primary" loading={starting} onClick={retryStart}>启动引擎</Button>
            </Space>
          </div>
        ) : null}

        {engine.ready ? (
          <>
            <div className="cloak-events-head">
              <span className="cloak-events-head-icon"><MessageOutlined /></span>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="cloak-events-head-title">标签事件流</span>
                <span className="cloak-events-head-sub">来自 cloakPreload.cjs · 用于联调 / 调试观察</span>
              </div>
              <span className="cloak-events-head-meta" title={activeTab?.url || ''}>
                {activeTab?.title || activeTab?.url || '尚未加载'}
              </span>
            </div>
            <div className="cloak-events-body">
              {activeEvents.length === 0 ? (
                <div className="cloak-empty-state">
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={null}
                  />
                  <div className="cloak-empty-state-title">暂无事件</div>
                  <div className="cloak-empty-state-desc">
                    在隐身浏览器内操作（导航、点击、滚动），或调用 <code>sendInTab(channel)</code>，
                    即可看到由 <code>cloakPreload.cjs</code> 转发的事件在此逐条展示。
                  </div>
                </div>
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
        ) : null}
      </div>
    </div>
  );
}
