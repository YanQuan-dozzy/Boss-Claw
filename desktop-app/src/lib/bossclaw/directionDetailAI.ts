// 投递方向「AI 复核细化」：对每个方向，结合画像细粒度能力 + 简历原文，
// 产出细化后的「匹配技能」与「真实能力缺口」，修正本地静态目录粗词（如「数据库」）的误报。
//
// 设计要点：
// - 不新增按钮：由「根据画像更新」动作在本地 buildDirectionPlan 之后自动调用（AI 未配置/失败时静默回退本地）。
// - 一次调用覆盖全部方向；只补 matchedSkills/gaps 两个字段，不改动方向优先级/搜索词/启用状态。
// - matchedSkills 只能引用简历真实事实；gaps 只写该方向真实缺失的能力，细粒度、如实，不灌水。
// - 不复用本地一致性缓存（方向计划为确定性小对象，cache key 不稳定），成功失败由调用方降级。
import type { AppConfig, DirectionItem, Profile } from './types';
import type { ChatMessage } from './llm';
import { callModel, extractJson } from './llm';
import { normalizeDirectionKey, normalizeStringList } from './helpers';
import { uniq } from './defaults';

const SYSTEM_PROMPT = `你是求职方向的能力匹配核对助手。用户会给出若干「求职方向」与求职者的简历素材（细粒度能力清单 + 技能 + 经历/项目 + 简历原文摘录）。

请对每个方向输出两个清单：
1. matchedSkills：该方向岗位通常要求、且求职者简历中**真实具备**的匹配技能/能力（只能引用简历素材里有的，每项 ≤20 字，最多 6 项）。
2. gaps：该方向岗位通常需要、但求职者简历**明显没有**的真实能力缺口。要求：**完整梳理后按缺口重要性从高到低取前 5**（每项 ≤20 字，共 5 项）；**不得为了凑数而把已具备的能力报成缺口**；只写确属缺失的实质能力；**严禁**把简历已体现的能力报成缺口（例如简历已熟练 PostgreSQL/MySQL/SQL 调优/索引/事务，就**不得**把「数据库」列为缺口，应细化为它真正缺的部分）。

注意：要与简历实际内容逐一对齐。matchedSkills 与 gaps 都尽量细化、具体、可操作，不要用「数据库」「接口设计」这类宽泛词；简历已覆盖的领域不得进入 gaps；**若确实没有实质缺口，就如实只列 1 项或留空，严禁编造/凑数**。

【输出 schema】只输出以下字段（字段名与类型不可变更；items 需覆盖用户给出的每一个方向）：
{"items":[{"name":"方向名","matchedSkills":["..."],"gaps":["..."]}]}

【输出样例】（仅示意字段格式与写法，内容必须来自简历素材真实事实，不得照抄样例内容）：
{"items":[{"name":"后端开发","matchedSkills":["PostgreSQL 索引与事务","SQL 调优","Spring Boot 接口开发"],"gaps":["Kubernetes：岗位常要求容器编排与集群运维，简历未体现相关经历，建议补充实操项目"]}]}

只输出一个 json 对象，不要任何解释文字、不要代码块围栏。`;

export interface DirectionDetailRefineInput {
  items: DirectionItem[];
  profile?: Profile | null;
  resumeText?: string;
}

export interface DirectionDetailRefineResult {
  /** 命中的方向条目，按方向名归一化对齐 */
  name: string;
  matchedSkills: string[];
  gaps: string[];
}

/** 解析并清洗 AI 返回的方向细节（去重、限长、剔除空项），按方向名归一化便于回填。 */
export function parseDirectionDetails(raw: unknown): DirectionDetailRefineResult[] {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try {
      parsed = extractJson(raw);
    } catch {
      console.warn('[directionDetailAI] AI 返回 JSON 解析/修复失败，本次方向细化将回退为本地：', raw.slice(0, 240));
      parsed = null;
    }
  }
  const items = Array.isArray((parsed as any)?.items)
    ? (parsed as any).items
    : Array.isArray(parsed)
      ? parsed
      : [];
  const out: DirectionDetailRefineResult[] = [];
  for (const item of items) {
    const name = String(item?.name || item?.direction || '').trim();
    if (!name) continue;
    const matchedSkills = uniq(normalizeStringList(item?.matchedSkills, 8)).slice(0, 6);
    const gaps = uniq(normalizeStringList(item?.gaps, 8)).slice(0, 5);
    out.push({
      name,
      matchedSkills: matchedSkills.map((s) => s.slice(0, 20)),
      gaps: gaps.map((s) => s.slice(0, 20)),
    });
  }
  return out;
}

/**
 * 一次 AI 调用，为给定投递方向列表产出细粒度的匹配技能与真实能力缺口。
 * 失败或未配置 API Key 时抛错，由调用方（「根据画像更新」）静默回退本地结果。
 */
export async function refineDirectionCapabilities(
  input: DirectionDetailRefineInput,
  config: AppConfig['model']
): Promise<DirectionDetailRefineResult[]> {
  if (!config?.apiKey) throw new Error('请先在「设置」页填写 AI API Key');
  const facts: Profile['facts'] = input.profile?.facts || {
    education: [], experiences: [], projects: [], skills: [], capabilities: [], certificates: [],
  };
  const capabilities = normalizeStringList(facts.capabilities, 30);
  const skills = normalizeStringList(facts.skills, 20);
  const experiences = normalizeStringList(facts.experiences, 4);
  const projects = normalizeStringList(facts.projects, 4);
  const userPayload = {
    求职方向: normalizeStringList(input.items.map((it) => it.name), 12),
    画像细粒度能力: capabilities.length ? capabilities : skills,
    画像技能: skills,
    经历与项目: [...experiences, ...projects],
    简历原文摘录: String(input.resumeText || '').trim().slice(0, 4000),
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请核对下面每个求职方向的匹配技能与能力缺口：\n${JSON.stringify(userPayload, null, 2)}` },
  ];
  const raw = await callModel(messages, config, { jsonMode: true, temperature: 0.2, maxTokens: 1600 });
  const details = parseDirectionDetails(raw);
  if (!details.length) throw new Error('AI 未返回可用的方向细化结果');
  return details;
}

/** 按方向名把 AI 细化结果合并进已有方向项（仅覆盖 matchedSkills/gaps），返回新列表。 */
export function applyDirectionDetails(
  items: DirectionItem[],
  details: DirectionDetailRefineResult[]
): DirectionItem[] {
  if (!details.length) return items;
  const byKey = new Map(details.map((d) => [normalizeDirectionKey(d.name), d]));
  return items.map((item) => {
    const detail = byKey.get(normalizeDirectionKey(item.name));
    if (!detail) return item;
    return {
      ...item,
      matchedSkills: detail.matchedSkills.length ? detail.matchedSkills : item.matchedSkills,
      gaps: detail.gaps.length ? detail.gaps : item.gaps,
      updatedAt: Date.now(),
    };
  });
}