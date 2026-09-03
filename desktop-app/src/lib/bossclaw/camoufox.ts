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
  /** 当前使用的隐身内核：camoufox（仅此可用）/ none */
  kernel?: string;
  /** 内核可执行文件路径（仅 camoufox 原生内核，legacy chrome/edge 不再使用） */
  kernelPath?: string;
  kernelMessage?: string;
  cookies?: boolean;
  cookieCount?: number;
  /** 是否已真实登录（存在 BOSS 的 wt2 鉴权 token） */
  loggedIn?: boolean;
  message?: string;
}

export interface CamoufoxStatus {
  python: boolean;
  pythonCmd?: string | null;
  camoufox: boolean;
  running: boolean;
  ready: boolean;
  /** 依赖首次安装中（后台进行，非就绪非失败） */
  installing?: boolean;
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
  /** 该岗位为外部网申，无法自动沟通（应标记跳过） */
  external?: boolean;
  /** 目标 HR/会话疑似冲突，已暂停发送 */
  conflict?: boolean;
  /** HR 已发来消息，需进入「AI 跟聊」回复（code 700） */
  needsReply?: boolean;
  hasHrMessage?: boolean;
  /** HR 最新一条消息文本（用于生成 AI 回复） */
  hrLastMessage?: string;
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
  // P10：同动作(同 jobId) in-flight 防重。避免多个入口并发调用导致同一岗位被重复发送。
  // 说明：主进程已有 AbortSignal.timeout 兜底超时；此处不做激进渲染层超时——无服务端取消机制时，
  // 渲染层超时释放锁反而会在服务端仍在真实发送的同时放行重试，放大双发风险。so 只做防重复。
  const key = `${action}:${typeof payload?.jobId === 'string' && payload.jobId ? payload.jobId : 'global'}`;
  if (CAMOUFOX_IN_FLIGHT.has(key)) {
    return ({ ok: false, error: '同一岗位/动作正在执行中，已阻止重复操作' }) as T;
  }
  CAMOUFOX_IN_FLIGHT.add(key);
  try {
    const r = await window.electron?.camoufoxCall?.(action, payload || {});
    return (r as T) ?? ({ ok: false, error: '主进程未暴露 camoufox 接口' } as T);
  } finally {
    CAMOUFOX_IN_FLIGHT.delete(key);
  }
}

/** P10：Camoufox in-flight 锁集合 */
const CAMOUFOX_IN_FLIGHT = new Set<string>();

/** 隐身搜索岗位 */
export function camoufoxSearch(query: string, city: string, pages = 1, os?: string): Promise<CamoufoxSearchResult> {
  return camoufoxCall<CamoufoxSearchResult>('search', { query, city, pages, os: os || undefined });
}

/** 隐身发送招呼语 */
export function camoufoxSend(jobId: string, greeting: string, os?: string): Promise<CamoufoxSendResult> {
  return camoufoxCall<CamoufoxSendResult>('send', { jobId, greeting, os: os || undefined });
}

export interface CamoufoxResumeImageInput {
  name: string;
  data: string;
}

/**
 * 自动沟通（真正的浏览器操作）：打开可见浏览器窗口，真实点击「立即沟通」、
 * 真实键盘输入招呼语并发送，最后确认文字气泡。
 * 区别于 camoufoxSend（friend/add.json API 优先）。
 */
export function camoufoxChat(
  jobId: string,
  greeting: string,
  opts?: {
    os?: string;
    sendResumeImage?: boolean;
    sendOnlineResume?: boolean;
    /** 目标岗位上下文（用于进入沟通后核验 HR/公司，防发错人） */
    recruiterName?: string;
    company?: string;
    jobTitle?: string;
    /** 本地 base64 图片简历（发送图片简历附件时携带） */
    resumeImages?: CamoufoxResumeImageInput[];
    /**
     * 'auto'（默认）首次打招呼投递：若 HR 已发来消息则返回 needsReply 供 AI 跟聊；
     * 'reply' 发送渲染层生成的 AI 回复文本（配合 replyText）。
     */
    mode?: 'auto' | 'reply';
    /** mode='reply' 时要发送的 AI 回复文本 */
    replyText?: string;
  }
): Promise<CamoufoxChatResult> {
  return camoufoxCall<CamoufoxChatResult>('chat', {
    jobId,
    greeting,
    os: opts?.os || undefined,
    sendResumeImage: Boolean(opts?.sendResumeImage),
    sendOnlineResume: Boolean(opts?.sendOnlineResume),
    recruiterName: opts?.recruiterName || '',
    company: opts?.company || '',
    jobTitle: opts?.jobTitle || '',
    resumeImages: opts?.resumeImages || [],
    mode: opts?.mode || 'auto',
    replyText: opts?.replyText || '',
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

/**
 * 重启 Camoufox 引擎桥（先停后拉）：自动沟通误触关闭后自愈用。
 * 返回重启后的状态；引擎未就绪/多轮重启仍失败时由调用方决定自动停止。
 */
export async function camoufoxRestart(): Promise<CamoufoxStatus> {
  try {
    const s = await window.electron?.camoufoxRestart?.();
    if (!s) return { python: false, camoufox: false, running: false, ready: false, message: '主进程未暴露 camoufoxRestart 接口' };
    return s as CamoufoxStatus;
  } catch (e: any) {
    return { python: false, camoufox: false, running: false, ready: false, message: String(e?.message || e) };
  }
}

/** 检查是否已启用 Camoufox 引擎（设置开关） */
export function camoufoxEnabled(config: { camoufox?: { enabled?: boolean } } | undefined | null): boolean {
  return Boolean(config?.camoufox?.enabled);
}

/** 检查 Camoufox 搜索结果的错误码是否属于「立即停止」级风控（P11：36/32/35 统一停止交人工） */
export function isCamoufoxStopCode(code: number | null | undefined): boolean {
  return code === 36 || code === 32 || code === 35;
}

/** 环境异常码（P11：38/37 —— 需提示用户先扫码登录 / 环境异常交人工） */
export function isCamoufoxEnvCode(code: number | null | undefined): boolean {
  return code === 38 || code === 37;
}
