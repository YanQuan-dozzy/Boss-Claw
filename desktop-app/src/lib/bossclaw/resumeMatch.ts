// 简历 × JD 匹配分析（确定性本地算法，不依赖 AI）
// 参考 GitHub 开源项目 Resume-Matcher / Resume Architect / Resume-Customizer / ai-resume-tailor 的最佳实践：
//   - 关键词覆盖率分析（已覆盖 / 画像有简历缺 / 完全缺失 三层判定）
//   - 匹配评分（定制前 vs 定制后，揭示定制带来的提升）
// 全部本地计算：免费、确定性、可解释；AI 只负责内容生成，评分与分析永远可复现。
// 安全不变量：本模块只做「比对与提示」，绝不生成任何简历事实。
import type { Profile } from './types';
import { normalizeStringList } from './helpers';

// ===== JD 英文停用词：高频功能词 / 无信息量的通用词 =====
// 过滤后剩余的英文 token 多为技术栈、工具、领域术语（React / Python / Docker / 数据清洗等）
const JD_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'of', 'to', 'in', 'on', 'at', 'by', 'from', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'am', 'you', 'your', 'yours', 'our', 'ours', 'we', 'us', 'will', 'would',
  'can', 'could', 'should', 'must', 'may', 'might', 'shall', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no',
  'this', 'that', 'these', 'those', 'it', 'its', 'them', 'they', 'he', 'she', 'his', 'her', 'their', 'what', 'which',
  'who', 'whom', 'whose', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'than', 'then', 'when', 'where', 'why', 'how', 'about', 'above', 'below', 'between', 'during',
  'after', 'before', 'under', 'over', 'through', 'into', 'out', 'up', 'down', 'off', 'against', 'upon',
  'work', 'works', 'working', 'job', 'jobs', 'position', 'positions', 'role', 'roles', 'experience', 'experiences',
  'skill', 'skills', 'ability', 'abilities', 'responsibility', 'responsibilities', 'requirement', 'requirements',
  'require', 'requires', 'required', 'qualification', 'qualifications', 'candidate', 'candidates', 'applicant',
  'applicants', 'team', 'company', 'business', 'project', 'projects', 'product', 'products', 'excellent', 'good',
  'strong', 'solid', 'able', 'prefer', 'preferred', 'plus', 'including', 'include', 'includes', 'etc', 'day',
  'days', 'year', 'years', 'month', 'months', 'hour', 'hours', 'per', 'every', 'within', 'related', 'relevant',
  'prior', 'previous', 'full', 'time', 'part', 'remote', 'onsite', 'office', 'base', 'based', 'location',
  'salary', 'competitive', 'benefit', 'benefits', 'function', 'functions', 'field', 'fields', 'area', 'areas',
  'level', 'senior', 'junior', 'mid', 'entry', 'lead', 'leading', 'new', 'high', 'low', 'large', 'small',
  'various', 'multiple', 'different', 'other', 'one', 'two', 'three', 'using', 'used', 'use', 'usage',
  'development', 'develop', 'developer', 'developers', 'design', 'designer', 'designers', 'manage', 'management',
  'manager', 'support', 'analysis', 'analyze', 'implementation', 'implement', 'maintain', 'maintenance',
  'knowledge', 'familiar', 'familiarity', 'understanding', 'understand', 'experiencewith', 'goodat', 'proficient',
]);

// 无信息量的通用英文 token（域名/链接等）
const JD_NOISE_TOKENS = /^(?:https?|www|com|org|net|cn|io|html|css|js|ts)$/i;

/** 词边界命中（纯英文/数字词；中文用子串匹配，避免 Java 误命中 JavaScript） */
export function keywordHit(keyword: string, text: string): boolean {
  const k = String(keyword || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!k) return false;
  if (/^[\x00-\x7F]+$/.test(k)) {
    return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
  }
  return t.includes(k);
}

