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
      '先读懂 JD，分三层（判定骨架）：\n1. 硬门槛：学历、行业背景、地点、是否接受远程/出差、求职类型。任一明确不满足 → 直接判不推荐（fitLevel=unfit、decision=reject、score=40），记入 hardBlocks，不再往下看。\n经验年限与语言要求（不足→谨慎，绝不判不推荐）：岗位要求常被夸大、与实际差距大，不能仅凭年限或语言否决岗位；年限不足或未体现语言证书 → 降到谨慎档（60），reason 说明能否用真实同领域经历/项目补位。达标则正常参与匹配。\n2. 优先条件：「优先/加分/更佳」。有可迁移经历补位才算覆盖，否则只降不升。\n3. 职责信号：反复提「沟通/推进/协同/复盘」→重推进能力；「转化/留存/增长/投放」→重结果导向；「方案/需求/迭代」→重结构化思考。据此判断「活对不对口」。\n团队信号（快速变化/体系完善等）只作中性提示，不参与打分。\n误区：①别只看职位名，看职责；②JD 有理想化成分，找到能对上的核心点即可，找不到就按缺口对待。\n\n整体分 score：分两步判定——先判推荐与不推荐，再对达标岗分配匹配/谨慎并按贴合度细化：\n- 不推荐 unfit（0-49）：先按硬门槛/领域级技术栈错位/方向完全错位判定，命中即 reject（常见 20-40）。\n- 推荐 strong（81-100）：极稀有，仅方向高度同向+核心技能直接命中+零实质缺口+优先条件多数覆盖才给（81-90，91+几乎不给）。\n- 其余达标岗大致匹配约 60% / 谨慎约 40% 分配（不要全匹配、也别全谨慎），并按 JD×简历贴合度在各自档内细化：匹配 match（65-80）普通65-68/较好69-72/很强73-76/近乎完美77-80（80极少，避免一堆75+）；谨慎 cautious（50-64）弱50-53/中54-58/强59-64。\n同档内按贴合度上下取值，严禁同一档全打同一分（如清一色64/75/80）。\n\ndimensionScores 五维各自独立评分、各自拉开、不许全 80-95，每维 {score: 0-100 整数, evidence: ≤30字依据}：\nskill 技能：全命中 90 / 大多命中有个别缺 80 / 需迁移或学 70 / 缺口明显 60 / 缺口很重 50 / 领域级错位 20\ndirection 方向：完全同向 90 / 基本同向 80 / 近似 70 / 有偏移 60 / 弱相关 50 / 错位 40\nsalary 薪资（按本地校准信息）：达标偏上 85 / 高度重叠 75 / 部分重叠偏低 60 / 明显低于期望 30 / 期望未设或面议 60\neducation 学历：达标 90 / 高于要求 70 / 未要求 65 / 不达标 30\nexperience 经验（年限比例）：≥要求 85 / 八成 75 / 六成 60 / 四成 45 / 不足 30 / 未要求 60\n技术栈错位不做一刀切：仅「领域级」无关才算根本错位（如岗位核心在电子/硬件/嵌入式/通信基带/固件、简历只有纯软件开发）；同属软件开发时语言/框架不同不算错位（Java↔Python、React↔Vue、前端↔后端、Go↔Java、C#↔Java），按需迁移/现学给 60-70；判定的对象是岗位每天做的核心工作，不是某个语言名。技能维 ≤25 时整体档位不得高于谨慎。信息不足给中性分（技能/方向 50、薪资 60、学历 65、经验 60）并在 evidence 写明「无可比对信息」；五维加权（34/28/14/8/6）只作总分档内微调、不得改变 fitLevel。\n\nmatchedEvidence 写 3-6 条「岗位要求 X — 简历具备 Y」真实证据（每条 ≤40 字，禁无证据泛词）；gaps 只列岗位明确要求而简历未涉及的实质技能（≤3 条，格式「技能名：匹配说明」，同义/同族已覆盖不算缺口、非技能词不计），硬性条件不满足记入 hardBlocks；greeting 用求职者第一人称（「您好，我想应聘贵公司的{岗位名}」开头），项目亮点精炼（只挑 1-2 个最相关真实项目/技能、一句话概括，禁罗列技术栈清单），全文 ≤250 字单行，仅引用简历事实，禁承诺薪资/到岗/面试时间；以上判断严禁编造简历不存在的技能。',
  },
  {
    id: 'greetings',
    name: '打招呼语（工作台定制）',
    description: '工作台定制打招呼语（求职信）：按岗位生成第一人称求职招呼语，统一口径（工作台 / 简历中心预览 / 定制简历求职信共用）',
    scope: 'greetings',
    defaultEnabled: true,
    instructions:
      'greeting 是求职者发给招聘方/HR 的第一人称求职招呼语（求职信），必须遵守工作台打招呼语统一口径：①以"您好，我想应聘贵公司的{岗位名}"开头（关键锚点，缺失会被系统替换为通用模板）；②一句话点明真实身份（简历中的学历/年级/专业）；③**项目亮点必须精炼**——只挑与岗位最相关的 1-2 个真实项目/技能，每个用一句话概括「做了什么 + 最贴岗位的关键成果或技术要点」，**禁止罗列技术栈清单**（不写"使用 A、B、C、D 与 E 实现…""封装 N 个服务 / M 个工具入口"这类多项枚举），不写与岗位无关的经历；④结尾表达对岗位方向与具体工作内容的兴趣和加入意愿；⑤全文**不超过 250 字**（含标点，建议 120-200 字；超长会被系统截断），单行输出不换行。严禁招聘方口吻（"看到你的简历""你的经历很匹配我们""欢迎进一步沟通""我们团队""候选人"等），不得承诺薪资、到岗时间、年限或不存在的能力。',
  },
  {
    id: 'tailor-cv',
    name: '岗位定制简历',
    description: '根据岗位 JD 定制简历：匹配技能 / 量化经历 / 摘要 / 求职信 / 优化建议',
    scope: 'assistant',
    defaultEnabled: true,
    instructions:
      '定制内容以简历/画像事实为底色，岗位 JD 是能力编写与表述的规范来源（对齐 resume-alchemist：按 JD 关键词编写能力、STAR 润色经历、量化提升匹配度）；能力/技能按 JD 适当编写（鼓励方向）：候选人在相关领域确有真实背景时，允许把其真实掌握与相近的泛化能力用 JD 规范术语合理编写为技能并写入技能区/摘要/经历，放大与岗位的匹配点（如做过多表数据处理→“Python + Pandas 数据清洗”）；硬性事实红线绝不逾越：不得虚构公司/职位/在职时长、学校/学历/专业、证书/奖项、具体数字/比例/金额/用户量/时长，不得承诺薪资/到岗时间/面试时间，与岗位能力域毫无交集无法合理外推的不得凭空宣称；tailoredSummary 120-150 字开头点明身份、突出与目标岗位最相关的真实技能与项目，可按 JD 规范名编写岗位适配能力；tailoredExperiences 2-4 条按岗位相关性重排，按 STAR（情境/任务→行动→结果）精简为一句亮点，允许把真实做过但表述泛化的能力按岗位语境写得更具指向性，量化改写规则：简历事实本身含数字时才允许提炼为「行动动词+可量化成果」句式，简历没有数字就保持事实描述，严禁编造或推算任何百分比、金额、人数、用户量、时长；highlightedSkills 3-8 个「岗位适配技能」：按 JD 规范名编写与岗位匹配的能力（含简历已具备与可合理外推的相近能力），体现对岗位的胜任力；coverLetter 为第一人称求职打招呼语("您好，我想应聘贵公司的{岗位名}"开头)，项目亮点精炼（只挑 1-2 个最相关的真实项目/技能、一句话概括，禁止罗列技术栈清单），全文不超过 250 字，单行不换行，严禁招聘方口吻，不得承诺薪资、到岗时间、面试时间；suggestions 为 3-5 条可执行的优化建议（基于简历与 JD 的真实差距），每条 ≤40 字，不得建议编造事实。多轮自检（系统级，对齐 ai-job-search 的 drafter-reviewer）：首轮草稿后，程序发起独立的第二轮 Reviewer 审阅（以招聘方/ATS 视角逐字段自检，仅修订需改进字段，null 表示保留草稿）；修订若把求职信改坏（口吻/非空校验不过）会回退为草稿，绝不外泄低质内容。',
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
