// 技能归一本体 + JD 噪音词闸门（缺口判定专用；纯本地确定性词表，不调用 AI、可复现、可解释）
//
// 修复的真实误报（用户实测截图）：
//   jobMatch 会把 JD 里出现的**任意英文 token** 收成「技术关键词」，画像词表未命中就报
//   「岗位要求画像未具备：…」，于是出现两类假缺口：
//   ① 非技能词混入：HR / bug / Demo —— 招聘角色、流程与交付物词汇，本就不是技能要求；
//   ② 同一能力的表述差异：简历写「熟练 Git 分支协作」，JD 写 GitHub/GitLab；
//      简历写 Python（FastAPI），JD 写 Flask；简历写 React/TypeScript/Next.js，JD 写 JavaScript
//      —— 逐字面比对全部落成假缺口。
//
// 两把确定性闸门（供 jobMatch / resumeMatch / directions 共用）：
//   1. isNonSkillJdToken()   —— 非技能噪音词，直接不进缺口候选；
//   2. 等价组 / 上位覆盖      —— 画像已具备同族或上位能力时，该 JD 要求视为已覆盖。
//
// 设计克制：等价组只收录「同一语言/同一用途的同族实现」与「写法别名」，不做跨产品互认
// （如 MySQL 与 PostgreSQL 不互认、会 Vue 不等于会 React），避免真实缺口被掩盖。

// ===== 技能规范键 =====
/**
 * 归一为可比较的规范键：小写 → 去掉分隔符（空格 / `.` / `-` / `_` / `/`）。
 * 保留 `+` `#` 语义（C++ / C# 不能被压成 C）；这样 `Node.js`、`node js`、`NodeJS`
 * 都归一为 `nodejs`，`mybatis-plus` 与 `MyBatisPlus` 也归一到同一键。
 */
export function canonicalSkillKey(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s._\-\/\\|·•]+/g, '')
    .trim();
}

// ===== 闸门 1：非技能噪音词 =====
// 均为 canonical 形式（小写、无分隔符）。命中即说明该 token 不是技能要求，不进缺口候选。
const JD_NON_SKILL_TOKENS = new Set<string>([
  // 招聘角色 / 流程 / 文档
  'hr', 'hrbp', 'hrm', 'cv', 'jd', 'resume', 'interview', 'interviewer', 'candidate', 'offer',
  'headcount', 'onboard', 'onboarding', 'kpi', 'okr', 'roi',
  // 交付物 / 缺陷 / 过程词（不是技术栈）
  'demo', 'demos', 'bug', 'bugs', 'issue', 'issues', 'ticket', 'tickets',
  'deadline', 'milestone', 'deliverable', 'deliverables',
  // 常见缩写 / 公司实体后缀
  'ltd', 'inc', 'corp', 'llc', 'gmbh', 'etc', 'eg', 'ie', 'aka',
]);

/** 是否非技能噪音词（HR / bug / Demo / JD 等）——命中即不应作为缺口 */
export function isNonSkillJdToken(token: string): boolean {
  const key = canonicalSkillKey(token);
  return !!key && JD_NON_SKILL_TOKENS.has(key);
}

// ===== 闸门 2：技能等价组与上位覆盖 =====
/** 等价组（canonical 形式）：组内任一具备 → 视为该组全部具备（同义写法 / 同族可迁移实现） */
const SKILL_EQUIVALENCE_GROUPS: string[][] = [
  // 版本控制与代码托管：简历写「Git 分支协作」，JD 写 GitHub / GitLab / Gitee
  ['git', 'github', 'gitlab', 'gitee', 'bitbucket', 'svn'],
  // Python Web 框架：同一语言、同一用途，具备其一即可胜任同类后端开发
  ['flask', 'django', 'fastapi', 'tornado', 'sanic', 'starlette'],
  // Java 后端框架
  ['spring', 'springboot', 'springmvc', 'springcloud', 'springsecurity'],
  // 持久层 / ORM
  ['mybatis', 'mybatisplus', 'jpa', 'hibernate'],
  // JS / TS 写法归一（TS 是 JS 超集，两者互为等价表述）
  ['javascript', 'js', 'es6', 'ecmascript', 'jsx'],
  ['typescript', 'ts', 'tsx'],
  // 前端框架写法归一
  ['react', 'reactjs'],
  ['vue', 'vuejs', 'vue2', 'vue3'],
  ['angular', 'angularjs'],
  ['node', 'nodejs'],
  // 包管理与构建工具
  ['npm', 'yarn', 'pnpm'],
  ['webpack', 'vite', 'rollup', 'gulp'],
  // 关系型数据库（仅写法归一，不做跨产品互认）
  ['postgresql', 'postgres', 'pgsql'],
  ['mysql', 'mariadb'],
  // 容器与编排
  ['docker', 'podman'],
  ['k8s', 'kubernetes'],
  // 消息队列 / 中间件（同一用途：异步解耦 / 削峰）
  ['kafka', 'rabbitmq', 'rocketmq', 'activemq', 'pulsar'],
  // 搜索引擎（Lucene 系同族）
  ['elasticsearch', 'solr'],
  // 深度学习框架（同族可迁移）
  ['pytorch', 'tensorflow', 'paddlepaddle'],
  // 流式计算（实时计算同族）
  ['spark', 'flink'],
  // 持续集成
  ['jenkins', 'gitlabci', 'githubactions'],
  // AI 编程助手：同类工具任一款具备即视为该能力类别已覆盖（避免 JD 写 Codex/Copilot、
  // 简历写 ChatGPT/Claude/Cursor 被判缺口）
  [
    'chatgpt', 'gpt', 'openai', 'cursor', 'copilot', 'codex', 'claude', 'gemini',
    'deepseek', 'kimi', 'qwen', 'doubao', 'tongyi', 'wenxin', 'ernie', 'llama',
  ],
];

