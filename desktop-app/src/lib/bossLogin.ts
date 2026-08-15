// BOSS 直聘登录态检测（渲染进程侧）。
// 以主进程读取 webview 持久化会话（persist:bossclaw）中的 wt2 主会话 cookie 为准，
// 未登录（cookie 缺失/异常）时返回 false，供启动自动辅助 / 搜索采集前拦截。
export async function checkBossLogin(): Promise<boolean> {
  try {
    const fn = window.electron?.bossLogin;
    if (typeof fn !== 'function') return false;
    const res = (await fn()) as { loggedIn?: boolean } | null | undefined;
    return Boolean(res && res.loggedIn);
  } catch {
    return false;
  }
}
