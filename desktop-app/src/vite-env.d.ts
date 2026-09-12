/// <reference types="vite/client" />

// 主窗口 preload 暴露的安全接口（electron/preload/app.cjs）
interface ElectronBridgeApi {
  versions?: { electron?: string; chrome?: string; node?: string };
  getAppInfo?: () => Promise<{ name: string; version: string }>;
  openExternal?: (url: string) => void;
  // 读取「使用前必读」文档（首页「阅读使用文档」入口）
  readDoc?: () => Promise<{ ok: boolean; text?: string; file?: string; error?: string }>;
  bossLogin?: () => Promise<unknown>;
  bossLogout?: (platform: string) => Promise<{ ok: boolean; removed?: number; error?: string }>;
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
  // 窗口置顶（标题栏图钉按钮）
  winAlwaysOnTop?: () => Promise<boolean>;
  winAlwaysOnTopSet?: (value: boolean) => void;
  onWindowAlwaysOnTopChanged?: (callback: (isOnTop: boolean) => void) => () => void;
  // Camoufox 隐身引擎（可选增强，Python 桥）——platform 参数（boss/liepin/zhaopin/job51）
  camoufoxStatus?: (platform?: string) => Promise<{ python: boolean; pythonCmd?: string | null; camoufox: boolean; running: boolean; ready: boolean; message?: string; engine?: unknown }>;  camoufoxCall?: (action: string, payload?: Record<string, unknown>) => Promise<any>;
  camoufoxStop?: () => void;
  camoufoxRestart?: (platform?: string) => Promise<{ python: boolean; pythonCmd?: string | null; camoufox: boolean; running: boolean; ready: boolean; installing?: boolean; message?: string; engine?: unknown }>;
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
  // AI Skills 层（skills/<id>/SKILL.md，调用 AI 时按作用域启用）
  skillsList?: () => Promise<Array<{ id: string; name: string; description: string; scope: string; defaultEnabled: boolean; custom?: boolean }>>;
  skillsRead?: (id: string) => Promise<{ id: string; body: string }>;
  skillsImport?: (payload: {
    raw?: string;
    fields?: { name: string; description?: string; scope: string; instructions: string };
  }) => Promise<{ ok: boolean; skill?: { id: string; name: string; description: string; scope: string; defaultEnabled: boolean; custom: boolean }; error?: string }>;
  skillsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  // 保存定制简历 PDF（主进程 printToPDF；html 为 A4 打印友好 HTML）
  savePdf?: (defaultName: string, html: string) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
  // 保存「达标岗位」数据到本地（dir 为空走保存对话框；dir 为绝对路径则在导出目录自动按天写文件）
  saveQualifiedJobs?: (defaultName: string, jsonText: string, dir?: string) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
  // 达标岗位导出目录：读取 / 设置 / 系统目录选择对话框（选择即应用并持久化）
  qualifiedJobsDirGet?: () => Promise<{ dir?: string }>;
  qualifiedJobsDirSet?: (dir: string) => Promise<{ ok?: boolean; dir?: string; error?: string }>;
  qualifiedJobsDirPick?: () => Promise<{ ok?: boolean; canceled?: boolean; dir?: string; error?: string }>;
  // 开机自启动（Windows 登录项）
  autostartGet?: () => Promise<{ ok?: boolean; openAtLogin?: boolean; error?: string }>;
  autostartSet?: (enabled: boolean) => Promise<{ ok?: boolean; enabled?: boolean; error?: string }>;
  // 本地数据备份目录（localStorage 主存储 + 周期脏检查写盘）
  backupDir?: () => Promise<{ dir?: string; error?: string }>;
  backupDirSet?: (dir: string) => Promise<{ ok?: boolean; dir?: string; error?: string }>;
  backupDirPick?: () => Promise<{ ok?: boolean; canceled?: boolean; dir?: string; error?: string }>;
  backupWrite?: (bundle: unknown) => Promise<{ ok?: boolean; file?: string; size?: number; error?: string }>;
  backupRead?: () => Promise<{ ok?: boolean; file?: string | null; bundle?: { updatedAt?: number; keys?: Record<string, string | null> } | null; error?: string }>;
  backupDelete?: () => Promise<{ ok?: boolean; error?: string }>;
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