/**
 * 上位覆盖关系：画像具备 key（含其等价写法）→ 右侧 JD 要求视为已被覆盖。
 * 单向，不做反向（会 TS 必然掌握 JS；会 JS 不等于会 TS）。
 */
const SKILL_COVERS: Record<string, string[]> = {
  typescript: ['javascript', 'js'],
  react: ['javascript', 'js', 'jsx'],
  vue: ['javascript', 'js'],
  angular: ['javascript', 'js', 'typescript'],
  svelte: ['javascript', 'js'],
  nextjs: ['react', 'javascript', 'js'],
  nuxtjs: ['vue', 'javascript', 'js'],
  node: ['javascript', 'js'],
  jquery: ['javascript', 'js'],
};

function findEquivalenceGroup(key: string): string[] | null {
  for (const group of SKILL_EQUIVALENCE_GROUPS) {
    if (group.some((member) => canonicalSkillKey(member) === key)) return group;
  }
  return null;
}

/** `term` 的等价技能键集合（canonical 形式，含自身；无等价组时只含自身）。
 *  中文技能别名一并展开：JD 写「缓存」→ 并入 redis/memcached 等价键，简历有 Redis 即视为已覆盖；
 *  此处的 `zhAliasToKeys` 在下方「中文技能别名词典」一节定义后填充（运行前已就绪）。 */
export function equivalentSkillKeys(term: string): string[] {
  const key = canonicalSkillKey(term);
  if (!key) return [];
  const keys = new Set<string>([key]);
  for (const member of findEquivalenceGroup(key) || []) keys.add(canonicalSkillKey(member));
  const aliasFamily = zhAliasToKeys.get(key);
  if (aliasFamily) for (const k of aliasFamily) keys.add(k);
  return [...keys].filter(Boolean);
}

/** 能「覆盖」`term` 的上位技能键集合（canonical 形式；等价写法已展开） */
export function coveringSkillKeys(term: string): string[] {
  const key = canonicalSkillKey(term);
  if (!key) return [];
  const out = new Set<string>();
  for (const [source, targets] of Object.entries(SKILL_COVERS)) {
    if (!targets.some((target) => canonicalSkillKey(target) === key)) continue;
    for (const candidate of equivalentSkillKeys(source)) out.add(candidate);
  }
  return [...out];
}

/** 从任意文本（画像 JSON / 简历原文）抽取英文技术 token 的规范键集合，用于「已具备」比对 */
export function skillKeysInText(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9+#.\-]{1,29}/g)) {
    const key = canonicalSkillKey(match[0]);
    if (key) keys.add(key);
  }
  return keys;
}

