// 本地确定性多维匹配引擎（不依赖 AI，免费、可复现、可解释）
// 对齐 GitHub 优秀项目的核心实践：
//   - ai-job-search (MadsLorentzen, 34k★)：多维匹配评估（技能/方向/地点/薪资/学历）
//     + deal-breaker 硬否决（确定性硬约束，配置化，不依赖模型判断）
//   - Agentic-Career-Assistant：混合评分（精确技能重叠加权）+ 可解释匹配（评分分解展示）
//   - SkillFit-AI / JobMatch-AI：0-100 量化维度分 + 缺失技能如实标注
// 经验维度不在本地计算（交给 AI 五维评估），见下方「经验：本地不再计算」口径说明。
// 职责：analyzeJob 的本地兜底 / AI 分数校准 / UI 可解释维度；绝不生成任何简历事实（诚实规则）。
import type { AppConfig, JobMeta, Profile } from './types';
import { normalizeStringList, findDirectionRule } from './helpers';
import { HARD_BLOCK_SCORE_CAP } from './fitLevel';
import { keywordHit, extractJdKeywords } from './resumeMatch';
import { isNonSkillJdToken, equivalentSkillKeys, coveringSkillKeys, skillKeysInText, extractEnglishTokens, zhAliasCoversTerm } from './skillTaxonomy';
import { isCompanyExcluded } from './companyFilter';
import { isLocationExcluded } from './locationFilter';
import { detectInterviewMode } from './interviewMode';
import { decodeSalaryDigits } from './jobDisplay';
import {
  detectWorkSchedule,
  monthlyWorkDaysOf,
  DEFAULT_WEEKLY_DAYS,
  dailyToMonthlyK,
  hourlyToMonthlyK,
  scheduleBasisText,
} from './workSchedule';
import type { WorkSchedule } from './workSchedule';

// ===== 薪资区间解析（统一折算到「千元/月」，唯一实现；priority.salaryPriority 与本文件共用）=====
// 单位必须与数字「成对」解析（审查 P3-02/P3-04：曾把「8千-1.2万」错算成 12~80 K/月，真实 8~12K）。
// 日薪/时薪折算的月工作日基数由调用方按工作制度传入（双休 22 / 大小周 24 / 单休 26，见 workSchedule.ts）。
export interface SalaryRange {
  low: number; // 千元/月
  high: number;
  daily: boolean; // 是否日薪口径
  hourly: boolean; // 是否时薪口径
  valid: boolean; // 是否解析出有效区间
}

type SalarySeg = { value: number; unit: '万' | '千' | 'k' | '' };
const SEGMENT_RE = /(\d+(?:\.\d+)?)\s*(万|千|[Kk])?/g;
// 年薪口径：串里出现「年薪/年包/每年/万/年」等（「13薪」已在上游清洗，不会误伤）
const ANNUAL_RE = /年薪|年包|每年|万\s*[-\/]\s*年|[-\/]\s*年/;

/** 把「数字 + 可选单位」逐段解析；单位缺失的段继承最近的显式单位（前向优先）：「1.5-2万」→ 1.5 继承 万。 */
function parseSalarySegments(cleaned: string): SalarySeg[] | null {
  const segs: SalarySeg[] = [];
  let m: RegExpExecArray | null;
  while ((m = SEGMENT_RE.exec(cleaned))) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    segs.push({ value, unit: (m[2] || '') as SalarySeg['unit'] });
  }
  if (!segs.length) return null;
  const n = segs.length;
  for (let i = 0; i < n; i++) {
    if (segs[i].unit !== '') continue;
    let unit: SalarySeg['unit'] = '';
    for (let j = i + 1; j < n; j++) if (segs[j].unit !== '') { unit = segs[j].unit; break; }
    if (!unit) for (let j = i - 1; j >= 0; j--) if (segs[j].unit !== '') { unit = segs[j].unit; break; }
    segs[i].unit = unit;
  }
  return segs;
}

export function parseSalaryRange(
  salary: string | undefined | null,
  monthlyWorkDays = monthlyWorkDaysOf(DEFAULT_WEEKLY_DAYS)
): SalaryRange {
  const invalid: SalaryRange = { low: 0, high: 0, daily: false, hourly: false, valid: false };
  // 先还原平台字体混淆（BOSS 把薪资数字映射到 Unicode 私有区），否则一律落到「未识别」
  const raw = decodeSalaryDigits(String(salary || '')).trim();
  if (!raw || /面议/.test(raw)) return invalid;
  // 去掉「13薪/14薪/15薪」等年终奖月数，避免「13」被误当作薪资区间上限
  const cleaned = raw.replace(/[·*＊xX×\s]*1[2-8]\s*薪/g, '').trim();
  const hourly = /\/\s*(?:小时|时)|每\s*(?:小时|时)|时薪/.test(cleaned);
  const daily = !hourly && /\/\s*天|每\s*天|每天|\/\s*日|每\s*日|日薪|按天结算/.test(cleaned);
  const segs = parseSalarySegments(cleaned);
  if (!segs) return invalid;
  // 日薪/时薪：数字不做「万/千」缩放（段值即元/小时、元/天）
  const values = segs.map((s) => s.value);
  let low: number;
  let high: number;
  if (hourly) {
    low = hourlyToMonthlyK(values[0], monthlyWorkDays); // 元/小时 → 千元/月（8 小时/天 × 月工作日）
    high = hourlyToMonthlyK(values.length >= 2 ? values[1] : values[0], monthlyWorkDays);
    return { low, high, daily: false, hourly: true, valid: true };
  }
  if (daily) {
    low = dailyToMonthlyK(values[0], monthlyWorkDays); // 元/天 → 千元/月（月工作日按工作制度取 22/24/26…）
    high = dailyToMonthlyK(values.length >= 2 ? values[1] : values[0], monthlyWorkDays);
    return { low, high, daily: true, hourly: false, valid: true };
  }
  // 月薪/年薪口径：单位随数字走（万 → ×10 千元；千/K → ×1；无单位段已继承最近单位）；年薪 ÷12
  const yearly = ANNUAL_RE.test(cleaned);
  const ks = segs.map((s) => (s.unit === '万' ? s.value * 10 : s.value));
  if (yearly) for (let i = 0; i < ks.length; i++) ks[i] /= 12;
  low = ks[0];
  high = ks.length >= 2 ? ks[1] : ks[0];
  if (low > high) [low, high] = [high, low];
  if (/元\s*\/\s*月|元\s*每\s*月/.test(cleaned)) {
    low /= 1000;
    high /= 1000;
  } else if (!/[Kk万千]/.test(cleaned) && high > 200) {
    low /= 1000;
    high /= 1000; // 纯数字且偏大（如 15000-20000 元）→ 千元
  }
  return { low, high, daily: false, hourly: false, valid: true };
}

