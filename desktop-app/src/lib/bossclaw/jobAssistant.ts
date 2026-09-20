// AI 求职助手 —— 根据岗位定制简历（结构化七模块文档 + JD 要点对照 + 同口径匹配分 + 求职信/打招呼语）
// 参考 GitHub 开源项目 Anarkh-Lee/resume-alchemist 的优化方法论（按 JD 编写能力 / JD 关键词优化 /
//   STAR 法则润色经历），并兼容 MadsLorentzen/ai-job-search 的 /apply 流程与 Resume-Matcher 引导式建议：
//   - 经历要点允许「量化改写」（仅提炼简历已有数字，严禁编造）；对标 resume-alchemist 的量化成果；
//   - 能力/技能按 JD 适当编写（放大匹配点），但硬性事实（经历/学历/证书/数字/承诺）绝不编造；
//   - 输出可执行的 ATS 优化建议清单；对标 Resume-Matcher 的 guided improvements。
// 落地为 BOSS 直聘场景：输入岗位 JD，基于简历/画像真实事实，生成岗位针对性内容。
//
// 结构口径（2026-09-14 定）：
//   - 定制产出「七模块结构化简历文档」（教育经历/实习经历/工作经历/项目经历/专业技能/个人荣誉/自我评价），
//     模块顺序与「空模块不输出」由渲染层决定，AI 只填内容；
//   - 每条定制后内容都要挂一条「原文摘录」（source）：挂不上原文的条目在 UI 中标为需人工核对，
//     把「编造」在结构上暴露出来，而不是靠事后审查；
//   - 「匹配度」改为 AI 同口径判定：同一次调用、同一份 JD 要点清单、同一套标准，输出 before/after 两个分，
//     解决旧的「原简历+定制内容拼接重算 → 前后恒等」问题（本地算法仅作 AI 不可用时的兜底展示）；
//   - 「岗位要点对照」改为 AI 分层要点（硬门槛/优先条件/职责信号/团队信号）× 三层判定（已体现/可补充/不具备）；
//   - 二轮 Reviewer 复检保留，但其修订差异不再单独展示，面板统一展示「原文摘录 → 定制后条目」逐条对照。
//
// 安全不变量（对齐 AGENTS.md 2.1）：
//   - 能力/技能可按 JD 适当编写（放大匹配点），但经历、学历、证书、量化数字与任何承诺绝不编造；
//   - 量化只允许提炼简历中已有的数字（规模/时长/效率），简历没有数字就保持事实描述，严禁编造百分比、金额、用户量；
//   - 求职信必须求职者第一人称口吻，禁止招聘方口吻（复用打招呼语校验口径）；
//   - AI 输出不达标一律回退本地规则兜底，绝不把招聘方口吻的文本交给用户。
import type { AppConfig, JobMeta, Profile } from './types';
import { cachedCallModel, aiFailureKind } from './llm';
import { reloadSkills, skillInstructionsFor } from './skills';
import { stableProfileView, fallbackApplicantGreeting, settleGreetingLength } from './matching';
import { allocateContextBudget, fitContextToTokens } from './contextBudget';
import { prepareContextText } from './oversizedContext';
import { DEFAULT_ANALYZE_GREETING_INSTRUCTIONS } from './prompts';
import { buildSchoolDisclosureRule, hasSchoolMention, resolveSchoolTier } from './schoolTier';
import { normalizeStringList } from './helpers';
import { decodeSalaryDigits } from './jobDisplay';
import {
  analyzeJdKeywords,
  buildLocalSuggestions,
  computeMatchScore,
  extractJdKeywords,
  resumeHasQuantifiedEvidence,
  type JdKeywordAnalysis,
  type MatchScore,
} from './resumeMatch';

// ===== 结构化简历文档（七模块）=====
/** 定制简历文档中的一条内容：text=定制后文本；source=原简历/经历补充材料中的原文摘录（照抄，未改写真） */
export interface TailorDocLine {
  text: string;
  source: string;
}

/** 定制简历文档的一个「块」（教育经历/实习经历/工作经历/项目经历共用） */
export interface TailorDocBlock {
  /** 块首行：项目/公司/学校名 + 角色或专业学历 */
  heading: string;
  /** 第二行元信息：技术栈：… / 时间：… */
  meta: string;
  /** 要点 */
  bullets: TailorDocLine[];
}

/** 定制简历文档（七模块；空模块为空数组/空对象，由渲染层决定顺序与省略） */
export interface TailorResumeDoc {
  education: TailorDocBlock[];
  internships: TailorDocBlock[];
  works: TailorDocBlock[];
  projects: TailorDocBlock[];
  /** 专业技能：按类别分组，每项 text 形如「后端：精通 Java、熟悉 MyBatis」（**必须保留描述语**） */
  skills: TailorDocLine[];
  honors: string[];
  selfEval: TailorDocLine;
}

export const EMPTY_TAILOR_DOC: TailorResumeDoc = {
  education: [],
  internships: [],
  works: [],
  projects: [],
  skills: [],
  honors: [],
  selfEval: { text: '', source: '' },
};

/** JD 要点层级（对齐 JD 拆解方法的四层信息） */
export type JdPointLayer = 'must' | 'prefer' | 'duty' | 'team';
/** JD 要点在候选人侧的体现情况：covered 简历已体现 / addable 画像或补充材料具备但简历未写 / missing 完全没有 */
export type JdPointVerdict = 'covered' | 'addable' | 'missing';

export interface TailorJdPoint {
  /** 要点（≤12 字，同类已合并） */
  point: string;
  layer: JdPointLayer;
  verdict: JdPointVerdict;
  /** 一句依据（≤30 字，必须是可核对的简历事实） */
  evidence: string;
}

/** AI 同口径匹配度：before=原简历+补充材料+画像；after=定制后简历文档 */
export interface TailorAiMatch {
  before: number;
  after: number;
}

/** 逐条改写对照（由文档里的 source/text 派生，保证与最终交付稿永远同步） */
export interface TailorRewrite {
  /** 所属模块中文名 */
  module: string;
  /** 定制后条目 */
  after: string;
  /** 原简历该条的原文摘录；空串表示未找到原文对应（需人工核对） */
  before: string;
  /** 原文摘录来源：resume 简历原文 / extra 经历补充材料 / none 未找到 */
  from: 'resume' | 'extra' | 'none';
}

export const JD_LAYER_LABEL: Record<JdPointLayer, string> = {
  must: '硬门槛',
  prefer: '优先条件',
  duty: '职责信号',
  team: '团队信号',
};

