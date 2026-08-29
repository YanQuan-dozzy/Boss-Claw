// 本地确定性多维匹配引擎（不依赖 AI，免费、可复现、可解释）
// 对齐 GitHub 优秀项目的核心实践：
//   - ai-job-search (MadsLorentzen, 34k★)：多维匹配评估（技能/方向/地点/薪资/学历/经验）
//     + deal-breaker 硬否决（确定性硬约束，配置化，不依赖模型判断）
//   - Agentic-Career-Assistant：混合评分（精确技能重叠加权）+ 可解释匹配（评分分解展示）
//   - SkillFit-AI / JobMatch-AI：0-100 量化维度分 + 缺失技能如实标注
// 职责：analyzeJob 的本地兜底 / AI 分数校准 / UI 可解释维度；绝不生成任何简历事实（诚实规则）。
import type { AppConfig, JobMeta, Profile } from './types';
import { normalizeStringList, findDirectionRule, extractDegree } from './helpers';
import { keywordHit, extractJdKeywords } from './resumeMatch';
import { isCompanyExcluded } from './companyFilter';
import { isLocationExcluded } from './locationFilter';

// ===== 薪资区间解析（统一折算到「千元/月」）=====
// 与 priority.ts salaryPriority 的解析口径一致，但返回区间 [low, high] 供匹配分计算
export interface SalaryRange {
  low: number; // 千元/月
  high: number;
  daily: boolean; // 是否日薪口径
  valid: boolean; // 是否解析出有效区间
}

export function parseSalaryRange(salary: string | undefined | null): SalaryRange {
  const raw = String(salary || '').trim();
  if (!raw || /面议/.test(raw)) return { low: 0, high: 0, daily: false, valid: false };
  // 去掉「13薪/14薪/15薪」等年终奖月数，避免「13」被误当作薪资区间上限
  const cleaned = raw.replace(/[·*＊xX×\s]*1[2-8]\s*薪/g, '').trim();
  const daily = /\/\s*天|每\s*天|每天|\/\s*日|每\s*日/.test(cleaned);
  const nums = [...cleaned.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return { low: 0, high: 0, daily: false, valid: false };
  let low = nums[0];
  let high = nums.length >= 2 ? nums[1] : nums[0];
  if (low > high) [low, high] = [high, low];
  if (daily) {
    low = (low * 22) / 1000; // 元/天 → 千元/月（22 个工作日）
    high = (high * 22) / 1000;
  } else if (/万/.test(cleaned)) {
    low *= 10;
    high *= 10;
  } else if (/元\s*\/\s*月|元\s*每\s*月/.test(cleaned)) {
    low /= 1000;
    high /= 1000;
  } else if (!/[Kk]/.test(cleaned) && high > 200) {
    low /= 1000;
    high /= 1000; // 纯数字且偏大（如 15000-20000 元）→ 千元
  }
  return { low, high, daily, valid: true };
}

/** 解析期望薪资（画像 hardConstraints.salary，形如「15-25K」「1-2万」「不限」） */
function parseExpectedSalary(profile: Profile | null): SalaryRange {
  const raw = String(profile?.hardConstraints?.salary || '').trim();
  if (!raw || /不限|面议/.test(raw)) return { low: 0, high: 0, daily: false, valid: false };
  const parsed = parseSalaryRange(raw);
  return parsed;
}

// ===== 学历等级（用于「JD 要求学历 vs 画像学历」比较）=====
const DEGREE_LEVEL: Record<string, number> = { 不限: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 };

function degreeLevel(text: string): number {
  const t = String(text || '');
  if (/博士|ph\.?d/i.test(t)) return 4;
  if (/硕士|研究生|master/i.test(t)) return 3;
  if (/本科|学士|bachelor/i.test(t)) return 2;
  if (/大专|专科|associate/i.test(t)) return 1;
  return 0;
}

// ===== 经验年限提取 =====
/** 从「X-Y年」/「X年」/「在校/应届」解析经验年限下限；无法解析返回 null */
export function parseExperienceYears(text: string | undefined | null): number | null {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/在校|应届|无经验|不限/.test(t)) return 0;
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  return Math.min(...nums); // 取下限，保守判断
}

