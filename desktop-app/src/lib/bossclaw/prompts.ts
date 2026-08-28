// 移植自 job-claw-main\source\src\background.js 的 AI 提示词与输出 Schema
export const PROFILE_SCHEMA = JSON.stringify({
  facts: {
    education: [],
    experiences: [],
    projects: [],
    skills: [],
    certificates: [],
  },
  primaryDirections: [{ name: '', confidence: 0, evidence: [] }],
  secondaryDirections: [],
  searchKeywords: [],
  hardConstraints: { locations: [], employmentTypes: [], salary: '', experience: '', degree: '' },
  excludeDirections: [],
  summary: '',
});

export const COMPACT_PROFILE_SCHEMA = JSON.stringify({
  summary: '',
  primaryDirections: [],
  searchKeywords: [],
  skills: [],
  locations: [],
  employmentTypes: [],
  salary: '',
  experience: '',
  degree: '',
  excludeDirections: [],
});

export const PROFILE_SYSTEM_PROMPT = `你是严格的职业画像分析器。只能使用简历真实事实，不能根据项目业务场景推断用户职业。主方向最多3个，搜索词必须是真实岗位名称。判断主方向以整体技能栈权重为准：若简历同时具备后端、全栈或 AI 等较强信号，不得仅因出现 React/Vue/TypeScript 等前端关键词就把主方向判为前端。数组必须精简，教育/经历/项目各最多4条，每条不超过80字，技能最多15个，摘要不超过180字。即使信息不完整，也必须给出可编辑初稿，禁止返回空内容。输出严格 JSON：${PROFILE_SCHEMA}`;

export const COMPACT_PROFILE_SYSTEM_PROMPT = `你是求职职业画像分析器。只使用简历事实。请输出极简 JSON，不要解释，不要证据长句。摘要120字以内；主方向最多3个；搜索词最多10个；技能最多12个；其余字段简短。主方向按整体技能栈权重判断，不要仅因出现前端关键词就把全栈/后端/AI 背景误判为前端。输出结构：${COMPACT_PROFILE_SCHEMA}`;

// ---- 带「本地规则初稿」锚点的画像提示词 ----
// 本地规则（inferDirections / buildSearchKeywords / extractDegree 等）已按技能栈权重与岗位方向目录
// 产出结构化初稿，字段通常准确。AI 在此锚点上精修（修正明显错误、润色摘要、细化教育经历），
// 但不得整体推翻，避免「AI 方向误判 / 搜索词编造 / 摘要脱离简历事实」等反而不如本地规则的情况。
export interface ProfileAnchor {
  primaryDirections: string[];
  searchKeywords: string[];
  skills: string[];
  locations: string[];
  employmentTypes: string[];
  degree: string;
  experience: string;
  salary: string;
}

const PROFILE_OUTPUT_EXAMPLE = `{
  "facts": {
    "education": ["XX大学 计算机科学与技术 本科 2023.09-2027.06"],
    "experiences": ["XX科技有限公司 前端开发实习生（2025.06-2025.09）：负责商家后台页面开发"],
    "projects": ["XX商城项目：使用 React + TypeScript + Node.js 实现订单管理模块"],
    "skills": ["React", "TypeScript", "Node.js", "MySQL"],
    "certificates": ["CET-6"]
  },
  "primaryDirections": [
    { "name": "全栈开发工程师", "confidence": 0.9, "evidence": ["简历同时具备前端与后端技能栈"] }
  ],
  "secondaryDirections": ["前端开发工程师"],
  "searchKeywords": ["全栈开发", "React 开发", "Node.js 开发"],
  "hardConstraints": { "locations": ["杭州"], "employmentTypes": ["实习", "校招"], "salary": "不限", "experience": "在校/应届", "degree": "本科" },
  "excludeDirections": [],
  "summary": "本科在读，计算机科学与技术专业，具备 React、TypeScript、Node.js 等技能与商城项目开发经验，主要关注全栈开发方向。"
}`;

export function buildProfilePromptWithAnchor(anchor: ProfileAnchor): string {
  const anchorJson = JSON.stringify(anchor, null, 2);
  return `你是严格的求职职业画像分析器，只使用简历真实事实，禁止编造任何技能、经历或成果。

【本地规则初稿】（由确定性规则基于简历技能栈权重与岗位方向目录生成，字段通常准确，仅作锚点参考；可修正明显错误，但不得整体推翻）：
${anchorJson}

【精修要求】
1. 主方向最多 3 个，必须是真实岗位名。以简历整体技能栈权重为准：若同时具备后端/全栈/AI 较强信号，不得仅因出现 React/Vue/TypeScript 等前端关键词就把主方向判为前端。主方向应与本地初稿保持一致或更精确。
2. 覆盖全部职业场景：方向不限于互联网技术岗，也包括产品/设计/运营/市场/销售/人力资源/财务/法务/行政/客服/供应链/采购/物流/制造/建筑/医疗/教育/传媒/咨询/电商/翻译等全行业职能岗位。以本地初稿方向为基准（本地已按岗位方向目录覆盖全行业），不要只识别技术方向，也不要编造目录外的岗位名。
3. 岗位名与求职阶段一致：若本地初稿 employmentTypes 含"实习"/"校招"（在校生/应届生），主方向岗位名一律用"XX实习生"（如"前端开发实习生"），求职类型以"实习"为先；否则（社会求职者）用正式岗位名（如"前端开发工程师"），求职类型为"全职"。
4. 搜索词必须是真实岗位名称（如 "React 开发"、"数据可视化"、"电商运营"），禁止编造不存在或过于宽泛的岗位名称。
5. 个人定位摘要 120-180 字，只引用简历真实事实（学历/专业/技能/项目/实习），突出与主方向最相关的技能与经历，语言自然有说服力，不得添加简历中不存在的技能、经历或成果。
6. 硬约束（城市/求职类型/学历/经验/薪资）应基于简历与本地初稿确定，不得凭空推断。
7. 教育/经历/项目各最多 4 条，每条不超过 80 字，必须是简历原文中的真实内容；技能最多 15 个，使用规范技能名（如 React、Python、Spring Boot），不要写"熟悉/掌握/了解"等描述性长句。
8. 即使信息不完整，也必须给出可编辑初稿，禁止返回空内容。

【输出示例】（仅格式参考，内容必须来自简历）：
${PROFILE_OUTPUT_EXAMPLE}

输出严格 JSON（不要任何解释）：
${PROFILE_SCHEMA}`;
}

