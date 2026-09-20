// 原简历「AI 智能整理」：把从 PDF/文件提取的原始文字交给 LLM 整理成工整、结构清晰的中文简历正文，
// 再由 Canvas 渲染成无敏感信息图片。仅重新组织/润色原文里的事实，不新增不虚构。
//
// 复用 llm.cachedCallModel（scope=assistant）：缓存 key 已含完整输入哈希，同一份简历重复整理直接命中，
// 不重复计费；未配置 API Key / 调用失败时调用方回退本地原文。全程求职者第一人称书面口吻。
// 注意：敏感信息在整理后进行统一脱敏（resumeDesensitize），因此这里保留原文事实即可。

import type { AppConfig } from './types';
import { cachedCallModel } from './llm';
import { resolveContextBudget } from './contextBudget';
import { prepareContextText } from './oversizedContext';

const SYSTEM_PROMPT = `你是求职者的简历整理助手。请把用户提供的、从简历或 PDF 提取出的原始文字，整理成一份工整、通顺、结构清晰的中文简历正文。

要求：
- 只能依据原文中已出现的事实进行整理，不得新增、虚构、美化或推断任何经历、技能、薪资、到岗时间、面试时间。
- 保留所有实质内容（教育、工作/实习经历、项目、技能、证书、作品、自我评价），可合理分段与排序。
- 措辞做极小幅度润色使其通顺即可，不要过度改写，不得删除有信息量的内容。
- 用求职者第一人称的书面口吻，简洁专业，避免口语化。
- 可带小标题组织（如：求职意向 / 教育背景 / 工作经历 / 项目经历 / 技能特长 / 自我评价），格式规整。
- 只输出整理后的简历正文纯文本，不要任何 JSON、代码块、Markdown 标记或解释性文字。`;

/**
 * 用 AI 整理简历原文（jsonMode 关闭，返回纯文本）。
 * 失败/未配置时抛错，由调用方回退本地原文。
 */
export async function polishResumeWithAI(rawText: string, config: AppConfig['model']): Promise<string> {
  // 原文投入量按「模型窗口 × 用量档位」计算（旧实现固定截 12000 字，大窗口模型被白白浪费）：
  // 整理要求**保真不删内容**，故占满可用输入预算（输出预留 3200）。
  // 超预算时走 transform 分片：逐片各自整理后按原文顺序拼接 ——
  // 这里**不能**用「提炼要点」（会把简历压成摘要、丢失原文），也不能按预算截断（会丢后半段）。
  const prepared = await prepareContextText(String(rawText || ''), config, {
    tokenBudget: resolveContextBudget(config, { outputTokens: 3200 }).inputBudgetTokens,
    focus: '简历全部内容（整理任务要求保真，不压缩、不摘要）',
    cacheScope: 'assistant',
    purpose: '简历整理',
    mode: 'transform',
    instruction: SYSTEM_PROMPT,
  });
  // 超窗时各片已分别整理完成、按序拼接即为最终正文 → 不再重复整理一次
  const raw = prepared.condensed
    ? prepared.text
    : await cachedCallModel(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `请整理下面这份简历原始文字：\n\n${prepared.text}` },
        ],
        config,
        { jsonMode: false, temperature: 0.3, maxTokens: 3200 },
        { scope: 'assistant' },
      );
  const text = String(raw || '').trim();
  if (text.replace(/[\s\s]/g, '').length < 40) {
    throw new Error('AI 整理结果过短，已回退本地原文');
  }
  return text;
}