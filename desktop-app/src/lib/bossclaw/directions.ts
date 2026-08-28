// 移植自 job-claw-main\source\src\background.js 的岗位方向计划逻辑
import type { DirectionItem, DirectionPlan, Profile } from './types';
import { normalizeStringList, clampNumber, normalizeDirectionKey, findDirectionRule } from './helpers';

// 证据占位符（仅作标记，不应作为「职业画像中已提取到」的真实证据展示）
const MANUAL_EDIT_EVIDENCE = '用户手动编辑';
const PLACEHOLDER_EVIDENCE = new Set([MANUAL_EDIT_EVIDENCE, '根据简历中的技能、项目和求职阶段生成']);

export function directionPreset(name: string) {
  return findDirectionRule(name) || null;
}

export function stableDirectionId(name: string, source = 'profile'): string {
  const input = `${source}:${normalizeDirectionKey(name) || String(name || '').trim().toLowerCase()}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `direction_${(hash >>> 0).toString(36)}`;
}

function normalizedSkillSet(profile: Profile = {} as Profile): Map<string, string> {
  return new Map(normalizeStringList(profile?.facts?.skills, 50).map((skill) => [normalizeDirectionKey(skill), skill]));
}

export function buildDirectionKeywords(name: string, profile: Profile = {} as Profile): string[] {
  const allKeywords = normalizeStringList(profile?.searchKeywords, 30);
  const nameKey = normalizeDirectionKey(name);
  const preset = directionPreset(name);
  // 方向名是否为实习/校招风格，用于保持搜索词风格一致（避免「全栈开发」方向混入「全栈开发实习生」搜索词）
  const nameIntern = /实习生|校招|应届/.test(name);
  const matching = allKeywords.filter((keyword) => {
    const key = normalizeDirectionKey(keyword);
    if (!key || !nameKey) return false;
    if (nameKey !== key && !key.startsWith(nameKey) && !nameKey.startsWith(key)) return false;
    // 剩余部分若为纯字母（如「java」匹配到「javascript」的「script」），视为不同词，避免跨词错配
    const tail = key.startsWith(nameKey) ? key.slice(nameKey.length) : nameKey.slice(key.length);
    if (tail && /^[a-z]+$/i.test(tail)) return false;
    // 保持实习/全职风格一致
    return /实习生|校招|应届/.test(keyword) === nameIntern;
  });
  return normalizeStringList([name, ...matching, ...(preset?.keywords || [])].filter(Boolean)).slice(0, 8);
}

export function buildDirectionEvidence(name: string, candidate: any = {}, profile: Profile = {} as Profile) {
  const skills = normalizeStringList(profile?.facts?.skills, 30);
  const skillMap = normalizedSkillSet(profile);
  const preset = directionPreset(name);
  const relevant = (preset?.relevantSkills || skills).filter((skill) => {
    const key = normalizeDirectionKey(skill);
    return skillMap.has(key) || skills.some((current) => normalizeDirectionKey(current).includes(key) || key.includes(normalizeDirectionKey(current)));
  });
  const matchedSkills = normalizeStringList(relevant.length ? relevant : skills.slice(0, 4)).slice(0, 5);
  const gaps = (preset?.gapSkills || [])
    .filter((skill) => {
      const key = normalizeDirectionKey(skill);
      return ![...skillMap.keys()].some((existing) => existing.includes(key) || key.includes(existing));
    })
    .slice(0, 3);
  const evidence = normalizeStringList(candidate?.evidence, 3).filter((item) => !PLACEHOLDER_EVIDENCE.has(item));
  const reason = evidence.length
    ? `职业画像中已提取到：${evidence.join('；')}`.slice(0, 160)
    : matchedSkills.length
      ? `与简历中的 ${matchedSkills.join('、')} 技能和项目经历匹配。`
      : `该方向来自职业画像中的主要求职方向，可继续人工调整。`;
  return { matchedSkills, gaps, reason };
}

export function normalizeDirectionItem(item: any = {}, index = 0): DirectionItem {
  const name = String(item.name || item.title || '').trim().slice(0, 60);
  const source = item.source === 'custom' || item.custom ? 'custom' : 'profile';
  const id = String(item.id || stableDirectionId(name || `custom-${index}`, source));
  return {
    id,
    source,
    custom: source === 'custom',
    sourceName: String(item.sourceName || name).trim().slice(0, 60),
    name,
    enabled: item.enabled !== false,
    priority: Math.round(clampNumber(item.priority, 1, 99, index + 1)),
    score: Math.round(clampNumber(item.score, 0, 100, source === 'custom' ? 70 : Math.max(60, 88 - index * 7))),
    reason: String(item.reason || (source === 'custom' ? '用户自定义岗位方向。' : '根据职业画像推荐。')).trim().slice(0, 240),
    matchedSkills: normalizeStringList(item.matchedSkills, 8),
    gaps: normalizeStringList(item.gaps, 6),
    keywords: normalizeStringList(item.keywords, 12).length ? normalizeStringList(item.keywords, 12) : [name],
    updatedAt: Number(item.updatedAt || Date.now()),
  };
}

function profileDirectionSignature(profile: Profile = {} as Profile): string {
  return JSON.stringify({
    directions: normalizeStringList(profile?.primaryDirections?.map((item) => (typeof item === 'string' ? item : item?.name)), 6).map(normalizeDirectionKey),
    keywords: normalizeStringList(profile?.searchKeywords, 20).map(normalizeDirectionKey),
  });
}

export function normalizeDirectionPlan(plan: any, profile: Profile | null = null, options: any = {}): DirectionPlan {
  const items = (Array.isArray(plan?.items) ? plan.items : [])
    .map((item: any, index: number) => normalizeDirectionItem(item, index))
    .filter((item: DirectionItem) => item.name && item.keywords.length)
    .sort((left: DirectionItem, right: DirectionItem) => left.priority - right.priority || right.score - left.score)
    .slice(0, 12)
    .map((item: DirectionItem, index: number) => ({ ...item, priority: index + 1 }));
  return {
    version: 1,
    items,
    confirmed: options.confirmed ?? Boolean(plan?.confirmed),
    updatedAt: Number(options.updatedAt || plan?.updatedAt || Date.now()),
    appliedAt: Number(options.appliedAt || plan?.appliedAt || 0),
    profileSignature: String(options.profileSignature || plan?.profileSignature || profileDirectionSignature(profile as Profile)).slice(0, 600),
  };
}

export function buildDirectionPlan(profile: Profile | null = null, currentPlan: DirectionPlan | null = null, options: any = {}): DirectionPlan {
  const p = (profile || {}) as Profile;
  const primary = Array.isArray(p?.primaryDirections) ? p.primaryDirections : [];
  const secondary = Array.isArray(p?.secondaryDirections) ? p.secondaryDirections : [];
  const searchKeywords = normalizeStringList(p?.searchKeywords, 20);
  const candidates: { name: string; raw: any }[] = [];
  for (const item of [...primary, ...secondary]) {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim();
    if (!name || candidates.some((candidate) => normalizeDirectionKey(candidate.name) === normalizeDirectionKey(name))) continue;
    candidates.push({ name, raw: typeof item === 'object' ? item : {} });
  }
  for (const keyword of searchKeywords) {
    if (candidates.length >= 6) break;
    if (!findDirectionRule(keyword)) continue;
    if (candidates.some((candidate) => normalizeDirectionKey(candidate.name) === normalizeDirectionKey(keyword))) continue;
    candidates.push({ name: keyword, raw: {} });
  }
  if (!candidates.length) candidates.push({ name: '目标岗位', raw: {} });

  const existing = new Map((currentPlan?.items || []).map((item) => [String(item.id || ''), item]));
  const generated = candidates.slice(0, 6).map((candidate, index) => {
    const id = stableDirectionId(candidate.name, 'profile');
    const previous = existing.get(id);
    // 手动编辑的方向（旧数据可能残留「用户手动编辑」证据 + confidence=1）不默认满分
    const rawEvidence = normalizeStringList(candidate.raw?.evidence, 3);
    const manualEdited = rawEvidence.includes(MANUAL_EDIT_EVIDENCE);
    const confidence = manualEdited ? 0.75 : Number(candidate.raw?.confidence);
    const score = Number.isFinite(confidence) ? Math.round(confidence <= 1 ? confidence * 100 : confidence) : Math.max(62, 90 - index * 7);
    const evidence = buildDirectionEvidence(candidate.name, candidate.raw, p);
    return normalizeDirectionItem({
      id,
      source: 'profile',
      sourceName: candidate.name,
      name: options.preserveEdits && previous?.name ? previous.name : candidate.name,
      enabled: options.preserveSelections && previous ? previous.enabled : index < 3,
      priority: previous?.priority || index + 1,
      score,
      reason: evidence.reason,
      matchedSkills: evidence.matchedSkills,
      gaps: evidence.gaps,
      // 默认沿用旧搜索词；显式指定 preserveKeywords:false 时（如「根据画像更新」）强制重算，以修复历史错误关键词
      keywords: options.preserveEdits && options.preserveKeywords !== false && previous?.keywords?.length ? previous.keywords : buildDirectionKeywords(candidate.name, p),
    }, index);
  });
  const custom = options.preserveCustom === false ? [] : (currentPlan?.items || []).filter((item) => item?.source === 'custom' || item?.custom).map((item, index) => normalizeDirectionItem(item, generated.length + index));
  return normalizeDirectionPlan(
    {
      items: [...generated, ...custom],
      confirmed: options.confirmed ?? false,
      updatedAt: Date.now(),
      appliedAt: options.confirmed ? Date.now() : Number(currentPlan?.appliedAt || 0),
    },
    p,
    { confirmed: options.confirmed ?? false, updatedAt: Date.now() }
  );
}

export function selectedDirectionItems(plan: DirectionPlan | null = null): DirectionItem[] {
  return (Array.isArray(plan?.items) ? plan.items : [])
    .map((item, index) => normalizeDirectionItem(item, index))
    .filter((item) => item.enabled && item.name && item.keywords.length)
    .sort((left, right) => left.priority - right.priority || right.score - left.score);
}
