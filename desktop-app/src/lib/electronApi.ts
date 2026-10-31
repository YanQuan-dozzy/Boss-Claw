// 渲染进程访问 preload 注入 API 的安全封装。
// 集中所有 `window.electron.*` 调用，避免散落多处。
// 每个方法都做了「API 存在性 + 类型基本校验」保护，preload 未就绪时返回安全降级值。
//
// 设计原则（AGENTS.md §3.1 进程安全）：
//   1. contextIsolation:true 下，渲染进程只通过 contextBridge 暴露的 window.electron 与主进程通信。
//   2. 永远不直接 typeof window.electron 操作，所有调用走该封装，便于统一审计与单测替身。
//   3. 任何缺失的 API 都以「默认值 + Promise.resolve() / no-op」形式降级，绝不抛错导致 UI 崩溃。

import type { MockIndexEntry, MockSession } from './bossclaw/mockInterviewTypes';
import type { QueueFilePayload } from './bossclaw/queueTypes';
import type { BankMeta, BankQuestion } from './bossclaw/mockInterviewBank';
import type {
  AsrResult,
  ClonedVoice,
  CustomVoice,
  SpeechProgress,
  SpeechStatus,
  TtsChunk,
  TtsResult,
  TtsStreamResult,
  VoicePackProbe,
} from './bossclaw/mockInterviewVoice';

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

  // 本地桥（OpenClaw）访问令牌：随机生成、存于 ~/.bossclaw/bridge-token（C-2）
  bridge: {
    token: async (): Promise<string> => {
      try {
        const fn = (api() as { bridgeToken?: () => Promise<string> }).bridgeToken;
        if (!fn) return '';
        const t = await fn();
        return typeof t === 'string' ? t : '';
      } catch {
        return '';
      }
    },
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

  // 岗位队列文件仓储（issue #10）：pending / qualifiedExports 存于 <userData>/queue/
  queue: {
    /** 'file' = 队列写主进程文件；'localstorage' = 已回滚到旧路径 */
    mode: (): 'file' | 'localstorage' => (api().queueStoreMode === 'localstorage' ? 'localstorage' : 'file'),
    load: async (): Promise<{ ok: boolean; data?: QueueFilePayload | null; source?: string; recovered?: boolean; error?: string }> => {
      try {
        const fn = api().queueLoad;
        if (!fn) return { ok: false, error: '队列文件存储仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; data?: unknown; source?: string; recovered?: boolean; corrupt?: boolean; error?: string };
        return {
          ok: Boolean(r?.ok),
          data: (r?.data as QueueFilePayload | null | undefined) ?? null,
          source: r?.source,
          recovered: Boolean(r?.recovered),
          error: r?.error,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    save: async (text: string, seq: number, opts?: { migrationSnapshot?: boolean }): Promise<{ ok: boolean; stale?: boolean; seq?: number; bytes?: number; error?: string }> => {
      try {
        const fn = api().queueSave;
        if (!fn) return { ok: false, error: '队列文件存储仅桌面端可用' };
        const r = (await fn(text, seq, opts)) as { ok?: boolean; stale?: boolean; seq?: number; bytes?: number; error?: string };
        return { ok: Boolean(r?.ok), stale: r?.stale, seq: r?.seq, bytes: r?.bytes, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    clear: async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().queueClear;
        if (!fn) return { ok: false, error: '队列文件存储仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; error?: string };
        return { ok: Boolean(r?.ok), error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    usage: async (): Promise<{ ok: boolean; bytes?: number; bakBytes?: number; totalBytes?: number; error?: string }> => {
      try {
        const fn = api().queueUsage;
        if (!fn) return { ok: false };
        const r = (await fn()) as { ok?: boolean; bytes?: number; bakBytes?: number; totalBytes?: number; error?: string };
        return { ok: Boolean(r?.ok), bytes: r?.bytes, bakBytes: r?.bakBytes, totalBytes: r?.totalBytes, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  },

  // 模拟面试：会话文件仓储（主进程 <userData>/mock-interview/），渲染层只经此封装读写
  mockInterview: {
    list: async (): Promise<{ ok: boolean; sessions: MockIndexEntry[]; error?: string }> => {
      try {
        const fn = api().mockInterviewList;
        if (!fn) return { ok: false, sessions: [], error: '模拟面试存储仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; sessions?: MockIndexEntry[]; error?: string };
        return { ok: Boolean(r?.ok), sessions: Array.isArray(r?.sessions) ? (r!.sessions as MockIndexEntry[]) : [], error: r?.error };
      } catch (e) {
        return { ok: false, sessions: [], error: (e as Error).message };
      }
    },
    read: async (id: string): Promise<{ ok: boolean; session?: MockSession; error?: string }> => {
      try {
        const fn = api().mockInterviewRead;
        if (!fn) return { ok: false, error: '模拟面试存储仅桌面端可用' };
        const r = (await fn(id)) as { ok?: boolean; session?: MockSession; error?: string };
        return { ok: Boolean(r?.ok), session: r?.session, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    write: async (session: MockSession, opts?: { immediate?: boolean }): Promise<{ ok: boolean; stale?: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewWrite;
        if (!fn) return { ok: false, error: '模拟面试存储仅桌面端可用' };
        const r = (await fn(session, opts)) as { ok?: boolean; stale?: boolean; error?: string };
        return { ok: Boolean(r?.ok), stale: r?.stale, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    remove: async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewDelete;
        if (!fn) return { ok: false, error: '模拟面试存储仅桌面端可用' };
        return (await fn(id)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    clear: async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewClear;
        if (!fn) return { ok: false, error: '模拟面试存储仅桌面端可用' };
        return (await fn()) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    clearSessions: async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewClearSessions;
        if (!fn) return { ok: false, error: '模拟面试存储仅桌面端可用' };
        return (await fn()) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    exportAll: async (): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; count?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewExport;
        if (!fn) return { ok: false, error: '模拟面试导出仅桌面端可用' };
        return (await fn()) as { ok: boolean; canceled?: boolean; filePath?: string; count?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    usage: async (): Promise<{ ok: boolean; count: number; bytes: number; error?: string }> => {
      try {
        const fn = api().mockInterviewUsage;
        if (!fn) return { ok: false, count: 0, bytes: 0, error: '模拟面试存储仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; count?: number; bytes?: number; error?: string };
        return { ok: Boolean(r?.ok), count: Number(r?.count || 0), bytes: Number(r?.bytes || 0), error: r?.error };
      } catch (e) {
        return { ok: false, count: 0, bytes: 0, error: (e as Error).message };
      }
    },

    // ===== 题库（P3：内置库随包只读，用户库写 userData）=====
    bankList: async (): Promise<{ ok: boolean; banks: BankMeta[]; error?: string }> => {
      try {
        const fn = api().mockInterviewBankList;
        if (!fn) return { ok: false, banks: [], error: '题库仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; banks?: BankMeta[]; error?: string };
        return { ok: Boolean(r?.ok), banks: Array.isArray(r?.banks) ? (r!.banks as BankMeta[]) : [], error: r?.error };
      } catch (e) {
        return { ok: false, banks: [], error: (e as Error).message };
      }
    },
    bankRead: async (bankId: string): Promise<{ ok: boolean; questions: BankQuestion[]; meta?: BankMeta; error?: string }> => {
      try {
        const fn = api().mockInterviewBankRead;
        if (!fn) return { ok: false, questions: [], error: '题库仅桌面端可用' };
        const r = (await fn(bankId)) as { ok?: boolean; questions?: BankQuestion[]; meta?: BankMeta; error?: string };
        return {
          ok: Boolean(r?.ok),
          questions: Array.isArray(r?.questions) ? (r!.questions as BankQuestion[]) : [],
          meta: r?.meta,
          error: r?.error,
        };
      } catch (e) {
        return { ok: false, questions: [], error: (e as Error).message };
      }
    },
    bankCreate: async (name: string): Promise<{ ok: boolean; bank?: BankMeta; error?: string }> => {
      try {
        const fn = api().mockInterviewBankCreate;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        const r = (await fn(name, 'custom')) as { ok?: boolean; bank?: BankMeta; error?: string };
        return { ok: Boolean(r?.ok), bank: r?.bank, error: r?.error };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankRename: async (bankId: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewBankRename;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, name)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankDelete: async (bankId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewBankDelete;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankToggle: async (bankId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewBankToggle;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, enabled)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankRestoreBuiltin: async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewBankRestoreBuiltin;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn()) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankAddQuestion: async (bankId: string, q: Partial<BankQuestion>): Promise<{ ok: boolean; question?: BankQuestion; count?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankAddQuestion;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, q)) as { ok: boolean; question?: BankQuestion; count?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankUpdateQuestion: async (bankId: string, questionId: string, patch: Partial<BankQuestion>): Promise<{ ok: boolean; question?: BankQuestion; error?: string }> => {
      try {
        const fn = api().mockInterviewBankUpdateQuestion;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, questionId, patch)) as { ok: boolean; question?: BankQuestion; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankDeleteQuestion: async (bankId: string, questionId: string): Promise<{ ok: boolean; count?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankDeleteQuestion;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, questionId)) as { ok: boolean; count?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankImport: async (bankId: string, questions: BankQuestion[], mode: 'append' | 'replace' = 'append'): Promise<{ ok: boolean; count?: number; added?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankImport;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(bankId, questions, { mode })) as { ok: boolean; count?: number; added?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankUsage: async (): Promise<{ ok: boolean; count: number; bytes: number; builtinCount?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankUsage;
        if (!fn) return { ok: false, count: 0, bytes: 0, error: '题库仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; count?: number; bytes?: number; builtinCount?: number; error?: string };
        return {
          ok: Boolean(r?.ok),
          count: Number(r?.count || 0),
          bytes: Number(r?.bytes || 0),
          builtinCount: Number(r?.builtinCount || 0),
          error: r?.error,
        };
      } catch (e) {
        return { ok: false, count: 0, bytes: 0, error: (e as Error).message };
      }
    },
    bankCacheRead: async (): Promise<{ ok: boolean; data?: string; bytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankCacheRead;
        if (!fn) return { ok: false };
        return (await fn()) as { ok: boolean; data?: string; bytes?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankCacheWrite: async (payload: string): Promise<{ ok: boolean; bytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankCacheWrite;
        if (!fn) return { ok: false, error: '题库仅桌面端可用' };
        return (await fn(payload)) as { ok: boolean; bytes?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    bankCacheClear: async (): Promise<{ ok: boolean; freedBytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewBankCacheClear;
        if (!fn) return { ok: false };
        return (await fn()) as { ok: boolean; freedBytes?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    // ===== 语音（P2：本地 Kokoro 朗读）=====
    speechStatus: async (): Promise<SpeechStatus> => {
      try {
        const fn = api().mockInterviewSpeechStatus;
        if (!fn) return { ok: false, error: '语音仅桌面端可用' };
        return ((await fn()) as SpeechStatus) || { ok: false, error: '状态读取失败' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    speechInstall: async (pack: 'tts' | 'asr' | 'clone' | 'melo' = 'tts'): Promise<{ ok: boolean; bytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewSpeechInstall;
        if (!fn) return { ok: false, error: '语音安装仅桌面端可用' };
        return ((await fn(pack)) as { ok: boolean; bytes?: number; error?: string }) || { ok: false };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    speechCancel: async (): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewSpeechCancel;
        if (!fn) return { ok: false, error: '语音安装仅桌面端可用' };
        return (await fn()) as { ok: boolean; canceled?: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    speechRemove: async (pack: 'tts' | 'asr' | 'clone' | 'melo' = 'tts'): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewSpeechRemove;
        if (!fn) return { ok: false, error: '语音仅桌面端可用' };
        return (await fn(pack)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    /** 切换朗读模型（Kokoro ⇄ MeloTTS）。两套都装了才切得动，主进程会重启 worker */
    speechSetPack: async (pack: 'kokoro' | 'melo'): Promise<{ ok: boolean; pack?: string; error?: string }> => {
      try {
        const fn = api().mockInterviewSpeechSetPack;
        if (!fn) return { ok: false, error: '语音仅桌面端可用' };
        return (await fn(pack)) as { ok: boolean; pack?: string; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    speechSetOnline: async (on: boolean): Promise<{ ok: boolean; onlineEngine?: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewSpeechSetOnline;
        if (!fn) return { ok: false, error: '语音仅桌面端可用' };
        return (await fn(on)) as { ok: boolean; onlineEngine?: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    asr: async (opts: {
      samplesBase64: string;
      sampleRate: number;
      segments?: Array<{ start: number; end: number }>;
    }): Promise<AsrResult> => {
      try {
        const fn = api().mockInterviewAsr;
        if (!fn) return { ok: false, error: '语音识别仅桌面端可用' };
        return ((await fn(opts)) as AsrResult) || { ok: false, error: '识别失败' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    asrWarmup: async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewAsrWarmup;
        if (!fn) return { ok: false, error: '语音识别仅桌面端可用' };
        return (await fn()) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    tts: async (opts: { text: string; sid?: number; speed: number; voiceId?: string; numSteps?: number; engine?: string; onlineVoice?: string }): Promise<TtsResult> => {
      try {
        const fn = api().mockInterviewTts;
        if (!fn) return { ok: false, error: '语音合成仅桌面端可用' };
        return ((await fn(opts)) as TtsResult) || { ok: false, error: '合成失败' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    ttsPreview: async (opts: { sid?: number; speed?: number; voiceId?: string; engine?: string; onlineVoice?: string }): Promise<TtsResult> => {
      try {
        const fn = api().mockInterviewTtsPreview;
        if (!fn) return { ok: false, error: '语音合成仅桌面端可用' };
        return ((await fn(opts)) as TtsResult) || { ok: false, error: '试听失败' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    /**
     * 流式朗读：先问一次 invoke，合成过程中分块从 onTtsChunk 推过来。
     * 返回值在整段合成结束（或取消）时 resolve；首包到达靠 onTtsChunk 感知。
     */
    ttsStream: async (
      opts: { text: string; sid?: number; speed: number; voiceId?: string; numSteps?: number; engine?: string; onlineVoice?: string },
      streamId: string,
    ): Promise<TtsStreamResult> => {
      try {
        const fn = api().mockInterviewTtsStream;
        if (!fn) return { ok: false, unavailable: true, error: '流式朗读仅桌面端可用' };
        return ((await fn({ ...opts, streamId })) as TtsStreamResult) || { ok: false, error: '合成失败' };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        // 主进程还没注册这条通道（旧版本）时不该弹错，退回整段合成即可
        if (/No handler registered/i.test(msg)) return { ok: false, unavailable: true, error: msg };
        return { ok: false, error: msg };
      }
    },
    ttsCancel: async (streamId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewTtsCancel;
        if (!fn) return { ok: false, error: '流式朗读仅桌面端可用' };
        return (await fn(streamId)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    onTtsChunk: (callback: (chunk: TtsChunk) => void): (() => void) => {
      const fn = api().onMockInterviewTtsChunk;
      if (!fn) return () => {};
      return fn((chunk) => callback(chunk as TtsChunk));
    },
    clearTtsCache: async (): Promise<{ ok: boolean; freedBytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewTtsClearCache;
        if (!fn) return { ok: false, error: '语音仅桌面端可用' };
        return (await fn()) as { ok: boolean; freedBytes?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    // ===== 克隆音色（P4-B：参考音频存 userData/speech/voices）=====
    voiceList: async (): Promise<{ ok: boolean; voices: CustomVoice[]; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceList;
        if (!fn) return { ok: false, voices: [], error: '自定义音色仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; voices?: CustomVoice[]; error?: string };
        return { ok: Boolean(r?.ok), voices: Array.isArray(r?.voices) ? (r!.voices as CustomVoice[]) : [], error: r?.error };
      } catch (e) {
        return { ok: false, voices: [], error: (e as Error).message };
      }
    },
    voiceCreate: async (payload: {
      name?: string;
      samplesBase64: string;
      sampleRate: number;
      refText: string;
    }): Promise<{
      ok: boolean;
      voice?: ClonedVoice;
      previewOk?: boolean;
      previewError?: string;
      previewWavBase64?: string;
      error?: string;
    }> => {
      try {
        const fn = api().mockInterviewVoiceCreate;
        if (!fn) return { ok: false, error: '克隆音色仅桌面端可用' };
        return (await fn(payload)) as {
          ok: boolean;
          voice?: ClonedVoice;
          previewOk?: boolean;
          previewError?: string;
          previewWavBase64?: string;
          error?: string;
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voicePackPick: async (): Promise<{
      ok: boolean;
      canceled?: boolean;
      dir?: string;
      probe?: VoicePackProbe;
      error?: string;
    }> => {
      try {
        const fn = api().mockInterviewVoicePackPick;
        if (!fn) return { ok: false, error: '音色包导入仅桌面端可用' };
        return (await fn()) as { ok: boolean; canceled?: boolean; dir?: string; probe?: VoicePackProbe; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voicePackPreview: async (dir: string, sid = 0): Promise<{
      ok: boolean;
      wavBase64?: string;
      bytes?: number;
      ms?: number;
      engine?: string;
      family?: string;
      borrowedDataDir?: boolean;
      error?: string;
    }> => {
      try {
        const fn = api().mockInterviewVoicePackPreview;
        if (!fn) return { ok: false, error: '音色包试听仅桌面端可用' };
        return (await fn(dir, sid)) as {
          ok: boolean;
          wavBase64?: string;
          bytes?: number;
          ms?: number;
          engine?: string;
          family?: string;
          error?: string;
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voiceImport: async (
      dir: string,
      opts: { name?: string; license?: string; source?: string; sid?: number },
    ): Promise<{ ok: boolean; voice?: CustomVoice; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceImport;
        if (!fn) return { ok: false, error: '音色包导入仅桌面端可用' };
        return (await fn(dir, opts)) as { ok: boolean; voice?: CustomVoice; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voiceRename: async (id: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceRename;
        if (!fn) return { ok: false, error: '克隆音色仅桌面端可用' };
        return (await fn(id, name)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voiceRemove: async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceRemove;
        if (!fn) return { ok: false, error: '克隆音色仅桌面端可用' };
        return (await fn(id)) as { ok: boolean; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    voiceUsage: async (): Promise<{ ok: boolean; count: number; bytes: number; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceUsage;
        if (!fn) return { ok: false, count: 0, bytes: 0, error: '克隆音色仅桌面端可用' };
        const r = (await fn()) as { ok?: boolean; count?: number; bytes?: number; error?: string };
        return { ok: Boolean(r?.ok), count: Number(r?.count || 0), bytes: Number(r?.bytes || 0), error: r?.error };
      } catch (e) {
        return { ok: false, count: 0, bytes: 0, error: (e as Error).message };
      }
    },
    voiceClear: async (): Promise<{ ok: boolean; removed?: number; freedBytes?: number; error?: string }> => {
      try {
        const fn = api().mockInterviewVoiceClear;
        if (!fn) return { ok: false, error: '克隆音色仅桌面端可用' };
        return (await fn()) as { ok: boolean; removed?: number; freedBytes?: number; error?: string };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    onSpeechProgress: (cb: (p: SpeechProgress) => void) =>
      (api().onMockInterviewSpeechProgress || noopUnsub)(cb as (p: unknown) => void),
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