// ===== 输出 Schema =====
export const TAILOR_SCHEMA = JSON.stringify({
  highlightedSkills: [],
  tailoredSummary: '',
  tailoredExperiences: [],
  coverLetter: '',
  skillGaps: [],
  suggestions: [],
  resume: {
    education: [{ heading: '', meta: '', bullets: [{ text: '', source: '' }] }],
    internships: [{ heading: '', meta: '', bullets: [{ text: '', source: '' }] }],
    works: [{ heading: '', meta: '', bullets: [{ text: '', source: '' }] }],
    projects: [{ heading: '', meta: '', bullets: [{ text: '', source: '' }] }],
    skills: [{ text: '', source: '' }],
    honors: [],
    selfEval: { text: '', source: '' },
  },
  jdPoints: [{ point: '', layer: 'must|prefer|duty|team', verdict: 'covered|addable|missing', evidence: '' }],
  matchScore: { before: 0, after: 0 },
});

// 输出样例：官方 JSON Output 要求 prompt 给出「希望模型输出的 JSON 格式样例」。
// 仅示意字段格式与取值风格，内容必须来自简历/画像真实事实（模型不得照抄样例内容）。
const TAILOR_OUTPUT_EXAMPLE = `{
  "highlightedSkills": ["React", "TypeScript", "前端性能优化", "Git 分支协作"],
  "tailoredSummary": "计算机科学与技术专业在读本科生，具备 React + TypeScript 前端开发与 Node.js 接口联调经验，在商城项目中负责订单管理模块的页面开发与状态管理，熟悉组件化拆分与前后端联调流程。",
  "tailoredExperiences": [
    "在 XX 商城项目中负责订单管理模块，用 React + TypeScript 完成页面开发与状态管理，支撑下单到售后全流程交互",
    "在 XX 科技实习期间参与商家后台页面开发，配合后端完成接口联调并优化首屏渲染表现"
  ],
  "coverLetter": "您好，我想应聘贵公司的前端开发实习生岗位。我是计算机科学与技术专业在读本科生，做过基于 React + TypeScript 的商城订单管理模块，负责页面开发与状态管理；对岗位的工程化与性能优化方向很感兴趣，希望有机会进一步沟通，谢谢。",
  "skillGaps": ["Kubernetes：岗位要求容器编排与集群运维，简历与画像未体现相关经历，建议补充实操项目"],
  "suggestions": ["把商城项目的首屏优化数据前置到经历第一条", "在技能区补充 Jest 单元测试能力", "摘要中明确写出期望的前端工程化方向"],
  "resume": {
    "education": [
      { "heading": "XX大学 计算机科学与技术 | 本科在读（2027 届）", "meta": "2023.09-2027.06", "bullets": [{ "text": "连续两年获校级二等奖学金", "source": "连续两年获得学校二等奖学金" }] }
    ],
    "internships": [
      { "heading": "XX 科技 前端开发实习生", "meta": "2025.07-2025.09", "bullets": [{ "text": "参与商家后台页面开发，配合后端完成接口联调，并优化首屏渲染表现", "source": "参与商家后台页面开发，配合后端完成接口联调" }] }
    ],
    "works": [],
    "projects": [
      { "heading": "XX 商城系统 | 前端开发", "meta": "技术栈：React + TypeScript + Vite", "bullets": [{ "text": "负责订单管理模块的页面开发与状态管理，支撑下单到售后全流程交互", "source": "负责商城项目订单管理模块的页面开发与状态管理" }] }
    ],
    "skills": [
      { "text": "前端开发：熟悉 React、TypeScript、Vite，沉淀通用组件库", "source": "前端：熟悉 React、TypeScript、Vite，沉淀通用组件库" },
      { "text": "协作工具：熟练 Git 分支协作", "source": "工具：熟练 Git 分支协作" }
    ],
    "honors": ["2024 年蓝桥杯大学生 Java B 组省一等奖"],
    "selfEval": { "text": "全栈开发 + AI 应用双线实践者，独立完成过面向用户的 AI 功能产品。", "source": "全栈开发 + AI 应用双线实践者，独立完成过面向用户的 AI 功能产品。" }
  },
  "jdPoints": [
    { "point": "React 开发经验", "layer": "duty", "verdict": "covered", "evidence": "商城项目订单模块用 React 实现" },
    { "point": "前端工程化", "layer": "prefer", "verdict": "addable", "evidence": "画像中具备 Vite 构建与组件库沉淀经验" },
    { "point": "Kubernetes 部署", "layer": "must", "verdict": "missing", "evidence": "简历与画像均无容器编排相关经历" }
  ],
  "matchScore": { "before": 62, "after": 78 }
}`;

// 第二轮 Reviewer 输出样例：字段为 null 表示「该字段无需修订、保留草稿」。
const TAILOR_REVIEW_OUTPUT_EXAMPLE = `{
  "tailoredSummary": "计算机科学与技术专业在读本科生，具备 React + TypeScript 前端开发经验，在商城项目中负责订单管理模块的页面开发与状态管理，熟悉组件化拆分与接口联调流程。",
  "tailoredExperiences": null,
  "highlightedSkills": null,
  "coverLetter": null,
  "skillGaps": null,
  "suggestions": null,
  "resume": null,
  "reviewNote": "摘要原稿罗列了多项技术栈，已改写为「身份 + 1-2 个最相关亮点」；逐条核对 resume 的 source 与 text，未发现超出原文的表述；其余字段保持草稿。"
}`;