/** 从画像经历中提取总年限（多条经历年限之和的近似，按「X年」「X-Y年」解析） */
function profileExperienceYears(profile: Profile | null): number | null {
  if (!profile) return null;
  let total = 0;
  let found = false;
  for (const exp of profile.facts?.experiences || []) {
    const years = parseExperienceYears(String(exp));
    if (years != null) {
      total += years;
      found = true;
    }
  }
  if (found) return total;
  return parseExperienceYears(profile.hardConstraints?.experience);
}

/** 从 JD 文本提取要求的学历等级；未明确要求返回 null */
function jdRequiredDegreeLevel(job: JobMeta): number | null {
  const text = `${String(job.title || '')} ${String(job.description || '')} ${String(job.cardText || '')}`;
  const level = degreeLevel(text);
  if (level <= 0) return null; // 未明确要求
  // 「不限学历/学历不限」不构成要求
  if (/不限|以上|学历不限|无学历要求/.test(text) && !/本科及以上|硕士及以上|博士及以上/.test(text)) return null;
  return level;
}

/** 从 JD 文本提取要求的经验年限；未明确要求返回 null */
function jdRequiredExperienceYears(job: JobMeta): number | null {
  const text = `${String(job.title || '')} ${String(job.description || '')} ${String(job.cardText || '')}`;
  if (/经验不限|无经验要求|无要求/.test(text)) return 0;
  const years = parseExperienceYears(text);
  if (years == null) return null;
  // 仅当上下文确实是「经验要求」（如「3-5年经验」「5年以上」）才使用，避免误把「3-5人」当经验
  if (/(经验|工作年限|相关工作|从业)/.test(text)) return years;
  return null;
}

// ===== 岗位求职类型判定（实习/全职）=====
type JobEmploymentType = 'intern' | 'fulltime' | 'unknown';
function jobEmploymentType(job: JobMeta): JobEmploymentType {
  const text = `${String(job.title || '')} ${String(job.description || '')} ${String(job.cardText || '')}`;
  const intern = /实习/.test(text) && !/不招实习|无需实习/.test(text);
  const fulltime = /全职|社招/.test(text) || /正式员工|正式岗位/.test(text);
  if (intern && !fulltime) return 'intern';
  if (fulltime && !intern) return 'fulltime';
  return 'unknown';
}

// ===== 目标城市判定 =====
/** 地点是否可判定（远程/全国/不限 → 不可判定，不拦截） */
function isLocationDecidable(location: string | undefined | null): boolean {
  const loc = String(location || '').trim();
  if (!loc) return false;
  if (/远程|居家|全国|不限|多地|海外/.test(loc)) return false;
  return true;
}

// ===== 对外输出类型 =====
export interface LocalMatchDimensions {
  /** 技能匹配 0-100（画像技能在 JD 中的加权命中率）；信息不足为 null */
  skill: number | null;
  /** 方向匹配 0-100（岗位标题/描述 vs 画像方向/搜索词） */
  direction: number | null;
  /** 地点匹配 0-100（岗位地点 vs 目标城市） */
  location: number | null;
  /** 薪资匹配 0-100（JD 薪资 vs 期望薪资） */
  salary: number | null;
  /** 学历匹配 0-100（JD 要求 vs 画像学历） */
  education: number | null;
  /** 经验匹配 0-100（JD 要求 vs 画像经验） */
  experience: number | null;
  /** 本地加权综合分 0-100（各维度加权，null 维度剔除后重归一化）；信息不足为 null */
  overall: number | null;
  /** 维度计算的确定程度（0-1）：有实际命中的数据越多越可信，用于 AI 分校准的置信度 */
  confidence: number;
}

export interface LocalMatchResult {
  dimensions: LocalMatchDimensions;
  /** 本地确定性硬约束（deal-breaker）：任一项存在即应拦下（AI 分 ≤35 / decision=reject） */
  hardBlocks: string[];
  /** 本地命中的真实匹配点（技能/方向命中列表，可解释） */
  evidence: string[];
  /** 本地识别的缺口（JD 明确要求、画像词表未具备的关键词） */
  gaps: string[];
}

