// lib/notify.ts —— 系统通知的唯一入口
//
// 为什么不让调用方直接 `new Notification(...)`：
//   ① 渲染层的 Web Notification 在 Windows 上拿不到应用图标与 AUMID 归属，弹出的通知像是「Chrome 的」；
//   ② 点击通知需要唤回主窗口（可能在托盘里藏着），只有主进程做得到；
//   ③ 开关是一次性的（AppConfig.systemNotify），散落各处就会出现「设置里关了但某处还在弹」。
// 因此统一走主进程 `jc:notify`（electron/main.cjs::showSystemNotification）。
//
// 调用纪律：通知只是「用户不在界面上时的补充提示」，**不参与任何业务判断**。
// 发送失败（系统不支持 / 用户关掉通知）必须静默降级，绝不能中断投递或让 Promise 变成未捕获拒绝。
//
// 口径（v2.6.1 之后）：只在「用户需要动手或需要知道」的节点发 ——
//   首次投递验收暂停、风控命中暂停、定时任务完成；不要把每一次投递成功都弹一遍（那是骚扰）。

import { useSettingsStore } from '@/store/useSettingsStore';

/** 当前是否允许发通知（设置页开关，默认开） */
export function systemNotifyEnabled(): boolean {
  return useSettingsStore.getState().config.systemNotify !== false;
}

/** 发一条系统通知；未开启 / 环境不支持时静默返回 false */
export function notifySystem(title: string, body: string): boolean {
  if (!systemNotifyEnabled()) return false;
  const api = typeof window !== 'undefined' ? window.electron : undefined;
  if (!api?.notify) return false;
  try {
    // 主进程返回值（ok / skipped）只用于排查，不影响调用方逻辑
    void api.notify({ title, body }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** 首次投递成功后暂停验收 —— 用户必须回来看气泡与附件，是最高优先级的通知 */
export function notifyValidationPaused(jobTitle?: string): void {
  const job = String(jobTitle || '').trim();
  notifySystem(
    '首次投递已发出，等待你核对',
    (job ? `岗位：${job}\n` : '') + '请在界面确认聊天对象、文字气泡与附件是否一致，再继续投递。'
  );
}

/** 风控命中（code 32 / 35 / 36 / 37）自动停止 —— 必须让人知道「不是程序坏了，是被平台拦了」 */
export function notifyRiskPaused(code: string | number, detail?: string): void {
  const tail = String(detail || '').trim();
  notifySystem(
    `已自动停止投递（风控 ${code}）`,
    (tail ? tail + '\n' : '') + '这是平台侧的账号或行为校验，请手动处理后再继续；应用不会尝试绕过。'
  );
}

/** 定时任务触发 / 完成 —— 结果在窗口里，用户此刻可能不在界面上 */
export function notifyScheduleEvent(title: string, summary: string): void {
  notifySystem(title, summary);
}
