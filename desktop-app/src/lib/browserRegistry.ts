// src/lib/browserRegistry.ts —— 全局浏览器注册表
// ---------------------------------------------------------------------------
// controlRuntime（全局单例，main.tsx 安装）需要读取/驱动内置浏览器，但 webview 元素
// 只活在 BrowserViewImpl 组件内。此模块用一个可替换的「浏览器句柄」解耦二者：
// BrowserViewImpl 挂载时 registerBrowser(handle)，卸载时注销；controlRuntime 通过
// getBrowser() 拿到句柄执行浏览器只读探索 / 投递动作。避免把 BrowserView 的 apiRef 穿透到
// 全局控制运行时。
//
// 安全口径：本句柄只暴露「只读探索 + 半自动预填 + 触发自动投递」能力；真正的发送校验由
// webview preload 的 domApply / Workbench 引擎执行（招呼语非空、外部网申跳过、气泡确认、
// 风控即停），controlRuntime 只在 executionMode='auto' 时才允许触发发送。
export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
}

export interface BrowserPageCard {
  title: string;
  company: string;
  salary: string;
  url: string;
  location: string;
}

export interface BrowserPageRead {
  url: string;
  title: string;
  bodyText: string;
  listCards: BrowserPageCard[];
  listCount: number;
  mode: 'webview' | 'cloak' | null;
}

export interface BrowserApplyOutcome {
  ok: boolean;
  reason?: string;
  /** 触发自动投递后是否可观测到结果（走应用日志 / apply-stage） */
  hint?: string;
}

/** BrowserViewImpl(webview 引擎) 注册的浏览器句柄；cloak 引擎见 BrowserHandle.mode */
export interface BrowserHandle {
  mode: 'webview' | 'cloak' | null;
  activeTab: () => BrowserTabInfo | null;
  tabs: () => BrowserTabInfo[];
  loadURL: (url: string, tabId?: string) => void;
  /** BOSS 官方搜索岗位列表（只读） */
  joblist: (query: string, city?: string, page?: number, pageSize?: number) => Promise<unknown>;
  /** BOSS 官方岗位卡片（详情，只读） */
  jobCard: (encryptJobId: string) => Promise<unknown>;
  /** 读取当前/指定 tab 的页面文本与列表卡摘要（只读） */
  readPage: (tabId?: string) => Promise<BrowserPageRead>;
  /** 触发 preload 的 dom-dump 诊断（只读；同步触发，诊断结果走日志区） */
  domDump: (tabId?: string) => unknown;
  /** 半自动：打开沟通并预填招呼语草稿，不发送 */
  prefillGreeting: (greeting: string) => Promise<{ ok: boolean; reason?: string; href?: string }>;
  /**
   * 全自动：触发当前 tab 的自动投递（webview start-apply / domApply）。
   * 仅当 controlRuntime 判定 executionMode==='auto' 时才被调用。
   */
  sendApply: (payload?: { greeting?: string }) => Promise<BrowserApplyOutcome>;
}

let registered: BrowserHandle | null = null;

export function registerBrowser(handle: BrowserHandle): void {
  registered = handle;
}

export function unregisterBrowser(): void {
  registered = null;
}

export function getBrowser(): BrowserHandle | null {
  return registered;
}