// ===== 系统提示词 =====
// 求职信（coverLetter）的打招呼语提示词由调用方按「skill → 简历中心输入框内容」优先级解析后传入（都不满足则回退本地规则），
// 与工作台岗位分析、简历中心预览共用同一口径。
export function buildTailorSystemPrompt(greetingInstructions: string, schoolRule = ''): string {
  return `你是求职者的求职助手（不是招聘方）。任务：先读懂目标岗位 JD，再据此定制简历——产出「结构化简历文档（七模块）」「JD 要点对照清单」「定制前/后同口径匹配分」「量化经历要点」「第一人称求职打招呼语（求职信）」与「可执行的优化建议」。

执行顺序：**先把 JD 按四层拆解读完（硬门槛 / 优先条件 / 职责信号 / 团队信号），再开始输出内容**；jdPoints、resume、highlightedSkills 必须是读完 JD 之后的结论，不得跳过拆解直接润色。

铁律：
1. 定制内容以简历/职业画像/经历补充材料的事实为底色；岗位 JD 是**能力编写与表述的规范来源**（对齐 resume-alchemist：按 JD 关键词编写能力、STAR 润色经历，提升匹配度）。
2. **能力/技能按 JD 适当编写（鼓励方向）**：候选人在相关领域确有真实背景/经历时，允许把其真实掌握与相近的泛化能力用 JD 规范术语合理编写为技能，写入 highlightedSkills、tailoredSummary 与经历要点，放大与岗位的匹配点（如做过多表数据处理 →「Python + Pandas 数据清洗」；做过前端页面、岗位要「性能优化」→「前端性能优化」）。
3. **保留原简历的能力描述语（保真红线，最容易出错）**：原简历对能力的「精通 / 熟练 / 熟悉 / 掌握 / 擅长 / 了解 / 具备…能力 / 沉淀」等描述语是**求职者真实水平的表达**，改写时必须**原样保留**（可同义替换，如「熟悉」→「熟练」属于升级，**禁止降级或删除**）。**严禁把带描述语的表述压成无修饰的技能罗列**：
   - 原文：「前端：熟悉 React、TypeScript，沉淀通用组件库」
   - ✗ 错误：「前端：React、TypeScript、通用组件库」（描述语全丢，等于抹平水平差异）
   - ✓ 正确：「前端：熟悉 React、TypeScript，沉淀通用组件库」
   按 JD 补充新技能时，须为该技能给出**与原文同组、同强度**的描述语，不得凭空升级为「精通」。
4. **硬性事实红线（绝不逾越）**：不得虚构公司/职位/在职时长、学校/学历/专业、证书/奖项、具体数字/比例/金额/用户量/时长；不得承诺薪资、到岗时间、面试时间；与岗位能力域毫无交集、无法从真实背景合理外推的，绝不写进 tailoredSummary、highlightedSkills、resume 或 coverLetter 当作自己具备。触犯任一条即输出失败，交由本地规则兜底。
5. tailoredSummary 为 120-150 字求职者个人摘要：开头点明身份（学历/年级/专业），突出与目标岗位最相关的真实技能与项目。
6. tailoredExperiences 为 2-4 条经历要点：从真实经历中挑选与岗位最相关者，按 **STAR（情境/任务 → 行动 → 结果）** 精简为一句亮点重排（每条不超过 80 字）。[量化改写规则]：若简历事实本身含数字（如"服务 3 年""日活 5 万""耗时从 2 小时降到 30 分钟"），允许提炼为「行动动词 + 可量化成果」句式；若简历没有数字，必须保持事实描述，**严禁编造或推算任何百分比、金额、人数、用户量、时长**。
7. highlightedSkills 为 3-8 个「岗位适配技能」：按 JD 规范名编写与岗位匹配的能力（含简历已具备与可合理外推的相近能力）；与岗位无关或与候选人背景毫无交集的一律不列。
8. skillGaps 为 1-4 个「岗位明确要求、但候选人背景与该能力域毫无交集、无法合理编写」的能力提示，没有则返回空数组。
9. coverLetter 为第一人称求职打招呼语（求职信），必须遵守以下工作台打招呼语提示词（本软件打招呼语统一口径，含开头格式、口吻、长度、安全红线）：
${greetingInstructions}${schoolRule}
10. suggestions 为 3-5 条「求职者可执行」的优化建议：基于简历与 JD 的真实差距给出，每条不超过 40 字，不得建议编造事实。

【resume：结构化简历文档（七模块）】
- resume 是**可直接排版成 PDF 的定制简历正文**，不是摘要、不是备注。模块固定为：教育经历（education）/ 实习经历（internships）/ 工作经历（works）/ 项目经历（projects）/ 专业技能（skills）/ 个人荣誉（honors）/ 自我评价（selfEval）。顺序由程序决定，你只填内容。
- **没有内容的模块一律返回空数组或空对象，绝不编造内容去填充、也不写"暂无"**。
- education / internships / works / projects 每项 = { heading, meta, bullets }：heading 是首行（学校 + 专业 | 学历 / 公司 + 岗位 / 项目名 + 一句话定位 | 角色），meta 是第二行元信息（时间 / 「技术栈：…」），bullets 是要点。
- **每条 bullet 必须带 source**：source 是**原简历或经历补充材料里对应那一条的原文摘录，照抄不改写**。若该条与原文完全一致，source 照抄同样文本；若原文中确实找不到对应内容，source 填空字符串 ""（这类条会在界面上标为「需人工核对」，禁止用来塞进编造内容）。
- **改写只允许「重新表达」，不允许「新增事实」**：bullet 的 text 超出 source 能支撑的范围即为违规。
- 按岗位相关性从高到低排列 bullets；每个项目/经历 1-4 条要点，每条不超过 80 字。**bullet 同样受「保留能力描述语」约束**：原文写「负责」「参与」「配合」等动词或「熟练/熟悉」等描述语时，不得改写成无修饰的名词堆叠。
- skills 为「按类别分组的专业技能」：每项 { text, source }，一组一行，与 JD 相关性高的组排在前面；source 填原简历技能区的原文摘录。**text 必须保留原简历的描述语结构，形如「后端：精通 Java（Spring Boot），熟悉 MyBatis，擅长接口设计」「前端：熟悉 React、TypeScript，沉淀通用组件库」**，即「类别：<描述语><技能>、<描述语><技能>，<描述语><能力/成果>」；**严禁输出成「后端：Java、Spring Boot、MyBatis」这类无描述语的裸技能列表**。按 JD 补充新技能时沿用该组的描述语强度，不得凭空升级为「精通」。组名与分组由你按 JD 与本人真实技能归纳，不得把简历中不存在的技能写进来。
- honors 为个人荣誉/证书纯文本条目数组；selfEval 为自我评价 { text, source }。
- **禁止输出空标题、占位符（如「（暂无）」「待补充」）或说明性文字**。

【jdPoints：JD 要点对照清单】
- 把 JD 拆成四层要点：must 硬门槛（学历/年限/语言/行业背景/远程出差）、prefer 优先条件（「优先/加分/更佳」）、duty 职责信号（每天到底要做什么）、team 团队信号（公司阶段/协作方式）。
- 同类合并、总数不超过 20 条，每条 point 不超过 12 字，不要罗列 JD 里的每个词。
- 每条给 verdict：covered = 简历正文已体现；addable = 职业画像或经历补充材料中真实具备、但简历正文没写；missing = 与候选人真实背景毫无交集、无法合理外推。
- evidence 一句话（不超过 30 字）说明依据，必须是可核对的简历事实；**不得把「优先/加分」写成硬性不满足**。
- 不要把职位名、公司名、招聘流程词（HR/面试/简历筛选）当作要点。

【matchScore：定制前/后同口径匹配分】
- before = 原简历 + 经历补充材料 + 职业画像 对这份 JD 的匹配度；after = **定制后的 resume 文档** 对这份 JD 的匹配度。
- 两者必须**基于同一份 jdPoints、用同一套判断标准**：按要点分层加权（硬门槛权重最高，优先条件次之，职责信号再次，团队信号仅作参考），各自给 0-100 整数。
- after 只有在定制确实补上了要点时才允许高于 before；**不允许为了好看而抬分**，也不允许两分自动设成差值固定值。若定制没有实质增益，after 与 before 持平即是正确结果。

【输出 schema】只输出以下字段（字段名与类型不可变更）：
${TAILOR_SCHEMA}

【输出样例】（仅示意字段格式与写法，内容必须来自简历/画像/补充材料的真实事实，不得照抄样例内容）：
${TAILOR_OUTPUT_EXAMPLE}

只输出一个 json 对象，不要解释、不要代码块围栏。`;
}

