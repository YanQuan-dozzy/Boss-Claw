// 移植自 job-claw-main\source\src\background.js 的职业画像逻辑
import type { AppConfig, Profile, ProfileDraft, HardConstraints, PrimaryDirection } from './types';
import { uniq } from './defaults';
import {
  cleanResumeText,
  extractSkills,
  inferDirections,
  buildSearchKeywords,
  extractDegree,
  extractLocations,
  isStudentResume,
  normalizeStringList,
  lineMatches,
  normalizeDirectionKey,
  findDirectionRule,
} from './helpers';
import {
  buildProfilePromptWithAnchor,
  buildCompactProfilePromptWithAnchor,
} from './prompts';
import { cachedCallModel, AIError, aiFailureKind, isRetryableAiOutputError } from './llm';
import { skillInstructionsFor } from './skills';

function explainProfileFallbackReason(reason = '', kind = ''): string {
  const message = String(reason || '').trim();
  const resolvedKind = kind || aiFailureKind({ message });
  if (!message) return '';
  if (resolvedKind === 'config-missing') return 'AI 尚未配置；本次未调用 AI，当前初稿全部来自本地规则。';
  if (resolvedKind === 'service-error') return 'AI 请求没有成功；本次画像未使用 AI，当前初稿全部来自本地规则。';
  return 'AI 连接可用，但返回内容未通过完整性校验；系统已自动精简重试，仍未成功，因此本次初稿全部来自本地规则。';
}

export function validateGeneratedProfile(profile: any): any {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 画像字段不完整');
  }
  const directions = normalizeStringList(profile.primaryDirections, 3);
  const keywords = normalizeStringList(profile.searchKeywords, 12);
  const summary = String(profile.summary || '').trim();
  if (!directions.length || !keywords.length || summary.length < 12) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 画像字段不完整');
  }
  if (!profile.facts || typeof profile.facts !== 'object' || Array.isArray(profile.facts)) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 画像字段不完整');
  }
  if (!profile.hardConstraints || typeof profile.hardConstraints !== 'object' || Array.isArray(profile.hardConstraints)) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 画像字段不完整');
  }
  return profile;
}

export function validateCompactGeneratedProfile(profile: any): any {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 精简画像字段不完整');
  }
  const normalized = {
    summary: String(profile.summary || '').trim(),
    primaryDirections: normalizeStringList(profile.primaryDirections, 3),
    searchKeywords: normalizeStringList(profile.searchKeywords, 12),
    skills: normalizeStringList(profile.skills, 30),
    locations: normalizeStringList(profile.locations, 20),
    employmentTypes: normalizeStringList(profile.employmentTypes, 10),
    salary: String(profile.salary || '').trim(),
    experience: String(profile.experience || '').trim(),
    degree: String(profile.degree || '').trim(),
    excludeDirections: normalizeStringList(profile.excludeDirections, 20),
  };
  if (!normalized.primaryDirections.length || !normalized.searchKeywords.length || normalized.summary.length < 12) {
    throw new AIError('AI_PROFILE_INCOMPLETE', 'AI 精简画像字段不完整');
  }
  return normalized;
}

export function buildLocalProfile(resumeText: string, reason = '', failureKind = ''): Profile {
  const text = cleanResumeText(resumeText);
  if (text.length < 30) throw new Error('简历内容太少，暂时无法生成职业画像');
  const skills = extractSkills(text);
  const primaryDirections = inferDirections(text, skills);
  const searchKeywords = buildSearchKeywords(primaryDirections, skills);
  const degree = extractDegree(text);
  const locations = extractLocations(text);
  const internship = isStudentResume(text);
  const employmentTypes = internship ? ['实习', '校招'] : ['全职'];
  const experience = internship ? '在校/应届' : '按岗位要求匹配';
  const topSkills = skills.slice(0, 7);
  const summaryParts: string[] = [];
  if (degree !== '不限') summaryParts.push(`${degree}${internship ? '在读或应届' : '背景'}`);
  if (topSkills.length) summaryParts.push(`具备 ${topSkills.join('、')} 等技能或项目经验`);
  summaryParts.push(`主要关注 ${primaryDirections.join('、')} 方向`);

  const education = lineMatches(text, /大学|学院|本科|硕士|博士|教育经历|专业/i, 6);
  const experiences = lineMatches(text, /实习|工作经历|公司|负责|任职|助理|工程师/i, 8);
  const projects = lineMatches(text, /项目|系统|平台|工作台|GitHub|开发|实现|搭建|设计/i, 10);
  const certificates = lineMatches(text, /证书|CET|英语六级|英语四级|资格|获奖|奖项/i, 6);
  const resolvedKind = failureKind || (reason ? aiFailureKind({ message: reason }) : 'not-requested');

  return normalizeProfile({
    facts: { education, experiences, projects, skills, certificates },
    primaryDirections: primaryDirections.map((name) => ({ name, confidence: 0.72, evidence: ['根据简历中的技能、项目和求职阶段生成'] })),
    secondaryDirections: [],
    searchKeywords,
    hardConstraints: { locations, employmentTypes, salary: '不限', experience, degree },
    excludeDirections: [],
    summary: `${summaryParts.join('，')}。`,
    generation: {
      mode: 'local-fallback',
      label: '本地规则初稿',
      aiStatus: resolvedKind,
      warning: explainProfileFallbackReason(reason, resolvedKind),
      technicalReason: String(reason || ''),
      generatedAt: Date.now(),
    },
  });
}

