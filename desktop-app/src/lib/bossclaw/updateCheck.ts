// lib/bossclaw/updateCheck.ts —— 版本更新检查（只查、只提示、只跳转，不自动下载安装）
//
// 为什么不做静默自动更新：
//   ① 打包配置是 `win.signAndEditExecutable: false`（无代码签名）+ `asar: false`（源码目录分发），
//      自动替换 exe 会被 SmartScreen / 杀软拦住，且替换时机无法与「正在跑的投递」对齐；
//   ② 本项目的数据与登录态都在本机，突然换二进制文件出问题时用户无法回退到上一个版本。
// 因此口径是：用户点「检查更新」→ 比对 GitHub Releases 最新 tag → 有新版本就给下载入口，
// 由用户自己下载安装。**不做启动即联网检查**（避免每次开应用都产生外部请求）。
//
// 网络通道：走主进程 `jc:fetch-url`（electronApi.fetchUrl），不直连 —— 渲染层直连会被 CORS 拦，
// 且主进程侧已有出站白名单、超时与 32MB 响应上限。

import { electronApi } from '@/lib/electronApi';

const REPO = 'YanQuan-dozzy/Boss-Claw';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CACHE_KEY = 'bossclaw-update-check';
/** 同一会话内 6 小时内不重复打 GitHub API（未认证限流 60 次/小时，够用但没必要浪费） */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  ok: boolean;
  current: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  publishedAt?: string;
  checkedAt?: number;
  error?: string;
}

/** 取三段版本号；解析不出返回空数组（**宁可不判更新，也不误报**） */
export function parseVersion(input: string): number[] {
  const m = String(input || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest 是否严格新于 current（相等 / 解析失败 / 降级一律 false） */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function readCache(current: string): UpdateCheckResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as UpdateCheckResult;
    if (!cached || cached.current !== current) return null;
    if (!cached.checkedAt || Date.now() - cached.checkedAt > CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(result: UpdateCheckResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {
    // 缓存写失败（配额）不影响检查本身，忽略
  }
}

/**
 * 检查更新。
 * @param force true = 忽略 6 小时缓存（用户主动点按钮时用）
 */
export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  let current = '';
  try {
    const info = await electronApi.getAppInfo();
    current = String(info?.version || '');
  } catch {
    current = '';
  }
  const base: UpdateCheckResult = { ok: false, current };

  if (!current) return { ...base, error: '读不到当前版本号（窗口未就绪）' };
  if (!force) {
    const cached = readCache(current);
    if (cached) return cached;
  }

  const res = await electronApi.fetchUrl(RELEASES_API);
  if (!res.ok || !res.text) {
    // GitHub 在国内常被墙：这不是缺陷，给出可读原因并带上「手动打开 Releases」的兜底路径
    const reason = res.error || `HTTP ${res.status || 0}`;
    return { ...base, error: `无法访问 GitHub（${reason}）` };
  }

  let latest = '';
  let url = RELEASES_PAGE;
  let publishedAt: string | undefined;
  try {
    const data = JSON.parse(res.text) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      message?: string;
    };
    if (data?.message && !data.tag_name) {
      // 例如 API 限流：{ "message": "API rate limit exceeded ..." }
      return { ...base, error: `GitHub 接口返回：${String(data.message).slice(0, 120)}` };
    }
    latest = String(data?.tag_name || '').replace(/^v/i, '');
    if (data?.html_url) url = String(data.html_url);
    publishedAt = data?.published_at || undefined;
  } catch {
    return { ...base, error: '解析 GitHub 返回内容失败' };
  }

  if (!latest) return { ...base, error: 'GitHub 返回的最新版本号为空' };

  const result: UpdateCheckResult = {
    ok: true,
    current,
    latest,
    hasUpdate: isNewerVersion(latest, current),
    url,
    publishedAt,
    checkedAt: Date.now(),
  };
  writeCache(result);
  return result;
}

/** 打开发布页（有新版本时的「前往下载」） */
export function openReleasesPage(url?: string): void {
  try {
    electronApi.external.open(url || RELEASES_PAGE);
  } catch {
    // 无外部浏览器 / 非 Electron 环境：静默失败，界面上的文案本身已给出地址
  }
}
