// 投递方向「AI 生成新搜索词」：围绕单个投递方向，生成 3 条该方向内、招聘平台真实常见的搜索关键词。
//
// 设计要点：
// - 只补该方向内的词，严禁跨方向（如「全栈开发」「后端开发」「产品经理」），避免污染该方向的任务搜索。
// - 显式把「已有关键词」传给模型要求去重，返回后再按方向键二次去重，保证每次点击都能拿到新词。
// - 只需要 3 条短词，maxTokens 很小；不走结果缓存，避免「每次点击都拿到同一批」。
// - 未配置 API Key / 调用失败时抛错，由调用方提示用户，不静默改动方向数据。

import type { AppConfig, DirectionItem, Profile } from './types';
import type { ChatMessage } from './llm';
import { callModel, extractJson } from './llm';
import { normalizeDirectionKey, normalizeStringList } from './helpers';

const SYSTEM_PROMPT = `你是招聘平台的岗位搜索词推荐助手。用户会给出一个「求职方向」，请为它在招聘平台上生成 3 条新的岗位搜索关键词。

要求：
- 必须是该方向**内部**真实常见的岗位搜索词（2~8 个汉字，或行业通用的英文缩写），能在招聘平台搜到对口岗位。
- 严禁跨方向：不要给出属于其他方向的词（例如给「AI 应用开发」方向时不要出现「全栈开发」「后端开发」「产品经理」等）。
- 不要与用户给出的「已有关键词」重复或高度近似（不要只加/减「工程师」「实习生」这类后缀）。
- 措辞符合招聘平台搜索习惯，简洁、可直接粘贴进搜索框。
- 只输出 JSON，格式为 {"keywords":["关键词1","关键词2","关键词3"]}，不要任何解释文字。`;

export interface GenerateDirectionKeywordsInput {
  item: DirectionItem;
  profile?: Profile | null;
}

/** 解析模型返回的关键词列表：非空字符串、去重、剔除已存在的词、最多 3 条 */
export function parseGeneratedKeywords(raw: unknown, existing: string[] = []): string[] {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw;
  const list = Array.isArray((parsed as any)?.keywords)
    ? (parsed as any).keywords
    : Array.isArray(parsed)
      ? (parsed as any)
      : [];
  const taken = new Set(normalizeStringList(existing, 40).map(normalizeDirectionKey));
  const out: string[] = [];
  for (const candidate of normalizeStringList(list, 12)) {
    const text = candidate.slice(0, 20);
    const key = normalizeDirectionKey(text);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

/**
 * 为单个投递方向生成 3 条新搜索词（已剔除现有关键词）。
 * 失败或未配置时抛错，由调用方提示用户。
 */
export async function generateDirectionKeywords(
  input: GenerateDirectionKeywordsInput,
  config: AppConfig['model']
): Promise<string[]> {
  if (!config?.apiKey) throw new Error('请先在「设置」页填写 AI API Key');
  const { item, profile } = input;
  const existing = normalizeStringList(item?.keywords, 20);
  const skills = normalizeStringList(profile?.facts?.skills, 12);
  const userPayload = {
    方向名称: item?.name || '',
    该方向已有的搜索关键词: existing,
    与方向相关的简历技能: skills.length ? skills : (item?.matchedSkills || []),
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请为下面这个求职方向生成 3 条新的搜索关键词：\n${JSON.stringify(userPayload, null, 2)}` },
  ];
  const raw = await callModel(messages, config, { jsonMode: true, temperature: 0.6, maxTokens: 500 });
  const keywords = parseGeneratedKeywords(raw, existing);
  if (!keywords.length) throw new Error('AI 未生成可用的新关键词，请稍后重试');
  return keywords;
}