/** 画像贡献词（技能/搜索词/方向），作为中文关键词与高权重词来源 */
function profileTermSource(profile: Profile | null): string[] {
  if (!profile) return [];
  return normalizeStringList(profile.facts?.skills, 30)
    .concat(profile.searchKeywords || [])
    .concat(normalizeStringList(profile.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)), 8))
    .filter((t) => String(t || '').length >= 2);
}

/**
 * 从 JD 提取关键词集合（≤40 个，去重）：
 *   - 英文技术/领域词（regex 抽取 + 停用词过滤）；
 *   - 画像词表（技能/搜索词/方向，含中文）中在 JD 出现的词——高权重（真实技能）。
 * 返回 { keywords, weights } 便于评分时加权。
 */
export function extractJdKeywords(jd: string, profile: Profile | null): { keywords: string[]; weights: number[] } {
  const source = String(jd || '');
  const pool = new Map<string, number>(); // key=小写，value=权重
  // 1. 英文 token：从 JD 抽取，权重 1
  for (const m of source.matchAll(/[A-Za-z][A-Za-z0-9+#.\-]{1,29}/g)) {
    const token = m[0];
    if (JD_STOPWORDS.has(token.toLowerCase()) || JD_NOISE_TOKENS.test(token)) continue;
    const key = token.toLowerCase();
    pool.set(key, Math.max(pool.get(key) || 0, 1));
  }
  // 2. 画像词表：在 JD 中出现的技能/方向词，权重 3（真实技能命中价值最高）
  for (const term of profileTermSource(profile)) {
    const t = String(term || '').trim();
    if (!t) continue;
    if (keywordHit(t, source)) {
      const key = t.toLowerCase();
      pool.set(key, Math.max(pool.get(key) || 0, 3));
    }
  }
  const entries = [...pool.entries()];
  // 稳定排序：权重降序 → 原长度降序（长词更有信息量），再按字典序保证确定性
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  // 保留原始大小写用于展示：从 JD / 画像词表中取第一个匹配的原始形式
  const keywords: string[] = [];
  const weights: number[] = [];
  for (const [key, weight] of entries.slice(0, 40)) {
    let original = key;
    const rawMatch = source.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (rawMatch) original = rawMatch[0];
    keywords.push(original);
    weights.push(weight);
  }
  return { keywords, weights };
}

export interface MatchScore {
  /** 0-100 匹配分 */
  score: number;
  /** 命中关键词数 */
  coverage: number;
  /** 关键词总数 */
  total: number;
  /** 覆盖率 0-100 */
  coverageRatio: number;
}

/**
 * 计算一段文本对关键词集合的加权匹配分。
 * 权重：画像词表词 ×3，普通英文词 ×1；score = 加权命中 / 加权总数 × 100，
 * 覆盖率 <30% 时额外压低（区分「差」与「中」），≥85% 封顶 100。
 */
export function computeMatchScore(keywords: string[], weights: number[], text: string): MatchScore {
  const total = keywords.length;
  if (!total) {
    return { score: 0, coverage: 0, total: 0, coverageRatio: 0 };
  }
  let hitWeight = 0;
  let totalWeight = 0;
  let coverage = 0;
  for (let i = 0; i < keywords.length; i++) {
    const w = weights[i] || 1;
    totalWeight += w;
    if (keywordHit(keywords[i], text)) {
      hitWeight += w;
      coverage += 1;
    }
  }
  const coverageRatio = Math.round((coverage / total) * 100);
  let score = totalWeight ? Math.round((hitWeight / totalWeight) * 100) : 0;
  if (coverageRatio < 30) score = Math.round(score * 0.5);
  return {
    score: Math.max(0, Math.min(100, score)),
    coverage,
    total,
    coverageRatio,
  };
}

export interface JdKeywordAnalysis {
  /** JD 要求、简历原文已体现（最佳，保持即可） */
  coveredInResume: string[];
  /** JD 要求、简历原文未体现但画像具备（建议把画像技能/经历写进简历） */
  missingInResumeButInProfile: string[];
  /** JD 要求、简历与画像均未体现（真实缺口，如实提示） */
  completelyMissing: string[];
}

/** 三层比对：JD 关键词 → 简历原文 / 画像 / 都没。可传入已提取的关键词避免重复计算。 */
export function analyzeJdKeywords(
  jd: string,
  resumeText: string,
  profile: Profile | null,
  preExtracted?: string[]
): JdKeywordAnalysis {
  const keywords = preExtracted && preExtracted.length ? preExtracted : extractJdKeywords(jd, profile).keywords;
  const resume = String(resumeText || '');
  const profileBlob = JSON.stringify({
    facts: profile?.facts || {},
    searchKeywords: profile?.searchKeywords || [],
    primaryDirections: profile?.primaryDirections || [],
  });
  const analysis: JdKeywordAnalysis = { coveredInResume: [], missingInResumeButInProfile: [], completelyMissing: [] };
  for (const k of keywords) {
    if (keywordHit(k, resume)) {
      analysis.coveredInResume.push(k);
    } else if (keywordHit(k, profileBlob)) {
      analysis.missingInResumeButInProfile.push(k);
    } else {
      analysis.completelyMissing.push(k);
    }
  }
  return analysis;
}

/** 用于定制后评分的文本（定制输出内容） */
export function tailoredTextForScore(tailored: { tailoredSummary?: string; tailoredExperiences?: string[]; highlightedSkills?: string[] }): string {
  return [
    String(tailored?.tailoredSummary || ''),
    ...(Array.isArray(tailored?.tailoredExperiences) ? tailored.tailoredExperiences : []),
    ...(Array.isArray(tailored?.highlightedSkills) ? tailored.highlightedSkills : []),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 本地优化建议兜底（基于关键词三层分析的确定性建议，AI 不可用时使用）。
 * 参考 Resume-Matcher 的「指导性改进」：给出可执行的补强动作，不编造事实。
 */
export function buildLocalSuggestions(analysis: JdKeywordAnalysis, jd: string, hasQuantifiedResume: boolean): string[] {
  const suggestions: string[] = [];
  if (analysis.missingInResumeButInProfile.length) {
    suggestions.push(
      `简历未体现但职业画像具备的技能：${analysis.missingInResumeButInProfile.slice(0, 6).join('、')}。建议在简历的「技能/项目」中补充这些能力的落地场景（只写真实做过的）。`
    );
  }
  if (analysis.completelyMissing.length) {
    suggestions.push(
      `岗位要求但简历与画像均未体现：${analysis.completelyMissing.slice(0, 6).join('、')}。请评估是补齐学习、在求职信如实说明，还是放弃该岗位。`
    );
  }
  if (analysis.coveredInResume.length && !suggestions.length) {
    suggestions.push('简历对岗位关键词覆盖良好，可进一步将最相关的 1-2 个项目在摘要中前置，强化第一印象。');
  }
  if (/量化|指标|数据|增长|提升|优化|效率|业绩|成果/i.test(String(jd || '')) && !hasQuantifiedResume) {
    suggestions.push('岗位强调量化成果，而简历经历缺少数字。建议为真实经历补充量化描述（如规模、时长、效率提升），严禁编造数据。');
  }
  if (!suggestions.length) {
    suggestions.push('建议在求职信中明确点出与岗位最匹配的 1-2 项真实技能或项目，并说明加入意愿。');
  }
  return suggestions.slice(0, 5);
}

/** 判断简历经历中是否已有量化表达（数字 + 单位，如 3 年 / 50 万用户 / 提升 20% / 首屏 1.2 秒 / 20+ 个组件） */
export function resumeHasQuantifiedEvidence(resumeText: string): boolean {
  return /\d+\s*[+~至\-]?\s*(年|个月|月|天|小时|时|分钟|分|秒|毫秒|万|千|亿|%|人|个|次|篇|项|条|单|台|家|倍|MB|GB|TB|QPS)/i.test(
    String(resumeText || '')
  );
}