// ===== 第二轮：招聘方 + ATS 视角自检修订（Reviewer） =====
// 对齐 MadsLorentzen/ai-job-search 的 /apply 流程（drafter → reviewer → revise），
// 以及 llamaindex-pse 的 Planner-Specialist-Evaluator 审阅思想：
// 第一轮初稿后，再以招聘方/ATS 视角逐字段自检、修订，避免一次性生成带出
// 夸大表述、语气瑕疵、关键词覆盖不真实、口吻不当等问题。字段输出 null（或缺省）表示「保持草稿不变」。
export const TAILOR_REVIEW_SCHEMA = JSON.stringify({
  tailoredSummary: null,
  tailoredExperiences: null,
  highlightedSkills: null,
  coverLetter: null,
  skillGaps: null,
  suggestions: null,
  resume: null,
  reviewNote: null,
});

export function buildReviewSystemPrompt(schoolRule = ''): string {
  return `你是资深招聘方 + ATS 简历审核专家，负责对上一轮 AI 已起草的「岗位定制简历」做第二轮回审与修订（对齐 ai-job-search 的 drafter-reviewer：先起草，再以招聘方视角自检，修订后才可交付）。

输入：职业画像 / 经历补充材料 / 目标岗位 JD / 上一轮草稿（含结构化简历文档 resume 与 JD 要点清单 jdPoints）。

任务：逐字段审阅草稿，仅对「需要改进」的字段输出修订值；某字段无需修改就输出 null（缺省代表保留草稿）。审阅维度：
1. **诚实性红线（最优先，逐条核对 source）**：resume 里每条 bullet 的 text 是否超出了同一条 source 能支撑的范围？education/internships/works/projects 的 heading、meta 是否与原文一致（公司/职位/在职时长、学校/学历/专业、时间不得改动或美化）？是否存在 source 为空、却写了具体事实的条目？是否存在虚构证书/奖项/数字/比例/金额/用户量/时长、或承诺薪资/到岗/面试时间？**触犯任一条必须在 resume 中修订或删除该条**，绝不保留。
2. ATS 关键词覆盖：JD 高权重关键词（技能/工具/领域术语）是否被真实覆盖？候选人在相关领域确有真实背景时，允许把其真实掌握或相近的泛化能力按 JD 规范名编写为「适配技能」并前置入摘要/经历/技能；与候选人背景毫无交集的关键词不得硬塞，应归入 skillGaps 或在 jdPoints 中记为 missing。
3. 结构与可排版性：resume 模块齐全且**没有编造出来的空壳模块**（没内容的模块必须是空数组/空对象，不得出现「暂无」「待补充」等占位文字）；bullets 是否按岗位相关性从高到低、每条不超过 80 字。
4. STAR 与一页适配：tailoredSummary 120-150 字、开头点明身份；tailoredExperiences 2-4 条、一条不超过 80 字；量化只提炼简历已有数字，严禁编造或推算。
5. 求职信口吻：coverLetter 必须求职者第一人称（以「您好，我想应聘贵公司的{岗位名}」开头），全文 120-200 字（含标点，建议约 150 字，与 greetings.ts::GREETING_LENGTH_RULE 同口径）、单行不换行；项目亮点必须精炼（只挑 1-2 个与岗位最相关的真实项目/技能、禁止罗列技术栈清单）；严禁招聘方口吻（「看到你的简历」「你的经历很匹配我们」「欢迎进一步沟通」「我们团队」「候选人」等），不得承诺薪资、到岗时间、面试时间。**校名披露（只约束 coverLetter，简历正文 resume 中的学校名照抄原文不受此限）**：${schoolRule ? schoolRule.trim() : '院校名称只有简历院校属于 985/211 时才允许写出，其余院校一律不出现任何院校名称或层级字样，只写学历/专业/年级。'}
6. 建议可执行性：suggestions 3-5 条、基于简历与 JD 的真实差距、每条不超过 40 字。
7. **能力描述语保真（重点复查项）**：逐条比对 resume.skills 与各模块 bullet 的 text / 同条 source，**原文中的「精通 / 熟练 / 熟悉 / 掌握 / 擅长 / 了解 / 具备…能力 / 沉淀」等描述语是否被保留**？凡是「原文有描述语、text 里却压成了无修饰的技能罗列」（如 source「前端：熟悉 React、TypeScript，沉淀通用组件库」被改成 text「前端：React、TypeScript、通用组件库」），**必须在 resume 中把描述语按 source 原文补回**（可同义替换，不得升级为「精通」），并在 reviewNote 里说明补回了哪几条；同时检查有没有反向错误——把原文的「了解」写成「精通」这类**凭空升级**，也要改回原文强度。

**不要修订 jdPoints 与 matchScore**（保持草稿，程序会沿用）。

【输出 schema】只输出以下字段（字段名与类型不可变更；无需修订的字段一律输出 null）：
${TAILOR_REVIEW_SCHEMA}

【输出样例】（null 表示该字段无需修订、保留草稿；仅示意写法，实际判断须基于草稿内容）：
${TAILOR_REVIEW_OUTPUT_EXAMPLE}

只输出一个 json 对象，不要解释、不要代码块围栏。`;
}

// ===== 口吻校验（复用打招呼口径，保证与现有投递链路一致） =====
function isApplicantVoice(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const reversed = /看到你的简历|你的简历|很匹配我们|匹配我们|欢迎.*进一步沟通|期待你加入我们|候选人|我们团队|我们公司|我们这边|团队主要涉及|你很匹配|方便的话来聊聊|期待与你/i.test(raw);
  const applicantVoice = /我想应聘|我希望应聘|我对.{0,30}(岗位|职位|这份|这个|该).{0,15}(感兴趣|有兴趣)|想进一步了解|希望进一步沟通|希望和您(聊聊|沟通|交流)|希望加入|对该.{0,10}感兴趣|期望加入|期待加入|可实习|可到岗|您好/i.test(raw);
  return !reversed && applicantVoice;
}

