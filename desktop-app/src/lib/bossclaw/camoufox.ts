// BossClaw Camoufox 隐身引擎 —— 渲染端客户端
// 通过主进程 IPC 调用本地 Python 桥（camoufox_server.py），提供：
//   - 状态检测（python/camoufox 是否安装、桥是否就绪）
//   - 隐身搜索（joblist API，自动处理 code 37 环境检查）
//   - 隐身发送（friend/add.json + 页面点击兜底）
//   - 扫码登录（可见窗口）
// 安全不变量与 Boss-claw 其余投递链路一致：code 36/32 立即停止、交人工处理。

export interface CamoufoxEngineInfo {
  ok: boolean;
  version?: string;
  python?: string;
  camoufox?: boolean;
  camoufoxVersion?: string;
  /** 当前使用的内核：camoufox / chrome / edge / none */
  kernel?: string;
  /** 内核可执行文件路径（chrome/edge 时） */
  kernelPath?: string;
  kernelMessage?: string;
  cookies?: boolean;
  cookieCount?: number;
  message?: string;
}

export interface CamoufoxStatus {
  python: boolean;
  pythonCmd?: string | null;
  camoufox: boolean;
  running: boolean;
  ready: boolean;
  message?: string;
  engine?: CamoufoxEngineInfo;
}

export interface CamoufoxJob {
  jobId: string;
  title: string;
  company: string;
  salary: string;
  location: string;
  experience: string;
  degree: string;
  labels: string[];
  skills: string[];
  description: string;
  recruiterName: string;
  bossTitle: string;
  companySize: string;
  companyType: string;
  url: string;
}

export interface CamoufoxSearchResult {
  ok: boolean;
  code?: number;
  message?: string;
  jobs?: CamoufoxJob[];
  error?: string;
}

export interface CamoufoxSendResult {
  ok: boolean;
  sent?: boolean;
  code?: number;
  message?: string;
  method?: string;
  error?: string;
}

export interface CamoufoxChatResult {
  ok: boolean;
  sent?: boolean;
  code?: number;
  message?: string;
  method?: string;
  sentVia?: string;
  error?: string;
}

export interface CamoufoxLoginResult {
  ok: boolean;
  loggedIn?: boolean;
  code?: number;
  message?: string;
  error?: string;
}

export type CamoufoxAction = 'search' | 'send' | 'chat' | 'login' | 'logout' | 'clear';

/** 查询 Camoufox 引擎状态（会尝试自动拉起桥） */
export async function camoufoxStatus(): Promise<CamoufoxStatus> {
  try {
    const s = await window.electron?.camoufoxStatus?.();
    return (s as CamoufoxStatus) || { python: false, camoufox: false, running: false, ready: false, message: '主进程未暴露 camoufox 接口' };
  } catch (e: any) {
    return { python: false, camoufox: false, running: false, ready: false, message: String(e?.message || e) };
  }
}

/** 调用 Camoufox 桥（搜索 / 发送 / 登录） */
export async function camoufoxCall<T = any>(action: CamoufoxAction, payload?: Record<string, unknown>): Promise<T> {
  const r = await window.electron?.camoufoxCall?.(action, payload || {});
  return (r as T) ?? ({ ok: false, error: '主进程未暴露 camoufox 接口' } as T);
}

/** 隐身搜索岗位 */
export function camoufoxSearch(query: string, city: string, pages = 1, os?: string): Promise<CamoufoxSearchResult> {
  return camoufoxCall<CamoufoxSearchResult>('search', { query, city, pages, os: os || undefined });
}

/** 隐身发送招呼语 */
export function camoufoxSend(jobId: string, greeting: string, os?: string): Promise<CamoufoxSendResult> {
  return camoufoxCall<CamoufoxSendResult>('send', { jobId, greeting, os: os || undefined });
}

/**
 * 自动沟通（真正的浏览器操作）：打开可见浏览器窗口，真实点击「立即沟通」、
 * 真实键盘输入招呼语并发送，最后确认文字气泡。
 * 区别于 camoufoxSend（friend/add.json API 优先）。
 */
export function camoufoxChat(
  jobId: string,
  greeting: string,
  opts?: { os?: string; sendResumeImage?: boolean; sendOnlineResume?: boolean }
): Promise<CamoufoxChatResult> {
  return camoufoxCall<CamoufoxChatResult>('chat', {
    jobId,
    greeting,
    os: opts?.os || undefined,
    sendResumeImage: Boolean(opts?.sendResumeImage),
    sendOnlineResume: Boolean(opts?.sendOnlineResume),
  });
}

/** 打开 Camoufox 可见窗口扫码登录 */
export function camoufoxLogin(timeout = 180, os?: string): Promise<CamoufoxLoginResult> {
  return camoufoxCall<CamoufoxLoginResult>('login', { timeout, os: os || undefined });
}

/** 清除 Camoufox 会话 Cookie */
export function camoufoxLogout(): Promise<{ ok: boolean }> {
  return camoufoxCall('logout');
}

/** 停止 Camoufox 桥（释放资源） */
export function camoufoxStop(): void {
  window.electron?.camoufoxStop?.();
}

/** 检查是否已启用 Camoufox 引擎（设置开关） */
export function camoufoxEnabled(config: { camoufox?: { enabled?: boolean } } | undefined | null): boolean {
  return Boolean(config?.camoufox?.enabled);
}

/** 检查 Camoufox 搜索结果的错误码是否属于「立即停止」级风控（36/32）或环境异常（38，需登录） */
export function isCamoufoxStopCode(code: number | null | undefined): boolean {
  return code === 36 || code === 32;
}

/** 环境异常码（38：未登录的自动化环境被识别）—— 需提示用户先扫码登录 */
export function isCamoufoxEnvCode(code: number | null | undefined): boolean {
  return code === 38;
}
