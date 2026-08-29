// BossClaw AI Skills 层 —— 标准 SKILL.md 技能体系
// 技能定义（名称/描述/作用域/指令正文）存放在 `desktop-app/skills/<id>/SKILL.md`
// （标准格式：frontmatter 含 name/description/scope/defaultEnabled，正文为指令），
// 由主进程 IPC（jc:skills-list / jc:skills-read）读取，软件运行时调用 AI 时按作用域启用注入。
//
// 机制：
//   - 每个 skill 绑定一个 AI 调用作用域（scope），启用时把正文指令追加到该调用点的 system prompt；
//   - 启用状态持久化 localStorage（bossclaw-skills-v1），默认全部启用；
//   - IPC 不可用/未加载完成时，回退内置 BOSS_SKILLS（与 SKILL.md 正文一致），保证功能可用；
//   - 技能指令是 system prompt 的一部分：开关变化 → messages 变化 → AI 缓存 key 自动失效。

import type { AICacheScope } from './llm';

export type SkillScope = AICacheScope; // 'profile' | 'job-analysis' | 'greetings' | 'assistant'

export interface BossSkill {
  /** 技能 ID（唯一，= skills/<id> 目录名） */
  id: string;
  /** 展示名 */
  name: string;
  /** 一句话说明（设置页展示） */
  description: string;
  /** 绑定的 AI 调用作用域 */
  scope: SkillScope;
  /** 默认启用 */
  defaultEnabled: boolean;
  /** 指令正文（SKILL.md 正文；IPC 不可用时用内置兜底） */
  instructions: string;
  /** 是否用户自定义技能（true=存储在 userData/skills，可删除；false=内置只读） */
  custom?: boolean;
}

// ===== 内置技能注册表（IPC 不可用 / 未加载完成时的兜底，与 SKILL.md 正文一致） =====

export const BOSS_SKILLS: BossSkill[] = [
  {
    id: 'resume-profile',
    name: '职业画像',
    description: '简历 → 职业画像：本地规则锚点 + AI 精修，方向覆盖全行业',
    scope: 'profile',
    defaultEnabled: true,
    instructions:
      '仅使用简历真实事实生成画像，禁止推断或编造技能/经历/成果；主方向覆盖全部职业场景（技术/产品/设计/运营/市场/销售/人力资源/财务/法务/行政/客服/供应链/制造/建筑/医疗/教育/传媒/咨询/电商/翻译等全行业职能岗位），按整体技能栈权重判断，不得仅因前端关键词把全栈/后端/AI 背景误判为前端；在校生/应届生岗位名一律用"XX实习生"且求职类型以"实习"为先，社会求职者用正式岗位名且求职类型为"全职"；搜索词必须是真实岗位名称；教育/经历/项目各最多 4 条、每条不超过 80 字，技能最多 15 个，摘要 120-180 字且只引用简历事实；即使信息不完整也必须给出可编辑初稿，禁止返回空内容。',
  },
  {
    id: 'job-analysis',
    name: '岗位匹配评估',
    description: '岗位分析：硬条件门槛 + 技能匹配评分 + 第一人称打招呼草稿',
    scope: 'job-analysis',
    defaultEnabled: true,
    instructions:
      '评分必须稳定（同一岗位重复分析波动 ≤±5）且与决策档位一致（recommend 80-95 / cautious 55-74 / reject ≤35），严禁所有岗位挤在 60-70 之间；硬性条件（学历/经验年限/地点/求职类型）不满足记入 hardBlocks 且 score ≤35；严禁把招聘方在线/活跃状态或岗位发布时间当作匹配理由；greeting 必须求职者第一人称（"您好，我想应聘贵公司的{岗位名}"开头），只引用简历事实，严禁招聘方口吻，不得承诺薪资、到岗时间、面试时间。',
  },
  {
    id: 'greetings',
    name: '打招呼语',
    description: '简历级 4 条打招呼语：技能匹配 / 项目经验 / 岗位兴趣 / 简洁版',
    scope: 'greetings',
    defaultEnabled: true,
    instructions:
      '生成 4 条打招呼语且角度各不相同（技能匹配 / 项目经验 / 岗位兴趣 / 简洁版），每条 50-110 字；全部使用求职者第一人称口吻（"您好，我想应聘……"），严禁招聘方口吻（"看到你的简历""你的经历很匹配我们""欢迎进一步沟通""我们团队""候选人"等）；只能引用简历真实事实（技能/项目/经验/教育），不得编造或承诺薪资、到岗时间、面试时间、不存在的能力；输出严格 JSON。',
  },
  {
    id: 'tailor-cv',
    name: '岗位定制简历',
    description: '根据岗位 JD 定制简历：匹配技能 / 量化经历 / 摘要 / 求职信 / 优化建议',
    scope: 'assistant',
    defaultEnabled: true,
    instructions:
      '只引用简历/画像真实事实定制内容；岗位 JD 只作匹配参照，JD 要求但简历缺失的能力必须如实列入 skillGaps，绝不写进摘要或求职信当作自己具备；tailoredSummary 120-180 字开头点明身份、突出与岗位最相关的真实技能与项目；tailoredExperiences 2-4 条按岗位相关性重排改写（每条 ≤80 字），量化改写规则：简历事实本身含数字（规模/时长/效率）时才允许提炼为「行动动词+可量化成果」句式，简历没有数字就保持事实描述，严禁编造或推算任何百分比、金额、人数、用户量、时长；coverLetter 为第一人称求职打招呼语（"您好，我想应聘贵公司的{岗位名}"开头），80-160 字，严禁招聘方口吻，不得承诺薪资、到岗时间、面试时间；suggestions 为 3-5 条可执行的优化建议（基于简历与 JD 的真实差距），每条 ≤40 字，不得建议编造事实。',
  },
];