/** 定制结果中的匹配分析（本地确定性兜底计算；AI 可用时以 aiMatch 为准） */
export interface TailorMatchAnalysis {
  /** JD 关键词三层比对（本地兜底展示用） */
  keywords: JdKeywordAnalysis;
  /** 定制前匹配分（基于简历原文 + 画像） */
  before: MatchScore;
  /** 本地兜底不再提供可比对的「定制后分」（口径不同会误导），恒等于 before */
  after: MatchScore;
}

/** 第二轮回审（Reviewer）结论：只保留一行结论与本次被修订的字段名 */
export interface TailorReviewMeta {
  /** 复检结论（一行） */
  note?: string;
  /** 被修订的字段中文名 */
  revisedFields: string[];
}

export interface TailorResult {
  /** 岗位要求且简历具备的技能 */
  highlightedSkills: string[];
  /** 针对岗位定制的个人摘要 */
  tailoredSummary: string;
  /** 按岗位相关性重排的经历要点（允许量化改写，仅提炼简历已有数字） */
  tailoredExperiences: string[];
  /** 定制求职信（第一人称打招呼语） */
  coverLetter: string;
  /** 岗位要求但简历缺失的技能/经验（如实呈现，不补写） */
  skillGaps: string[];
  /** 可执行的优化建议（AI 生成，失败回退本地规则） */
  suggestions: string[];
  /** 结构化简历文档（七模块）：PDF 排版的事实来源 */
  doc: TailorResumeDoc;
  /** JD 要点对照清单（AI 分层 + 三层判定 + 依据） */
  jdPoints: TailorJdPoint[];
  /** AI 同口径匹配度；null = AI 不可用，界面回退本地估算（不作前后对比） */
  aiMatch: TailorAiMatch | null;
  /** 逐条改写对照（由 doc 的 source/text 派生，与最终交付稿永远同步） */
  rewrites: TailorRewrite[];
  /**
   * 描述语丢失告警（确定性检出）：把原文里「精通/熟练/熟悉/…」等能力描述语抹平的改写条目。
   * 提示词已要求保真，这里是兜底——真丢了就在界面上如实标出来，便于人工补回。
   */
  qualifierLoss: QualifierLoss[];
  /** 匹配分析（本地确定性计算，仅 AI 不可用时作兜底展示） */
  match: TailorMatchAnalysis;
  /** 第二轮回审（Reviewer）结论（有修订或结论时才有） */
  review?: TailorReviewMeta;
  method: 'ai' | 'local';
  warning?: string;
}

// ===== 文档解析与派生 =====

const lineText = (v: unknown): string => String(v ?? '').trim();

/** 规范化一个块（教育/实习/工作/项目）：heading/meta/bullets(含 source) */
function normalizeBlocks(raw: unknown, maxBlocks: number): TailorDocBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: TailorDocBlock[] = [];
  for (const item of raw.slice(0, maxBlocks)) {
    const heading = lineText((item as any)?.heading);
    const meta = lineText((item as any)?.meta);
    const bullets: TailorDocLine[] = [];
    const rawBullets = Array.isArray((item as any)?.bullets) ? (item as any).bullets : [];
    for (const b of rawBullets.slice(0, 6)) {
      const text = lineText(typeof b === 'string' ? b : b?.text);
      if (!text) continue;
      // 字符串形式的 bullet（模型偶尔返回纯文本）视为无 source，界面会标为需人工核对
      const source = lineText(typeof b === 'string' ? '' : b?.source);
      bullets.push({ text: text.slice(0, 120), source: source.slice(0, 300) });
    }
    if (!heading && !meta && !bullets.length) continue;
    out.push({ heading: heading.slice(0, 120), meta: meta.slice(0, 120), bullets });
  }
  return out;
}

/** 规范化 { text, source } 行列表（专业技能） */
function normalizeLines(raw: unknown, max: number): TailorDocLine[] {
  if (!Array.isArray(raw)) return [];
  const out: TailorDocLine[] = [];
  for (const item of raw.slice(0, max)) {
    const text = lineText(typeof item === 'string' ? item : item?.text);
    if (!text) continue;
    const source = lineText(typeof item === 'string' ? '' : item?.source);
    out.push({ text: text.slice(0, 120), source: source.slice(0, 300) });
  }
  return out;
}

/** 把 AI 返回的 resume 规范化（缺字段/类型错一律回落空，绝不让脏数据进 PDF） */
export function normalizeTailorDoc(raw: unknown): TailorResumeDoc {
  const r: any = raw || {};
  return {
    education: normalizeBlocks(r.education, 3),
    internships: normalizeBlocks(r.internships, 4),
    works: normalizeBlocks(r.works, 4),
    projects: normalizeBlocks(r.projects, 4),
    skills: normalizeLines(r.skills, 8),
    honors: normalizeStringList(r.honors, 8).map((h) => String(h).slice(0, 120)),
    selfEval: {
      text: lineText(r.selfEval?.text ?? (typeof r.selfEval === 'string' ? r.selfEval : '')).slice(0, 400),
      source: lineText(r.selfEval?.source).slice(0, 600),
    },
  };
}

const JD_LAYERS: JdPointLayer[] = ['must', 'prefer', 'duty', 'team'];
const JD_VERDICTS: JdPointVerdict[] = ['covered', 'addable', 'missing'];

export function normalizeJdPoints(raw: unknown, max = 20): TailorJdPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: TailorJdPoint[] = [];
  for (const item of raw.slice(0, max)) {
    const point = lineText((item as any)?.point).slice(0, 24);
    if (!point) continue;
    const layer = JD_LAYERS.includes((item as any)?.layer) ? ((item as any).layer as JdPointLayer) : 'duty';
    const verdict = JD_VERDICTS.includes((item as any)?.verdict) ? ((item as any).verdict as JdPointVerdict) : 'missing';
    out.push({ point, layer, verdict, evidence: lineText((item as any)?.evidence).slice(0, 60) });
  }
  return out;
}

/** 夹取 0-100 整数分 */
const clampScore = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

export function normalizeAiMatch(raw: unknown): TailorAiMatch | null {
  const r: any = raw || {};
  const before = r.before ?? r.beforeScore;
  const after = r.after ?? r.afterScore;
  if (before == null || after == null) return null;
  return { before: clampScore(before), after: clampScore(after) };
}

/** 归一化文本（去空白/标点差异）用于判断「是否真的改写过」 */
const normForCompare = (s: string): string =>
  String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.;:!?！？"'“”‘’（）()【】\[\]·\-—~～]/g, '')
    .toLowerCase();

export interface TailorRewriteResult {
  rewrites: TailorRewrite[];
  /** 定制后条目里找不到原文对应的（界面标为需人工核对，属于潜在的编造风险点） */
  unmatched: TailorRewrite[];
}