// 主方向融合：本地规则为骨架（技能栈权重判定，通常准确），AI 结果只做排序调整与补充，防止 AI 误判。
// - AI 与本地有交集：以本地对象为骨架（保留本地置信度与显式求职意向名），按 AI 顺序排列，补回本地独有方向；
// - AI 与本地无交集（整体跑偏，视为不可信）：完全以本地为准，不吸收 AI 方向。
// - AI 补充的方向按求职阶段归一化岗位名：在校生→"XX实习生"，社会求职者→正式岗位名。
function mergeDirections(aiValue: any, localDirections: PrimaryDirection[], student: boolean): PrimaryDirection[] {
  const localKeys = localDirections.map((item) => normalizeDirectionKey(item.name));
  const aiDirs = normalizeDirections(aiValue, localDirections);
  const aiKeys = aiDirs.map((item) => normalizeDirectionKey(item.name));
  const hasOverlap = aiKeys.some((key) => localKeys.includes(key));
  if (!hasOverlap) return [...localDirections].slice(0, 3);

  const stageName = (name: string): string => {
    const rule = findDirectionRule(name);
    if (!rule) return name;
    return student ? rule.internName : rule.name;
  };
  const kept: PrimaryDirection[] = [];
  for (const aiDir of aiDirs) {
    if (kept.length >= 3) break;
    const key = normalizeDirectionKey(aiDir.name);
    const localMatch = localDirections.find((item) => normalizeDirectionKey(item.name) === key);
    if (localMatch) {
      if (!kept.some((item) => normalizeDirectionKey(item.name) === key)) kept.push(localMatch);
    } else {
      const staged = stageName(aiDir.name);
      kept.push({ ...aiDir, name: staged });
    }
  }
  for (const local of localDirections) {
    if (kept.length >= 3) break;
    const key = normalizeDirectionKey(local.name);
    if (!kept.some((item) => normalizeDirectionKey(item.name) === key)) kept.push(local);
  }
  return kept.slice(0, 3);
}

// 搜索词：本地构建为准（方向名 + 目录关键词 + 技能开发词），AI 仅在能对齐到本地锚点时增补，过滤编造岗位名
function mergeSearchKeywords(aiValue: any, localKeywords: string[], directions: PrimaryDirection[], skills: string[]): string[] {
  const aiKeywords = normalizeStringList(aiValue, 12);
  const anchorTerms = [...localKeywords, ...directions.map((d) => d.name), ...skills];
  const extra = aiKeywords.filter((kw) => {
    const lower = kw.toLowerCase();
    return anchorTerms.some((term) => {
      const t = String(term).toLowerCase();
      return t.includes(lower) || lower.includes(t);
    });
  });
  return uniq([...localKeywords, ...extra]).slice(0, 12);
}

// 技能：本地规范技能名为准；AI 补充仅采用能命中本地技能目录的规范技能名，丢弃"熟悉 XX 开发"等描述性短语
function mergeSkills(aiSkillsValue: any, localSkills: string[]): string[] {
  const catalogHits = extractSkills(normalizeStringList(aiSkillsValue, 30).join(' '));
  return uniq([...localSkills, ...catalogHits]).slice(0, 40);
}

// 学历为客观事实：本地精确关键词抽取（博士/硕士/本科/大专）优先；本地未知时采用 AI 判断
function resolveDegree(localDegree: string, aiDegree: any): string {
  const aiValue = String(aiDegree || '').trim();
  if (localDegree && localDegree !== '不限') return localDegree;
  return aiValue || localDegree || '不限';
}