/** 解析期望薪资（画像 hardConstraints.salary，形如「15-25K」「1-2万」「不限」） */
export function parseExpectedSalary(profile: Profile | null): SalaryRange {
  const raw = String(profile?.hardConstraints?.salary || '').trim();
  if (!raw || /不限|面议/.test(raw)) return { low: 0, high: 0, daily: false, hourly: false, valid: false };
  // 期望薪资是用户的基准，与单个岗位的工作制度无关 → 按标准双休口径折算
  return parseSalaryRange(raw);
}

/**
 * 计算岗位的「日薪等效值」（元/天）。
 * 把任意薪资口径（月 K、元/月、万/月、日薪、时薪）按岗位工作制度折算到统一的「元/天」，
 * 用于「最低日薪」确定性硬约束（与用户设定的 minSalaryPerDay 比较）。
 * 无法解析（面议 / 无薪资 / 纯占位）返回 null —— 此时不拦截（与 salaryPriority 口径一致：无薪资信号既不抬升也不压低）。
 */
export function jobDailySalaryFloor(job?: Partial<JobMeta> | null): number | null {
  if (!job) return null;
  const schedule = detectWorkSchedule(job);
  const range = parseSalaryRange(job.salary, schedule.monthlyWorkDays);
  if (!range.valid) return null;
  // 千元/月 → 元/天：low_K * 1000 / 月工作日。
  // 该公式对月/日/时三种口径统一成立（日薪原样返回、时薪按 ×8 还原、月薪按 ÷月工作日 还原）。
  const daily = (range.low * 1000) / schedule.monthlyWorkDays;
  return Number.isFinite(daily) ? Math.round(daily * 10) / 10 : null;
}

/**
 * 计算岗位的「月薪等效值」（K元/月）。
 * 把任意薪资口径（月 K、元/月、万/月、日薪、时薪）按岗位工作制度折算到统一的「K元/月」，
 * 用于「最低月薪」确定性硬约束（与用户设定的 minSalaryPerMonth 比较，单位 K元/月，支持 1 位小数）。
 * 无法解析（面议 / 无薪资 / 纯占位）返回 null —— 此时不拦截（与 salaryPriority 口径一致：无薪资信号既不抬升也不压低）。
 */