/**
 * 由文档里的 source/text 派生「原文 → 定制后」逐条对照：
 *   - source 为空 → 无原文对应，进 unmatched（界面提示需人工核对）；
 *   - source 与 text 归一化后一致 → 未改写，不列入对照；
 *   - 其余 → 一条改写对照，并按原文出现位置判断来源（补充材料 / 简历原文）。
 */
export function deriveRewrites(
  doc: TailorResumeDoc,
  moduleOf: Record<string, string>,
  extraText = ''
): TailorRewriteResult {
  const rewrites: TailorRewrite[] = [];
  const unmatched: TailorRewrite[] = [];
  const extraBlob = normForCompare(extraText);
  const push = (module: string, line: TailorDocLine) => {
    const after = lineText(line.text);
    const before = lineText(line.source);
    if (!after) return;
    if (!before) {
      unmatched.push({ module, after, before: '', from: 'none' });
      return;
    }
    if (normForCompare(after) === normForCompare(before)) return;
    const src = normForCompare(before);
    const from: TailorRewrite['from'] = extraBlob && src && extraBlob.includes(src) ? 'extra' : 'resume';
    rewrites.push({ module, after, before, from });
  };
  const walk = (key: string, blocks: TailorDocBlock[]) => {
    const module = moduleOf[key] || key;
    for (const b of blocks) for (const bullet of b.bullets) push(module, bullet);
  };
  walk('internships', doc.internships);
  walk('works', doc.works);
  walk('projects', doc.projects);
  for (const line of doc.skills) push(moduleOf.skills || '专业技能', line);
  push(moduleOf.selfEval || '自我评价', doc.selfEval);
  return { rewrites, unmatched };
}

/**
 * 能力描述语及其水平强度：数字越大越强；0 = 非水平类（只判断有无，如「沉淀/具备」）。
 * 用于区分「同义替换/升级」（可接受）与「降级/抹平」（必须报出来）。
 */
const QUALIFIER_LEVELS: Record<string, number> = {
  了解: 1,
  会用: 1,
  熟悉: 2,
  掌握: 2,
  沉淀: 0,
  具备: 0,
  能独立: 0,
  可独立: 0,
  熟练: 3,
  擅长: 3,
  精通: 4,
};
const PROFICIENCY_WORDS_RE = new RegExp(Object.keys(QUALIFIER_LEVELS).join('|'), 'g');

/** 文本中出现过的最高描述语强度（0 = 无水平类描述语） */
function maxQualifierLevel(text: string): number {
  const hits = text.match(PROFICIENCY_WORDS_RE) || [];
  return hits.reduce((max, w) => Math.max(max, QUALIFIER_LEVELS[w] ?? 0), 0);
}

/** 一条「描述语被抹平或降级」的改写 */
export interface QualifierLoss {
  /** 所属模块中文名 */
  module: string;
  /** 原简历原文 */
  before: string;
  /** 定制后内容 */
  after: string;
  /** 丢失或降级的描述语 */
  words: string[];
}

/**
 * 确定性检出「描述语失真」：原文含能力描述语，而定制后**该描述语既不在、也没有被同级或更强的描述语替换**。
 * 判定口径：
 *   - 原词仍在 → 不算失真；
 *   - 被同级/更强描述语替换（熟悉→掌握、熟悉→精通）→ 不算失真（同义替换/合理升级）；
 *   - 被降级（熟练→熟悉）或直接抹平（「熟悉 X、沉淀 Y」压成「X、Y」）→ 算失真。
 * 用途：提示词已要求保真，但模型仍可能压平——这里如实检出并在界面提示，
 * **不做自动回填**（回填需要重新措辞，交给 AI 复检或人工，避免本地拼出不通顺的句子）。
 */
export function findQualifierLoss(rewrites: TailorRewrite[]): QualifierLoss[] {
  const out: QualifierLoss[] = [];
  for (const r of rewrites) {
    if (!r.before || !r.after) continue;
    const hits = r.before.match(PROFICIENCY_WORDS_RE);
    if (!hits || !hits.length) continue;
    const afterPeak = maxQualifierLevel(r.after);
    const lost = [...new Set(hits)].filter((w) => {
      if (r.after.includes(w)) return false;
      const level = QUALIFIER_LEVELS[w] ?? 0;
      if (level > 0 && afterPeak >= level) return false;
      return true;
    });
    if (lost.length) out.push({ module: r.module, before: r.before, after: r.after, words: lost });
  }
  return out;
}

/** 模块中文名（对照展示用） */
export const RESUME_DOC_MODULE_LABEL: Record<string, string> = {
  education: '教育经历',
  internships: '实习经历',
  works: '工作经历',
  projects: '项目经历',
  skills: '专业技能',
  honors: '个人荣誉',
  selfEval: '自我评价',
};

/** 本地兜底：用职业画像 facts 拼一份结构化文档（AI 不可用时保证 PDF 仍可用） */
export function buildLocalTailorDoc(profile: Profile | null): TailorResumeDoc {
  const facts = profile?.facts;
  const blocksOf = (items: string[] | undefined): TailorDocBlock[] =>
    (items || [])
      .filter(Boolean)
      .slice(0, 4)
      .map((s) => ({ heading: String(s).slice(0, 120), meta: '', bullets: [] as TailorDocLine[] }));
  return {
    education: blocksOf(facts?.education),
    internships: blocksOf(facts?.experiences),
    works: [],
    projects: blocksOf(facts?.projects),
    skills: (facts?.skills || []).slice(0, 12).map((s) => ({ text: String(s), source: '' })),
    honors: (facts?.certificates || []).slice(0, 8).map((s) => String(s)),
    selfEval: { text: String(profile?.summary || '').trim(), source: '' },
  };
}

/**
 * 根据岗位 JD 生成定制简历（结构化文档 + JD 要点对照 + 同口径匹配分 + 求职信 + 建议）+ 本地确定性匹配兜底。
 * 输入：岗位信息（title/company/salary/location/description）、简历原文、职业画像、AI 模型配置、可选经历补充材料。
 * AI 不可用/输出不达标 → 回退本地规则，绝不外泄未经事实与口吻校验的内容。
 */
