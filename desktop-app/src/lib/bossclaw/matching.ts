// 移植自 F:\job-claw-main\source\src\background.js 的岗位匹配与沟通草稿逻辑
import type { AppConfig, JobAnalysis, JobMeta, Profile } from './types';
import { normalizeStringList } from './helpers';
import { callModel } from './llm';
import { buildAnalyzeSystemPrompt } from './prompts';
import { detectInterviewMode } from './interviewMode';

// 本地确定性匹配分（0-100）：基于岗位标题+描述的文本与画像技能/搜索词/方向的命中。
// 标题命中是强信号（岗位方向核心在标题），描述命中是弱信号；映射到 0-100，供 AI 分轻微平滑兜底。
export function localMatchScore(job: JobMeta, profile: Profile | null): number | null {
  if (!profile) return null;
  const title = String(job.title || '').toLowerCase();
  const desc = String(job.description || '').toLowerCase();
  const skills = normalizeStringList(profile.facts?.skills, 30).map((s) => s.toLowerCase());
  const keywords = (profile.searchKeywords || []).map((k) => String(k).toLowerCase());
  const directions = normalizeStringList(
    profile.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)),
    8
  ).map((s) => String(s || '').toLowerCase());
  const terms = [...new Set([...skills, ...keywords, ...directions].filter((t) => t.length >= 2))];
  if (!terms.length) return null;
  const hit = (term: string, text: string): boolean => {
    // 纯英文/数字词用词边界匹配（避免 Java 误命中 JavaScript），中文用子串匹配
    if (/^[\x00-\x7F]+$/.test(term)) {
      return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    }
    return text.includes(term);
  };
  const titleHits = terms.filter((t) => hit(t, title)).length;
  const descHits = terms.filter((t) => hit(t, desc)).length;
  if (!titleHits && !descHits) return 0;
  // 标题命中权重 ×3，描述命中 ×1；以「前 8 个核心词全部命中标题」为满分基准，映射到 0-100
  const weighted = titleHits * 3 + descHits;
  const full = Math.max(1, Math.min(terms.length, 8) * 3);
  return Math.max(0, Math.min(100, Math.round((weighted / full) * 100)));
}

export function fallbackApplicantGreeting(job: JobMeta, profile: Profile | null): string {
  const title = String(job?.title || '该岗位').trim();
  const skills = normalizeStringList(profile?.facts?.skills, 4);
  const education = normalizeStringList(profile?.facts?.education, 1);
  const direction = normalizeStringList(profile?.primaryDirections?.map((item) => (typeof item === 'string' ? item : item?.name)), 2);
  const identity = education[0] || '';
  const evidence = skills.length ? `熟悉${skills.slice(0, 3).join('、')}，有相关项目实践` : (profile?.summary || direction.join('、'));
  const parts = [`您好，我想应聘贵公司的${title}岗位。`];
  if (identity) parts.push(`我是${identity}，`);
  if (evidence) parts.push(`${evidence}。`);
  parts.push('对该岗位的工作内容很感兴趣，希望有机会进一步沟通，谢谢。');
  return parts.join('').replace(/。{2,}/g, '。').slice(0, 200);
}

// 岗位视图净化：只把匹配分析真正需要的字段交给 AI。
// 剥离 hrActive / cardText / chatUrl 等字段——招聘方在线状态只用于展示与用户设置的活跃度过滤，
// 绝不能成为 AI 的推荐理由；cardText 整页文本里的「在线/刚刚活跃」字样同样会误导 AI。
function aiJobView(job: JobMeta): Record<string, unknown> {
  return {
    title: job.title,
    company: job.company,
    salary: job.salary,
    location: job.location,
    description: job.description,
    jobId: job.jobId,
  };
}

