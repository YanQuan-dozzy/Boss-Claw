// 平台登录态检测（渲染进程侧）。
// 以主进程读取 webview 持久化会话（persist:bossclaw）中的各平台鉴权 cookie 为准。
// 候选 cookie 名权威源 = main.cjs `WEBVIEW_AUTH_COOKIE_HINTS`（与 camoufox_server.py
// `PLATFORM_AUTH_COOKIE_HINTS` 双源同步），本文件不再重复枚举。
// 未登录（cookie 缺失/异常）时返回 false / null，供启动自动辅助 / 搜索采集前拦截，
// 以及底部状态栏展示各平台整体登录情况。
import type { JobPlatform } from './bossclaw/platforms';
import { PLATFORM_IDS } from './bossclaw/platforms';

export type PlatformLogins = Record<JobPlatform, boolean | null>;

function emptyLogins(): PlatformLogins {
  return Object.fromEntries(PLATFORM_IDS.map((p) => [p, null])) as PlatformLogins;
}

/**
 * 探测全部平台登录态：返回 BOSS 主登录（loggedIn，供既有拦截逻辑使用）
 * 与逐平台登录表（platforms）。
 * 主进程异常时不抛错，platforms 全为 null（等价「检测中」，与 BOSS 旧口径一致）。
 */
export async function checkAllPlatformsLogin(): Promise<{ loggedIn: boolean; platforms: PlatformLogins }> {
  const platforms = emptyLogins();
  try {
    const fn = window.electron?.bossLogin;
    if (typeof fn !== 'function') return { loggedIn: false, platforms };
    const res = (await fn()) as
      | { loggedIn?: boolean; platforms?: Record<string, boolean> }
      | null
      | undefined;
    if (res?.platforms) {
      for (const id of PLATFORM_IDS) {
        if (typeof res.platforms[id] === 'boolean') platforms[id] = res.platforms[id];
      }
    }
    return { loggedIn: Boolean(res && res.loggedIn), platforms };
  } catch {
    return { loggedIn: false, platforms };
  }
}

/** BOSS 直聘单独登录态（兼容既有调用方：工作台投递前拦截 / 现场复核） */
export async function checkBossLogin(): Promise<boolean> {
  return (await checkAllPlatformsLogin()).loggedIn;
}