// ===== 磁盘加载（skills/*/SKILL.md，经主进程 IPC） =====

interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  defaultEnabled: boolean;
  custom: boolean;
  body: string;
}

let loadedSkills: LoadedSkill[] | null = null;
let loadPromise: Promise<void> | null = null;

/** 使已加载定义失效（导入/删除自定义技能后调用，下次访问自动重载） */
function invalidateSkills(): void {
  loadedSkills = null;
  loadPromise = null;
}

/** 从磁盘加载 skills 目录下各 SKILL.md 定义（幂等；失败时保持内置兜底，不阻塞调用） */
export async function ensureSkillsLoaded(): Promise<void> {
  if (loadedSkills) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const list: any[] = (await window.electron?.skillsList?.()) || [];
      const defs = await Promise.all(
        list.map(async (s: any) => {
          const body = String((await window.electron?.skillsRead?.(s.id))?.body || '');
          return {
            id: String(s.id || ''),
            name: String(s.name || s.id || ''),
            description: String(s.description || ''),
            scope: (['profile', 'job-analysis', 'greetings', 'assistant'].includes(s.scope) ? s.scope : 'assistant') as SkillScope,
            defaultEnabled: s.defaultEnabled !== false,
            custom: Boolean(s.custom),
            body,
          } as LoadedSkill;
        })
      );
      if (defs.length) loadedSkills = defs;
    } catch {
      /* IPC 不可用：保持 null，走内置兜底 */
    }
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function currentDefs(): LoadedSkill[] | BossSkill[] {
  if (loadedSkills && loadedSkills.length) return loadedSkills;
  return BOSS_SKILLS;
}

function findSkill(id: string): (LoadedSkill | BossSkill) | undefined {
  return currentDefs().find((s) => s.id === id);
}

// ===== 启用状态持久化（localStorage，独立于业务配置） =====

const SKILL_STATE_KEY = 'bossclaw-skills-v1';

function loadState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SKILL_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, boolean>;
    }
  } catch {
    /* 数据损坏则重建 */
  }
  return {};
}

