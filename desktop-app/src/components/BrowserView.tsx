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
import { Button, Input, Modal, Tooltip, Select, message } from 'antd';
import {
  ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined,
  PlusCircleOutlined, ThunderboltOutlined, CloseOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import electronApi from '@/lib/electronApi';
import { PLATFORM_META, PLATFORM_IDS, PLATFORM_CHIP_PALETTE, platformEnabled, resolvePlatform, type JobPlatform } from '@/lib/bossclaw/platforms';
import { isWhitelistedUrl, whitelistSitesOf, WHITELIST_GROUPS, type BrowserSite as BrowserWhitelistSite } from '@/lib/bossclaw/browserWhitelist';
import { registerBrowser, unregisterBrowser } from '@/lib/browserRegistry';
import CloakView from '@/components/CloakView';
import BrowserNewTabPage, { type NewTabGroup } from '@/components/BrowserNewTabPage';

// 默认加载 BOSS 直聘（多平台：按 defaultPlatform 加载对应平台首页）
const BOSS_HOME = PLATFORM_META.boss.homeUrl;

// 空白标签页（便签页）占位 URL，同时作为下拉的常驻选项 value：选择后新建空白标签，用户自行输入网址访问（受白名单约束）
const NEW_TAB_PAGE_URL = '__newtab__';
type NewTabSelection = JobPlatform | typeof NEW_TAB_PAGE_URL;

// ===== 加载遮罩生命周期计时 =====
// 遮罩由 webview 加载事件驱动。旧实现只依赖 did-finish-load（页面 load 事件），
// 且 3s「兜底」在 finish 回调内才开始计时——BOSS 这类站点若有慢子资源拖住 load，
// 遮罩会无限期转圈。现改为「导航序号 + 多级兜底」：
//   · load 完成（finish/did-stop-loading）→ 立即淡出，不再额外空等；
//   · dom-ready（HTML 解析完，defer/module 脚本已执行）→ 给足首屏窗口后软兜底淡出；
//   · 每次导航开始 → 硬兜底，加载挂起/网络黑洞时遮罩也有明确上限；
//   · did-fail-load（断网/连接被重置/证书错误）→ 立即淡出，杜绝永久转圈。
const LOADING_FADE_MS = 300;               // 淡出动画窗口（匹配 CSS transition 0.25s，略留余量）
const HIDE_AFTER_DOM_READY_MS = 1800;      // dom-ready 后软兜底：给 SPA 首屏渲染窗口
const HARD_HIDE_MS = 15000;                // 导航级硬兜底：加载挂起时遮罩最长展示时长

// 加载动画徽标短名（方块内展示；未收录平台回退 label 去常见后缀）
const PLATFORM_SHORT: Partial<Record<JobPlatform, string>> = {
  boss: 'BOSS',
  liepin: '猎聘',
  zhaopin: '智联',
  job51: '无忧',
};
const platformShort = (platform: JobPlatform): string =>
  PLATFORM_SHORT[platform] || PLATFORM_META[platform]?.label.replace(/(直聘|招聘|无忧)$/, '') || PLATFORM_META[platform]?.label || '加载';

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
  /** 该标签的加载遮罩是否仍在展示（true = 页面尚未就绪，仍不可交互） */
  isLoading: (id: string) => boolean;
  /** 主标签（采集页，永不被自动关闭） */
  getMainTabId: () => string;
  /** 所有 detail 标签 id */
  getDetailTabIds: () => string[];
  getActiveTabId: () => string;
  getFirstTabId: () => string;
  /** 在指定标签页面上下文执行 BOSS 官方 API，返回原始响应（{code, zpData, ...} 或 {error}） */
  bossApi: (action: string, params?: Record<string, any>, tabId?: string) => Promise<any>;
  /**
   * 非 BOSS 平台「一键投递」：为该平台新建 detail 标签打开岗位详情，等 preload 就绪后下发
   * platform-apply，终态经 platform-apply-result 回传 resolve。返回 {ok, stage, external?, code?, message?, error?, tabId}。
   * stage: success | external | skip | stop | risk | failed。
   */
  platformApply: (url: string, platform: JobPlatform, job: any) => Promise<{
    ok: boolean; stage: string; external?: boolean; code?: number; message?: string; error?: string; tabId?: string;
  }>;
  /**
   * 只读探测页面自身的就绪事实（readyState / 岗位卡片命中数 / 选择器计数 / 骨架屏启发式）。
   * 采集侧以此为**权威**判定「搜索页是否真的加载完成」——加载遮罩状态机只作参考，
   * 避免事件序列异常时一直误判「加载中」。返回 {error} 表示探测失败（preload 未就绪等）。
   */
  pageStatus: (tabId?: string) => Promise<any>;
}

