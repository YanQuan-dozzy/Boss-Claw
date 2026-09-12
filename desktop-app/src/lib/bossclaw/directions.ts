// 移植自 job-claw-main\source\src\background.js 的岗位方向计划逻辑
import type { DirectionItem, DirectionPlan, Profile } from './types';
import { uniq } from './defaults';
import { normalizeStringList, clampNumber, normalizeDirectionKey, findDirectionRule } from './helpers';

// 证据占位符（仅作标记，不应作为「职业画像中已提取到」的真实证据展示）
const MANUAL_EDIT_EVIDENCE = '用户手动编辑';
const PLACEHOLDER_EVIDENCE = new Set([MANUAL_EDIT_EVIDENCE, '根据简历中的技能、项目和求职阶段生成']);

// 粗粒度能力词的成员覆盖表（缺口比对的确定性同义词）。
// 目录里的 gapSkills（如「数据库」）是宽泛能力名；简历/画像里往往存的是具体成员（PostgreSQL/MySQL/SQL 调优），
// 逐词子串匹配会误报缺口。据此把粗词展开为成员 token，任一成员被画像覆盖即视为该能力已具备、不再判为缺口。
const GAP_COVERAGE_SYNONYMS: Record<string, string[]> = {
  数据库: ['postgresql', 'mysql', 'oracle', 'sqlite', 'mssql', 'sql server', 'sql', 'mongodb', 'redis', 'pgvector', '索引', '事务', '调优'],
  缓存: ['redis', 'memcached', '本地缓存', '缓存击穿', '缓存雪崩', 'cdn'],
  接口设计: ['api', 'rest', 'restful', 'rpc', 'graphql', '接口', 'grpc', 'webhook', '微服务'],
  后端接口: ['api', 'rest', 'restful', 'rpc', 'graphql', '接口', 'grpc', '后端'],
  部署运维: ['docker', 'k8s', 'kubernetes', 'ci/cd', 'jenkins', 'nginx', 'linux', '容器', '部署', '运维', 'devops', 'github actions'],
  工程化: ['vite', 'webpack', 'rollup', '构建', '脚手架', 'monorepo', 'pnpm', 'webpack', 'lint', 'typescript', '工程化'],
  性能优化: ['性能', '优化', '调优', '首屏', '渲染', 'qps', 'tps', '减少重排', '请求合并', '缓存'],
  组件库: ['antd', 'element', '组件', 'design system', 'storybook', 'lerna'],
  模型评测: ['评估', 'benchmark', '评测', '指标', 'accuracy', 'llm', '效果测试'],
  向量数据库: ['pgvector', 'milvus', 'faiss', 'qdrant', '向量检索', 'embedding', '向量'],
  提示词工程: ['prompt', 'few-shot', 'cot', '提示词', 'rag'],
  图形性能优化: ['canvas', 'webgl', '渲染', 'dpr', 'fps', '性能', '优化', '帧率'],
  算法: ['算法', '机器学习', '深度学习', 'nlp', '模型', '推荐', '排序', '数据结构'],
  数学基础: ['线性代数', '概率', '统计', '微积分', '高数', '数学'],
  大规模训练: ['分布式训练', 'gpu', 'cuda', '多卡', '集群训练', '微调', 'lora'],
  统计学: ['统计', '假设检验', '回归', '方差', 'ab测试', '概率', '线性代数'],
  业务指标: ['指标', '漏斗', '留存', '转化率', 'gmv', '北极星', '埋点', '数据分析'],
  自动化框架: ['selenium', 'playwright', 'cypress', 'pytest', 'junit', '自动化', 'testng'],
  性能测试: ['jmeter', 'loadrunner', '性能', '压测', 'qps', 'tps', '并发'],
  测试设计: ['用例', '测试计划', '场景', '边界', '冒烟', '回归'],
  监控告警: ['prometheus', 'grafana', 'zabbix', '监控', '告警', '日志', 'elk', 'sentry'],
  渗透实战: ['渗透', 'xss', 'sql注入', 'csrf', '漏洞', 'burp', 'metasploit'],
  安全工具: ['nmap', 'burp', 'wireshark', 'hydra', '漏洞扫描', '安全'],
  合规: ['等保', 'gdpr', '合规', 'iso27001', '审计'],
  原生组件: ['webview', 'bridge', 'jni', '原生', 'flutter platform channel'],
  跨端适配: ['responsive', '适配', 'viewport', 'rem', '媒体查询', '跨端', '小程序'],
  驱动开发: ['驱动', 'kernel', 'module', 'linux驱动', '中断', 'dma'],
  硬件调试: ['示波器', '万用表', 'jtag', 'uart', 'spi', 'i2c', '调试', '硬件'],
  rtos: ['freertos', 'rt-thread', 'ucos', 'rtos', '嵌入式实时'],
  // 以下 key 为 gapSkills 经 normalizeDirectionKey 归一化后的形式（去除 / 与空格等字符）
  高并发分布式设计: ['高并发', '分布式', '并发', 'qps', '秒杀', '限流'],
  云原生容器化: ['k8s', 'kubernetes', 'docker', '云原生', '容器'],
  消息队列: ['kafka', 'rabbitmq', 'rocketmq', '消息队列', 'mq'],
  实时计算: ['flink', '实时', 'spark streaming', '流计算', 'kafka streams'],
  数据治理: ['数据治理', '元数据', '数据质量', 'hive'],
  湖仓一体: ['湖仓', '数据湖', 'iceberg', 'hudi', 'paimon'],
  数据库内核: ['存储引擎', '内核', '索引结构', 'b+树', 'wal'],
  分布式数据库: ['tidb', 'oceanbase', '分库分表', 'sharding', '分布式存储'],
  高可用容灾架构: ['高可用', '主从', '哨兵', '集群', '容灾', 'failover', 'replica'],
  模型评测可观测性: ['评测', 'benchmark', 'eval', '可观测', 'otel'],
  模型微调推理部署: ['微调', 'fine-tuning', 'lora', 'vllm', 'tensorrt', 'sft', '部署'],
  agent编排: ['agent', '工作流', 'function calling', 'tool', '编排'],
  // 岗位要求技能中的常见能力词（relevantSkills 并入缺口候选后，确保画像已具备时不被误报为缺口）
  微服务: ['微服务', 'rpc', 'grpc', 'dubbo', 'spring cloud', '服务拆分'],
  分布式: ['分布式', '一致性哈希', '分区', 'zookeeper'],
  数据仓库: ['数据仓库', '数仓', 'hive', '数据平台', '数据分层'],
  数仓建模: ['数仓建模', '维度建模', '数据建模', '星型模型'],
  数据分析: ['数据分析', '数据运营', 'sql', 'excel', 'bi'],
  数据可视化: ['数据可视化', '可视化', 'echarts', '大屏'],
  用户增长: ['用户增长', '增长', '留存', '转化', '拉新'],
  客户开发: ['客户开发', '拓客', '获客', '销售线索'],
  商务谈判: ['商务谈判', '谈判', '议价', '报价'],
  供应商管理: ['供应商', 'sourcing', '供应商开发'],
  库存管理: ['库存', '盘点', '呆滞'],
  现场管理: ['现场', '施工', '安全', '5s'],
  设备维护: ['设备维护', '保养', 'tpm', '维修'],
  结构设计: ['结构设计', '力学', 'solidworks', 'cad'],
  平台规则: ['平台规则', '平台', '治理'],
  店铺运营: ['店铺运营', '店铺', '链接', '详情页'],
  跨境电商: ['跨境电商', 'amazon', 'ebay', '独立站', 'tiktok shop'],
  短视频: ['短视频', '抖音', '视频号', '快手', 'tiktok'],
  直播: ['直播', '带货', '主播', '直播间'],
  数字营销: ['数字营销', 'sem', 'seo', '信息流', '投放'],
  私域: ['私域', '社群', '企微', '会员'],
  内容策划: ['内容策划', '内容', '选题', '文案'],
  品牌策划: ['品牌策划', '品牌', '公关', '媒介'],
  数据运营: ['数据运营', '数据分析', '运营指标', '埋点'],
};