/** 从文本抽取英文 token 原文（保留大小写，用于逐词噪音检查与展示） */
export function extractEnglishTokens(text: string): string[] {
  return [...String(text || '').matchAll(/[A-Za-z][A-Za-z0-9+#.\-]{1,29}/g)].map((match) => match[0]);
}

// ===== 中文技能别名词典（中文 JD 技能缺口检测专用）=====
// 背景：extractJdKeywords 只抽英文 token + 画像词表命中；中文 JD 里「熟悉消息队列、掌握容器化部署」
// 这类写法若画像词表未收录，就检测不到缺口。本词典把「可明确映射到单一技能实体/同族」的高频中文词
// 收录进来，供：
//   ① resumeMatch.extractJdKeywords 中文通道：JD 命中别名 → 作为关键词（权重 2）与缺口候选；
//   ② jobMatch.isJdTermCovered 覆盖判定：JD 中文词「容器化」⇄ 简历英文「Docker」、
//      或 JD 英文「Docker」⇄ 简历中文「容器化」双向视为已覆盖（通过等价组展开 + 文本命中）。
// 红线：只收录能映射到单一技能实体或明确同族的词，不收「开发 / 技术 / 架构」等泛词，
// 避免把真实缺口掩盖掉。
export interface ChineseSkillTerm {
  /** 规范技能键（canonical，如 redis / kafka / docker）；其等价组由 SKILL_EQUIVALENCE_GROUPS 展开 */
  key: string;
  /** 中文别名（岗位 JD 里的中文写法） */
  zh: string[];
}

export const CHINESE_SKILL_TERMS: ChineseSkillTerm[] = [
  // 数据存储与缓存
  { key: 'redis', zh: ['缓存', 'Redis缓存', '缓存技术'] },
  { key: 'mongodb', zh: ['非关系型数据库', '文档数据库'] },
  { key: 'elasticsearch', zh: ['搜索引擎', '全文检索'] },
  // 消息与异步
  { key: 'kafka', zh: ['消息队列', '消息中间件', '消息服务'] },
  // 容器与云原生
  { key: 'docker', zh: ['容器化', '容器化部署', '微服务容器化'] },
  { key: 'k8s', zh: ['容器编排', '容器调度', 'Kubernetes集群'] },
  { key: 'nginx', zh: ['反向代理', '负载均衡'] },
  // 微服务
  { key: 'springcloud', zh: ['微服务', '微服务架构'] },
  // 大数据
  { key: 'hadoop', zh: ['大数据平台', 'HDFS'] },
  { key: 'spark', zh: ['流式计算', '实时计算'] },
  { key: 'flink', zh: ['流式处理', '实时流处理'] },
  { key: 'hive', zh: ['数据仓库'] },
  // 数据分析
  { key: 'pandas', zh: ['数据处理', '数据清洗'] },
  { key: 'airflow', zh: ['任务调度', '工作流调度'] },
  // 机器学习 / 深度学习
  { key: 'pytorch', zh: ['深度学习', '深度学习框架'] },
  { key: 'tensorflow', zh: ['深度学习', '深度学习框架'] },
  { key: 'sklearn', zh: ['机器学习', '机器学习框架'] },
  { key: 'langchain', zh: ['大模型应用', 'Agent开发', 'RAG'] },
  // 并发 / 性能
  { key: '多线程', zh: ['并发编程', '并发处理'] },
  { key: 'sql', zh: ['SQL优化', '数据库优化', '复杂SQL'] },
  // 数据库建模
  { key: 'mysql', zh: ['建表', '索引优化', '数据库设计'] },
  // 测试与交付
  { key: 'pytest', zh: ['自动化测试', '测试框架'] },
  { key: 'jenkins', zh: ['持续集成', 'CI/CD'] },
];

// 中文别名（小写）→ 等价规范键集合（含等价组展开；同一别名多处收录时并集）
const zhAliasToKeys = new Map<string, Set<string>>();
for (const term of CHINESE_SKILL_TERMS) {
  const group = findEquivalenceGroup(term.key) || [term.key];
  const keys = new Set(group.map((member) => canonicalSkillKey(member)));
  for (const alias of term.zh) {
    const a = String(alias || '').trim().toLowerCase();
    if (!a) continue;
    const prev = zhAliasToKeys.get(a);
    zhAliasToKeys.set(a, new Set([...(prev || []), ...keys]));
  }
}

/** 文本中命中的中文技能别名（去重，按词表顺序；画像/简历文本与 JD 文本均可传入） */
export function chineseSkillHitsInText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const t = String(text || '');
  for (const term of CHINESE_SKILL_TERMS) {
    for (const alias of term.zh) {
      if (!seen.has(alias) && t.includes(alias)) {
        seen.add(alias);
        out.push(alias);
      }
    }
  }
  return out;
}

/** 中文别名 → 等价规范键集合（英文，含等价组展开；无匹配返回仅自身） */
export function equivalentKeysForAlias(alias: string): string[] {
  const a = String(alias || '').trim().toLowerCase();
  const keys = zhAliasToKeys.get(a);
  return keys ? [...keys] : [canonicalSkillKey(alias)].filter(Boolean);
}

/**
 * 确认 JD 要求词是否被「画像/简历文本」中的中文别名覆盖（反向方向）：
 * 简历写「容器化」（中文）→ JD 写 Docker / Podman 视为已覆盖（term 的等价键与别名族相交）。
 */
export function zhAliasCoversTerm(term: string, text: string): boolean {
  const termKeys = new Set(equivalentSkillKeys(term));
  for (const alias of chineseSkillHitsInText(text)) {
    for (const k of equivalentKeysForAlias(alias)) {
      if (termKeys.has(k)) return true;
    }
  }
  return false;
}