interface Props {
  /** 初始标签加载的招聘平台（默认 boss；多平台：liepin/zhaopin/job51 加载各自首页） */
  defaultPlatform?: JobPlatform;
  onNavigate?: (info: NavInfo) => void;
  onJoinTask?: (info: { url: string; title: string }) => void;
  onJobExtracted?: (job: any) => void;
  onApplyStage?: (stage: string, data: any, tabId?: string) => void;
  onLoginState?: (data: any) => void;
  onCollectProgress?: (data: any) => void;
  onCollectDone?: (data: any) => void;
  onDomDump?: (data: any) => void;
  apiRef?: React.MutableRefObject<WebviewApi | null>;
  /**
   * 采集/投递期间抑制「正在加载 XX…」遮罩：可视化采集的价值就在于让用户看到逐卡片
   * 滚动/高亮/展开动画，遮罩会在每次切换搜索组合时盖住整页，反而让人以为「卡在加载动画」。
   * 抑制仅影响遮罩渲染，加载状态机与事件照常运行（isLoading 仍可查询）。
   */
  overlaySuppressed?: boolean;
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

function BrowserViewImpl({ defaultPlatform = 'boss', onNavigate, onJoinTask, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump, apiRef, overlaySuppressed = false }: Props) {
  const homeMeta = PLATFORM_META[defaultPlatform] || PLATFORM_META.boss;
  const [tabs, setTabs] = useState<TabState[]>(() => {
    const tab = makeTab(homeMeta.homeUrl, homeMeta.label, 'main');
    return [tab];
  });
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? '');

  // ===== 多平台适配：新建标签时选择的平台（与设置页「招聘平台」启用状态联动）=====
  const config0 = useSettingsStore((s) => s.config);
  const enabledPlatforms = useMemo<JobPlatform[]>(
    () => PLATFORM_IDS.filter((p) => platformEnabled(config0, p)),
    [config0],
  );
  const [newTabPlatform, setNewTabPlatform] = useState<NewTabSelection>('boss');
  useEffect(() => {
    if (newTabPlatform !== NEW_TAB_PAGE_URL && !platformEnabled(config0, newTabPlatform)) setNewTabPlatform('boss');
  }, [config0, newTabPlatform]);

  // 便签页白名单分组：平台（按启用状态过滤）+ 综合/中高端 + 应届生/实习 + 蓝领/兼职/生活
  const newTabGroups = useMemo<NewTabGroup[]>(() => {
    const platformSites: BrowserWhitelistSite[] = enabledPlatforms.map((p) => {
      const m = PLATFORM_META[p];
      return { domain: m.domain, label: m.label, homeUrl: m.homeUrl, group: 'platform' as const, groupLabel: '平台' };
    });
    const groups: NewTabGroup[] = [{ label: '平台', sites: platformSites }];
    for (const g of WHITELIST_GROUPS) {
      groups.push({ label: g.label, sites: whitelistSitesOf(g.group) });
    }
    return groups;
  }, [enabledPlatforms]);