export async function tailorForJob(
  job: JobMeta,
  resumeText: string,
  profile: Profile | null,
  model: AppConfig['model'],
  customGreetingPrompt?: string,
  extraMaterials?: string
): Promise<TailorResult> {
  // ===== 本地确定性匹配分析（不依赖 AI；仅作 AI 不可用时的兜底展示） =====
  const { keywords, weights } = extractJdKeywords(job.description || '', profile);
  const keywordAnalysis = analyzeJdKeywords(job.description || '', resumeText, profile, keywords);
  const profileBlob = profile ? JSON.stringify(stableProfileView(profile)) : '';
  const beforeScore = computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}`);

  const extra = String(extraMaterials || '').trim();

  const buildMatch = (): TailorMatchAnalysis => ({
    keywords: keywordAnalysis,
    before: beforeScore,
    // 本地算法不再产出「定制后分」：AI 两次判分的口径不可比，旧实现（原简历+定制内容拼接重算）
    // 会让前后恒等、给出「定制无增益」的假象。这里恒等于 before，界面据此标注为「本地估算」。
    after: beforeScore,
  });

  const localFallback = (warning: string): TailorResult => {
    const doc = buildLocalTailorDoc(profile);
    return {
      highlightedSkills: normalizeStringList(profile?.facts?.skills, 8),
      tailoredSummary: String(profile?.summary || '').trim() || '（未生成画像，请先在简历中心生成职业画像）',
      tailoredExperiences: normalizeStringList(profile?.facts?.experiences, 3),
      coverLetter: fallbackApplicantGreeting(job, profile),
      skillGaps: [],
      suggestions: buildLocalSuggestions(keywordAnalysis, job.description || '', resumeHasQuantifiedEvidence(resumeText)),
      doc,
      jdPoints: [],
      aiMatch: null,
      rewrites: [],
      qualifierLoss: [],
      match: buildMatch(),
      method: 'local',
      warning,
    };
  };
  if (!profile) return localFallback('尚未生成职业画像，当前为本地规则生成的定制内容。');
  if (!model?.apiKey) return localFallback('AI 尚未配置，当前为本地规则生成的定制内容。');

  // ===== 上下文预算（唯一口径见 contextBudget.ts）=====
  // 「简历 / 经历补充材料 / 职业画像 / 岗位描述」四段共享一次请求的输入预算：
  // 旧实现是各自硬编码字面量（简历 6000 字、补充材料 4000 字、岗位描述不裁），
  // 结果是「1M 窗口的模型只吃 6000 字简历」，而小窗口模型仍可能被长 JD 顶穿。
  // 现改为由用户在设置页声明的窗口大小与用量档位（全满 / 40%）统一决定。
  // 第一轮（草稿）与第二轮（复检）共用同一份裁剪结果：口径一致，也保证两轮看到的上下文相同。
  const ctxBudget = allocateContextBudget(
    model,
    { resume: 0.45, extra: 0.2, profile: 0.15, job: 0.2 },
    { outputTokens: 4096 },
  );
  // 简历与经历补充材料是「定制内容的事实来源」：超预算时分片提炼（≤3 片）后合并，
  // 不静默丢弃后半段经历（见 oversizedContext.ts）——定制简历的每条内容都必须能溯源到真实原文。
  const resumeCtx = (
    await prepareContextText(String(resumeText || ''), model, {
      tokenBudget: ctxBudget.resume,
      focus: '与目标岗位定制相关的简历真实事实：教育背景、实习/工作经历、项目经历、技能栈、证书荣誉（保留具体名称与数字）',
      cacheScope: 'assistant',
      purpose: '定制简历-简历上下文',
    })
  ).text;
  const extraCtx = extra
    ? (
        await prepareContextText(extra, model, {
          tokenBudget: ctxBudget.extra,
          focus: '求职者补充提供的真实经历材料（项目细节、成果、职责），与简历原文同为事实来源',
          cacheScope: 'assistant',
          purpose: '定制简历-补充材料',
        })
      ).text
    : '';
  const profileCtx = fitContextToTokens(JSON.stringify(stableProfileView(profile)), ctxBudget.profile);
  const jobView = {
    title: job.title,
    company: job.company,
    salary: decodeSalaryDigits(job.salary),
    location: job.location,
    // 只裁 description 值（直接裁 stringify 后的整段 JSON 会把结构切坏）
    description: fitContextToTokens(String(job.description || ''), ctxBudget.job),
  };
  try {
    // 求职信/打招呼语提示词来源优先级：① skill（greetings 技能，含用户自定义技能）→ ② 简历中心输入框内容 → ③ 都不满足则回退本地规则。
    // 每次调用都从磁盘重读 skills/*/SKILL.md（不改文件即无副作用），保证 JD 拆解方法等技能文档改了即时生效。
    await reloadSkills();
    const greetingsSkill = skillInstructionsFor('greetings');
    const greetingInstructions = greetingsSkill || (customGreetingPrompt || '').trim();
    // 校名披露：本地名单裁定后注入（见 schoolTier.ts）——只约束 coverLetter，简历正文按原文照抄不受限
    const schoolTier = resolveSchoolTier(normalizeStringList(profile.facts?.education, 8), resumeText);
    const schoolRule =
      buildSchoolDisclosureRule(schoolTier) +
      '\n（以上「校名披露」规则只约束 coverLetter；简历正文 resume 与 tailoredSummary 中的学校名按简历原文照抄，不受此限。）';
    const coverHasSchoolIssue = (text: string) => !schoolTier.allowSchoolName && hasSchoolMention(text);
    const result: any = await cachedCallModel(
      [
        { role: 'system', content: buildTailorSystemPrompt(greetingInstructions, schoolRule) + skillInstructionsFor('assistant') },
        {
          role: 'user',
          content: `职业画像：${profileCtx}
简历：${resumeCtx}${extraCtx ? `\n\n经历补充材料（求职者本人提供，与简历原文同为真实事实来源）：\n${extraCtx}` : ''}
岗位：${JSON.stringify(jobView)}`,
        },
      ],
      model,
      { maxTokens: 4096, temperature: 0.3 },
      { scope: 'assistant' }
    );
    const summary = String(result?.tailoredSummary || '').trim();
    const cover = String(result?.coverLetter || '').trim();
    // 事实与口吻校验：摘要非空 + 求职信通过口吻校验 + 校名披露合规（非 985/211 不得出现院校名称）
    if (!summary || !isApplicantVoice(cover) || coverHasSchoolIssue(cover)) {
      return localFallback('AI 生成未通过事实/口吻/校名披露校验，已回退本地规则。');
    }

    // ===== 第一轮：草稿（Draft） =====
    const draftDoc = normalizeTailorDoc(result?.resume);
    const draftPoints = normalizeJdPoints(result?.jdPoints);
    const draftAiMatch = normalizeAiMatch(result?.matchScore);
    const draft = {
      tailoredSummary: summary.slice(0, 300),
      tailoredExperiences: normalizeStringList(result?.tailoredExperiences, 4).map((e) => String(e).slice(0, 90)),
      highlightedSkills: normalizeStringList(result?.highlightedSkills, 8),
      coverLetter: String(cover).trim().replace(/\s+/g, ' '),
      skillGaps: normalizeStringList(result?.skillGaps, 4),
      suggestions: normalizeStringList(result?.suggestions, 5).map((s) => String(s).slice(0, 60)),
      doc: draftDoc,
    };

    // ===== 第二轮：招聘方 + ATS 视角自检修订（Reviewer） =====
    // 对齐 ai-job-search 的 drafter-reviewer。逐字段合并：仅当 review 给出「非空且通过校验」的修订才覆盖，
    // 否则保留草稿；review 失败/无效一律不降级草稿（草稿本身已通过事实与口吻校验）。
    // 注意：复检的「修订差异」不再单独展示（面板统一展示「原文 → 定制后」逐条对照），只保留一行结论与修订字段名。
    let finalDoc = draftDoc;
    let reviewMeta: TailorReviewMeta | undefined;
    try {
      const review: any = await cachedCallModel(
        [
          { role: 'system', content: buildReviewSystemPrompt(schoolRule) + skillInstructionsFor('assistant') },
          {
            role: 'user',
            content: `职业画像：${profileCtx}${extraCtx ? `\n经历补充材料：\n${extraCtx}` : ''}