// 经验：AI 给出可核实的年限或求职阶段时采用，否则用本地（避免 AI 凭空推断年限）
function resolveExperience(localExperience: string, aiExperience: any): string {
  const aiValue = String(aiExperience || '').trim();
  if (/^\d+(?:\.\d+)?\s*年|应届|在校|实习|在读|无经验/.test(aiValue)) return aiValue;
  return localExperience || aiValue || '';
}

export function mergeProfileWithFallback(aiProfile: any, fallbackProfile: Profile, generation: any = null): Profile {
  const ai = aiProfile && typeof aiProfile === 'object' ? aiProfile : {};
  const aiFacts = ai.facts && typeof ai.facts === 'object' ? ai.facts : {};
  const fallbackFacts = fallbackProfile.facts || {};
  const hard = ai.hardConstraints && typeof ai.hardConstraints === 'object' ? ai.hardConstraints : {};
  const fallbackHard = fallbackProfile.hardConstraints || {};
  // 在校生/应届生判定（本地规则基于教育时间与关键词确定性判断）：在校优先实习，非在校用正式岗位
  const student = Array.isArray(fallbackHard.employmentTypes) && fallbackHard.employmentTypes.some((t) => t === '实习' || t === '校招');

  // 结构化字段本地锚定融合：方向/搜索词/技能/客观硬约束以本地规则为准，防止 AI 误判与编造；
  // 教育/经历/项目/摘要等语言性字段以 AI 为准（AI 抽取与润色更智能），本地兜底。
  const primaryDirections = mergeDirections(ai.primaryDirections, fallbackProfile.primaryDirections, student);
  const searchKeywords = mergeSearchKeywords(ai.searchKeywords, fallbackProfile.searchKeywords, primaryDirections, fallbackFacts.skills || []);
  const skills = mergeSkills(aiFacts.skills, fallbackFacts.skills || []);
  const locations = uniq([...fallbackHard.locations, ...normalizeStringList(hard.locations, 20)]).slice(0, 6);
  const employmentTypes = uniq([...fallbackHard.employmentTypes, ...normalizeStringList(hard.employmentTypes, 10)]).slice(0, 4);

  return normalizeProfile({
    ...fallbackProfile,
    ...ai,
    facts: {
      ...fallbackFacts,
      ...aiFacts,
      education: Array.isArray(aiFacts.education) && aiFacts.education.length ? aiFacts.education : fallbackFacts.education,
      experiences: Array.isArray(aiFacts.experiences) && aiFacts.experiences.length ? aiFacts.experiences : fallbackFacts.experiences,
      projects: Array.isArray(aiFacts.projects) && aiFacts.projects.length ? aiFacts.projects : fallbackFacts.projects,
      skills,
      certificates: Array.isArray(aiFacts.certificates) && aiFacts.certificates.length ? aiFacts.certificates : fallbackFacts.certificates,
    },
    primaryDirections,
    searchKeywords,
    hardConstraints: {
      ...fallbackHard,
      ...hard,
      locations,
      employmentTypes,
      salary: String(hard.salary || fallbackHard.salary || '不限'),
      experience: resolveExperience(fallbackHard.experience, hard.experience),
      degree: resolveDegree(fallbackHard.degree, hard.degree),
    },
    summary: String(ai.summary || fallbackProfile.summary),
    generation: generation || {
      mode: 'ai-assisted',
      label: 'AI 完整画像',
      aiStatus: 'success',
      warning: 'AI 返回的完整 JSON 已通过校验；结构化字段与本地规则初稿融合，防止方向误判与事实编造。',
      generatedAt: Date.now(),
    },
  });
}

function compactProfileToFull(compact: any, fallback: Profile): any {
  return {
    facts: {
      ...(fallback.facts || {}),
      skills: compact.skills.length ? compact.skills : fallback.facts?.skills || [],
    },
    primaryDirections: compact.primaryDirections,
    secondaryDirections: [],
    searchKeywords: compact.searchKeywords,
    hardConstraints: {
      ...(fallback.hardConstraints || {}),
      locations: compact.locations.length ? compact.locations : fallback.hardConstraints?.locations || [],
      employmentTypes: compact.employmentTypes.length ? compact.employmentTypes : fallback.hardConstraints?.employmentTypes || [],
      salary: compact.salary || fallback.hardConstraints?.salary || '不限',
      experience: compact.experience || fallback.hardConstraints?.experience || '',
      degree: compact.degree || fallback.hardConstraints?.degree || '不限',
    },
    excludeDirections: compact.excludeDirections,
    summary: compact.summary,
  };
}

