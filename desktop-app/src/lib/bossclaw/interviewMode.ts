// 面试方式筛选：确定性规则，由用户在设置中指定，非 AI 判断。
// 与岗位标题/描述/卡片文本中的「线上/线下」面试关键词配合，
// 用于在「加入任务」时排除与用户设定冲突的面试方式岗位，避免浪费每日打招呼配额。
//
// 识别口径（优先本地关键字，宽松不误杀）：
//   offline（线下）：明确、正面披露存在到现场/线下面试的岗位；若出现「无需/不用到场、线上即可」等否定表述则不判为线下。
//   online （线上）：明确出现「线上/视频/远程/电话/在线」等面试（沟通）信号。
//   unknown（未识别）：未在说明中明确披露任何面试方式——一律判为「合格」，不参与过滤、不误杀。
import type { InterviewModeFilter, JobMeta } from './types';

export type DetectedInterviewMode = 'online' | 'offline' | 'unknown';

// 将岗位文本映射为面试方式；unknown 表示未明确披露线上/线下（不参与过滤，避免误杀）
export function detectInterviewMode(job: JobMeta | null | undefined): DetectedInterviewMode {
  const text = [
    String(job?.title || ''),
    String(job?.description || ''),
    String(job?.cardText || ''),
  ]
    .join('\n')
    .toLowerCase();
  if (!text) return 'unknown';

  // 「无需/不用/不必 到司/到公司/现场/线下 …（面试/笔试/沟通）」或「线上即可/统一线上」等否定表述，
  // 表明岗位实际是（或可以是）线上/远程，不能据此判为线下——线上机会不得误当成线下拦截。
  const negatedOffline =
    /(?:无需|不用|不需要|不必|线上即可|可线上|支持线上|优先线上|全程线上|统一线上|均在线上)[^。；;\n]{0,12}(?:到(?:司|公司|现场|岗)|线下|现场)(?:面试|笔试|面谈|沟通)?/.test(text) ||
    /无需线下面试|不用线下面试|线上面试(?:即可|优先|均可)|线上视频面试|可视频面试/.test(text);

  // 明确、正面披露「线下」的确定性信号（需陈述存在到场/线下的面试环节，才判为线下）
  const offline =
    /线下面试|现场面试|必须(?:到|线下|现场)[^。；;\n]{0,10}(?:面试|面谈|笔试)|面试需到现场|到(?:司|公司|岗|现场|店)(?:面试|面谈|笔试)|门店面试|驻场面试|现场(?:笔试|初试|复试)|线下(?:笔试|初试|复试|面谈)/;
  if (offline.test(text) && !negatedOffline) return 'offline';

  // 明确披露「线上」的正面信号
  const online =
    /线上面试|视频面试|远程面试|电话面试|在线面试|网络面试|云面试|线上沟通|视频沟通|远程沟通|线上初面|线上笔试|视频初面/;
  if (online.test(text)) return 'online';

  // 未明确披露任何面试方式 → unknown，按「合格」处理（不参与过滤，避免误杀）
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