export function jobMonthlySalaryFloor(job?: Partial<JobMeta> | null): number | null {
  if (!job) return null;
  const schedule = detectWorkSchedule(job);
  const range = parseSalaryRange(job.salary, schedule.monthlyWorkDays);
  if (!range.valid) return null;
  // range.low 单位即为千元/月（K元/月），保留 1 位小数
  const monthlyK = range.low;
  return Number.isFinite(monthlyK) ? Math.round(monthlyK * 10) / 10 : null;
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

// ===== 经验：本地不再计算 =====
// 口径（2026-09-14 定）：经验维度**完全交给 AI 五维评估**（job-analysis 的 dimensionScores.experience，
// 提示词已规定「年限不足 → 降到谨慎档（60），绝不判不推荐」）。本地解析 JD 要求年限 / 画像经历区间
// 属于对同一事实的重复判断，且口径与 AI 不一致（本地会按比例压分甚至误判），因此整块删除：
//   - 删 parseExperienceYears / parseMonthSpan / mergeMonthSpans / profileExperienceYears / jdRequiredExperienceYears；
//   - 本地经验维度恒为 null（UI 自动过滤；AI 路径由 AI 分值填充）。
// 注意：`profile.hardConstraints.experience` 仍是「求职条件」的展示字段（profile.ts 维护），此处不涉及。

/** 从 JD 文本提取要求的学历等级；未明确要求返回 null */
function jdRequiredDegreeLevel(job: JobMeta): number | null {
  // 岗位要求只从明确岗位字段（title/description）解析，不拼接 cardText——
  // cardText 是列表卡片文本（含「急聘/高薪/相似岗位/导航」等噪声），极易把
  // 相似岗位或周边内容的学历要求误当成当前岗位要求，造成「正常岗位被判学历不足→35 分」。
  const text = `${String(job.title || '')} ${String(job.description || '')}`;
  const level = degreeLevel(text);
  if (level <= 0) return null; // 未明确要求
  // 「不限学历/学历不限」不构成要求
  if (/不限|以上|学历不限|无学历要求/.test(text) && !/本科及以上|硕士及以上|博士及以上/.test(text)) return null;
  return level;
}

// ===== 岗位求职类型判定（实习/全职）=====
type JobEmploymentType = 'intern' | 'fulltime' | 'unknown';
function jobEmploymentType(job: JobMeta): JobEmploymentType {
  const text = `${String(job.title || '')} ${String(job.description || '')}`;
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
  /** 经验匹配 0-100：**本地不再计算，恒为 null**（由 AI 五维评估 dimensionScores.experience 提供） */
  experience: number | null;
  /** 本地加权综合分 0-100（各维度加权，null 维度剔除后重归一化）；信息不足为 null */
  overall: number | null;
  /** 维度计算的确定程度（0-1）：「有可比对依据（而非中性兜底）」的维度数 ÷ 参与本地计算的维度数，用于 AI 分校准的置信度 */
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

// ===== 维度权重单一来源（P3-05；P1-08 已加语义注释）=====
// 「本地可计算维度」与「AI 五维」是两组刻意不同的集合（共同维度权重数值一致）：
//  - LOCAL_DIM_WEIGHTS：含 location、不含 experience（经验本地恒 null，Σ=0.94）；
//  - AI_DIM_WEIGHTS：含 experience、不含 location（location 恒取本地值，Σ=0.90）。
// 差异是设计意图，勿「补齐」成同名同集合；matching.ts::mergeAiDimensions 引用本表，勿再自建第二份。
export type AIDimKey = 'skill' | 'direction' | 'salary' | 'education' | 'experience';
export const LOCAL_DIM_WEIGHTS: ReadonlyArray<readonly [keyof LocalMatchDimensions, number]> = [
  ['skill', 0.34],
  ['direction', 0.28],
  ['location', 0.1],
  ['salary', 0.14],
  ['education', 0.08],
] as const;
export const AI_DIM_WEIGHTS: ReadonlyArray<readonly [AIDimKey, number]> = [
  ['skill', 0.34],
  ['direction', 0.28],
  ['salary', 0.14],
  ['education', 0.08],
  ['experience', 0.06],
] as const;

// ===== 核心：本地多维匹配 =====

/**
 * 缺口判定口径的画像文本：结构化画像 + 简历原文。
 * 简历里的技能表述可能只写在经历行、未落入结构化 facts（如「熟练 Git 分支协作」），
 * 只查画像会误报缺失，故一并纳入。
 */
function buildProfileBlob(profile: Profile | null, resumeText = ''): string {
  return JSON.stringify({
    facts: profile?.facts || {},
    searchKeywords: profile?.searchKeywords || [],
    primaryDirections: profile?.primaryDirections || [],
    hardConstraints: profile?.hardConstraints || {},
    resume: String(resumeText || '').slice(0, 15000),
  });
}

/** 画像/简历文本已具备的能力键集合（英文 token 规范键，用于等价组与上位覆盖比对） */
function coveredSkillKeys(blob: string): Set<string> {
  return skillKeysInText(blob);
}

/**
 * JD 关键词是否已被画像/简历覆盖（三层判定，任一命中即视为已具备，不算缺口）：
 *   ① 原文命中：保持原有口径（英文词边界 / 中文子串）；
 *   ② 等价组：简历写 Git，JD 写 GitHub/GitLab；简历写 FastAPI，JD 写 Flask/Django（见 skillTaxonomy）；
 *   ③ 上位覆盖：会 TypeScript / React / Vue / Node 即已掌握 JavaScript。
 * 仅用于缺口判定与技能分惩罚口径，不影响技能命中/证据。
 */
function isJdTermCovered(term: string, blob: string, keys: Set<string>): boolean {
  if (keywordHit(term, blob)) return true;
  // 中文技能别名方向：JD 写「容器化」、简历有 Docker（中文别名 → 英文等价键展开，见 equivalentSkillKeys）；
  // JD 写 Docker、简历写「容器化」（文本中的中文别名族与 term 等价键相交，见 zhAliasCoversTerm）。
  if (zhAliasCoversTerm(term, blob)) return true;
  if (equivalentSkillKeys(term).some((key) => keys.has(key))) return true;
  return coveringSkillKeys(term).some((key) => keys.has(key));
}

/**
 * 清洗缺口条目（AI 复核结果与本地候选共用），命中以下任一即丢弃：
 *   ① 条目里的英文 token 全为非技能噪音词（「Demo」「HR」「bug 修复」）；
 *   ② 条目里的英文 token 全部已被画像/简历覆盖（「Flask」「GitHub 作品 Demo」）。
 * 纯中文条目（如「缺少大厂实习经历」）不在此判废，保留给上层展示。
 */
export function cleanGapList(gaps: unknown[], profile: Profile | null, resumeText = ''): string[] {
  const blob = buildProfileBlob(profile, resumeText);
  const keys = coveredSkillKeys(blob);
  const cleaned: string[] = [];
  for (const raw of Array.isArray(gaps) ? gaps : []) {
    const gap = String(raw ?? '').trim();
    if (!gap) continue;
    const tokens = extractEnglishTokens(gap);
    if (tokens.length) {
      const meaningful = tokens.filter((t) => !isNonSkillJdToken(t));
      if (!meaningful.length) continue; // 全是噪音词
      if (meaningful.every((t) => isJdTermCovered(t, blob, keys))) continue; // 全部已具备
    }
    if (!cleaned.includes(gap)) cleaned.push(gap);
  }
  return cleaned;
}

// ===== 本地匹配上下文（一次解析、多处复用，避免子步骤重复计算）=====
// P3-08 拆分依据：原 computeLocalMatch 约 320 行、9 个内联硬约束 + 5 个维度混在一个函数里，
// 无法对单个约束写粒度化单测，新增约束也容易插错位置。拆分后：
//   - 共享事实解析一次进 ctx，硬约束与维度子函数各自消费、互不重复计算；
//   - collectHardBlocks 独立导出，可对单个约束扩展断言（scripts/score-regression.mjs）；
//   - 全部保持纯函数、零新依赖。
interface LocalMatchContext {
  job: JobMeta;
  profile: Profile | null;
  config: Partial<AppConfig>;
  title: string;
  desc: string;
  /** 标题 + 描述 + 卡片文本（技能命中的宽松口径；卡片文本含「急聘/高薪」等噪声，只用于命中判定不用于缺口） */
  jdText: string;
  /** 标题 + 描述（缺口 / 学历要求的保守口径，排除卡片噪声） */
  jdReqText: string;
  profileBlob: string;
  profileKeys: Set<string>;
  /** JD 明确要求、画像词表未具备的关键词（技能分惩罚与 gaps 展示共用） */
  missingJdTerms: string[];
  targetLocations: string[];
  /** JD 要求学历等级；未明确要求为 null */
  requiredDegree: number | null;
  profileDegreeText: string;
  profileDegreeLevel: number;
  directions: string[];
  keywords: string[];
  /** 去重后的核心技能池与方向目录技能池（技能分与置信度共用） */
  corePool: string[];
  directionPool: string[];
  /** 薪资口径三件套（薪资维度 / 置信度 / 展示共用） */
  schedule: WorkSchedule;
  expected: SalaryRange;
  jdRange: SalaryRange;
}

function buildLocalMatchContext(
  job: JobMeta,
  profile: Profile | null,
  config: Partial<AppConfig>,
  resumeText = ''
): LocalMatchContext {
  const title = String(job.title || '');
  const desc = String(job.description || '');
  const jdReqText = `${title} ${desc}`;
  // JD 关键缺口词（提取一次，技能分惩罚与 gaps 展示共用）：
  // extractJdKeywords 产出「JD 里出现的英文技术词 + 画像词命中」，画像词表未具备的即真实缺口。
  // 缺口判定口径 = 结构化画像词表 + 简历原文：简历里的技能表述可能未落入结构化 facts
  // （如「熟练 Git 分支协作」「熟练使用 ChatGPT/Claude/Cursor」只写在经历行），只查画像会误报缺失。
  const profileBlob = buildProfileBlob(profile, resumeText);
  const profileKeys = coveredSkillKeys(profileBlob);
  const { keywords: jdKeywords } = extractJdKeywords(jdReqText, profile);
  // 三层闸门：非技能噪音词（HR / bug / Demo）→ 原文命中 → 等价组/上位覆盖（Git↔GitHub、FastAPI↔Flask、TS/React→JS）
  const missingJdTerms = jdKeywords.filter((k) => {
    if (isNonSkillJdToken(k)) return false;
    if (isJdTermCovered(k, profileBlob, profileKeys)) return false;
    return true;
  });

  const targetLocations = normalizeStringList(profile?.hardConstraints?.locations, 20);

  // 学历：JD 明确要求 + 画像显式学历/教育经历行（口径注释见 collectHardBlocksFromCtx 规则 6）
  const requiredDegree = jdRequiredDegreeLevel(job);
  const profileDegreeText =
    String(profile?.hardConstraints?.degree || '').trim() ||
    normalizeStringList(profile?.facts?.education, 8).join(' ');
  const profileDegreeLevel = degreeLevel(profileDegreeText);

  // 技能池（去重、去短词）：画像核心技能 + 方向目录相关技能，技能分与置信度共用
  const directionNames = normalizeStringList(
    profile?.primaryDirections?.map((d) => (typeof d === 'string' ? d : d?.name)),
    8
  );
  const directionSkills: string[] = [];
  for (const dir of directionNames) {
    const rule = findDirectionRule(String(dir));
    if (rule?.relevantSkills) directionSkills.push(...rule.relevantSkills);
  }
  const seenSkill = new Set<string>();
  const corePool: string[] = [];
  const directionPool: string[] = [];
  for (const s of normalizeStringList(profile?.facts?.skills, 30).map((s) => String(s).trim())) {
    if (s.length >= 2 && !seenSkill.has(s.toLowerCase())) {
      seenSkill.add(s.toLowerCase());
      corePool.push(s);
    }
  }
  for (const s of directionSkills) {
    if (s.length >= 2 && !seenSkill.has(s.toLowerCase())) {
      seenSkill.add(s.toLowerCase());
      directionPool.push(s);
    }
  }

  // 薪资口径三件套（薪资维度与置信度共用；日薪/时薪折算基数按岗位工作制度取月工作日）
  const schedule = detectWorkSchedule(job);
  const expected = parseExpectedSalary(profile);
  const jdRange = parseSalaryRange(job.salary, schedule.monthlyWorkDays);

  return {
    job,
    profile,
    config,
    title,
    desc,
    jdText: `${title} ${desc} ${String(job.cardText || '')}`,
    jdReqText,
    profileBlob,
    profileKeys,
    missingJdTerms,
    targetLocations,
    requiredDegree,
    profileDegreeText,
    profileDegreeLevel,
    directions: directionNames.map((d) => String(d)),
    keywords: (profile?.searchKeywords || []).map((k) => String(k)),
    corePool,
    directionPool,
    schedule,
    expected,
    jdRange,
  };
}

// ===== 硬约束收集（P3-08：每个约束一条规则，顺序即展示顺序）=====
// 注意：matching.ts 用 `local.hardBlocks.slice(0, 2).join('；')` 生成拦截文案，
// 新增约束必须追加在数组末尾、不要插到中间——顺序改变会连带改变展示文案。
function collectHardBlocksFromCtx(ctx: LocalMatchContext): string[] {
  const { job, profile, config } = ctx;
  const rules: Array<() => string | null> = [
    // 1. 城市反选（设置 → 求职偏好）
    () => {
      if (isLocationExcluded(job.location, config as AppConfig)) {
        return `岗位地点「${String(job.location || '').trim()}」命中城市排除名单`;
      }
      return null;
    },
    // 2. 公司/招聘方黑名单
    () => {
      const blacklist = isCompanyExcluded(job, config as AppConfig);
      return blacklist.excluded ? blacklist.reason : null;
    },
    // 3. 猎头岗位
    () => (config.excludeHeadhunters && job.isHeadhunter ? '岗位为猎头代招，已按「排除猎头」设置拦截' : null),
    // 4. 目标城市不符（画像硬约束 locations 非空且可判定）
    () => {
      if (!ctx.targetLocations.length || !isLocationDecidable(job.location)) return null;
      const locText = String(job.location || '');
      const hit = ctx.targetLocations.some((city) => city && locText.includes(city));
      return hit
        ? null
        : `岗位地点「${locText.trim()}」不在目标城市（${ctx.targetLocations.slice(0, 4).join('、')}）`;
    },
    // 5. 求职类型冲突（实习/全职，仅明确信号且冲突才拦）
    () => {
      const empTypes = normalizeStringList(profile?.hardConstraints?.employmentTypes, 10);
      const wantIntern = empTypes.some((t) => t === '实习' || t === '校招');
      const wantFulltime = empTypes.some((t) => t === '全职' || t === '社招');
      const jobType = jobEmploymentType(job);
      if (jobType === 'fulltime' && wantIntern && !wantFulltime) {
        return '岗位为全职/社招，与画像「仅实习/校招」的求职类型冲突';
      }
      if (jobType === 'intern' && wantFulltime && !wantIntern) {
        return '岗位为实习，与画像「全职」的求职类型冲突';
      }
      return null;
    },
    // 6. 学历不足（JD 明确要求更高学历）
    //    画像学历口径：只认「画像硬约束里显式填写的学历」与「教育经历行的学历词」。
    //    旧实现把整个 facts JSON 交给 extractDegree 并取最高学历，两条错都由此而来：
    //      ① 漏拦——项目/经历行出现「协助博士生调研」→ 画像被判为博士 → 岗位要求硕士也不拦；
    //      ② 误拦——技能/项目行出现「本科及以上优先」→ 大专求职者被判为本科。
    //    学历是用户硬设置，判错任一方向都会让设置失效，故收窄到真正承载学历的字段。
    () => {
      if (ctx.requiredDegree == null || ctx.profileDegreeLevel <= 0 || ctx.requiredDegree <= ctx.profileDegreeLevel) return null;
      return `岗位要求学历不低于「${levelName(ctx.requiredDegree)}」，画像学历为「${profile?.hardConstraints?.degree || levelName(ctx.profileDegreeLevel)}」`;
    },
    // 7. 外部网申（对齐 job-priority 的 -6000 口径，提升为硬拦截）
    () =>
      /外部网申|立即网申|去网申/.test(`${job.applicationMode || ''} ${job.cardText || ''}`)
        ? '岗位为外部网申，需跳转第三方系统，不纳入投递队列'
        : null,
    // 8. 面试方式冲突（设置 → 仅线上/仅线下）
    //    以本地关键字实时判定为准（单一来源），未在说明中明确披露的岗位一律判为「合格」，不据以拦截。
    () => {
      const imFilter = config?.interviewModeFilter || 'any';
      if (imFilter === 'any') return null;
      const mode = detectInterviewMode(job);
      if (mode === 'unknown' || mode === imFilter) return null;
      const required = mode === 'offline' ? '线下' : '线上';
      const wanted = imFilter === 'online' ? '线上' : '线下';
      return `岗位要求${required}面试，与设定的「仅${wanted}」冲突`;
    },
    // 9. 最低薪资（设置 → 元/天 或 元/月；0 表示不限）
    //    将岗位任意薪资口径折算为「元/天」或「元/月」后低于阈值即硬拦截，确保不合理低薪岗位不进入投递队列。
    //    面议 / 无薪资岗位无法折算，按「无薪资信号」处理、不拦截（与 salaryPriority 口径一致）。
    () => {
      if (config?.minSalaryMode === 'month') {
        const minSalaryPerMonth = Number(config?.minSalaryPerMonth ?? 0);
        if (minSalaryPerMonth > 0) {
          const monthlyFloor = jobMonthlySalaryFloor(job);
          if (monthlyFloor != null && monthlyFloor < minSalaryPerMonth) {
            return `岗位月薪约 ${monthlyFloor} K元/月，低于设定的最低月薪 ${minSalaryPerMonth} K元/月`;
          }
        }
      } else {
        const minSalaryPerDay = Number(config?.minSalaryPerDay ?? 0);
        if (minSalaryPerDay > 0) {
          const dailyFloor = jobDailySalaryFloor(job);
          if (dailyFloor != null && dailyFloor < minSalaryPerDay) {
            return `岗位日薪约 ${dailyFloor} 元/天，低于设定的最低日薪 ${minSalaryPerDay} 元/天`;
          }
        }
      }
      return null;
    },
  ];
  const hardBlocks: string[] = [];
  for (const rule of rules) {
    const hit = rule();
    if (hit) hardBlocks.push(hit);
  }
  return hardBlocks;
}

/** 硬约束收集对外入口（P3-08）：可对单个约束做粒度化单测（scripts/score-regression.mjs 扩展断言用） */
export function collectHardBlocks(
  job: JobMeta,
  profile: Profile | null,
  config: Partial<AppConfig> = {}
): string[] {
  return collectHardBlocksFromCtx(buildLocalMatchContext(job, profile, config));
}

// ===== 技能匹配 =====
// 命中口径从「全量加权占比」改为「核心技能命中数映射 + 方向词加成」：
// 画像技能常达 10-30 个、JD 描述又短，全量占比会被大量未命中词稀释（强匹配也只算 20-50%），
// 把分数整体压扁。改为按「命中核心技能的个数」映射（0/1/2/3/4+ → 0/35/70/88/98）——
// 3 个核心技能命中即达推荐档（对齐 AI 提示词「大部分命中 = recommend」口径）；
// 方向规则相关技能按命中占比小额加成（最多 +10），只加分、不进分母稀释。
function computeSkillScore(ctx: LocalMatchContext, evidence: string[]): number | null {
  if (!ctx.corePool.length && !ctx.directionPool.length) return null;
  const hitTerms: string[] = [];
  let coreHits = 0;
  let dirHits = 0;
  for (const s of ctx.corePool) {
    if (keywordHit(s, ctx.jdText)) {
      coreHits += 1;
      hitTerms.push(s);
    }
  }
  for (const s of ctx.directionPool) {
    if (keywordHit(s, ctx.jdText)) {
      dirHits += 1;
      hitTerms.push(s);
    }
  }
  const coreBase = coreHits >= 4 ? 98 : [0, 35, 70, 88][coreHits] ?? 0;
  const dirBonus = ctx.directionPool.length ? Math.round((dirHits / ctx.directionPool.length) * 10) : 0;
  let score = Math.max(0, Math.min(100, coreBase + dirBonus));
  // JD 明确要求但画像未具备的关键词 → 技能分如实扣减（每个 +4、上限 12 分；仅计 ≥4 字符的实质技术词，
  // 避免 Web/API/UI 等通用短词与整页噪声误伤——与 gaps 展示共用同一缺口集合）
  const missingPenalty = Math.min(12, ctx.missingJdTerms.filter((t) => t.length >= 4).length * 4);
  if (missingPenalty) score = Math.max(0, score - missingPenalty);
  if (hitTerms.length) evidence.push(`技能命中：${hitTerms.slice(0, 8).join('、')}`);
  if (score >= 60) evidence.push(`技能匹配度 ${score}%`);
  return score;
}

// ===== 方向匹配（标题/描述 vs 画像方向 + 方向目录 + 搜索词）=====
// 与技能维度同口径：改用「方向命中数映射 + 关键词加成」，避免关键词把方向命中稀释掉。
// 标题命中 1 个主方向即为强信号（+55），描述/规则近似命中为弱信号（+20），
// 关键词按标题/描述命中数小额加成（每个 +5，最多 +15，不随关键词总量稀释）；2 个方向全标题命中即满分。
function computeDirectionScore(ctx: LocalMatchContext, evidence: string[]): number | null {
  const { directions, keywords } = ctx;
  if (!directions.length && !keywords.length) return null;
  let titleHits = 0;
  let weakHits = 0;
  let kwHits = 0;
  // 标题标准化键（C2：剥噪后用于方向比对；如「数据开发实习生（杭州）」→「数据开发实习生」）
  const titleKey = normalizeJobTitleKey(ctx.title);
  for (const dir of directions) {
    const dirKey = normalizeDirectionKeyForMatch(dir);
    if (!dirKey) continue;
    // ① 强信号：标题命中（双向子串 / 方向目录规则 test 命中标题 / 目录 keywords 命中标题）
    const rule = findDirectionRule(dir);
    const dirKeywordKeys = (rule?.keywords || []).map((kw) => normalizeDirectionKeyForMatch(String(kw))).filter((k) => k && k.length >= 2);
    const titleHitByDir = dirKey.length >= 2 && titleKey && (titleKey.includes(dirKey) || dirKey.includes(titleKey));
    const titleHitByRule = Boolean(rule && rule.test.test(titleKey));
    const titleHitByKw = dirKeywordKeys.some((k) => titleKey.includes(k) || k.includes(titleKey));
    if (titleHitByDir || titleHitByRule || titleHitByKw) {
      titleHits += 1;
      evidence.push(`方向命中：岗位「${ctx.title.trim() || '未知'}」匹配方向「${dir}」`);
    } else if (dirKey.length >= 2 && ctx.desc.includes(dirKey)) {
      weakHits += 1;
    } else {
      // 方向目录规则兜底：规则 test 正则命中岗位文本（如「AI 应用开发」方向命中「大模型应用工程师」）
      if (rule && rule.test.test(ctx.jdText)) {
        weakHits += 1;
        evidence.push(`方向近似：岗位内容符合「${dir}」方向`);
      }
    }
  }
  // 搜索词：标题命中强、描述命中弱
  for (const kw of keywords) {
    const k = String(kw).trim();
    if (!k || k.length < 2) continue;
    if (keywordHit(k, ctx.title)) {
      kwHits += 1;
      evidence.push(`关键词命中：岗位标题包含「${k}」`);
    } else if (keywordHit(k, ctx.desc)) {
      kwHits += 0.5;
    }
  }
  const kwBonus = Math.min(15, Math.round(kwHits * 5));
  return Math.max(0, Math.min(100, Math.round(titleHits * 55 + weakHits * 20 + kwBonus)));
}

// ===== 地点匹配 =====
function computeLocationScore(ctx: LocalMatchContext, evidence: string[]): number | null {
  if (isLocationDecidable(ctx.job.location) && ctx.targetLocations.length) {
    const locText = String(ctx.job.location || '');
    const hit = ctx.targetLocations.some((city) => city && locText.includes(city));
    if (hit) evidence.push(`地点命中：${locText.trim()} 在目标城市内`);
    return hit ? 100 : 0;
  }
  if (ctx.targetLocations.length) return 55; // 远程/未识别：中性
  return null;
}

// ===== 薪资匹配（不对称：明显低于期望必扣分，达到/高于期望给高分）=====
// 日薪/时薪的折算基数按岗位工作制度取月工作日（双休 22 / 大小周 24 / 单休 26），
// 避免把单休岗位的日薪按双休基数折算，导致等效月薪被显著低估、薪资匹配度误判。
function computeSalaryScore(ctx: LocalMatchContext, evidence: string[]): number | null {
  const { jdRange, expected, schedule } = ctx;
  let score: number | null;
  if (jdRange.valid && expected.valid) {
    // JD 上限低于期望下限 → 明显低于预期，低分惩罚（薪资可谈但不应假装达标）
    if (jdRange.high < expected.low) {
      score = 30;
      evidence.push(`薪资偏低：岗位「${decodeSalaryDigits(String(ctx.job.salary || '')).trim()}」低于期望下限 ${expected.low}K/月`);
    } else if (jdRange.low >= expected.high) {
      score = 100; // 起点已不低于期望上限：显著高于预期
    } else {
      // 部分/完全覆盖：重叠占比 + 60 基线（完全覆盖即 100）
      const overlap = Math.max(0, Math.min(jdRange.high, expected.high) - Math.max(jdRange.low, expected.low));
      const expSpan = Math.max(1, expected.high - expected.low);
      score = Math.round(Math.min(100, (overlap / expSpan) * 100 + 60));
    }
  } else if (jdRange.valid && !expected.valid) {
    score = 65; // 画像未设定期望薪资：中性偏正
  } else {
    score = 55; // JD 面议/未识别：中性
  }
  // 口径透明化：日薪/时薪的折算依据（工作制度 + 月工作日基数）写入证据，UI 与 AI 校准锚点共用
  if (jdRange.valid && (jdRange.daily || jdRange.hourly)) {
    const unit = jdRange.hourly ? '时薪' : '日薪';
    evidence.push(
      `薪资口径：岗位${unit}「${decodeSalaryDigits(String(ctx.job.salary || '')).trim()}」≈ ${jdRange.low.toFixed(1)}-${jdRange.high.toFixed(1)}K/月（${scheduleBasisText(schedule)}）`
    );
  }
  return score;
}

// ===== 学历匹配（正好达标满分；高于要求略降——部分公司会卡「学历过度匹配」；画像学历未知按 30 保守）=====
function computeEducationScore(ctx: LocalMatchContext): number | null {
  if (ctx.requiredDegree != null) {
    return ctx.profileDegreeLevel >= ctx.requiredDegree ? (ctx.profileDegreeLevel === ctx.requiredDegree ? 100 : 88) : 30;
  }
  return 60; // JD 未明确要求学历：中性
}

// ===== 加权综合分 + 置信度（null 维度剔除后重归一化）=====
// 权重说明：技能/方向是匹配核心；薪资在不对称评分后区分度提升，权重上调；
// 地点命中恒为 100（区分度低）降权；**经验已交给 AI，不参与本地加权**。
// 语义注意（P1-08/P3-05）：本表是「本地可计算维度」（含 location、无 experience，Σ=0.94）；
// matching.ts::mergeAiDimensions 引用上方导出的 AI_DIM_WEIGHTS（Σ=0.90，含 experience、无 location），
// 两侧共同维度权重数值刻意一致 —— 差异是设计意图，勿"补齐"成同名同集合。
interface LocalScores {
  skill: number | null;
  direction: number | null;
  location: number | null;
  salary: number | null;
  education: number | null;
}

function computeOverallAndConfidence(ctx: LocalMatchContext, scores: LocalScores): { overall: number | null; confidence: number } {
  const WEIGHTS = LOCAL_DIM_WEIGHTS;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [key, w] of WEIGHTS) {
    const v = scores[key as keyof LocalScores];
    if (v != null) {
      weightedSum += v * w;
      weightTotal += w;
    }
  }
  const overall = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
  // 置信度 = 「有真实依据的维度数 ÷ 参与本地计算的维度数」，而非「非空维度数 ÷ 维度数」。
  // 修复死开关：salary / education 在信息缺失时返回中性兜底值，恒为非 null → 旧的 scoredCount
  // 恒偏大、confidence 只可能落在少数几档，等于没有区分度。现在只有「画像与 JD 都提供了可比对信息」
  // 的维度才计信，信息不足时置信度会如实下降。（当前仅作为可解释性字段输出，无消费方依赖。）
  const informed = [
    ctx.corePool.length > 0 || ctx.directionPool.length > 0, // 技能：画像有技能词可比对
    ctx.directions.length > 0 || ctx.keywords.length > 0, // 方向：画像有方向/搜索词可比对
    ctx.targetLocations.length > 0 && isLocationDecidable(ctx.job.location), // 地点：JD 地点可判定且画像有目标城市
    ctx.jdRange.valid && ctx.expected.valid, // 薪资：JD 薪资与期望薪资都能解析
    ctx.requiredDegree != null, // 学历：JD 明确要求了学历
  ].filter(Boolean).length;
  const confidence = Math.max(0.15, Math.round((informed / WEIGHTS.length) * 100) / 100);
  return { overall, confidence };
}

// ===== 缺口（复用 missingJdTerms：JD 明确要求、画像词表未具备的关键词，如实标注不灌水）=====
// 逐条独立成项（每条 = 单个技能/技术栈，含「岗位要求」上下文），供任务卡片逐个展示、
// AI 兜底与优先级扣分（priority.ts gaps × 45）共用；不再合并成一条长句，便于 UI 精细展示。
function buildGapList(ctx: LocalMatchContext): string[] {
  const gaps: string[] = [];
  for (const term of ctx.missingJdTerms.slice(0, 8)) {
    const item = `岗位要求「${term}」画像未体现`;
    if (!gaps.includes(item)) gaps.push(item);
  }
  return gaps;
}

export function computeLocalMatch(
  job: JobMeta,
  profile: Profile | null,
  config: Partial<AppConfig> = {},
  resumeText = ''
): LocalMatchResult {
  // 一次性解析共享事实（JD 文本 / 缺口词 / 学历 / 技能池 / 薪资口径），供各子步骤复用，避免重复计算
  const ctx = buildLocalMatchContext(job, profile, config, resumeText);
  // 硬约束（deal-breaker，信息充分才拦截，避免误杀）：9 条规则按顺序收集，任一项存在即应拦下
  const hardBlocks = collectHardBlocksFromCtx(ctx);
  // 证据数组由各维度子函数按「技能 → 方向 → 地点 → 薪资」顺序追加（顺序 = 展示顺序）
  const evidence: string[] = [];
  const skill = computeSkillScore(ctx, evidence);
  const direction = computeDirectionScore(ctx, evidence);
  const location = computeLocationScore(ctx, evidence);
  const salary = computeSalaryScore(ctx, evidence);
  const education = computeEducationScore(ctx);
  const { overall, confidence } = computeOverallAndConfidence(ctx, { skill, direction, location, salary, education });

  // ---- 经验匹配：本地不计算（见文件上方「经验：本地不再计算」口径）----
  // 经验由 AI 五维评估判定，本地恒为 null（不参与加权综合分，UI 自动过滤该维度）。
  const experience: number | null = null;

  return {
    dimensions: { skill, direction, location, salary, education, experience, overall, confidence },
    hardBlocks,
    evidence,
    gaps: buildGapList(ctx),
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

/**
 * 岗位标题标准化键（C2：标题 → 方向目录匹配的强信号通道）：
 * 先剥掉标题里的噪音段（招人噪声括号、地点括号、公司名前缀、招聘字样），
 * 再走 normalizeDirectionKeyForMatch。例：
 *   「数据开发实习生（杭州）」→「数据开发实习生」→ 命中方向「数据开发实习生」；
 *   「XX信息科技有限公司招聘：前端开发工程师（双休）」→「前端开发工程师」。
 */
function normalizeJobTitleKey(title: string): string {
  let t = String(title || '').trim();
  if (!t) return '';
  t = t
    .replace(/【[^】]*】/g, ' ')
    .replace(/《[^》]*》/g, ' ')
    // 括号里的招人噪声（急聘/高薪/双休/社保/地域交通）→ 剥离
    .replace(
      /[（(][^)）]*(?:急聘|诚聘|高薪|包吃住|五险一金|五险|六险|公积金|双休|大小周|单休|朝九晚六|弹性工作|地铁|通勤|附近|坐标)[^)）]*[)）]/g,
      ' '
    )
    // 括号里的城市名 → 剥离（方向判定不含地点）
    .replace(
      /[（(][^)）]*(?:北京|上海|广州|深圳|成都|杭州|武汉|西安|南京|苏州|长沙|郑州|天津|重庆|青岛|大连|宁波|厦门|合肥|福州|济南|沈阳|哈尔滨|长春|昆明|南昌|贵阳|南宁|太原|石家庄|乌鲁木齐|兰州|海口|银川|西宁|呼和浩特)[^)）]*[)）]/g,
      ' '
    )
    // 前缀公司名（常见公司后缀）与「招聘」字样
    .replace(/^(?:[\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:有限公司|股份公司|信息科技|网络科技|信息技术|集团|工作室|合伙企业))/, ' ')
    .replace(/招聘[:：]?/g, ' ');
  return normalizeDirectionKeyForMatch(t);
}

// ===== 本地兜底分（仅在 AI 分缺失 / AI 不可用时出场）=====
// 硬约束命中 → 统一封顶 HARD_BLOCK_SCORE_CAP（35，unfit 档内低端，见 fitLevel.ts）
export function enhancedLocalScore(job: JobMeta, profile: Profile | null, config: Partial<AppConfig> = {}): number | null {
  if (!profile) return null;
  const local = computeLocalMatch(job, profile, config);
  if (local.hardBlocks.length) return Math.min(local.dimensions.overall ?? 0, HARD_BLOCK_SCORE_CAP);
  return local.dimensions.overall;
}
