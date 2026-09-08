// 岗位描述排除关键字（确定性过滤）
// 在「设置 → 求职偏好」中让用户输入不想接受的岗位描述关键词（如 出差 / 驻场 / 长期外派），
// 加入任务时按确定性规则跳过（不依赖 AI 判断，与「公司 / 招聘方黑名单」同级的硬过滤）。
//
// 匹配策略：
// - 对岗位的标题 / 卡片文本 / 岗位描述做拼接，忽略空白差异做「单向子串匹配」：
//   任一段落命中任一排除关键字即排除（用户关键词如「出差」命中「能接受出差」等）。
// - 命中即排除（宁可误杀、不放行用户明确不接受的岗位），不消耗 AI Token。
import type { AppConfig } from './types';

const normalize = (v: string) => String(v || '').replace(/\s+/g, '');

export interface JdKeywordFilterResult {
  excluded: boolean;
  /** 命中时的跳过原因（含命中的关键字），未命中时为空字符串 */
  reason: string;
}

/**
 * 判断某岗位是否命中「岗位描述排除关键字」。
 * 命中任一排除关键字 → excluded=true 应跳过；关键字为空时恒不排除。
 */
export function isJdKeywordExcluded(
  job: { title?: string; cardText?: string; description?: string } | null | undefined,
  config: AppConfig
): JdKeywordFilterResult {
  const keywords = config.excludedJobDescKeywords || [];
  if (!keywords.length) return { excluded: false, reason: '' };

  const text = normalize(
    [String(job?.title || ''), String(job?.cardText || ''), String(job?.description || '')].join('\n')
  );
  if (!text) return { excluded: false, reason: '' };

  for (const raw of keywords) {
    const kw = normalize(raw);
    if (!kw) continue;
    if (text.includes(kw)) {
      return { excluded: true, reason: `岗位描述命中排除关键字「${String(raw).trim()}」，已跳过` };
    }
  }
  return { excluded: false, reason: '' };
}