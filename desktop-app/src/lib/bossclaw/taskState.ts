// 移植自 F:\job-claw-main\source\src\lib\task-state.js
// 投递任务阶段、进度与状态元数据
// 注：在参考实现基础上扩展 'opened' 阶段（介于 open_chat 与 verify_chat_target 之间）——
//   工作台「点击立即沟通」打开聊天窗口但尚未执行自动沟通时的状态。
//   进度百分比：open_chat(78) → opened(80) → verify_chat_target(82)，逻辑顺序单调递增，
//   与原进度链（open_chat → verify_chat_target 78→82）配合 auto 流程留出 "打开后人工核对" 的位置。
import type { TaskStage } from './types';

export const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'ignored', 'skipped']);

export const TASK_STAGE_META: Record<TaskStage, [string, number]> = Object.freeze({
  discovered: ['已发现岗位', 12],
  collect_detail: ['读取岗位详情', 24],
  ai_analyze: ['AI 匹配分析', 42],
  ai_complete: ['AI 分析完成', 56],
  waiting_review: ['等待人工确认', 60],
  queued: ['等待投递', 64],
  retry_queued: ['等待重新投递', 66],
  open_job: ['打开岗位页面', 70],
  open_chat: ['打开沟通窗口', 78],
  opened: ['已打开沟通窗口，等待发送/核对', 80],
  verify_chat_target: ['核对 HR 与岗位', 82],
  fill_message: ['填写求职招呼语', 86],
  send_message: ['发送求职招呼语', 90],
  verify_message: ['确认文字已发送', 94],
  send_resume: ['发送简历附件', 97],
  verify_result: ['确认投递结果', 98],
  success: ['投递成功', 100],
  failed: ['投递失败', 100],
  ignored: ['已忽略', 100],
  skipped: ['未达到推荐条件', 100],
});

export function taskStageMeta(
  stage: TaskStage,
  label = '',
  progress: number | null = null
): { label: string; progress: number } {
  const meta = TASK_STAGE_META[stage] || [label || stage || '处理中', 0];
  return {
    label: String(label || meta[0] || '处理中'),
    progress: Math.max(0, Math.min(100, Number(progress ?? meta[1] ?? 0))),
  };
}

// 需求文档 6.2：任务进度条阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递）
export const PHASE_LABELS = ['整理', '匹配', '排序', '沟通', '投递'] as const;

const STAGE_TO_PHASE: Record<TaskStage, number> = {
  discovered: 0,
  collect_detail: 0,
  ai_analyze: 1,
  ai_complete: 1,
  waiting_review: 2,
  queued: 2,
  retry_queued: 2,
  open_job: 3,
  open_chat: 3,
  opened: 3,
  verify_chat_target: 3,
  fill_message: 4,
  send_message: 4,
  verify_message: 4,
  send_resume: 4,
  verify_result: 4,
  success: 4,
  failed: 4,
  ignored: 4,
  skipped: 4,
};

export function stageToPhase(stage: TaskStage): { index: number; label: string; progress: number } {
  const index = STAGE_TO_PHASE[stage] ?? 2;
  const meta = taskStageMeta(stage);
  return { index, label: PHASE_LABELS[index], progress: meta.progress };
}
