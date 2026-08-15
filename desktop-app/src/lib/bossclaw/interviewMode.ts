// 面试方式筛选：确定性规则，由用户在设置中指定，非 AI 判断。
// 与岗位标题/描述/卡片文本中的「线上/线下」面试关键词配合，
// 用于在「加入任务」时排除与用户设定冲突的面试方式岗位，避免浪费每日打招呼配额。
//
// 识别口径（确定性、严格，避免误杀）：
//   offline（线下）：明确出现「线下面试 / 现场面试 / 到司(公司/岗/现场)面试 / 必须(到/现场)面试 /
//                    需(到/现场/线下)面试 / 公司(门店/驻场)面试 / 面(试)需到现场 / 线下(现场)笔试」等信号
//   online （线上）：明确出现「线上(视频/远程/电话/在线)面试 / 网络(云)面试 / 线上(视频/远程)沟通」等信号
//   unknown（未识别）：未出现明确信号——按「未识别 ≠ 冲突」处理，不误杀（无法判断则保留）
import type { InterviewModeFilter, JobMeta } from './types';

export type DetectedInterviewMode = 'online' | 'offline' | 'unknown';

// 将岗位文本映射为面试方式；unknown 表示未出现明确线上/线下信号（不参与过滤，避免误杀）
export function detectInterviewMode(job: JobMeta | null | undefined): DetectedInterviewMode {
  const text = [
    String(job?.title || ''),
    String(job?.description || ''),
    String(job?.cardText || ''),
  ]
    .join('\n')
    .toLowerCase();
  if (!text) return 'unknown';
  // 线下信号（严格，避免误判）：现场 / 到司 / 到公司 / 到岗 / 线下面试 等
  const offline =
    /线下面试|现场面试|到(司|公司|岗|现场|店)面试|需(到|现场|线下)面试|必须(到|现场|线下)面试|公司(面试|直招面试)|门店面试|驻场面试|面(试)?需到现场|到岗面试|线下笔试|现场笔试/;
  if (offline.test(text)) return 'offline';
  // 线上信号：线上 / 视频 / 远程 / 电话 / 在线面试 等
  const online =
    /线上面试|视频面试|远程面试|电话面试|在线面试|网络面试|云面试|线上沟通|视频沟通|远程沟通|视频初面|线上初面/;
  if (online.test(text)) return 'online';
  return 'unknown';
}

// 用户设定的面试方式筛选与岗位实际面试方式是否冲突（冲突即应排除 / 扣分）
export function interviewModeConflict(
  job: JobMeta | null | undefined,
  filter: InterviewModeFilter | undefined | null
): boolean {
  if (!filter || filter === 'any') return false;
  const mode = detectInterviewMode(job);
  // 未识别（unknown）不视为冲突，避免误杀
  if (mode === 'unknown') return false;
  // 设定「仅线上」→ 要求线下的岗位冲突；设定「仅线下」→ 要求线上的岗位冲突
  return mode !== filter;
}

export const INTERVIEW_MODE_FILTER_OPTIONS: { value: InterviewModeFilter; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'online', label: '仅线上' },
  { value: 'offline', label: '仅线下' },
];

export const INTERVIEW_MODE_FILTER_LABEL: Record<InterviewModeFilter, string> = {
  any: '不限',
  online: '仅线上',
  offline: '仅线下',
};

export const INTERVIEW_MODE_LABEL: Record<DetectedInterviewMode, string> = {
  online: '线上',
  offline: '线下',
  unknown: '未识别',
};