// ===== 核心：本地多维匹配 =====
export function computeLocalMatch(job: JobMeta, profile: Profile | null, config: Partial<AppConfig> = {}): LocalMatchResult {
  const hardBlocks: string[] = [];
  const evidence: string[] = [];
  const title = String(job.title || '');
  const desc = String(job.description || '');
  const jdText = `${title} ${desc} ${String(job.cardText || '')}`;

  // ---- 硬约束（deal-breaker，信息充分才拦截，避免误杀）----
  // 1. 城市反选（设置 → 求职偏好）
  if (isLocationExcluded(job.location, config as AppConfig)) {
    hardBlocks.push(`岗位地点「${String(job.location || '').trim()}」命中城市排除名单`);
  }
  // 2. 公司/招聘方黑名单
  const blacklist = isCompanyExcluded(job, config as AppConfig);
  if (blacklist.excluded) hardBlocks.push(blacklist.reason);
  // 3. 猎头岗位
  if (config.excludeHeadhunters && job.isHeadhunter) {
    hardBlocks.push('岗位为猎头代招，已按「排除猎头」设置拦截');
  }
  // 4. 目标城市不符（画像硬约束 locations 非空且可判定）
  const targetLocations = normalizeStringList(profile?.hardConstraints?.locations, 20);
  if (targetLocations.length && isLocationDecidable(job.location)) {
    const locText = String(job.location || '');
    const hit = targetLocations.some((city) => city && locText.includes(city));
    if (!hit) {
      hardBlocks.push(`岗位地点「${locText.trim()}」不在目标城市（${targetLocations.slice(0, 4).join('、')}）`);
    }
  }
  // 5. 求职类型冲突（实习/全职，仅明确信号且冲突才拦）
  const empTypes = normalizeStringList(profile?.hardConstraints?.employmentTypes, 10);
  const wantIntern = empTypes.some((t) => t === '实习' || t === '校招');
  const wantFulltime = empTypes.some((t) => t === '全职' || t === '社招');
  const jobType = jobEmploymentType(job);
  if (jobType === 'fulltime' && wantIntern && !wantFulltime) {
    hardBlocks.push('岗位为全职/社招，与画像「仅实习/校招」的求职类型冲突');
  }
  if (jobType === 'intern' && wantFulltime && !wantIntern) {
    hardBlocks.push('岗位为实习，与画像「全职」的求职类型冲突');
  }
  // 6. 学历不足（JD 明确要求更高学历）
  const requiredDegree = jdRequiredDegreeLevel(job);
  const profileDegreeLevel = degreeLevel(profile?.hardConstraints?.degree || extractDegree(JSON.stringify(profile?.facts || {})));
  if (requiredDegree != null && profileDegreeLevel > 0 && requiredDegree > profileDegreeLevel) {
    hardBlocks.push(`岗位要求学历不低于「${levelName(requiredDegree)}」，画像学历为「${profile?.hardConstraints?.degree || levelName(profileDegreeLevel)}」`);
  }
  // 7. 经验不足（JD 明确要求年限高于画像）
  const requiredYears = jdRequiredExperienceYears(job);
  const profileYears = profileExperienceYears(profile);
  if (requiredYears != null && profileYears != null && requiredYears > profileYears && requiredYears - profileYears >= 1) {
    hardBlocks.push(`岗位要求约 ${requiredYears} 年经验，画像经历合计约 ${profileYears} 年`);
  }
  // 8. 外部网申（对齐 job-priority 的 -6000 口径，提升为硬拦截）
  if (/外部网申|立即网申|去网申/.test(`${job.applicationMode || ''} ${job.cardText || ''}`)) {
    hardBlocks.push('岗位为外部网申，需跳转第三方系统，不纳入投递队列');
  }
  // 9. 面试方式冲突（设置 → 仅线上/仅线下）
  const imFilter = config?.interviewModeFilter || 'any';
  if (imFilter !== 'any') {
    const mode = job.interviewMode || 'unknown';
    if (mode !== 'unknown' && mode !== imFilter) {
      const required = mode === 'offline' ? '线下' : '线上';
      const wanted = imFilter === 'online' ? '线上' : '线下';
      hardBlocks.push(`岗位要求${required}面试，与设定的「仅${wanted}」冲突`);
    }
  }

  // ---- 技能匹配（加权命中率：核心技能 ×3，方向相关技能 ×1）----
  const coreSkills = normalizeStringList(profile?.facts?.skills, 30).map((s) => String(s).trim());
  const directionSkills: string[] = [];
  for (const dir of normalizeStringList(profile?.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)), 8)) {
    const rule = findDirectionRule(String(dir));
    if (rule?.relevantSkills) directionSkills.push(...rule.relevantSkills);
  }
  const seenSkill = new Set<string>();
  const skillPool: { term: string; weight: number }[] = [];
  for (const s of coreSkills) {
    if (s.length >= 2 && !seenSkill.has(s.toLowerCase())) {
      seenSkill.add(s.toLowerCase());
      skillPool.push({ term: s, weight: 3 });
    }
  }
  for (const s of directionSkills) {
    if (s.length >= 2 && !seenSkill.has(s.toLowerCase())) {
      seenSkill.add(s.toLowerCase());
      skillPool.push({ term: s, weight: 1 });
    }
  }
  let skillScore: number | null = null;
  if (skillPool.length) {
    let hitWeight = 0;
    let totalWeight = 0;
    const hitTerms: string[] = [];
    for (const { term, weight } of skillPool) {
      totalWeight += weight;
      if (keywordHit(term, jdText)) {
        hitWeight += weight;
        hitTerms.push(term);
      }
    }
    skillScore = totalWeight ? Math.round((hitWeight / totalWeight) * 100) : 0;
    if (hitTerms.length) evidence.push(`技能命中：${hitTerms.slice(0, 8).join('、')}`);
    if (skillScore >= 60) evidence.push(`技能匹配度 ${skillScore}%`);
  }

  // ---- 方向匹配（标题/描述 vs 画像方向 + 方向目录 + 搜索词）----
  const directions = normalizeStringList(profile?.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)), 8).map((d) => String(d));
  const keywords = (profile?.searchKeywords || []).map((k) => String(k));
  let directionScore: number | null = null;
  if (directions.length || keywords.length) {
    let hits = 0;
    let total = 0;
    // 方向名：归一化后互相包含 → 强信号（标题命中 100 / 描述命中 70）
    for (const dir of directions) {
      const dirKey = normalizeDirectionKeyForMatch(dir);
      if (!dirKey) continue;
      total += 3;
      if (dirKey.length >= 2 && (title.includes(dirKey) || dirKey.includes(normalizeDirectionKeyForMatch(title)))) {
        hits += 3;
        evidence.push(`方向命中：岗位「${title.trim() || '未知'}」匹配方向「${dir}」`);
      } else if (dirKey.length >= 2 && desc.includes(dirKey)) {
        hits += 2;
      } else {
        // 方向目录规则兜底：规则 test 正则命中岗位文本（如「AI 应用开发」方向命中「大模型应用工程师」）
        const rule = findDirectionRule(dir);
        if (rule && rule.test.test(jdText)) {
          hits += 2.5;
          evidence.push(`方向近似：岗位内容符合「${dir}」方向`);
        }
      }
    }
    // 搜索词：标题命中强、描述命中弱
    for (const kw of keywords) {
      const k = String(kw).trim();
      if (!k || k.length < 2) continue;
      total += 1;
      if (keywordHit(k, title)) {
        hits += 1;
        evidence.push(`关键词命中：岗位标题包含「${k}」`);
      } else if (keywordHit(k, desc)) {
        hits += 0.5;
      }
    }
    directionScore = total ? Math.round((hits / total) * 100) : null;
  }

  // ---- 地点匹配 ----
  let locationScore: number | null = null;
  if (isLocationDecidable(job.location) && targetLocations.length) {
    const locText = String(job.location || '');
    const hit = targetLocations.some((city) => city && locText.includes(city));
    locationScore = hit ? 100 : 0;
    if (hit) evidence.push(`地点命中：${locText.trim()} 在目标城市内`);
  } else if (targetLocations.length) {
    locationScore = 55; // 远程/未识别：中性
  }

  // ---- 薪资匹配 ----
  let salaryScore: number | null = null;
  const expected = parseExpectedSalary(profile);
  const jdRange = parseSalaryRange(job.salary);
  if (jdRange.valid && expected.valid) {
    // 重合度：期望区间与 JD 区间的重叠长度 / 期望区间长度（截断到 0-100）
    const overlap = Math.max(0, Math.min(jdRange.high, expected.high) - Math.max(jdRange.low, expected.low));
    const expSpan = Math.max(1, expected.high - expected.low);
    salaryScore = Math.round(Math.min(100, (overlap / expSpan) * 100 + 55));
  } else if (jdRange.valid && !expected.valid) {
    salaryScore = 65; // 画像未设定期望薪资：中性偏正
  } else {
    salaryScore = 55; // JD 面议/未识别：中性
  }

  // ---- 学历匹配 ----
  let educationScore: number | null = null;
  if (requiredDegree != null) {
    educationScore = profileDegreeLevel >= requiredDegree ? 100 : 30;
  } else {
    educationScore = 60; // JD 未明确要求学历：中性
  }

  // ---- 经验匹配 ----
  let experienceScore: number | null = null;
  if (requiredYears != null && profileYears != null) {
    if (profileYears >= requiredYears) experienceScore = 100;
    else if (profileYears >= requiredYears * 0.6) experienceScore = 70;
    else experienceScore = 40;
  } else {
    experienceScore = 60; // 未明确要求：中性
  }

  // ---- 加权综合分（null 维度剔除后重归一化）----
  const WEIGHTS: [keyof LocalMatchDimensions, number][] = [
    ['skill', 0.32],
    ['direction', 0.28],
    ['location', 0.14],
    ['salary', 0.1],
    ['education', 0.08],
    ['experience', 0.08],
  ];
  let weightedSum = 0;
  let weightTotal = 0;
  let scoredCount = 0;
  for (const [key, w] of WEIGHTS) {
    const v = (() => {
      const dim = key as keyof LocalMatchDimensions;
      return dim === 'skill' ? skillScore : dim === 'direction' ? directionScore : dim === 'location' ? locationScore : dim === 'salary' ? salaryScore : dim === 'education' ? educationScore : experienceScore;
    })();
    if (v != null) {
      weightedSum += v * w;
      weightTotal += w;
      scoredCount += 1;
    }
  }
  const overall = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
  const confidence = scoredCount >= 4 ? 0.9 : scoredCount >= 3 ? 0.7 : scoredCount >= 2 ? 0.5 : 0.3;

  // ---- 缺口（JD 明确要求、画像词表未具备的关键词，如实标注不灌水）----
  const gaps: string[] = [];
  if (desc) {
    const { keywords: jdKeywords } = extractJdKeywords(jdText, profile);
    const profileBlob = JSON.stringify({
      facts: profile?.facts || {},
      searchKeywords: profile?.searchKeywords || [],
      primaryDirections: profile?.primaryDirections || [],
      hardConstraints: profile?.hardConstraints || {},
    });
    const missing = jdKeywords.filter((k) => !keywordHit(k, profileBlob)).slice(0, 8);
    if (missing.length) gaps.push(`岗位要求画像未具备：${missing.join('、')}`);
  }

  return {
    dimensions: { skill: skillScore, direction: directionScore, location: locationScore, salary: salaryScore, education: educationScore, experience: experienceScore, overall, confidence },
    hardBlocks,
    evidence,
    gaps,
  };
}

function levelName(level: number): string {
  return Object.entries(DEGREE_LEVEL).find(([, v]) => v === level)?.[0] || '不限';
}

/** 方向归一化（岗位标题/方向名的可比较键） */
function normalizeDirectionKeyForMatch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/实习生|实习|工程师|开发|岗位|职位|校招|社招|应届/g, '')
    .replace(/[\s,，/\\|·•()（）【】\[\]_-]+/g, '')
    .trim();
}

// ===== 旧本地兜底兼容：在 localMatchScore 之上的增强版（供 AI 分缺失时使用）=====
// 保留 matching.ts 的 localMatchScore 入口语义：profile 缺失时返回 null（调用方按 0 处理）
export function enhancedLocalScore(job: JobMeta, profile: Profile | null, config: Partial<AppConfig> = {}): number | null {
  if (!profile) return null;
  const local = computeLocalMatch(job, profile, config);
  if (local.hardBlocks.length) return Math.min(local.dimensions.overall ?? 0, 35);
  return local.dimensions.overall;
}
