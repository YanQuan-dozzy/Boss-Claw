// AI 求职助手 —— 根据岗位定制简历（定制摘要 + 量化经历 + 求职信/打招呼语 + 优化建议）
// 参考 GitHub 开源项目 Anarkh-Lee/resume-alchemist 的优化方法论（按 JD 编写能力 / JD 关键词优化 /
//   STAR 法则润色经历），并兼容 MadsLorentzen/ai-job-search 的 /apply 流程与 Resume-Matcher 引导式建议：
//   - 经历要点允许「量化改写」（仅提炼简历已有数字，严禁编造）；对标 resume-alchemist 的量化成果；
//   - 能力/技能按 JD 适当编写（放大匹配点），但硬性事实（经历/学历/证书/数字/承诺）绝不编造；
//   - 输出可执行的 ATS 优化建议清单；对标 Resume-Matcher 的 guided improvements。
// 落地为 BOSS 直聘场景：输入岗位 JD，基于简历/画像真实事实，生成岗位针对性内容。
//
// 安全不变量（对齐 AGENTS.md 2.1）：
//   - 能力/技能可按 JD 适当编写（放大匹配点），但经历、学历、证书、量化数字与任何承诺绝不编造；
//   - 量化只允许提炼简历中已有的数字（规模/时长/效率），简历没有数字就保持事实描述，严禁编造百分比、金额、用户量；
//   - 求职信必须求职者第一人称口吻，禁止招聘方口吻（复用打招呼语校验口径）；
//   - AI 输出不达标一律回退本地规则兜底，绝不把招聘方口吻的文本交给用户。
import type { AppConfig, JobMeta, Profile } from './types';
import { cachedCallModel } from './llm';
import { ensureSkillsLoaded, skillInstructionsFor } from './skills';
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
// 求职信（coverLetter）的打招呼语提示词由调用方按「skill → 简历中心输入框内容」优先级解析后传入（都不满足则回退本地规则），
// 与工作台岗位分析、简历中心预览共用同一口径。
export function buildTailorSystemPrompt(greetingInstructions: string): string {
  return `你是求职者的求职助手（不是招聘方）。任务：根据目标岗位 JD，为用户定制「岗位针对性简历摘要」「量化经历要点」「第一人称求职打招呼语（求职信）」与「可执行的优化建议」。

铁律：
1. 定制内容以简历/职业画像事实为底色；岗位 JD 是**能力编写与表述的规范来源**（对齐 resume-alchemist：按 JD 关键词编写能力、STAR 润色经历，提升匹配度）。
2. **能力/技能按 JD 适当编写（鼓励方向）**：候选人在相关领域确有真实背景/经历时，允许把其真实掌握与相近的泛化能力用 JD 规范术语合理编写为技能，写入 highlightedSkills、tailoredSummary 与 tailoredExperiences，放大与岗位的匹配点（如做过多表数据处理 →「Python + Pandas 数据清洗」；做过前端页面、岗位要「性能优化」→「前端性能优化」）。
3. **硬性事实红线（绝不逾越）**：不得虚构公司/职位/在职时长、学校/学历/专业、证书/奖项、具体数字/比例/金额/用户量/时长；不得承诺薪资、到岗时间、面试时间；与岗位能力域毫无交集、无法从真实背景合理外推的，绝不写进 tailoredSummary、highlightedSkills 或 coverLetter 当作自己具备。触犯任一条即输出失败，交由本地规则兜底。
4. tailoredSummary 为 120-150 字求职者个人摘要：开头点明身份（学历/年级/专业），突出与目标岗位最相关的真实技能与项目，可按 JD 规范名写入岗位适配能力。
5. tailoredExperiences 为 2-4 条经历要点：从简历/画像真实经历中挑选与岗位最相关者，按 **STAR（情境/任务 → 行动 → 结果）** 精简为一句亮点重排（每条不超过 80 字）。允许把真实做过、但原表述泛化的能力按岗位语境写得更具指向性。[原量化改写规则保持]：若简历事实本身含数字（如"服务 3 年""日活 5 万""耗时从 2 小时降到 30 分钟"），允许提炼为「行动动词 + 可量化成果」句式；若简历没有数字，必须保持事实描述，**严禁编造或推算任何百分比、金额、人数、用户量、时长**。不得新增简历中完全不存在的职位、数字、成果。
6. highlightedSkills 为 3-8 个「岗位适配技能」：按 JD 规范名编写与岗位匹配的能力（含简历已具备与可合理外推的相近能力），体现对岗位的胜任力；与岗位无关或与候选人背景毫无交集的能力一律不列。
7. skillGaps 为 1-4 个「岗位明确要求、但候选人背景与该能力域毫无交集、无法合理编写」的能力提示，没有则返回空数组；可由真实背景合理外推的预期能力应写入 highlightedSkills 而非 skillGaps。
8. coverLetter 为第一人称求职打招呼语（求职信），必须遵守以下工作台打招呼语提示词（本软件打招呼语统一口径，含开头格式、口吻、长度、安全红线）：
${greetingInstructions}
9. suggestions 为 3-5 条「求职者可执行」的优化建议：基于简历与 JD 的真实差距给出（如补充某技能在简历中的落地场景、把某量化成果前置、补写某项目细节、求职信突出某技能等），每条不超过 40 字，不得建议编造事实。

输出严格 JSON：${TAILOR_SCHEMA}`;
}