export function normalizeApplicantGreeting(result: any, job: JobMeta, profile: Profile | null): string {
  const raw = String(result?.greeting || '').trim();
  // 反向过滤：明确是招聘方口吻的招呼语（如"看到你的简历""欢迎进一步沟通""我们团队""候选人"等），
  // 一律用本地模板兜底——对齐 AGENTS.md 安全不变量（不得让 AI 用招聘方语气联系招聘方）。
  const reversed = /看到你的简历|你的简历|很匹配我们|匹配我们|欢迎.*进一步沟通|期待你加入我们|候选人|我们团队|我们公司|我们这边|团队主要涉及|你很匹配|方便的话来聊聊|期待与你/i.test(raw);
  // 求职者口吻校验放宽：覆盖"我想应聘/我希望应聘/我对...岗位...感兴趣/想进一步了解/
  // 希望进一步沟通/希望和您聊聊/对该岗位感兴趣/我对...感兴趣/期望加入/可到岗/可实习"
  // 等常见自然表达。LLM 不一定严格遵守 prompt 的"以"我想应聘"开头"，只要不是招聘方口吻即可放行。
  const applicantVoice = /我想应聘|我希望应聘|我对.{0,30}(岗位|职位|这份|这个|该).{0,15}(感兴趣|有兴趣)|我对.{0,30}(感兴趣|有兴趣)|想进一步了解|希望进一步沟通|希望和您(聊聊|沟通|交流)|希望加入|对该.{0,10}感兴趣|期望加入|期待加入|期望.{0,5}加入.{0,8}贵公司|我.{0,5}(适合|符合|胜任)|可实习|可到岗|面试.{0,5}到岗|期待.{0,5}(回复|联系|沟通)/.test(raw);
  if (!raw || reversed || !applicantVoice) return fallbackApplicantGreeting(job, profile);
  // 关键：AI 生成的打招呼语常含换行/制表符（LLM 输出习惯分段）。
  // BOSS 聊天框按 Enter 发送，多行文本会导致「只发前半句 / 发送被拒 / 气泡确认失败」。
  // 统一压成单行（与 greetings.ts normalizeGreetingText 口径一致），再截断。
  return raw.replace(/\s+/g, ' ').slice(0, 220);
}

export async function analyzeJob(
  job: JobMeta,
  profile: Profile | null,
  resumeText: string,
  config: AppConfig,
  model: AppConfig['model'],
  customGreetingPrompt?: string
): Promise<JobAnalysis> {
  if (!profile) throw new Error('请先生成职业画像');
  const systemPrompt = buildAnalyzeSystemPrompt(customGreetingPrompt);
  const result: any = await callModel(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `职业画像：${JSON.stringify(profile)}
简历：${String(resumeText || '').slice(0, 15000)}
岗位：${JSON.stringify(aiJobView(job))}`,
        },
      ],
      model
    );
  result.greeting = normalizeApplicantGreeting(result, job, profile);
  if (Array.isArray(result.hardBlocks) && result.hardBlocks.length) result.decision = 'reject';
  // 打分稳定性：AI 分主导且以 AI 分为准，本地确定性命中不再做线性混合——
  // 混合会把高分岗位拉低、造成「60 分扎堆」的趋中效应；local 仅在 AI 未给出有效分数时兜底。
  const aiScore = Number(result.score);
  const local = localMatchScore(job, profile);
  let score: number;
  if (Number.isFinite(aiScore)) {
    score = Math.max(0, Math.min(100, aiScore));
  } else {
    // AI 未给出有效分数时，用本地命中率兜底（避免所有岗位都是 0 分）
    score = local != null ? local : 0;
  }
  // 硬性条件不满足（学历/经验/地点等）→ 强制低分，避免 AI 给了高分但存在硬伤
  if (Array.isArray(result.hardBlocks) && result.hardBlocks.length) {
    score = Math.min(score, 35);
  }
  // 分数与决策档位确定性对齐：消灭「recommend 却 60 分」的模糊中间态，拉开评分梯度
  if (result.decision === 'recommend') score = Math.max(score, 80);
  else if (result.decision === 'cautious') score = Math.min(score, 74);
  else if (result.decision === 'reject') score = Math.min(score, 35);
  result.score = Math.max(0, Math.min(100, score));
  if (result.score < Number(config?.minScore ?? 75) && result.decision === 'recommend') {
    result.decision = 'cautious';
  }
  // 面试方式筛选（用户设定「仅线上 / 仅线下」时）：岗位实际面试方式与设定冲突，
  // 直接在匹配分中扣除，使其低于最低分被排除——
  // 对齐用户需求：设定「仅线上」时，要求线下面试的岗位不应继续留在候选列表中。
  // 仅当岗位文本明确出现线上/线下信号、且与设定冲突时才扣（未识别不误杀）。
  const imFilter = config?.interviewModeFilter || 'any';
  if (imFilter !== 'any') {
    const mode = detectInterviewMode(job);
    if (mode !== 'unknown' && mode !== imFilter) {
      const required = mode === 'offline' ? '线下' : '线上';
      const wanted = imFilter === 'online' ? '线上' : '线下';
      // 扣除足够分数（封顶 100），确保低于任何最低分阈值被排除
      result.score = Math.max(0, result.score - 1000);
      result.reason = `${result.reason ? String(result.reason).trim() + ' ' : ''}【面试方式不符】岗位要求${required}面试，与设定的「仅${wanted}」冲突，匹配分已扣除。`;
      if (result.decision === 'recommend') result.decision = 'cautious';
    }
  }
  return result as JobAnalysis;
}
