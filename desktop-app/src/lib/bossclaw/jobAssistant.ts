// AI 求职助手 —— 根据岗位定制简历（定制摘要 + 量化经历 + 求职信/打招呼语 + 优化建议）
// 参考 GitHub 开源项目 ai-job-search 的「tailor CVs / write cover letters」方法论，
// 并借鉴 Resume-Matcher / Resume Architect / Resume-Customizer / ResumeForge AI 的最佳实践：
//   - 经历要点允许「量化改写」（仅提炼简历已有数字，严禁编造）；对标 ResumeForge 的 quantified achievements；
//   - 输出可执行的 ATS 优化建议清单；对标 Resume-Matcher 的 guided improvements。
// 落地为 BOSS 直聘场景：输入岗位 JD，基于简历/画像真实事实，生成岗位针对性内容。
//
// 安全不变量（对齐 AGENTS.md 2.1）：
//   - 定制内容只能引用简历/画像中的真实事实，禁止编造技能、经历、成果、薪资承诺；
//   - 量化只允许提炼简历中已有的数字（规模/时长/效率），简历没有数字就保持事实描述，严禁编造百分比、金额、用户量；
//   - 求职信必须求职者第一人称口吻，禁止招聘方口吻（复用打招呼语校验口径）；
//   - AI 输出不达标一律回退本地规则兜底，绝不把招聘方口吻的文本交给用户。
import type { AppConfig, JobMeta, Profile } from './types';
import { cachedCallModel } from './llm';
import { skillInstructionsFor } from './skills';
import { stableProfileView, fallbackApplicantGreeting } from './matching';
import { normalizeStringList } from './helpers';
import {
  analyzeJdKeywords,
  buildLocalSuggestions,
  computeMatchScore,
  extractJdKeywords,
  resumeHasQuantifiedEvidence,
  tailoredTextForScore,
  type JdKeywordAnalysis,
  type MatchScore,
} from './resumeMatch';

// ===== 输出 Schema =====
export const TAILOR_SCHEMA = JSON.stringify({
  highlightedSkills: [],
  tailoredSummary: '',
  tailoredExperiences: [],
  coverLetter: '',
  skillGaps: [],
  suggestions: [],
});

// ===== 系统提示词 =====
export const TAILOR_SYSTEM_PROMPT = `你是求职者的求职助手（不是招聘方）。任务：根据目标岗位 JD，为用户定制「岗位针对性简历摘要」「量化经历要点」「第一人称求职打招呼语（求职信）」与「可执行的优化建议」。

铁律：
1. 只能引用简历/职业画像中的真实事实（技能、项目、经历、教育）。简历里没有的能力、年限、项目成果一律视为不存在，不得编造或暗示具备。
2. 岗位 JD 只作为「匹配参照」，JD 里写的能力若简历没有，必须如实计入 skillGaps，绝不写进 tailoredSummary 或 coverLetter 当作自己具备。
3. tailoredSummary 为 120-180 字求职者个人摘要：开头点明身份（学历/年级/专业），突出与目标岗位最相关的真实技能与项目，只使用简历事实。
4. tailoredExperiences 为 2-4 条经历要点：从简历事实中挑选与岗位最相关者，按岗位相关性重排改写（每条不超过 80 字）。**量化改写规则**：若简历事实本身含数字（如"服务 3 年""日活 5 万""耗时从 2 小时降到 30 分钟"），允许提炼为「行动动词 + 可量化成果」句式；若简历没有数字，必须保持事实描述，**严禁编造或推算任何百分比、金额、人数、用户量、时长**。不得新增简历中不存在的细节。
5. highlightedSkills 为 3-8 个「岗位要求且简历具备」的技能名（规范技能名，如 React、Spring Boot）。
6. skillGaps 为 1-4 个「岗位明确要求但简历未体现」的技能/经验（如岗位要求某工具而简历没有），没有则返回空数组。
7. coverLetter 为第一人称求职打招呼语，要求：①必须"您好，我想应聘贵公司的{岗位名}"开头；②一句话点明真实身份；③一句话说清与岗位最相关的真实技能或项目；④表达对岗位与工作内容的兴趣与加入意愿；⑤全文 80-160 字；严禁招聘方口吻（"看到你的简历""你的经历很匹配我们""欢迎进一步沟通""我们团队""候选人"等），不得承诺薪资、到岗时间、面试时间。
8. suggestions 为 3-5 条「求职者可执行」的优化建议：基于简历与 JD 的真实差距给出（如补充某技能在简历中的落地场景、把某量化成果前置、补写某项目细节、求职信突出某技能等），每条不超过 40 字，不得建议编造事实。

输出严格 JSON：${TAILOR_SCHEMA}`;

// ===== 口吻校验（复用打招呼口径，保证与现有投递链路一致） =====
function isApplicantVoice(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const reversed = /看到你的简历|你的简历|很匹配我们|匹配我们|欢迎.*进一步沟通|期待你加入我们|候选人|我们团队|我们公司|我们这边|团队主要涉及|你很匹配|方便的话来聊聊|期待与你/i.test(raw);
  const applicantVoice = /我想应聘|我希望应聘|我对.{0,30}(岗位|职位|这份|这个|该).{0,15}(感兴趣|有兴趣)|想进一步了解|希望进一步沟通|希望和您(聊聊|沟通|交流)|希望加入|对该.{0,10}感兴趣|期望加入|期待加入|可实习|可到岗|您好/i.test(raw);
  return !reversed && applicantVoice;
}