// 文本 token 命中：ASCII 词用词边界避免 Java 误命中 JavaScript，中文用子串
function textHasToken(token: string, text: string): boolean {
  const t = String(token || '').toLowerCase();
  const h = String(text || '').toLowerCase();
  if (!t) return false;
  if (/^[\x00-\x7F]+$/.test(t)) {
    return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(h);
  }
  return h.includes(t);
}

// 缺口词是否已被画像能力文本覆盖：原始写法（含空格，如 Spring Boot）→ 归一化形式 → 同义词成员任一命中
function gapCoveredByProfile(gap: string, profileText: string): boolean {
  const raw = String(gap || '').trim();
  if (raw && textHasToken(raw, profileText)) return true;
  const g = normalizeDirectionKey(gap);
  if (g && textHasToken(g, profileText)) return true;
  const members = GAP_COVERAGE_SYNONYMS[g] || [];
  return members.some((member) => textHasToken(member, profileText));
}

// 英文技能词是否在经历/项目的英文技术词证据中出现（词边界命中，如画像项目里用过 Redis / React Native）
function isEnglishTermCovered(gap: string, englishEvidence: string): boolean {
  const raw = String(gap || '').trim();
  if (raw && /^[\x00-\x7F]+$/.test(raw) && textHasToken(raw, englishEvidence)) return true;
  const t = normalizeDirectionKey(gap);
  if (!t || !/^[\x00-\x7F]+$/.test(t)) return false;
  return textHasToken(t, englishEvidence);
}