function saveState(states: Record<string, boolean>): void {
  try {
    localStorage.setItem(SKILL_STATE_KEY, JSON.stringify(states));
  } catch {
    /* 存储不可用时静默降级 */
  }
}

/** 读取某技能是否启用（未记录时按 defaultEnabled） */
export function isSkillEnabled(id: string): boolean {
  const skill = findSkill(id);
  if (!skill) return false;
  const state = loadState();
  return state[id] ?? skill.defaultEnabled;
}

/** 启停某技能（true=启用）。开关变化会改变注入指令 → 对应 AI 缓存 key 自动失效。 */
export function setSkillEnabled(id: string, enabled: boolean): void {
  if (!findSkill(id)) return;
  const state = loadState();
  state[id] = enabled;
  saveState(state);
}

/** 全部技能 + 当前启用状态（设置页渲染用；未加载完成时自动触发磁盘加载） */
export function allSkillsWithState(): (BossSkill & { enabled: boolean })[] {
  void ensureSkillsLoaded(); // 惰性加载：本次先返回当前可见定义，加载完成后调用方刷新
  const state = loadState();
  return currentDefs().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    scope: s.scope,
    defaultEnabled: s.defaultEnabled,
    instructions: 'body' in s ? s.body : s.instructions,
    custom: 'custom' in s ? s.custom : false,
    enabled: state[s.id] ?? s.defaultEnabled,
  }));
}

/** 恢复全部技能为默认启用 */
export function resetAllSkills(): void {
  saveState({});
}

// ===== 自定义技能（导入 / 新建 / 删除，经主进程写 userData/skills） =====

export interface CustomSkillFields {
  name: string;
  description?: string;
  scope: SkillScope;
  instructions: string;
}

type SkillOpResult = { ok: boolean; error?: string };

/** 导入 SKILL.md 全文（frontmatter + 正文），成功后在下次访问时重载技能列表 */
export async function importSkillFromRaw(raw: string): Promise<SkillOpResult> {
  try {
    const r = (await window.electron?.skillsImport?.({ raw })) || { ok: false, error: 'IPC 不可用' };
    if (r.ok) invalidateSkills();
    return { ok: Boolean(r.ok), error: r.error };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 新建自定义技能（表单字段），成功后在下次访问时重载技能列表 */
export async function createCustomSkill(fields: CustomSkillFields): Promise<SkillOpResult> {
  try {
    const r = (await window.electron?.skillsImport?.({ fields: { ...fields, scope: fields.scope } })) || { ok: false, error: 'IPC 不可用' };
    if (r.ok) invalidateSkills();
    return { ok: Boolean(r.ok), error: r.error };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 删除自定义技能（内置技能主进程会拒绝），成功后重载技能列表 */
export async function deleteCustomSkill(id: string): Promise<SkillOpResult> {
  try {
    const r = (await window.electron?.skillsDelete?.(id)) || { ok: false, error: 'IPC 不可用' };
    if (r.ok) invalidateSkills();
    return { ok: Boolean(r.ok), error: r.error };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 按作用域返回启用技能的指令（含引导语），供各 AI 调用点追加到 system prompt 末尾。
 * 无启用技能时返回空串，调用点应只在非空时拼接，避免污染提示词。
 * 未加载完成时先用内置定义（与 SKILL.md 正文一致），并惰性触发磁盘加载。
 */
export function skillInstructionsFor(scope: SkillScope): string {
  void ensureSkillsLoaded();
  const state = loadState();
  const enabled = currentDefs().filter((s) => s.scope === scope && (state[s.id] ?? s.defaultEnabled));
  if (!enabled.length) return '';
  const blocks = enabled.map((s) => {
    const body = 'body' in s ? s.body : s.instructions;
    return `【AI 技能 · ${s.name}】（由软件 skills 层注入，必须遵守）\n${body}`;
  });
  return `\n\n${blocks.join('\n\n')}`;
}