// 将本地规则初稿转为结构化锚点，注入 AI 提示词（方向/搜索词/技能/硬约束以本地为准，AI 精修）
function profileToAnchor(profile: Profile) {
  return {
    primaryDirections: profile.primaryDirections.map((item) => (typeof item === 'string' ? item : item.name)),
    searchKeywords: profile.searchKeywords,
    skills: profile.facts.skills,
    locations: profile.hardConstraints.locations,
    employmentTypes: profile.hardConstraints.employmentTypes,
    degree: profile.hardConstraints.degree,
    experience: profile.hardConstraints.experience,
    salary: profile.hardConstraints.salary,
  };
}

export async function buildProfile(resumeText: string, model: AppConfig['model']): Promise<Profile> {
  const text = cleanResumeText(resumeText);
  const fallback = buildLocalProfile(text);
  const anchor = profileToAnchor(fallback);
  let firstError: Error | null = null;
  try {
    // 缓存：key 含简历全文与锚点，简历未改动时重复生成画像直接命中，避免 22K 输入重复计费
    const profile = validateGeneratedProfile(
      await cachedCallModel(
        [
          { role: 'system', content: buildProfilePromptWithAnchor(anchor) + skillInstructionsFor('profile') },
          { role: 'user', content: text.slice(0, 22000) },
        ],
        model,
        { maxTokens: 4200, temperature: 0.05 },
        { scope: 'profile' }
      )
    );
    return mergeProfileWithFallback(profile, fallback);
  } catch (error) {
    firstError = error as Error;
  }

  if (isRetryableAiOutputError(firstError as any)) {
    try {
      const compact = validateCompactGeneratedProfile(
        await cachedCallModel(
          [
            { role: 'system', content: buildCompactProfilePromptWithAnchor(anchor) + skillInstructionsFor('profile') },
            { role: 'user', content: text.slice(0, 18000) },
          ],
          model,
          { maxTokens: 2200, temperature: 0.05 },
          { scope: 'profile' }
        )
      );
      return mergeProfileWithFallback(compactProfileToFull(compact, fallback), fallback, {
        mode: 'ai-compact-retry',
        label: 'AI 精简重试结果',
        aiStatus: 'success-after-retry',
        warning: 'AI 连接正常。首次完整画像输出未完成，系统已自动精简重试并成功采用 AI 结果。',
        technicalReason: String((firstError as any)?.message || ''),
        generatedAt: Date.now(),
      });
    } catch (retryError) {
      const combined = `${(firstError as any)?.message || 'AI 首次输出未通过'}；精简重试：${(retryError as any)?.message || '失败'}`;
      return buildLocalProfile(text, combined, aiFailureKind(firstError as any));
    }
  }

  return buildLocalProfile(text, (firstError as any)?.message || 'AI 生成失败', aiFailureKind(firstError as any));
}

// ---- 归一化 ----
export function normalizeProfile(incoming: any, current: any = null): Profile {
  const base = current && typeof current === 'object' ? current : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const profile: Profile = {
    ...base,
    ...next,
    facts: {
      education: [], experiences: [], projects: [], certificates: [],
      ...(base.facts || {}),
      ...(next.facts || {}),
      skills: normalizeStringList(next.facts?.skills ?? base.facts?.skills, 40),
    },
    primaryDirections: normalizeDirections(next.primaryDirections ?? base.primaryDirections, base.primaryDirections),
    secondaryDirections: normalizeStringList(next.secondaryDirections ?? base.secondaryDirections, 10),
    searchKeywords: normalizeStringList(next.searchKeywords ?? base.searchKeywords, 12),
    excludeDirections: normalizeStringList(next.excludeDirections ?? base.excludeDirections, 20),
    hardConstraints: {
      locations: [], employmentTypes: [], salary: '', experience: '', degree: '',
      ...(base.hardConstraints || {}),
      ...(next.hardConstraints || {}),
    },
    summary: String(next.summary ?? base.summary ?? '').trim(),
    editedAt: Date.now(),
  };
  profile.hardConstraints.locations = normalizeStringList(profile.hardConstraints.locations, 20);
  profile.hardConstraints.employmentTypes = normalizeStringList(profile.hardConstraints.employmentTypes, 10);
  profile.hardConstraints.salary = String(profile.hardConstraints.salary || '').trim();
  profile.hardConstraints.experience = String(profile.hardConstraints.experience || '').trim();
  profile.hardConstraints.degree = String(profile.hardConstraints.degree || '').trim();
  if (!profile.primaryDirections.length) throw new Error('职业画像至少需要一个主方向');
  if (!profile.searchKeywords.length) throw new Error('职业画像至少需要一个岗位搜索词');
  return profile;
}