// ===== 第二轮：招聘方 + ATS 视角自检修订（Reviewer） =====
// 对齐 MadsLorentzen/ai-job-search 的 /apply 流程（drafter → reviewer → revise），
// 以及 llamaindex-pse 的 Planner-Specialist-Evaluator 审阅思想：
// 第一轮初稿后，再以招聘方/ATS 视角逐字段自检、修订，避免一次性生成带出
// 夸大表述、语气瑕疵、关键词覆盖不真实、口吻不当等问题。字段输出 null（或缺省）表示「保持草稿不变」。
export const TAILOR_REVIEW_SCHEMA = JSON.stringify({
  tailoredSummary: null,
  tailoredExperiences: null,
  highlightedSkills: null,
  coverLetter: null,
  skillGaps: null,
  suggestions: null,
  reviewNote: null,
});

export function buildReviewSystemPrompt(): string {
  return `你是资深招聘方 + ATS 简历审核专家，负责对上一轮 AI 已起草的「岗位定制简历」做第二轮回审与修订（对齐 ai-job-search 的 drafter-reviewer：先起草，再以招聘方视角自检，修订后才可交付）。

输入：职业画像 / 目标岗位 JD / 上一轮草稿。

任务：逐字段审阅草稿，仅对「需要改进」的字段输出修订值；某字段无需修改就输出 null（缺省代表保留草稿）。审阅维度：
1. 诚实性红线（最优先）：草稿任何能力/经历/技能/数字/承诺是否超出简历事实？是否虚构公司/职位/在职时长、学校/学历/专业、证书/奖项、具体数字/比例/金额/用户量/时长？是否把「与岗位能力域毫无交集、无法从真实背景合理外推」的能力当作本人具备？触犯任一条必须修订或删除，绝不保留。
2. ATS 关键词覆盖：JD 高权重关键词（技能/工具/领域术语）是否被真实覆盖？候选人在相关领域确有真实背景时，允许把其真实掌握或相近的泛化能力按 JD 规范名编写为「适配技能」并前置入摘要/经历/技能；与候选人背景毫无交集的关键词不得硬塞，应归入 skillGaps。
3. STAR 与一页适配：tailoredSummary 120-150 字、开头点明身份（学历/年级/专业）；tailoredExperiences 2-4 条按相关性从高到低、一条不超过 80 字；量化只提炼简历已有数字，严禁编造或推算任何百分比/金额/人数/用户量/时长。
4. 求职信口吻：coverLetter 必须求职者第一人称（以「您好，我想应聘贵公司的{岗位名}」开头），80-160 字，严禁招聘方口吻（「看到你的简历」「你的经历很匹配我们」「欢迎进一步沟通」「我们团队」「候选人」等表述），不得承诺薪资、到岗时间、面试时间。
5. 建议可执行性：suggestions 3-5 条、基于简历与 JD 的真实差距、每条不超过 40 字，不得建议编造事实。

输出严格 JSON（只输出需修订的字段，其余一律 null）：${TAILOR_REVIEW_SCHEMA}`;
}

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

/** 单个被修订字段的片段对比（before → after，仅记录实际被 reviewer 改动的字段） */
export interface TailorFieldDiff {
  /** 字段中文展示名 */
  label: string;
  /** 修订前值 */
  before: string;
  /** 修订后值 */
  after: string;
}

