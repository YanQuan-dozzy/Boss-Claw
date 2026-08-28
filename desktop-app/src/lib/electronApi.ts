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
  },

  external: {
    open: (url: string) => {
      const fn = api().openExternal;
      if (fn && typeof url === 'string' && /^https?:\/\//i.test(url)) fn(url);
    },
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
  },

  webview: {
    preloadPath: (): string => (api() as { webviewPreload?: string }).webviewPreload || '',
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

  ipc: {
    invoke: (channel: string, ...args: unknown[]) => api().invoke?.(channel, ...args),
    send: (channel: string, ...args: unknown[]) => (api().send || noop)(channel, ...args),
    on: (channel: string, cb: (...args: unknown[]) => void) => (api().on || noopUnsub)(channel, cb),
  },
};

export default electronApi;
