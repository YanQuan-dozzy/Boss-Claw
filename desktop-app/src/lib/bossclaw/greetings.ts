// AI 生成个性化打招呼语（借鉴 AI-BossJob 的「简历 → 4 条打招呼语」能力）
// 安全不变量（对齐 AGENTS.md 2.1）：所有提示词与招呼语必须使用求职者第一人称口吻，
// 仅引用真实简历事实；禁止承诺薪资、到岗时间、面试时间或不存在的能力/经历。
import type { AppConfig, Profile } from './types';
import { cachedCallModel, aiFailureKind } from './llm';
import { skillInstructionsFor } from './skills';
import { normalizeStringList } from './helpers';
import { ANALYZE_SYSTEM_PROMPT } from './prompts';

const GREETINGS_SCHEMA = JSON.stringify({ greetings: ['', '', '', ''] });

/** 系统默认的简历级 4 条打招呼语提示词（用户可在简历中心自定义覆盖） */
export const DEFAULT_GREETING_PROMPT = `你是求职者本人（第一人称）。基于简历与职业画像，为应聘岗位生成 4 条个性化的求职打招呼语。
要求：
1. 全部使用求职者口吻（"您好，我想应聘……"），严禁招聘方口吻（不得出现"看到你的简历""你的经历很匹配我们""欢迎进一步沟通""我们团队""候选人"等）。
2. 只能引用简历中的真实事实（技能、项目、经验、教育），不得编造或承诺薪资、到岗时间、面试时间、不存在的能力。
3. 4 条角度各不相同：技能匹配 / 项目经验 / 岗位兴趣 / 简洁版，每条 50-110 字。
4. 输出严格 JSON：${GREETINGS_SCHEMA}`;

/** 提示词留空时的兜底（兼容旧数据）：返回系统默认提示词 */
export function resolveGreetingPrompt(customPrompt: string): string {
  const trimmed = (customPrompt || '').trim();
  return trimmed || DEFAULT_GREETING_PROMPT;
}

export function normalizeGreetingText(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

// 复用岗位草稿的口径检查：必须是求职者口吻，且不是招聘方口吻
function acceptableGreeting(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const reversed = /看到你的简历|你的简历|很匹配我们|匹配我们|欢迎.*沟通|期待你|候选人|我们团队|我们公司|团队主要涉及|你很匹配|方便的话来聊聊/i.test(raw);
  const applicantVoice = /我想应聘|我希望应聘|我对.{0,20}(岗位|职位).{0,10}(感兴趣|有兴趣)|想进一步了解|希望进一步沟通|您好/i.test(raw);
  return !reversed && applicantVoice;
}

export function buildLocalGreetings(profile: Profile | null, resumeText = ''): string[] {
  const skills = normalizeStringList(profile?.facts?.skills, 4);
  const projects = normalizeStringList(profile?.facts?.projects, 2);
  const directions = normalizeStringList(profile?.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)), 2);
  const direction = directions[0] || '该方向';
  const resumeHasEvidence = String(resumeText || '').trim().length > 0;

  const candidates: string[] = [];
  if (skills.length) {
    candidates.push(
      `您好，我想应聘${direction}相关岗位。我的简历中有${skills.slice(0, 3).join('、')}等相关技能与实践，希望有机会进一步了解岗位内容，谢谢。`
    );
  }
  if (projects.length) {
    candidates.push(
      `您好，我想应聘贵公司的${direction}岗位。我曾参与${projects[0]}，对岗位工作内容很感兴趣，希望能向您了解更多，谢谢。`
    );
  }
  candidates.push(
    `您好，我想应聘${direction}方向的工作，对这一领域很有兴趣。方便的话希望进一步了解岗位与团队情况，谢谢。`
  );
  candidates.push(
    `您好，我对贵公司${direction}相关岗位非常感兴趣，希望有机会深入沟通，谢谢。`
  );

  const result = candidates.filter((g) => acceptableGreeting(g));
  // 至少保证 4 条（缺失时用通用模板补齐）
  while (result.length < 4) {
    result.push(
      `您好，我想应聘${direction}相关岗位，对岗位内容很感兴趣。方便的话希望进一步了解，谢谢。`
    );
  }
  // 去除重复并截断到 4 条
  const uniq: string[] = [];
  for (const g of result) {
    if (!uniq.some((u) => u === g)) uniq.push(g);
    if (uniq.length >= 4) break;
  }
  void resumeHasEvidence;
  return uniq.map(normalizeGreetingText);
}

export async function generateGreetings(
  resumeText: string,
  profile: Profile | null,
  model: AppConfig['model'],
  customPrompt?: string
): Promise<{ greetings: string[]; method: string; warning?: string }> {
  const local = buildLocalGreetings(profile, resumeText);
  if (!model?.apiKey) {
    return { greetings: local, method: 'local', warning: 'AI 尚未配置，当前为本地规则生成的打招呼语。' };
  }
  try {
    const profileBrief = profile
      ? {
          summary: profile.summary,
          primaryDirections: profile.primaryDirections,
          searchKeywords: profile.searchKeywords,
          skills: profile.facts?.skills,
          experiences: profile.facts?.experiences,
        }
      : null;
    const systemPrompt = resolveGreetingPrompt(customPrompt || '') + skillInstructionsFor('greetings');
    // 简历截短至 8000 字 + 缓存：同一份简历与画像重复生成直接命中，不重复计费
    const result: any = await cachedCallModel(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `简历：\n${String(resumeText || '').slice(0, 8000)}\n\n职业画像：\n${JSON.stringify(profileBrief || {})}`,
        },
      ],
      model,
      { maxTokens: 2000, temperature: 0.4 },
      { scope: 'greetings' }
    );
    const rawList = Array.isArray(result?.greetings) ? result.greetings : [];
    const cleaned = rawList.map((g: unknown) => normalizeGreetingText(String(g || ''))).filter(acceptableGreeting);
    if (cleaned.length >= 2) {
      const merged = [...cleaned, ...local];
      const uniq: string[] = [];
      for (const g of merged) {
        if (!uniq.some((u) => u === g)) uniq.push(g);
        if (uniq.length >= 4) break;
      }
      return { greetings: uniq, method: 'ai' };
    }
    return {
      greetings: local,
      method: 'local',
      warning: 'AI 返回的招呼语未通过求职者口吻校验，已回退本地规则生成。',
    };
  } catch (error: any) {
    const kind = aiFailureKind(error);
    return {
      greetings: local,
      method: 'local',
      warning:
        kind === 'config-missing'
          ? 'AI 尚未配置，当前为本地规则生成的打招呼语。'
          : `AI 生成失败（${error?.message || '未知原因'}），已回退本地规则。`,
    };
  }
}

// 岗位匹配草稿仍使用 ANALYZE_SYSTEM_PROMPT 口径（保证单一入口），此处仅复用口吻检查
export const GREETING_PROMPT_REF = ANALYZE_SYSTEM_PROMPT;