/** 定制结果中的匹配分析（确定性本地计算，与 AI 无关） */
export interface TailorMatchAnalysis {
  /** JD 关键词三层比对 */
  keywords: JdKeywordAnalysis;
  /** 定制前匹配分（基于简历原文 + 画像） */
  before: MatchScore;
  /** 定制后匹配分（基于定制输出的摘要 + 经历 + 技能） */
  after: MatchScore;
}

export interface TailorResult {
  /** 岗位要求且简历具备的技能 */
  highlightedSkills: string[];
  /** 针对岗位定制的个人摘要 */
  tailoredSummary: string;
  /** 按岗位相关性重排的经历要点（允许量化改写，仅提炼简历已有数字） */
  tailoredExperiences: string[];
  /** 定制求职信（第一人称打招呼语） */
  coverLetter: string;
  /** 岗位要求但简历缺失的技能/经验（如实呈现，不补写） */
  skillGaps: string[];
  /** 可执行的优化建议（AI 生成，失败回退本地规则） */
  suggestions: string[];
  /** 匹配分析（本地确定性计算，定制前 vs 定制后） */
  match: TailorMatchAnalysis;
  method: 'ai' | 'local';
  warning?: string;
}

/**
 * 根据岗位 JD 生成定制简历（摘要 + 量化经历 + 求职信 + 建议）+ 本地确定性匹配分析。
 * 输入：岗位信息（title/company/salary/location/description）、简历原文、职业画像、AI 模型配置。
 * 匹配分析（before/after 评分 + 关键词三层比对）永远本地计算，免费、确定、可复现。
 * AI 不可用/输出不达标 → 回退本地规则（摘要用画像 summary，求职信用 fallbackApplicantGreeting，建议用本地分析）。
 */
export async function tailorForJob(
  job: JobMeta,
  resumeText: string,
  profile: Profile | null,
  model: AppConfig['model']
): Promise<TailorResult> {
  // ===== 本地确定性匹配分析（不依赖 AI，定制前后各算一次） =====
  const { keywords, weights } = extractJdKeywords(job.description || '', profile);
  const keywordAnalysis = analyzeJdKeywords(job.description || '', resumeText, profile, keywords);
  const profileBlob = profile ? JSON.stringify(stableProfileView(profile)) : '';
  const beforeScore = computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}`);

  const buildMatch = (afterText: string): TailorMatchAnalysis => ({
    keywords: keywordAnalysis,
    before: beforeScore,
    // 定制后 = 原简历 + 画像 + 定制内容（定制是对原简历的增强/前置，覆盖只会增加不会减少；
    // 若 AI 定制内容未命中任何 JD 关键词，after 与 before 持平，如实反映「定制无增益」）
    after: computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}\n${afterText}`),
  });

  const localFallback = (warning: string): TailorResult => {
    const tailored = {
      tailoredSummary: String(profile?.summary || '').trim() || '（未生成画像，请先在简历中心生成职业画像）',
      tailoredExperiences: normalizeStringList(profile?.facts?.experiences, 3),
      highlightedSkills: normalizeStringList(profile?.facts?.skills, 6),
    };
    return {
      ...tailored,
      coverLetter: fallbackApplicantGreeting(job, profile),
      skillGaps: [],
      suggestions: buildLocalSuggestions(keywordAnalysis, job.description || '', resumeHasQuantifiedEvidence(resumeText)),
      match: buildMatch(tailoredTextForScore(tailored)),
      method: 'local',
      warning,
    };
  };
  if (!profile) return localFallback('尚未生成职业画像，当前为本地规则生成的定制内容。');
  if (!model?.apiKey) return localFallback('AI 尚未配置，当前为本地规则生成的定制内容。');

  const jobView = {
    title: job.title,
    company: job.company,
    salary: job.salary,
    location: job.location,
    description: job.description,
  };
  try {
    const result: any = await cachedCallModel(
      [
        { role: 'system', content: TAILOR_SYSTEM_PROMPT + skillInstructionsFor('assistant') },
        {
          role: 'user',
          content: `职业画像：${JSON.stringify(stableProfileView(profile))}
简历：${String(resumeText || '').slice(0, 6000)}
岗位：${JSON.stringify(jobView)}`,
        },
      ],
      model,
      { maxTokens: 2200, temperature: 0.3 },
      { scope: 'assistant' }
    );
    const summary = String(result?.tailoredSummary || '').trim();
    const cover = String(result?.coverLetter || '').trim();
    // 事实与口吻校验：摘要非空 + 求职信通过口吻校验才接受 AI 结果
    if (!summary || !isApplicantVoice(cover)) {
      return localFallback('AI 生成未通过事实/口吻校验，已回退本地规则。');
    }
    const tailored = {
      tailoredSummary: summary.slice(0, 300),
      tailoredExperiences: normalizeStringList(result?.tailoredExperiences, 4).map((e) => e.slice(0, 90)),
      highlightedSkills: normalizeStringList(result?.highlightedSkills, 8),
    };
    return {
      ...tailored,
      coverLetter: cover.replace(/\s+/g, ' ').slice(0, 220),
      skillGaps: normalizeStringList(result?.skillGaps, 4),
      suggestions: normalizeStringList(result?.suggestions, 5).map((s) => s.slice(0, 60)),
      match: buildMatch(tailoredTextForScore(tailored)),
      method: 'ai',
    };
  } catch (error: any) {
    return localFallback(`AI 生成失败（${error?.message || '未知原因'}），已回退本地规则。`);
  }
}