/** 第二轮回审（Reviewer）的修订元信息 */
export interface TailorReviewMeta {
  /** 被修订字段的片段对比 */
  diffs: TailorFieldDiff[];
  /** reviewer 的自检优化说明 */
  note?: string;
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
  /** 第二轮回审（Reviewer）修订的片段对比与优化说明（有修订时才有） */
  review?: TailorReviewMeta;
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
  model: AppConfig['model'],
  customGreetingPrompt?: string
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
    // 求职信/打招呼语提示词来源优先级：① skill（greetings 技能，含用户自定义技能）→ ② 简历中心输入框内容 → ③ 都不满足则回退本地规则。
    // 先确保 skills 已从磁盘加载（含用户自行导入/新建的自定义技能）。
    await ensureSkillsLoaded();
    const greetingsSkill = skillInstructionsFor('greetings');
    const greetingInstructions = greetingsSkill || (customGreetingPrompt || '').trim();
    const result: any = await cachedCallModel(
      [
        { role: 'system', content: buildTailorSystemPrompt(greetingInstructions) + skillInstructionsFor('assistant') },
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
    // ===== 第一轮：草稿（Draft） =====
    const draft = {
      tailoredSummary: summary.slice(0, 300),
      tailoredExperiences: normalizeStringList(result?.tailoredExperiences, 4).map((e) => String(e).slice(0, 90)),
      highlightedSkills: normalizeStringList(result?.highlightedSkills, 8),
      coverLetter: cover.replace(/\s+/g, ' ').slice(0, 220),
      skillGaps: normalizeStringList(result?.skillGaps, 4),
      suggestions: normalizeStringList(result?.suggestions, 5).map((s) => String(s).slice(0, 60)),
    };

    // ===== 第二轮：招聘方 + ATS 视角自检修订（Reviewer） =====
    // 对齐 ai-job-search 的 drafter-reviewer。逐字段合并：仅当 review 给出「非空且通过校验」的修订才覆盖，
    // 否则保留草稿；review 失败/无效一律不降级草稿（草稿本身已通过事实与口吻校验）。
    let revised: (typeof draft & { review?: TailorReviewMeta }) = draft;
    try {
      const review: any = await cachedCallModel(
        [
          { role: 'system', content: buildReviewSystemPrompt() + skillInstructionsFor('assistant') },
          {
            role: 'user',
            content: `职业画像：${JSON.stringify(stableProfileView(profile))}
岗位：${JSON.stringify(jobView)}
草稿：${JSON.stringify({
              tailoredSummary: draft.tailoredSummary,
              tailoredExperiences: draft.tailoredExperiences,
              highlightedSkills: draft.highlightedSkills,
              coverLetter: draft.coverLetter,
              skillGaps: draft.skillGaps,
              suggestions: draft.suggestions,
            })}`,
          },
        ],
        model,
        { maxTokens: 1600, temperature: 0.2 },
        { scope: 'assistant' }
      );
      const reviewerText = (v: unknown) => String(v ?? '').trim();
      const merged = {
        tailoredSummary: reviewerText(review?.tailoredSummary) || draft.tailoredSummary,
        tailoredExperiences:
          Array.isArray(review?.tailoredExperiences) && review.tailoredExperiences.length
            ? normalizeStringList(review.tailoredExperiences, 4).map((e: unknown) => String(e).slice(0, 90))
            : draft.tailoredExperiences,
        highlightedSkills:
          Array.isArray(review?.highlightedSkills) && review.highlightedSkills.length
            ? normalizeStringList(review.highlightedSkills, 8)
            : draft.highlightedSkills,
        coverLetter: (() => {
          const c = reviewerText(review?.coverLetter);
          // 求职信修订须再次通过口吻校验才采纳，避免 review 把第一人称改坏
          return c && isApplicantVoice(c) ? c.replace(/\s+/g, ' ').slice(0, 220) : draft.coverLetter;
        })(),
        skillGaps: Array.isArray(review?.skillGaps) ? normalizeStringList(review.skillGaps, 4) : draft.skillGaps,
        suggestions:
          Array.isArray(review?.suggestions) && review.suggestions.length
            ? normalizeStringList(review.suggestions, 5).map((s: unknown) => String(s).slice(0, 60))
            : draft.suggestions,
      };
      // 摘要守卫：review 修订后仍须非空（草稿已验证为非空）
      const finalTailored = { ...merged, tailoredSummary: merged.tailoredSummary.slice(0, 300) || draft.tailoredSummary };
      // 收集实际被修订字段的片段对比（before → after），供 UI 展示 reviewer 的改动与优化说明
      const plain = (v: string | readonly string[]) => (Array.isArray(v) ? v.join('；') : String(v || ''));
      const diffs: TailorFieldDiff[] = [];
      const pushDiff = (label: string, before: string | readonly string[], after: string | readonly string[]) => {
        if (plain(before) !== plain(after)) diffs.push({ label, before: plain(before), after: plain(after) });
      };
      pushDiff('定制个人摘要', draft.tailoredSummary, finalTailored.tailoredSummary);
      pushDiff('重点经历', draft.tailoredExperiences, finalTailored.tailoredExperiences);
      pushDiff('岗位匹配技能', draft.highlightedSkills, finalTailored.highlightedSkills);
      pushDiff('定制求职信', draft.coverLetter, finalTailored.coverLetter);
      pushDiff('技能缺口', draft.skillGaps, finalTailored.skillGaps);
      pushDiff('优化建议', draft.suggestions, finalTailored.suggestions);
      const reviewNote = String(review?.reviewNote ?? '').trim() || undefined;
      revised = diffs.length || reviewNote ? { ...finalTailored, review: { diffs, note: reviewNote } } : finalTailored;
    } catch {
      /* review 失败不阻塞：沿用草稿 */
    }

    return {
      ...revised,
      match: buildMatch(tailoredTextForScore(revised)),
      method: 'ai',
    };
  } catch (error: any) {
    return localFallback(`AI 生成失败（${error?.message || '未知原因'}），已回退本地规则。`);
  }
}
