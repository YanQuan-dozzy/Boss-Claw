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

/** 发一条系统通知；未开启 / 环境不支持时静默返回 false。
 *  clickAction：通知点击后的渲染层动作（经主进程 jc:notify-action 回传），如跳转跟聊页并高亮会话。 */
export function notifySystem(title: string, body: string, clickAction?: { kind: string; conversation?: string }): boolean {
  if (!systemNotifyEnabled()) return false;
  const api = typeof window !== 'undefined' ? window.electron : undefined;
  if (!api?.notify) return false;
  try {
    // 主进程返回值（ok / skipped）只用于排查，不影响调用方逻辑
    void api.notify({ title, body, clickAction }).catch(() => {});
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

// ===== HR 回复提醒（P1-4）=====
// AI 跟聊会自动回复 HR 消息，用户完全不知道「HR 回了什么」——这是通知基建最该补的洞。
// 口径：
//   · 只在「检测到 HR 新消息」的收口点提醒（批量链路 aiReplyAndSend / 常驻监听 watchCycle），
//     复用 notifySystem 单一通道，不新增通知实现；
//   · 按会话聚合：同一会话 10 分钟内只提醒一次（跟聊监听两分钟一轮，HR 连发多条会刷屏）；
//     「HR 明确拒绝」是终态、每会话至多一次，**绕过聚合**直接提醒（文案不同）；
//   · 子开关 AppConfig.hrReplyNotify（默认开），且受主开关 systemNotify 约束 —— 两层都关才静默；
//   · 通知只是提示，不参与任何业务判断（跟聊收口逻辑独立运行，通知失败不影响投递）。

/** 同一会话两条提醒的最小间隔（毫秒）：10 分钟内只提醒一次 */
export const HR_REPLY_AGGREGATE_MS = 10 * 60 * 1000;

/** 会话 → 上次提醒时刻（模块级内存态，重启即清，不持久化） */
const hrReplyNotifiedAt = new Map<string, number>();

/** HR 回复提醒子开关（设置页「HR 回复提醒」，默认开；与主开关 systemNotify 独立） */
export function hrReplyNotifyEnabled(): boolean {
  return useSettingsStore.getState().config.hrReplyNotify !== false;
}

/** 清空聚合状态（回归测试 / 重新开启监听时用） */
export function resetHrReplyNotifyState(): void {
  hrReplyNotifiedAt.clear();
}

/** 会话聚合键：HR 名 + 公司归一（去空白、转小写），任一为空都能成键 */
export function hrReplyConvKey(hrName: string, company: string): string {
  const norm = (v: string) => String(v || '').replace(/\s+/g, '').toLowerCase();
  return `${norm(hrName)}|${norm(company)}`;
}

export interface HrReplyNotifyArgs {
  /** 会话聚合键（hrReplyConvKey 生成）；为空视为无法聚合，不提醒（避免误聚合成一条） */
  convKey?: string;
  /** 通知点击跳转用：会话显示名（HR 名或会话名），AutoChat 队列高亮按它归一匹配 */
  conversation?: string;
  jobTitle?: string;
  hrName?: string;
  /** HR 消息原文（取前 40 字做预览） */
  hrMessage: string;
  /** HR 明确拒绝（终态）：文案不同且绕过 10 分钟聚合 */
  rejected?: boolean;
}

/**
 * HR 回复提醒：检测到 HR 新消息时调用。
 * 返回是否真的发出了通知（聚合命中 / 开关关闭 / 环境不支持都返回 false，调用方不必处理）。
 */
export function notifyHrReply(args: HrReplyNotifyArgs): boolean {
  if (!systemNotifyEnabled()) return false;
  if (!hrReplyNotifyEnabled()) return false;
  const convKey = String(args.convKey || '').trim();
  if (!convKey) return false;
  const now = Date.now();
  const last = hrReplyNotifiedAt.get(convKey) || 0;
  // 拒绝是终态：即使 10 分钟内刚提醒过「新消息」，这条也必须发出来（否则用户以为只是普通回复）
  if (args.rejected) {
    hrReplyNotifiedAt.set(convKey, now);
  } else {
    if (now - last < HR_REPLY_AGGREGATE_MS) return false;
    hrReplyNotifiedAt.set(convKey, now);
  }
  const preview = String(args.hrMessage || '').trim().slice(0, 40);
  const hrName = String(args.hrName || args.conversation || '').trim();
  const who = [String(args.jobTitle || '').trim(), hrName].filter(Boolean).join(' · ');
  const head = who ? `${who}：` : '';
  // 点击通知 → 回到跟聊页并高亮该会话（主进程经 jc:notify-action 回传）
  const clickAction = {
    kind: 'open-autochat',
    conversation: String(args.conversation || '').trim(),
  };
  if (args.rejected) {
    // 终态通知绕过聚合：拒绝是每会话至多一次的关键事件，且必须与「新消息」文案可区分（回归断言）
    return notifySystem('HR 已明确拒绝，跟聊已结束', `${head}${preview || '（未提供消息内容）'}`, clickAction);
  }
  return notifySystem('HR 新消息', `${head}${preview}`, clickAction);
}