  // 每个标签独立的加载状态：加载中 = true，加载完成 = false
  // 初始时所有标签都处于加载中（BOSS_HOME 尚未加载完毕）
  const [loadingTabs, setLoadingTabs] = useState<Set<string>>(() => {
    const s = new Set<string>();
    tabs.forEach((t) => s.add(t.id));
    return s;
  });
  // 淡出动画阶段（已停止加载但遮罩还在淡出中）
  const [fadingTabs, setFadingTabs] = useState<Set<string>>(new Set());
  // 加载态的 ref 镜像：供 WebviewApi.isLoading 同步查询（避免把 state 闭包进 apiRef 拿到旧值）
  const loadingTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => { loadingTabsRef.current = loadingTabs; }, [loadingTabs]);

  // ===== 加载遮罩生命周期控制（导航序号 + 多级兜底）=====
  // loadSeqRef：每个标签的「当前导航序号」。did-start-navigation 时 +1；
  // 所有“隐藏遮罩”的定时器到期后先校验序号——期间若发生新导航（序号变化）
  // 则该定时器自动失效，避免旧导航残留的定时器误清新导航的 loading 态（遮罩提前消失/闪烁）。
  const loadSeqRef = useRef<Record<string, number>>({});
  // 立即进入淡出阶段，FADE_MS 后真正卸载节点（带序号校验）
  const hideLoading = useCallback((id: string, seq: number) => {
    setFadingTabs((prev) => { if (prev.has(id)) return prev; const s = new Set(prev); s.add(id); return s; });
    setTimeout(() => {
      if ((loadSeqRef.current[id] || 0) !== seq) return; // 期间已有新导航：放弃本次隐藏
      setLoadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
      setFadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
    }, LOADING_FADE_MS);
  }, []);
  // 定时淡出（快照当前序号，到期校验）；被更新的导航接管时自动失效
  const scheduleHide = useCallback((id: string, afterMs: number) => {
    const seq = loadSeqRef.current[id] || 0;
    setTimeout(() => {
      if ((loadSeqRef.current[id] || 0) !== seq) return;
      hideLoading(id, seq);
    }, afterMs);
  }, [hideLoading]);

  const markLoading = useCallback((id: string, loading: boolean) => {
    if (loading) {
      // 新加载开始：进入 loading 并中断可能残留的淡出
      setLoadingTabs((prev) => { if (prev.has(id)) return prev; const s = new Set(prev); s.add(id); return s; });
      setFadingTabs((prev) => { if (!prev.has(id)) return prev; const s = new Set(prev); s.delete(id); return s; });
    } else {
      hideLoading(id, loadSeqRef.current[id] || 0);
    }
  }, [hideLoading]);
  // handleRegister 只依赖 patchTab（不能随渲染重建，否则 webview 重复解绑/绑监听）；
  // 事件回调统一经本 ref 取最新版计时函数
  const loadingCtlRef = useRef({ markLoading, hideLoading, scheduleHide });
  loadingCtlRef.current = { markLoading, hideLoading, scheduleHide };

  // 确保 activeId 与 tabs 同步
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null, [tabs, activeId]);

  // ===== 事件回调全部用 ref，避免闭包捕获旧值 =====
  const callbacksRef = useRef({
    onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump,
  });
  useEffect(() => {
    callbacksRef.current = { onNavigate, onJobExtracted, onApplyStage, onLoginState, onCollectProgress, onCollectDone, onDomDump };
  });

  // ===== onNavigate 变化去重：webview 高频回传 nav（URL/标题未变的导航事件、SPA 内重复上报）=====
  // 若每次都调用，Workbench 的 setNav 会以新对象触发整树重渲染（该页是最大组件之一）。
  // 只在 URL 或标题真正变化时回调一次，URL 未变（如 title 保持空串）的消息直接丢弃。
  const lastNavReportRef = useRef<{ url: string; title: string } | null>(null);
  const reportNavigate = useCallback((url: string, title: string) => {
    const t = String(title || '');
    const prev = lastNavReportRef.current;
    if (prev && prev.url === url && prev.title === t) return;
    lastNavReportRef.current = { url, title: t };
    callbacksRef.current.onNavigate?.({ url, title: t });
  }, []);

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
  // 性能：逐键比较，值与现值一致（含值为 undefined 的键）时直接返回 prev，
  // 避免 webview 高频 nav 消息（URL 未变但事件触发）造成无效 re-render 整棵浏览器子树。
  const patchTab = useCallback((id: string, patch: Partial<TabState>) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const cur = prev[idx];
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!entries.length) return prev;
      let changed = false;
      for (const [k, v] of entries) {
        if ((cur as any)[k] !== v) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = [...prev];
      next[idx] = { ...cur, ...patch };
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

  // ===== 闲置标签自动关闭（设置约束 autoCloseIdleTabs / idleCloseMinutes）=====
  // 每个标签的「最近活跃时间戳」（激活 / 导航 / 切换标签时刷新）。仅 webview 模式生效；
  // 巡检不关激活标签、标签数 ≤1 不关；关闭逻辑复用 closeTab（含 webview destroy 与注册表清理）。
  const lastActivityRef = useRef<Record<string, number>>({});
  const touchTab = useCallback((id: string) => {
    lastActivityRef.current[id] = Date.now();
  }, []);
  // 新标签创建时补充初始活跃时间（makeTab 无时间戳字段，用副作用统一登记）
  useEffect(() => {
    const now = Date.now();
    for (const t of tabsRef.current) {
      if (lastActivityRef.current[t.id] == null) lastActivityRef.current[t.id] = now;
    }
  }, [tabs]);
  // 切换激活标签视为活跃
  const activateTab = useCallback((id: string) => {
    touchTab(id);
    setActiveId((prev) => (prev === id ? prev : id));
  }, [touchTab]);


  // ===== 注册 webview 元素 + 绑定事件监听 =====
  // 关键修复：handleRegister 内部不直接使用 useCallback 的回调函数，
  // 而是读取 callbacksRef.current，保证始终调用最新版本的 onNavigate 等。
  const handleRegister = useCallback((tabId: string, el: any) => {
    if (!el) {
      // P20：元素卸载/null 时同步清理注册态，避免同 tabId 重建时「新元素不绑监听 + 旧元素残留」致 IPC 静默失效
      delete webviewEls.current[tabId];
      delete preloadReady.current[tabId];
      delete registeredTabs.current[tabId];
      return;
    }
    webviewEls.current[tabId] = el;
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
            touchTab(tabId); // 页面导航视为活跃
            patchTab(tabId, {
              url: nextUrl || undefined,
              title: nextTitle || undefined,
              canGoBack: Boolean(payload?.canGoBack),
              canGoForward: Boolean(payload?.canGoForward),
            });
          }
          if (tabId === activeIdRef.current && nextUrl) {
            reportNavigate(nextUrl, nextTitle || '');
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
        case 'preload-ready':
          // preload 顶层脚本执行完毕 = IPC 监听器已注册（最权威的就绪信号）。
          // 兜底 dom-ready 未按预期到达（重定向/子框架干扰）时采集侧仍能判定页面可注入。
          preloadReady.current[tabId] = true;
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
        case 'platform-apply-result': {
          const resolve = apiResolvers.current.get(String(payload?.seq));
          if (resolve) {
            apiResolvers.current.delete(String(payload?.seq));
            resolve(payload);
          }
          break;
        }
        case 'page-read-result':
        case 'page-status-result':
        case 'prefill-greeting-result': {
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

    // ===== 加载状态机与 preload 就绪标记 =====
    // did-start-navigation：新页面开始加载（preload 尚未就绪）→ 重新进入 loading + 启动导航级硬兜底
    // dom-ready：preload 脚本顶层已执行完（IPC 监听器已注册）→ 启动 dom-ready 软兜底
    // did-finish-load / did-stop-loading：首屏资源就绪 → 立即淡出遮罩（不等多余子资源，避免转圈空耗）
    // did-fail-load：加载失败（断网/重置/证书）→ 立即淡出，杜绝永久转圈
    const markReady = () => {
      preloadReady.current[tabId] = true;
      forceResizeWebview(tabId);
    };
    const ctl = () => loadingCtlRef.current;
    // did-start-navigation：**仅主框架**导航才重置「preload 就绪」与遮罩。
    // 根因修复：旧实现未过滤子框架，页面内嵌 iframe/广告子框架导航会把 preloadReady 置 false，
    // 而 dom-ready 只对主框架触发 → 标记可能永久停在 false，采集侧等待 preload 一路超时
    // （表现为逐个搜索组合全部「搜索页加载超时，跳过该组合」、最终处理 0 个岗位）。
    el.addEventListener('did-start-navigation', ((event: any, _url?: string, _isInPlace?: boolean, legacyIsMainFrame?: boolean) => {
      const isMainFrame = typeof event?.isMainFrame === 'boolean' ? event.isMainFrame : legacyIsMainFrame !== false;
      if (!isMainFrame) return;
      preloadReady.current[tabId] = false;
      loadSeqRef.current[tabId] = (loadSeqRef.current[tabId] || 0) + 1; // 导航代际 +1，令旧定时器失效
      ctl().markLoading(tabId, true);
      ctl().scheduleHide(tabId, HARD_HIDE_MS); // 硬兜底：加载挂起/黑洞时遮罩最长展示 HARD_HIDE_MS
    }) as any);
    el.addEventListener('dom-ready', () => {
      markReady();
      // 软兜底：HTML 已解析且 defer/module 脚本已执行（SPA 首屏通常已完成），
      // 给足首屏渲染窗口后若 finish 仍未到（被慢子资源拖住），强制淡出让用户看到真实页面
      ctl().scheduleHide(tabId, HIDE_AFTER_DOM_READY_MS);
    });
    el.addEventListener('did-finish-load', () => {
      markReady();
      // 加载完成：先 resize 再立即淡出遮罩（确保 webview 尺寸已确定）
      forceResizeWebview(tabId);
      const t1 = setTimeout(() => { forceResizeWebview(tabId); }, 150);
      const t2 = setTimeout(() => forceResizeWebview(tabId), 600);
      ctl().markLoading(tabId, false);
      // 不需要清理这些 timeout，它们会自然过期
      void t1; void t2;
    });
    el.addEventListener('did-stop-loading', () => {
      forceResizeWebview(tabId);
      ctl().markLoading(tabId, false);
    });
    el.addEventListener('did-fail-load', () => {
      forceResizeWebview(tabId);
      ctl().markLoading(tabId, false);
    });
    el.addEventListener('did-frame-finish-load', () => forceResizeWebview(tabId));
    // 初始挂载兜底：首个 src 的首次导航若不触发 did-start-navigation，
    // 也保证遮罩有明确上限（序号为 0，无导航抢占时正常生效）
    ctl().scheduleHide(tabId, HARD_HIDE_MS);


    // ===== 前进/后退状态实时同步 =====
    // 状态由 preload 的 SPA 历史栈经 'nav' 消息上报（canGoBack/canGoForward 基于真实索引）；
    // 此处仅做 URL 兜底同步。did-go-back/did-go-forward 在 SPA 内基本不触发，留作整页导航兜底。
    el.addEventListener('did-navigate', (event: any) => {
      const url = event?.url;
      if (!url) return;
      touchTab(tabId);
      patchTab(tabId, { url });
      if (tabId === activeIdRef.current) reportNavigate(url, '');
      forceResizeWebview(tabId);
    });
    el.addEventListener('did-navigate-in-page', (event: any) => {
      if (event?.isMainFrame !== false) {
        const url = event?.url;
        if (url) {
          touchTab(tabId);
          patchTab(tabId, { url });
          if (tabId === activeIdRef.current) reportNavigate(url, '');
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
  }, [patchTab, touchTab]); // 唯一依赖是最新的 patchTab / 稳定的 touchTab

  // ===== 创建标签页（多标签版本）=====
  const createTab = useCallback((url: string, title: string, _activate: boolean, kind: 'main' | 'detail' = 'main'): string => {
    const fallbackTitle = PLATFORM_META[resolvePlatform(url)]?.label || 'BOSS直聘';
    const tab = makeTab(url, title || fallbackTitle, kind);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    return tab.id;
  }, []);

  // 白名单拦截：非招聘平台网址不允许在内置浏览器访问，可转系统浏览器
  const confirmOpenExternal = useCallback((url: string) => {
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    Modal.confirm({
      title: '该网址不在招聘平台白名单内',
      content: `「${host}」不在白名单中。内置浏览器仅允许访问白名单内的招聘平台，可在系统浏览器中打开。`,
      okText: '在系统浏览器打开',
      cancelText: '取消',
      onOk: () => { electronApi.external.open(url); },
    });
  }, []);

  // ===== 用户点 + 号：选中「空白标签页」走便签页，否则按所选平台新建 main 标签（采集多任务并发用）=====
  const addTab = useCallback(() => {
    if (newTabPlatform === NEW_TAB_PAGE_URL) {
      // 空白标签页（便签页）：新建占位标签，用户自行输入网址访问（受白名单约束）；React 页面非 webview，不出加载遮罩
      const id = createTab(NEW_TAB_PAGE_URL, '新标签页', true, 'main');
      setLoadingTabs((prev) => { const s = new Set(prev); s.delete(id); return s; });
      setFadingTabs((prev) => { const s = new Set(prev); s.delete(id); return s; });
      return id;
    }
    const meta = PLATFORM_META[newTabPlatform] || PLATFORM_META.boss;
    createTab(meta.homeUrl, meta.label, true, 'main');
  }, [createTab, newTabPlatform]);

  // ===== 在新标签打开 URL：默认 detail（沟通详情页，完成后自动关闭）；非白名单网址拦截 =====
  const openInNewTab = useCallback((url?: string, title?: string, kind: 'main' | 'detail' = 'detail'): string => {
    const target = url || BOSS_HOME;
    // 白名单约束：仅招聘平台网址允许在内置浏览器新建标签（其余可转系统浏览器）
    if (url && !isWhitelistedUrl(target)) {
      confirmOpenExternal(target);
      return '';
    }
    const fallbackTitle = PLATFORM_META[resolvePlatform(target)]?.label || 'BOSS直聘';
    return createTab(target, title || fallbackTitle, true, kind);
  }, [createTab, confirmOpenExternal]);

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
    // 「空白标签页」不适用于引擎标签内部通道，回退默认平台首页
    const meta = PLATFORM_META[(newTabPlatform === NEW_TAB_PAGE_URL ? 'boss' : newTabPlatform)] || PLATFORM_META.boss;
    return createTab(meta.homeUrl, meta.label, false, 'main');
  }, [createTab, newTabPlatform]);

  // ===== 在指定标签页加载 URL（按 tabId 真正派发）=====
  const loadURLInTab = useCallback((id: string, url: string) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    if (!tabId) return;
    const el = webviewEls.current[tabId];
    if (el) {
      try { (el.loadURL(url) as unknown as Promise<unknown>).catch(() => {}); } catch {}
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

  // ===== 用户级导航入口（白名单拦截）：地址栏前往/回车、便签页输入框统一走这里 =====
  // 白名单内 → 正常加载（有 tabId 则加载到指定标签，否则加载到主标签）；白名单外 → 拦截并确认转系统浏览器
  const userNavigate = useCallback((raw: string, tabId?: string) => {
    const target = raw.trim();
    if (!target) return;
    const finalUrl = /^https?:\/\//.test(target) ? target : 'https://' + target;
    if (!isWhitelistedUrl(finalUrl)) {
      confirmOpenExternal(finalUrl);
      return;
    }
    if (tabId) loadURLInTab(tabId, finalUrl);
    else navigate(finalUrl);
  }, [confirmOpenExternal, loadURLInTab, navigate]);

  const loadURL = useCallback((url: string) => navigate(url), [navigate]);

  // ===== 关闭标签：只要还剩至少一个标签就真正移除；（最后一个标签保底重置为首页，始终保留一个 webview）=====
  // 修复：原实现 main 标签永远只「重置回 BOSS 首页」不关闭，导致无法关闭标签。现改为——
  //   若 tabs 数量 > 1：真正 remove webview 并从列表移除（main/detail 一视同仁）；
  //   若是最后一个标签：仅导航回首页占位（不销毁 webContents，避免没有 webview 可用）。
  const closeTab = useCallback((id: string) => {
    const target = tabsRef.current.find((t) => t.id === id);
    if (!target) return;
    const hasOthers = tabsRef.current.length > 1;
    if (!hasOthers) {
      // 最后一个标签：退化为占位（导航回当前默认平台首页，保留一个 webview/登录态）
      const home = PLATFORM_META[newTabPlatform === NEW_TAB_PAGE_URL ? 'boss' : newTabPlatform] || PLATFORM_META.boss;
      patchTab(id, { url: home.homeUrl, title: home.label, canGoBack: false, canGoForward: false });
      const el = webviewEls.current[id];
      if (el) {
        try { (el.loadURL(home.homeUrl) as unknown as Promise<unknown>).catch(() => {}); } catch {}
      }
      return;
    }
    // 有其余标签：真正移除该标签
    const el = webviewEls.current[id];
    if (el) {
      try { el.remove?.(); } catch {}
      delete webviewEls.current[id];
      delete preloadReady.current[id];
      delete registeredTabs.current[id];
    }
    delete lastActivityRef.current[id];
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : prev;
    });
    if (activeIdRef.current === id) {
      const nextMain = tabsRef.current.find((t) => t.id !== id);
      setActiveId(nextMain?.id || tabsRef.current[0]?.id || '');
    }
  }, [patchTab, newTabPlatform]);

  const closeTabById = useCallback((id?: string) => {
    closeTab(id || activeIdRef.current);
  }, [closeTab]);

  // ===== 闲置标签自动关闭巡检（设置约束 autoCloseIdleTabs / idleCloseMinutes）=====
  // 仅 webview 引擎模式生效（cloak/camoufox 的标签有自己的生命周期管理，不受本巡检影响）；
  // 每 30s 巡检一次：存在「非激活」且「lastActivity 超过 idleCloseMinutes」的标签 → closeTab。
  // 安全护栏：不关激活标签、标签总数 ≤1 不关、用户未开启时不注册定时器。
  useEffect(() => {
    if (!config0.autoCloseIdleTabs) return;
    if (config0.engineMode !== 'webview') return;
    const thresholdMs = Math.max(1, Number(config0.idleCloseMinutes) || 5) * 60_000;
    const timer = setInterval(() => {
      const list = tabsRef.current;
      if (list.length <= 1) return;
      const now = Date.now();
      for (const t of list) {
        if (t.id === activeIdRef.current) continue; // 不关当前激活标签
        if (t.kind === 'main') continue; // 采集岗位主标签固定化，永不自动关闭
        const last = lastActivityRef.current[t.id];
        if (last != null && now - last > thresholdMs) {
          closeTab(t.id);
          break; // 列表已变化，下一个巡检轮次再处理其余
        }
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [config0.autoCloseIdleTabs, config0.engineMode, config0.idleCloseMinutes, closeTab]);

  const hasTab = useCallback((id: string) => {
    return tabsRef.current.some((t) => t.id === id);
  }, []);

  const isPreloadReady = useCallback((id: string) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    return Boolean(tabId && preloadReady.current[tabId]);
  }, []);

  const isLoading = useCallback((id: string) => {
    const tabId = id || tabsRef.current.find((t) => t.kind === 'main')?.id || tabsRef.current[0]?.id;
    return Boolean(tabId && loadingTabsRef.current.has(tabId));
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

  // ===== 控制桥所需：webview 只读探索 / 半自动预填 / 全自动投递（经 browserRegistry 暴露给 controlRuntime）=====
  // 与 bossApi 相同的 seq 关联回执：由 preload 在 page-read/prefill-greeting 通道回传结果。
  const cmdOnce = useCallback((channel: string, args: Record<string, any>, timeoutMs = 15000, tabId?: string) => {
    return new Promise<any>((resolve) => {
      const id = tabId || activeIdRef.current || tabsRef.current[0]?.id || '';
      if (!id) return resolve({ error: '无可用标签页' });
      const seq = String((seqRef.current += 1));
      const timer = setTimeout(() => {
        if (apiResolvers.current.has(seq)) {
          apiResolvers.current.delete(seq);
          resolve({ error: `${channel} 超时（${timeoutMs}ms）` });
        }
      }, timeoutMs);
      apiResolvers.current.set(seq, (payload: any) => { clearTimeout(timer); resolve(payload); });
      sendInTab(id, channel, { seq, ...args });
    });
  }, [sendInTab]);

  const readPage = useCallback((tabId?: string) => cmdOnce('page-read', {}, 15000, tabId), [cmdOnce]);
  // 页面就绪事实探测：短超时（6s）——探测失败本身也是有效信息（preload 未就绪）
  const pageStatus = useCallback((tabId?: string) => cmdOnce('page-status', {}, 6000, tabId), [cmdOnce]);

  // ===== 非 BOSS 平台「一键投递」：新标签页 DOM 投递（promise 通道，终态经 platform-apply-result）=====
  // 为该平台新建 detail 标签打开岗位详情 → 等 preload 就绪且不再 loading（含登录重定向等待）→
  // 下发 platform-apply；终态由 webview.cjs 经 platform-apply-result 回传（复用 seqRef/apiResolvers）。
  const platformApply = useCallback(
    (url: string, platform: JobPlatform, job: any): Promise<{ ok: boolean; stage: string; external?: boolean; code?: number; message?: string; error?: string; tabId?: string }> =>
      new Promise((resolve) => {
        const tabId = openInNewTab(url, PLATFORM_META[platform]?.label || '岗位投递', 'detail');
        const start = () => {
          const seq = String((seqRef.current += 1));
          const timer = setTimeout(() => {
            if (apiResolvers.current.has(seq)) {
              apiResolvers.current.delete(seq);
              resolve({ ok: false, stage: 'failed', error: 'platform-apply 超时（25s）', tabId });
            }
          }, 26000);
          apiResolvers.current.set(seq, (payload: any) => {
            clearTimeout(timer);
            resolve({ ...(payload || {}), tabId });
          });
          sendInTab(tabId, 'platform-apply', {
            seq,
            platform,
            job,
            externalApplyHints: PLATFORM_META[platform]?.externalApplyHints || [],
          });
        };
        const deadline = Date.now() + 25000;
        const poll = setInterval(() => {
          if (isPreloadReady(tabId) && !isLoading(tabId)) {
            clearInterval(poll);
            start();
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            resolve({ ok: false, stage: 'failed', error: '详情页加载超时', tabId });
          }
        }, 350);
      }),
    [openInNewTab, isPreloadReady, isLoading, sendInTab],
  );

  // ===== 暴露 apiRef（多标签版本）=====
  // 位置要求：必须在 pageStatus / cmdOnce 等成员定义之后（否则 TDZ 报错）
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
      isLoading,
      getMainTabId,
      getDetailTabIds,
      bossApi,
      platformApply,
      pageStatus,
      getActiveTabId: () => activeIdRef.current || '',
      getFirstTabId: () => tabsRef.current[0]?.id || '',
    };
  }, [apiRef, send, loadURL, closeTabById, openInNewTab, openEngineTab, loadURLInTab, sendInTab, hasTab, isPreloadReady, isLoading, getMainTabId, getDetailTabIds, bossApi, platformApply, pageStatus]);
  const prefillGreeting = useCallback((greeting: string) => cmdOnce('prefill-greeting', { greeting }, 20000), [cmdOnce]);
  const runDomDump = useCallback((tabId?: string) => {
    sendInTab(tabId || '', 'webview-command', { action: 'dom-dump' });
    return { ok: true, note: '已触发 DOM 诊断（结果见日志区）' };
  }, [sendInTab]);
  const sendApply = useCallback((payload: Record<string, any> = {}) => {
    const id = activeIdRef.current || tabsRef.current[0]?.id || '';
    if (!id) return Promise.resolve({ ok: false, reason: '无可用标签页' });
    sendInTab(id, 'start-apply', payload);
    // domApply 自带招呼语非空/外部网申跳过/气泡确认/风控即停；触发后结果经 apply-stage 回传。
    return Promise.resolve({ ok: true, hint: '已触发自动投递（domApply），结果见 apply-stage/日志；首次成功会自动暂停验收' });
  }, [sendInTab]);

  // ===== 通用 UI 接管（ui-eval）：对 webview 页面执行白名单 DOM 操作（query/click/type/scroll）=====
  const uiExec = useCallback(
    (op: 'query' | 'click' | 'type' | 'scroll', args: Record<string, any> = {}, timeoutMs = 10000, tabId?: string) =>
      cmdOnce('ui-eval', { op, ...args }, timeoutMs, tabId),
    [cmdOnce]
  );

  // ===== 把浏览器句柄注册进全局注册表（供 controlRuntime 只读探索 / 投递动作）=====
  useEffect(() => {
    registerBrowser({
      mode: 'webview',
      activeTab: () => {
        const t = tabsRef.current.find((x) => x.id === activeIdRef.current) || tabsRef.current[0];
        if (!t) return null;
        return { ...t, active: t.id === activeIdRef.current };
      },
      tabs: () => tabsRef.current.map((t) => ({ ...t, active: t.id === activeIdRef.current })),
      loadURL: (url, tabId) => {
        const id = tabId || tabsRef.current.find((t) => t.kind === 'main')?.id || activeIdRef.current || '';
        if (id) loadURLInTab(id, url);
      },
      joblist: (q, city, page, pageSize) => bossApi('joblist', { query: q, city, page, pageSize }),
      jobCard: (jid) => bossApi('jobCard', { encryptJobId: jid }),
      readPage,
      domDump: runDomDump,
      prefillGreeting,
      sendApply,
      uiExec,
    });
    return () => unregisterBrowser();
  }, [loadURLInTab, bossApi, readPage, runDomDump, prefillGreeting, sendApply, uiExec]);

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
                title={t.kind === 'detail' ? '关闭详情标签' : '关闭标签（至少保留一个）'}
                onClick={(e) => handleCloseTab(t.id, e)}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <CloseOutlined />
              </button>
            </div>
          ))}
        </div>
        <Tooltip title="新标签页">
          <Select
            size="small"
            style={{ width: 112 }}
            value={newTabPlatform}
            onChange={(v) => setNewTabPlatform(v as NewTabSelection)}
            options={[
              { value: NEW_TAB_PAGE_URL, label: '空白标签页' },
              ...enabledPlatforms.map((p) => ({ value: p, label: PLATFORM_META[p].label })),
            ]}
          />
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
          onPressEnter={() => activeTab && userNavigate(activeTab.url)}
          placeholder="输入网址后回车"
          prefix={<span style={{ fontSize: 11, opacity: 0.6 }}>链接</span>}
        />
        <Button size="small" type="primary" onClick={() => activeTab && userNavigate(activeTab.url)}>前往</Button>
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
          // 空白标签页（便签页）：React 渲染的白名单快捷页，无 <webview>
          if (t.kind === 'main' && t.url === NEW_TAB_PAGE_URL) {
            return (
              <div key={t.id} className={'browser-pane browser-pane-newtab' + (t.id === activeId ? ' is-active' : '')}>
                <BrowserNewTabPage
                  groups={newTabGroups}
                  onOpenSite={(site) => loadURLInTab(t.id, site.homeUrl)}
                  onNavigate={(raw) => userNavigate(raw, t.id)}
                />
              </div>
            );
          }
          const isLoading = loadingTabs.has(t.id);
          const isFading = fadingTabs.has(t.id);
          // 加载动画按「标签当前 URL」所在平台动态展示（默认 BOSS，未知域名自动回退）
          const pf = resolvePlatform(t.url);
          const pfMeta = PLATFORM_META[pf] || PLATFORM_META.boss;
          const pfPalette = PLATFORM_CHIP_PALETTE[pfMeta.chipKey] || PLATFORM_CHIP_PALETTE.brand;
          const pfColor = pfPalette.fg;
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
              {/* 加载中遮罩：仅在 active 标签且正在加载时可见，避免影响其他标签。
                  采集期间由 overlaySuppressed 抑制——遮罩会盖住可视化采集的滚动/高亮动画。 */}
              {t.id === activeId && !overlaySuppressed && (isLoading || isFading) && (
                <div
                  className={
                    'browser-loading-overlay' +
                    (isFading && !isLoading ? ' is-fading' : '')
                  }
                  aria-hidden="true"
                >
                  {/* 平台徽标 + 品牌色环绕转圈：按当前加载的平台动态取色/命名 */}
                  <div className="browser-loading-stage">
                    <span
                      className="browser-loading-ring"
                      style={{ borderColor: pfColor + '2e', borderTopColor: pfColor }}
                    />
                    <span
                      className="browser-loading-badge"
                      style={{ background: pfColor, boxShadow: `0 4px 14px ${pfColor}40` }}
                    >
                      {platformShort(pf)}
                    </span>
                  </div>
                  <span className="browser-loading-text">
                    正在加载 <span style={{ color: pfColor, fontWeight: 600 }}>{pfMeta.label}</span>…
                  </span>
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