岗位：${JSON.stringify(jobView)}
草稿：${JSON.stringify({
              tailoredSummary: draft.tailoredSummary,
              tailoredExperiences: draft.tailoredExperiences,
              highlightedSkills: draft.highlightedSkills,
              coverLetter: draft.coverLetter,
              skillGaps: draft.skillGaps,
              suggestions: draft.suggestions,
              resume: draft.doc,
              jdPoints: draftPoints,
            })}`,
          },
        ],
        model,
        { maxTokens: 3072, temperature: 0.2 },
        { scope: 'assistant' }
      );
      const reviewerText = (v: unknown) => String(v ?? '').trim();
      const merged = {
        tailoredSummary: reviewerText(review?.tailoredSummary) || draft.tailoredSummary,
        tailoredExperiences:
          Array.isArray(review?.tailoredExperiences) && review.tailoredExperiences.length
            ? normalizeStringList(review.tailoredExperiences, 4).map((e: unknown) => String(e).slice(0, 90))
            : draft.tailoredExperiences,
        highlightedSkills:
          Array.isArray(review?.highlightedSkills) && review.highlightedSkills.length
            ? normalizeStringList(review.highlightedSkills, 8)
            : draft.highlightedSkills,
        coverLetter: (() => {
          const c = reviewerText(review?.coverLetter);
          // 求职信修订须再次通过口吻校验与校名披露校验才采纳，避免 review 把第一人称改坏或把校名塞回来；
          // 只做单行化，长度交由 settle 再生成处理
          return c && isApplicantVoice(c) && !coverHasSchoolIssue(c)
            ? String(c).trim().replace(/\s+/g, ' ')
            : draft.coverLetter;
        })(),
        skillGaps: Array.isArray(review?.skillGaps) ? normalizeStringList(review.skillGaps, 4) : draft.skillGaps,
        suggestions:
          Array.isArray(review?.suggestions) && review.suggestions.length
            ? normalizeStringList(review.suggestions, 5).map((s: unknown) => String(s).slice(0, 60))
            : draft.suggestions,
      };
      // 摘要守卫：review 修订后仍须非空（草稿已验证为非空）
      const finalTailored = { ...merged, tailoredSummary: merged.tailoredSummary.slice(0, 300) || draft.tailoredSummary };
      // 结构化文档：review 返回了非空 resume 才替换（替换内容同样经规范化，脏数据进不来）
      const reviewedDoc = review?.resume ? normalizeTailorDoc(review.resume) : null;
      if (reviewedDoc) finalDoc = reviewedDoc;
      // 收集实际被修订字段的中文名（面板只展示一行结论，不再展示逐字段 before/after）
      const revisedFields: string[] = [];
      if (finalTailored.tailoredSummary !== draft.tailoredSummary) revisedFields.push('定制个人摘要');
      if (finalTailored.tailoredExperiences.join('；') !== draft.tailoredExperiences.join('；')) revisedFields.push('重点经历');
      if (finalTailored.highlightedSkills.join('；') !== draft.highlightedSkills.join('；')) revisedFields.push('岗位匹配技能');
      if (finalTailored.coverLetter !== draft.coverLetter) revisedFields.push('定制求职信');
      if (finalTailored.skillGaps.join('；') !== draft.skillGaps.join('；')) revisedFields.push('技能缺口');
      if (finalTailored.suggestions.join('；') !== draft.suggestions.join('；')) revisedFields.push('优化建议');
      if (reviewedDoc) revisedFields.push('简历文档');
      const note = reviewerText(review?.reviewNote) || undefined;
      if (note || revisedFields.length) reviewMeta = { note, revisedFields };
      Object.assign(draft, finalTailored);
    } catch {
      /* review 失败不阻塞：沿用草稿 */
    }

    // 逐条改写对照：由最终文档的 source/text 派生，因此永远与交付稿同步
    const { rewrites, unmatched } = deriveRewrites(finalDoc, RESUME_DOC_MODULE_LABEL, extra);
    const allRewrites = [...rewrites, ...unmatched];
    // 描述语保真兜底检出（只检出、不自动回填；回填措辞交给 AI 复检或人工）
    const qualifierLoss = findQualifierLoss(rewrites);

    return {
      ...draft,
      doc: finalDoc,
      jdPoints: draftPoints,
      aiMatch: draftAiMatch,
      rewrites: allRewrites,
      qualifierLoss,
      review: reviewMeta,
      coverLetter: await settleGreetingLength(draft.coverLetter, {
        job,
        profile,
        resumeText,
        model,
        greetingInstruction: greetingInstructions || DEFAULT_ANALYZE_GREETING_INSTRUCTIONS,
      }),
      match: buildMatch(),
      method: 'ai',
      // AI 首次返回的 JSON 不完整、已由二次补齐修复时，提示（内容仍来自 AI，非降级）
      warning: (result as any)?._repaired ? 'AI 首次返回的 JSON 不完整，已通过自动补齐修复（结果仍来自 AI）。' : undefined,
    };
  } catch (error: any) {
    const kind = aiFailureKind(error);
    const reason =
      kind === 'config-missing' || kind === 'service-error'
        ? `AI 请求${kind === 'config-missing' ? '未配置' : '异常'}，已回退本地规则（${error?.message || '未知原因'}）。`
        : `AI 返回内容解析异常，已回退本地规则（${error?.message || '未知原因'}）。`;
    return localFallback(reason);
  }
}