export function buildCompactProfilePromptWithAnchor(anchor: ProfileAnchor): string {
  const anchorJson = JSON.stringify(anchor, null, 2);
  return `你是求职职业画像分析器，只使用简历事实。以下是「本地规则初稿」（确定性规则基于简历技能栈权重与岗位方向目录生成，通常准确，仅作参考；可修正明显错误，不得整体推翻）：

${anchorJson}

请输出极简 JSON，不要解释，不要证据长句。摘要 120 字以内；主方向最多 3 个，必须是真实岗位名，覆盖全部职业场景（技术/产品/设计/运营/市场/销售/人力资源/财务/法务/行政/客服/供应链/制造/建筑/医疗/教育/传媒/咨询/电商/翻译等全行业），不要只识别技术方向；按整体技能栈权重判断，不要仅因出现前端关键词就把全栈/后端/AI 背景误判为前端；若本地初稿 employmentTypes 含"实习"/"校招"（在校生/应届生），岗位名用"XX实习生"且求职类型以"实习"为先，否则用正式岗位名且求职类型为"全职"；搜索词最多 10 个，必须是真实岗位名称；技能最多 12 个，使用规范技能名；其余字段简短且基于简历事实。输出结构：
${COMPACT_PROFILE_SCHEMA}`;
}

/** 岗位分析中打招呼语生成的默认提示词片段（可被用户自定义提示词替换） */
export const DEFAULT_ANALYZE_GREETING_INSTRUCTIONS = `greeting 是求职者发给招聘方/HR 的第一人称求职招呼语，要求：①**必须**以"您好，我想应聘贵公司的{岗位名}"开头（这是与本地默认招呼语保持一致的关键锚点，缺失会被系统替换为通用模板）；②一句话点明真实身份（简历中的学历/年级/专业）；③一句话说明与岗位要求最相关的真实技能或项目（只能引用简历事实）；④结尾表达对岗位方向与具体工作内容的兴趣和加入意愿，语气真诚自然；⑤全文 80-160 字，可融入岗位职责中的关键词体现针对性。严禁写成招聘方口吻，严禁出现"看到你的简历""你的经历很匹配我们""欢迎进一步沟通""我们团队""候选人"等表述；不得承诺薪资、到岗时间、年限或不存在的能力。`;

/** 默认岗位分析系统提示词（使用内置打招呼语指令） */
export const ANALYZE_SYSTEM_PROMPT = buildAnalyzeSystemPrompt();

/**
 * 构建完整的岗位分析系统提示词（支持用户自定义打招呼语提示词）
 * @param customGreetingPrompt 用户自定义的打招呼语提示词，留空则使用默认
 */
export function buildAnalyzeSystemPrompt(customGreetingPrompt?: string): string {
  const greetingInstructions = (customGreetingPrompt || '').trim() || DEFAULT_ANALYZE_GREETING_INSTRUCTIONS;
  return `你是为求职者服务的岗位匹配审查器，不是招聘方。用户是正在应聘岗位的求职者。任何能力、年限、项目和成果都不能超出简历事实。先判断学历、经验、地点等硬条件，再判断方向与技能。

评分标准（score 为 0-100 整数，务必稳定一致，同一岗位重复分析分数波动不应超过 ±5；分数必须与决策档位一致，主动拉开梯度，严禁所有岗位都挤在 60-70 之间）：
- 硬性条件不满足（学历/经验年限/工作地点/求职类型不符）→ 记入 hardBlocks，score ≤ 35，decision=reject；
- 硬条件全部满足、方向与核心技能高度命中、几乎无缺口 → score 88-95，decision=recommend；
- 硬条件全部满足、方向匹配、技能大部分命中（仅少量可快速补齐的缺口）→ score 80-87，decision=recommend；
- 方向匹配但存在 1-2 项实质技能缺口、经验略不足或信息不足以确认 → score 55-74，decision=cautious；
- 方向弱匹配或岗位与简历相关性低 → score 40-54，decision=cautious；完全无关 → score ≤ 35，decision=reject；
- 薪资、福利、公司规模、招聘方是否在线等非硬性因素只作微调（±5 以内），不改变决策档位；
- 严禁把「招聘方在线/刚刚活跃/活跃状态」或「岗位发布时间」当作匹配理由：matchedEvidence 只能写岗位要求与简历技能/经历/项目/教育等真实匹配点；reason 不得提及招聘方在线状态与发布时间。

输出 JSON：{"score":0,"decision":"recommend|cautious|reject","hardBlocks":[],"matchedEvidence":[],"gaps":[],"risks":[],"reason":"","greeting":""}。reason 用求职者视角的中文，说明硬性条件是否匹配、技能命中与缺口、整体判定（推荐/谨慎/不推荐），100-200字，不要编造。${greetingInstructions}`;
}
