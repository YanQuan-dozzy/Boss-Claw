/// <reference types="vite/client" />

// 主窗口 preload 暴露的安全接口（electron/preload/app.cjs）
interface ElectronBridgeApi {
  versions?: { electron?: string; chrome?: string; node?: string };
  getAppInfo?: () => Promise<{ name: string; version: string }>;
  openExternal?: (url: string) => void;
  bossLogin?: () => Promise<unknown>;
  webviewPreload?: string;
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send?: (channel: string, ...args: unknown[]) => void;
  on?: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  // 窗口控制（frame:false 自绘标题栏）
  winMinimize?: () => void;
  winMaximize?: () => void;
  winClose?: () => void;
  winIsMaximized?: () => Promise<boolean>;
  onWindowMaximized?: (callback: (maximized: boolean) => void) => () => void;
  // Camoufox 隐身引擎（可选增强，Python 桥）
  camoufoxStatus?: () => Promise<{ python: boolean; pythonCmd?: string | null; camoufox: boolean; running: boolean; ready: boolean; message?: string; engine?: unknown }>;
  camoufoxCall?: (action: string, payload?: Record<string, unknown>) => Promise<any>;
  camoufoxStop?: () => void;
  // CloakBrowser 隐身浏览器（可选增强，Node + Playwright）
  cloakBinary?: () => Promise<{ ok: boolean; binary?: any; error?: string }>;
  cloakStart?: (opts?: { licenseKey?: string; proxy?: string }) => Promise<{ ok: boolean; ready?: boolean; error?: string }>;
  cloakStop?: () => Promise<{ ok: boolean }>;
  cloakStatus?: () => Promise<{ ready: boolean; starting: boolean; binary: any; lastError: string | null }>;
  cloakPageNew?: (tabId: string, url?: string) => Promise<{ ok: boolean; tabId?: string; url?: string; title?: string; reused?: boolean; error?: string }>;
  cloakPageClose?: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
  cloakPageNavigate?: (tabId: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  cloakPageBack?: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
  cloakPageForward?: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
  cloakPageReload?: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
  cloakPageSend?: (tabId: string, channel: string, payload?: any) => Promise<{ ok: boolean; error?: string }>;
  cloakPageInput?: (tabId: string, action: string, text?: string) => Promise<{ ok: boolean; action?: string; error?: string }>;
  cloakPageList?: () => Promise<{ ok: boolean; pages: Array<{ tabId: string; url: string; title: string }> }>;
  onCloakEvent?: (callback: (event: { tabId: string; channel: string; payload: any }) => void) => () => void;
  onCloakStatusChanged?: (callback: (status: { ready: boolean; starting: boolean; binary: any; lastError: string | null }) => void) => () => void;
}

interface Window {
  electron?: ElectronBridgeApi;
}

// 让 TS 识别 <webview> 自定义元素（React 不知道该标签）
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        preload?: string;
        partition?: string;
        useragent?: string;
        nodeintegration?: boolean;
        webpreferences?: string;
        allowpopups?: boolean;
      };
    }
  }
}
