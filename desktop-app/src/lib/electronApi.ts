// 渲染进程访问 preload 注入 API 的安全封装。
// 集中所有 `window.electron.*` 调用，避免散落多处。
// 每个方法都做了「API 存在性 + 类型基本校验」保护，preload 未就绪时返回安全降级值。
//
// 设计原则（AGENTS.md §3.1 进程安全）：
//   1. contextIsolation:true 下，渲染进程只通过 contextBridge 暴露的 window.electron 与主进程通信。
//   2. 永远不直接 typeof window.electron 操作，所有调用走该封装，便于统一审计与单测替身。
//   3. 任何缺失的 API 都以「默认值 + Promise.resolve() / no-op」形式降级，绝不抛错导致 UI 崩溃。

export interface CamoufoxApiStatus {
  python?: boolean;
  pythonCmd?: string;
  camoufox?: boolean;
  running?: boolean;
  ready?: boolean;
  message?: string;
  engine?: unknown;
}

const noop = () => {};
const noopUnsub = () => () => {};

function api(): NonNullable<Window['electron']> | Record<string, never> {
  if (typeof window === 'undefined') return {};
  return window.electron || {};
}

// 供业务代码统一调用的安全封装（按用途分组）
export const electronApi = {
  isReady: (): boolean => Boolean(api().getAppInfo),
  versions: () => ({
    electron: api().versions?.electron || 'unknown',
    chrome: api().versions?.chrome || 'unknown',
    node: api().versions?.node || 'unknown',
  }),
  getAppInfo: async (): Promise<{ name: string; version: string } | null> => {
    try {
      const fn = api().getAppInfo;
      if (!fn) return null;
      return await fn();
    } catch {
      return null;
    }
  },

  // 窗口控制：API 缺失时一律静默 no-op（不影响其它逻辑）
  win: {
    minimize: () => (api().winMinimize || noop)(),
    maximize: () => (api().winMaximize || noop)(),
    close: () => (api().winClose || noop)(),
    isMaximized: async (): Promise<boolean> => {
      try {
        const fn = api().winIsMaximized;
        if (!fn) return false;
        return Boolean(await fn());
      } catch {
        return false;
      }
    },
    onMaximizedChanged: (cb: (maximized: boolean) => void) =>
      (api().onWindowMaximized || noopUnsub)(cb),
    // 窗口置顶：查询 / 设置 / 订阅变化（返回值统一收窄为 boolean）
    isAlwaysOnTop: async (): Promise<boolean> => {
      try {
        const fn = api().winAlwaysOnTop;
        if (!fn) return false;
        return Boolean(await fn());
      } catch {
        return false;
      }
    },
    setAlwaysOnTop: (value: boolean) => (api().winAlwaysOnTopSet || noop)(Boolean(value)),
    onAlwaysOnTopChanged: (cb: (isOnTop: boolean) => void) =>
      (api().onWindowAlwaysOnTopChanged || noopUnsub)(cb),
  },

  external: {
    open: (url: string) => {
      const fn = api().openExternal;
      if (fn && typeof url === 'string' && /^https?:\/\//i.test(url)) fn(url);
    },
  },

  // 读取「使用前必读」文档（首页「阅读使用文档」入口）
  readDoc: async (): Promise<{ ok: boolean; text?: string; error?: string }> => {
    try {
      const fn = api().readDoc;
      if (!fn) return { ok: false, error: 'readDoc API 不可用' };
      const r = (await fn()) as { ok?: boolean; text?: string; error?: string };
      return { ok: Boolean(r?.ok), text: r?.text, error: r?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  boss: {
    login: async (): Promise<boolean> => {
      try {
        const fn = api().bossLogin;
        if (!fn) return false;
        const r = (await fn()) as { loggedIn?: boolean } | undefined;
        return Boolean(r && r.loggedIn);
      } catch {
        return false;
      }
    },
    logout: async (platform: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().bossLogout;
        if (!fn) return { ok: false, error: 'bossLogout API 不可用' };
        return (await fn(platform)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  },

  webview: {
    preloadPath: (): string => (api() as { webviewPreload?: string }).webviewPreload || '',
  },

  // P05：LLM 主进程代理（主进程 Node fetch 转发，规避渲染层 CORS）
  llmProxy: async (
    url: string,
    payload: unknown,
    apiKey: string,
    timeoutMs?: number
  ): Promise<{ ok: boolean; status: number; text: string; error?: string }> => {
    try {
      const fn = (api() as Record<string, unknown>).llmProxy as
        | ((u: string, p: unknown, k: string, t?: number) => Promise<unknown>)
        | undefined;
      if (!fn) return { ok: false, status: 0, text: '', error: 'llmProxy 不可用' };
      const r = (await fn(url, payload, apiKey, timeoutMs)) as { ok?: boolean; status?: number; text?: string; error?: string };
      return {
        ok: Boolean(r?.ok),
        status: Number(r?.status || 0),
        text: String(r?.text || ''),
        error: r?.error || undefined,
      };
    } catch (e) {
      return { ok: false, status: 0, text: '', error: (e as Error).message };
    }
  },

  fetchUrl: async (url: string): Promise<{ ok: boolean; status?: number; text?: string; error?: string }> => {
    try {
      const fn = (api() as { fetchUrl?: (u: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }> }).fetchUrl;
      if (!fn) return { ok: false, error: 'fetch-url 不可用（仅 Electron 可用）' };
      const r = await fn(url);
      return r || { ok: false, error: 'no result' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  camoufox: {
    status: async () => {
      const fn = api().camoufoxStatus;
      if (!fn) return { ready: false, message: 'Camoufox API 不可用', running: false } as CamoufoxApiStatus;
      try {
        return (await fn()) || { ready: false, running: false };
      } catch {
        return { ready: false, running: false, message: '状态探测失败' };
      }
    },
    call: async (action: 'search' | 'send' | 'chat' | 'login' | 'logout' | 'clear', payload?: Record<string, unknown>) => {
      const fn = api().camoufoxCall;
      if (!fn) return { ok: false, error: 'camoufox API 不可用' };
      try {
        return await fn(action, payload);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    stop: () => (api().camoufoxStop || noop)(),
  },

  cloak: {
    binary: async () => {
      try {
        return (await api().cloakBinary?.()) ?? { ok: false, error: 'API 不可用' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    start: async (opts?: { licenseKey?: string; proxy?: string }) => {
      try {
        return (await api().cloakStart?.(opts)) ?? { ok: false, error: 'API 不可用' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    stop: async () => {
      try {
        return (await api().cloakStop?.()) ?? { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    status: async () => {
      try {
        return (await api().cloakStatus?.()) ?? { ready: false, lastError: 'API 不可用' };
      } catch (e) {
        return { ready: false, lastError: (e as Error).message };
      }
    },
    page: {
      new: (tabId: string, url: string) => api().cloakPageNew?.(tabId, url),
      close: (tabId: string) => api().cloakPageClose?.(tabId),
      navigate: (tabId: string, url: string) => api().cloakPageNavigate?.(tabId, url),
      back: (tabId: string) => api().cloakPageBack?.(tabId),
      forward: (tabId: string) => api().cloakPageForward?.(tabId),
      reload: (tabId: string) => api().cloakPageReload?.(tabId),
      send: (tabId: string, channel: string, payload?: unknown) =>
        api().cloakPageSend?.(tabId, channel, payload),
      input: (tabId: string, action: string, text: string) =>
        api().cloakPageInput?.(tabId, action, text),
      list: async () => {
        try {
          return (await api().cloakPageList?.()) ?? { ok: true, pages: [] };
        } catch {
          return { ok: true, pages: [] };
        }
      },
    },
    onEvent: (cb: (payload: unknown) => void) => (api().onCloakEvent || noopUnsub)(cb),
    onStatusChanged: (cb: (status: unknown) => void) => (api().onCloakStatusChanged || noopUnsub)(cb),
  },

  // 开机自启动（Windows 登录项；缺失时降级为关闭态 / no-op）
  autostart: {
    get: async (): Promise<{ openAtLogin: boolean }> => {
      try {
        const fn = api().autostartGet;
        if (!fn) return { openAtLogin: false };
        const r = (await fn()) as { ok?: boolean; openAtLogin?: boolean };
        return { openAtLogin: Boolean(r?.openAtLogin) };
      } catch {
        return { openAtLogin: false };
      }
    },
    set: (enabled: boolean) => (api().autostartSet || noop)(enabled),
  },

  // 本地数据备份目录（localStorage 主存储 + 周期脏检查写盘）
  backup: {
    dir: async (): Promise<string> => {
      try {
        const fn = api().backupDir;
        if (!fn) return '';
        const r = (await fn()) as { dir?: string } | undefined;
        return String(r?.dir || '');
      } catch {
        return '';
      }
    },
    setDir: async (dir: string): Promise<{ ok: boolean; dir?: string; error?: string }> => {
      try {
        const fn = api().backupDirSet;
        if (!fn) return { ok: false, error: 'backup API 不可用' };
        const r = (await fn(dir)) as { ok?: boolean; dir?: string; error?: string };
        return { ok: Boolean(r?.ok), dir: r?.dir, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    pick: async (): Promise<{ ok: boolean; canceled?: boolean; dir?: string; error?: string }> => {
      try {
        const fn = api().backupDirPick;
        if (!fn) return { ok: false, error: 'backup API 不可用' };
        const r = (await fn()) as { ok?: boolean; canceled?: boolean; dir?: string; error?: string };
        return { ok: Boolean(r?.ok), canceled: r?.canceled, dir: r?.dir, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    write: async (bundle: unknown): Promise<{ ok: boolean; file?: string; error?: string }> => {
      try {
        const fn = api().backupWrite;
        if (!fn) return { ok: false, error: 'backup API 不可用' };
        const r = (await fn(bundle)) as { ok?: boolean; file?: string; error?: string };
        return { ok: Boolean(r?.ok), file: r?.file, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    read: async (): Promise<{ ok: boolean; bundle?: { keys?: Record<string, string | null> } | null; file?: string | null; error?: string }> => {
      try {
        const fn = api().backupRead;
        if (!fn) return { ok: false, file: null };
        const r = (await fn()) as {
          ok?: boolean;
          bundle?: { keys?: Record<string, string | null> } | null;
          file?: string | null;
          error?: string;
        };
        return { ok: Boolean(r?.ok), bundle: r?.bundle ?? null, file: r?.file ?? null, error: r?.error };
      } catch (e) {
        return { ok: false, file: null, error: (e as Error).message };
      }
    },
    delete: async (): Promise<boolean> => {
      try {
        const fn = api().backupDelete;
        if (!fn) return false;
        const r = (await fn()) as { ok?: boolean };
        return Boolean(r?.ok);
      } catch {
        return false;
      }
    },
  },

  // 保存「达标岗位」数据到本地：dir 为空走系统保存对话框，dir 为绝对路径则在指定导出目录自动按天写文件
  saveQualifiedJobs: async (
    defaultName: string,
    jsonText: string,
    dir?: string
  ): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
    try {
      const fn = api().saveQualifiedJobs;
      if (!fn) return { ok: false, error: 'saveQualifiedJobs API 不可用（仅 Electron 可用）' };
      const r = (await fn(defaultName, jsonText, dir)) as {
        ok?: boolean;
        canceled?: boolean;
        filePath?: string;
        error?: string;
      };
      return { ok: Boolean(r?.ok), canceled: r?.canceled, filePath: r?.filePath, error: r?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 通用文本导出（CSV）：主进程弹系统保存对话框，由用户选择保存位置后写盘
  saveFile: async (
    defaultName: string,
    content: string,
    extWhitelist?: string[]
  ): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
    try {
      const fn = api().saveFile;
      if (!fn) return { ok: false, error: 'saveFile API 不可用（仅 Electron 可用）' };
      const r = (await fn(defaultName, content, extWhitelist)) as {
        ok?: boolean;
        canceled?: boolean;
        filePath?: string;
        error?: string;
      };
      return { ok: Boolean(r?.ok), canceled: r?.canceled, filePath: r?.filePath, error: r?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 统计数据报表 PDF（A4 横版）：与简历导出通道独立，避免对话框标题错位
  saveReportPdf: async (
    defaultName: string,
    html: string
  ): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
    try {
      const fn = api().saveReportPdf;
      if (!fn) return { ok: false, error: 'PDF 报表仅桌面端可用' };
      const r = (await fn(defaultName, html)) as {
        ok?: boolean;
        canceled?: boolean;
        filePath?: string;
        error?: string;
      };
      return { ok: Boolean(r?.ok), canceled: r?.canceled, filePath: r?.filePath, error: r?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 在系统文件管理器中定位到刚导出的文件
  showItem: async (filePath: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const fn = api().showItem;
      if (!fn) return { ok: false, error: 'showItem API 不可用（仅 Electron 可用）' };
      const r = (await fn(filePath)) as { ok?: boolean; error?: string };
      return { ok: Boolean(r?.ok), error: r?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 达标岗位导出目录：读取 / 设置 / 系统目录选择对话框（选择即应用并持久化）
  qualifiedJobsDir: {
    get: async (): Promise<string> => {
      try {
        const fn = api().qualifiedJobsDirGet;
        if (!fn) return '';
        const r = (await fn()) as { dir?: string };
        return String(r?.dir || '');
      } catch {
        return '';
      }
    },
    set: async (dir: string): Promise<{ ok: boolean; dir?: string; error?: string }> => {
      try {
        const fn = api().qualifiedJobsDirSet;
        if (!fn) return { ok: false, error: '导出目录 API 不可用' };
        const r = (await fn(dir)) as { ok?: boolean; dir?: string; error?: string };
        return { ok: Boolean(r?.ok), dir: r?.dir, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    pick: async (): Promise<{ ok: boolean; canceled?: boolean; dir?: string; error?: string }> => {
      try {
        const fn = api().qualifiedJobsDirPick;
        if (!fn) return { ok: false, error: '导出目录 API 不可用' };
        const r = (await fn()) as { ok?: boolean; canceled?: boolean; dir?: string; error?: string };
        return { ok: Boolean(r?.ok), canceled: r?.canceled, dir: r?.dir, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  },

  ipc: {
    invoke: (channel: string, ...args: unknown[]) => api().invoke?.(channel, ...args),
    send: (channel: string, ...args: unknown[]) => (api().send || noop)(channel, ...args),
    on: (channel: string, cb: (...args: unknown[]) => void) => (api().on || noopUnsub)(channel, cb),
  },
};

export default electronApi;