// 覆盖判定来源：细粒度能力 + 技能（含经历/项目中摘出的英文技术词，识别项目里实际用过、未入技能清单的能力）
function coverageSourcesFor(profile: Profile | null) {
  const skills = normalizeStringList(profile?.facts?.skills, 40);
  const capabilities = normalizeStringList(profile?.facts?.capabilities, 30);
  const namePool = [...capabilities, ...skills];
  const text = namePool.join('\n');
  // 归一化别名集：JS/js↔JavaScript、Node↔Node.js、React↔reactjs 都归一到同一键，供「别名归属」判定
  const tokens = new Set<string>(namePool.map((s) => normalizeDirectionKey(s)).filter(Boolean));
  const english = normalizeStringList(profile?.facts?.experiences, 10)
    .concat(normalizeStringList(profile?.facts?.projects, 10))
    .join(' ')
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/[^A-Za-z0-9#+.\-]+/g, ' ')
    .toLowerCase();
  return { text, english, tokens };
}

// 常见技能别名归一表：缺口与画像技能都先经规范映射，再判“相等即覆盖”。
// 用可控别名而非“任意子串互含”，避免 mysql⊃sql、java⊃javascript 等误覆盖真实缺口。
const SKILL_ALIAS_CANON: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  node: 'nodejs',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  'node.js 开发': 'nodejs',
  react: 'react',
  'react.js': 'react',
  reactjs: 'react',
  vue: 'vue',
  vuejs: 'vue',
  vue3: 'vue3',
  next: 'nextjs',
  'next.js': 'nextjs',
  nextjs: 'nextjs',
  nest: 'nestjs',
  'nest.js': 'nestjs',
  nestjs: 'nestjs',
  k8s: 'kubernetes',
  kubernetes: 'kubernetes',
  golang: 'go',
  go: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  dotnet: 'dotnet',
  express: 'express',
  jquery: 'jquery',
};

function canonicalSkillKey(value: string): string {
  return SKILL_ALIAS_CANON[normalizeDirectionKey(value)] || normalizeDirectionKey(value);
}

// 别名归属：缺口与画像任一 技能/能力 归一化后「规范名相等」→ 视为已覆盖（JS↔JavaScript、Node↔Node.js 等）
function gapAliasCovered(g: string, tokens: Set<string>): boolean {
  if (!g) return false;
  const canon = canonicalSkillKey(g);
  let hit = false;
  tokens.forEach((t) => {
    if (!hit && canonicalSkillKey(t) === canon) hit = true;
  });
  return hit;
}

// 缺口项是否已被画像覆盖（能力/技能/别名/英文证据任一命中 → 已具备，不应再显示为缺口）
function gapCovered(gap: string, coverage: { text: string; english: string; tokens: Set<string> }): boolean {
  if (gapCoveredByProfile(gap, coverage.text)) return true;
  if (gapAliasCovered(normalizeDirectionKey(gap), coverage.tokens)) return true;
  return isEnglishTermCovered(gap, coverage.english);
}

/**
 * 对外统一剔除「画像已具备」的缺口：无论缺口来自本地目录还是 AI 复核，
 * 写入方向前都再过此关，保证已具备的技能不会误报为缺口。默认只保留前 5。
 */
export function filterGapsCoveredByProfile(gaps: string[], profile: Profile | null, limit = 5): string[] {
  if (!Array.isArray(gaps) || !gaps.length) return gaps;
  const coverage = coverageSourcesFor(profile);
  return gaps.filter((g) => !gapCovered(g, coverage)).slice(0, limit);
}

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
  const skills = normalizeStringList(profile?.facts?.skills, 40);
  const preset = directionPreset(name);
  // 匹配技能：该方向「岗位要求技能」与画像技能按「归一化规范名相等」（含别名 JS↔JavaScript、Node↔Node.js）
  // 对齐，避免 java⊂javascript 这类子串误配（Java 绝不匹配 JavaScript）。
  const hasSkill = new Set<string>(skills.map((s) => canonicalSkillKey(s)));
  const pool = preset?.relevantSkills || skills;
  const relevant = pool.filter((skill) => hasSkill.has(canonicalSkillKey(skill)));
  const matchedSkills = normalizeStringList(relevant.length ? relevant : skills.slice(0, 4)).slice(0, 5);
  // 覆盖判定来源：细粒度能力 + 技能 + 经历/项目中摘出的英文技术词（画像实际用过但未必入技能清单的能力）。
  // 中文正文不参与缺口覆盖，防止泛词吞掉真实缺口。
  const coverage = coverageSourcesFor(profile);
  // 缺口候选 = 该方向岗位要求能力（静态缺口 + 岗位要求技能），与技能一体；
  // 画像已具备（能力/技能/英文证据）→ 剔除；未具备 → 真实缺口，按优先级保留前 5。
  const gapCandidates = uniq([...(preset?.gapSkills || []), ...(preset?.relevantSkills || [])]);
  const gaps = gapCandidates
    .filter((skill) => !gapCovered(skill, coverage))
    .slice(0, 5);
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
    gaps: normalizeStringList(item.gaps, 5),
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