function normalizeDirections(value: any, existing: any[] = []): any[] {
  const previous = new Map(
    (Array.isArray(existing) ? existing : []).map((item) => [String(typeof item === 'string' ? item : item?.name || '').trim(), item])
  );
  return normalizeStringList(value, 3).map((name) => {
    const old = previous.get(name);
    if (old && typeof old === 'object') return { ...old, name };
    // 用户手动编辑的方向：不默认给满分（否则会渲染成 100 分），也不把「用户手动编辑」当作真实证据展示
    return { name, confidence: 0.75, evidence: [] };
  });
}

export function profileHasCore(profile: Profile | ProfileDraft | null): boolean {
  return Boolean(
    profile &&
      normalizeStringList(profile.primaryDirections, 3).length &&
      normalizeStringList(profile.searchKeywords, 12).length
  );
}

// ---- 草稿 <-> 画像 ----
export function normalizeProfileDraft(incoming: any, fallback: any = null): ProfileDraft {
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const chooseList = (key: string, limit = 30) =>
    Object.prototype.hasOwnProperty.call(next, key) ? normalizeStringList(next[key], limit) : normalizeStringList(base[key], limit);
  const chooseText = (key: string) =>
    Object.prototype.hasOwnProperty.call(next, key) ? String(next[key] || '').trim() : String(base[key] || '').trim();
  return {
    summary: chooseText('summary'),
    primaryDirections: chooseList('primaryDirections', 3),
    searchKeywords: chooseList('searchKeywords', 12),
    skills: chooseList('skills', 40),
    locations: chooseList('locations', 20),
    employmentTypes: chooseList('employmentTypes', 10),
    experience: chooseText('experience'),
    degree: chooseText('degree'),
    salary: chooseText('salary'),
    excludeDirections: chooseList('excludeDirections', 20),
    source: String(next.source || base.source || 'draft'),
    updatedAt: Number(next.updatedAt || Date.now()),
  };
}

export function profileDraftHasCore(draft: ProfileDraft | null): boolean {
  return Boolean(
    draft &&
      normalizeStringList(draft.primaryDirections, 3).length &&
      normalizeStringList(draft.searchKeywords, 12).length
  );
}

export function profileDraftHasAny(draft: ProfileDraft | null): boolean {
  if (!draft || typeof draft !== 'object') return false;
  return Boolean(
    String(draft.summary || '').trim() ||
      normalizeStringList(draft.primaryDirections).length ||
      normalizeStringList(draft.searchKeywords).length ||
      normalizeStringList(draft.skills).length ||
      normalizeStringList(draft.locations).length ||
      normalizeStringList(draft.employmentTypes).length ||
      String(draft.experience || '').trim() ||
      String(draft.degree || '').trim() ||
      String(draft.salary || '').trim() ||
      normalizeStringList(draft.excludeDirections).length
  );
}

export function profileToDraft(profile: Profile | null, source = 'generated'): ProfileDraft {
  const hard: HardConstraints = profile?.hardConstraints || { locations: [], employmentTypes: [], salary: '', experience: '', degree: '' };
  return normalizeProfileDraft({
    summary: profile?.summary || '',
    primaryDirections: normalizeStringList(profile?.primaryDirections, 3),
    searchKeywords: normalizeStringList(profile?.searchKeywords, 12),
    skills: normalizeStringList(profile?.facts?.skills, 40),
    locations: normalizeStringList(hard.locations, 20),
    employmentTypes: normalizeStringList(hard.employmentTypes, 10),
    experience: hard.experience || '',
    degree: hard.degree || '',
    salary: hard.salary || '',
    excludeDirections: normalizeStringList(profile?.excludeDirections, 20),
    source,
    updatedAt: Date.now(),
  });
}

export function profileFromDraft(draft: ProfileDraft, currentProfile: Profile | null = null): Profile {
  const normalized = normalizeProfileDraft(draft);
  return normalizeProfile({
    ...(currentProfile || {}),
    summary: normalized.summary,
    primaryDirections: normalized.primaryDirections,
    searchKeywords: normalized.searchKeywords,
    excludeDirections: normalized.excludeDirections,
    facts: { ...(currentProfile?.facts || {}), skills: normalized.skills },
    hardConstraints: {
      ...(currentProfile?.hardConstraints || {}),
      locations: normalized.locations,
      employmentTypes: normalized.employmentTypes,
      experience: normalized.experience,
      degree: normalized.degree,
      salary: normalized.salary,
    },
  }, currentProfile);
}
