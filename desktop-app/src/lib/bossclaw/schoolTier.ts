// 院校层级（985 / 211）本地判定 + 打招呼语「校名披露」规则。
//
// 口径：打招呼语 / 求职信里**只有简历院校属于 985 / 211 时才写出校名**，其余院校
// （双非、独立学院、专科、境外院校等）一律不出现任何院校名称，只写学历/专业/年级。
// 理由：非名校校名写进招呼语不产生加分，反而分散 HR 在第一屏里抓「岗位匹配点」的注意力。
//
// 本地名单是**唯一裁决来源**（对齐既有「AI 优先、本地兜底」原则）：AI 不自行判断院校层级，
// 由本地在提示词里给出「允许写校名 / 禁止写校名」的明确结论，避免模型把双非误当 211、
// 或按常识臆造校名。同一结论同时服务于本地兜底链：本地兜底模板（fallbackApplicantGreeting）
// 与 AI 生成结果的口吻校验都用它。

/** 985 工程院校（39 所）。 */
const ELITE_985: string[] = [
  '北京大学',
  '清华大学',
  '中国人民大学',
  '北京航空航天大学',
  '北京理工大学',
  '中国农业大学',
  '北京师范大学',
  '中央民族大学',
  '南开大学',
  '天津大学',
  '大连理工大学',
  '东北大学',
  '吉林大学',
  '哈尔滨工业大学',
  '复旦大学',
  '同济大学',
  '上海交通大学',
  '华东师范大学',
  '南京大学',
  '东南大学',
  '浙江大学',
  '中国科学技术大学',
  '厦门大学',
  '山东大学',
  '中国海洋大学',
  '武汉大学',
  '华中科技大学',
  '中南大学',
  '湖南大学',
  '国防科技大学',
  '中山大学',
  '华南理工大学',
  '重庆大学',
  '四川大学',
  '电子科技大学',
  '西安交通大学',
  '西北工业大学',
  '西北农林科技大学',
  '兰州大学',
];

/** 211 工程院校中非 985 的部分（77 所）。 */
const ELITE_211_ONLY: string[] = [
  // 北京
  '北京交通大学',
  '北京工业大学',
  '北京科技大学',
  '北京化工大学',
  '北京邮电大学',
  '北京林业大学',
  '北京中医药大学',
  '北京外国语大学',
  '中国传媒大学',
  '中央财经大学',
  '对外经济贸易大学',
  '北京体育大学',
  '中央音乐学院',
  '中国政法大学',
  '华北电力大学',
  '中国矿业大学',
  '中国石油大学',
  '中国地质大学',
  // 天津 / 河北
  '天津医科大学',
  '河北工业大学',
  // 山西 / 内蒙古
  '太原理工大学',
  '内蒙古大学',
  // 辽宁 / 吉林 / 黑龙江
  '辽宁大学',
  '大连海事大学',
  '东北师范大学',
  '延边大学',
  '哈尔滨工程大学',
  '东北农业大学',
  '东北林业大学',
  // 上海
  '华东理工大学',
  '东华大学',
  '上海外国语大学',
  '上海财经大学',
  '上海大学',
  '海军军医大学',
  // 江苏
  '苏州大学',
  '南京航空航天大学',
  '南京理工大学',
  '河海大学',
  '江南大学',
  '南京农业大学',
  '中国药科大学',
  '南京师范大学',
  // 安徽 / 福建 / 江西
  '安徽大学',
  '合肥工业大学',
  '福州大学',
  '南昌大学',
  // 山东 / 河南
  '郑州大学',
  // 湖北 / 湖南
  '武汉理工大学',
  '华中农业大学',
  '华中师范大学',
  '中南财经政法大学',
  '湖南师范大学',
  // 广东 / 广西 / 海南
  '暨南大学',
  '华南师范大学',
  '广西大学',
  '海南大学',
  // 重庆 / 四川
  '西南大学',
  '西南交通大学',
  '四川农业大学',
  '西南财经大学',
  // 贵州 / 云南 / 西藏
  '贵州大学',
  '云南大学',
  '西藏大学',
  // 陕西 / 甘肃 / 青海 / 宁夏 / 新疆
  '西北大学',
  '西安电子科技大学',
  '长安大学',
  '陕西师范大学',
  '空军军医大学',
  '青海大学',
  '宁夏大学',
  '新疆大学',
  '石河子大学',
];

/** 985 + 211 全量名单（规范化形式，共 116 所）。 */
export const ELITE_SCHOOLS: string[] = [...ELITE_985, ...ELITE_211_ONLY];

/**
 * 常见院校简称 → 全名。
 * 只收录无歧义的强简称（有歧义的简称一律不收录，宁可判为「非精英」→ 不写校名，
 * 也不冒险把双非当成 211 写进招呼语）。
 */
const ELITE_ALIASES: Record<string, string> = {
  北大: '北京大学',
  清华: '清华大学',
  复旦: '复旦大学',
  南开: '南开大学',
  浙大: '浙江大学',
  南大: '南京大学',
  武大: '武汉大学',
  华科: '华中科技大学',
  哈工大: '哈尔滨工业大学',
  上交: '上海交通大学',
  西交: '西安交通大学',
  北航: '北京航空航天大学',
  北理: '北京理工大学',
  同济: '同济大学',
  天大: '天津大学',
  厦大: '厦门大学',
  山大: '山东大学',
  吉大: '吉林大学',
  川大: '四川大学',
  重大: '重庆大学',
  兰大: '兰州大学',
  北邮: '北京邮电大学',
  央财: '中央财经大学',
  上财: '上海财经大学',
  西电: '西安电子科技大学',
  哈工程: '哈尔滨工程大学',
  第二军医大学: '海军军医大学',
  第四军医大学: '空军军医大学',
  国防科大: '国防科技大学',
};

/** 归一化：去掉括号补充说明（如「中国矿业大学（北京）」「北京大学（985）」）与空白/分隔符。 */
function normalizeSchoolText(raw: string): string {
  return String(raw || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000·・\-—_、,，|｜/]/g, '');
}

export interface SchoolTierResult {
  /** 命中的 985/211 院校名（规范化全名，最多 3 个） */
  eliteSchools: string[];
  /** 是否允许招呼语出现校名（仅当命中 985/211 时为 true） */
  allowSchoolName: boolean;
}

/**
 * 判定简历院校层级：命中 985/211 → 允许写校名，否则禁止（含「没识别到院校」的情况，
 * 保守判为禁止——AI 若在此情况下写出校名，即属幻觉，正好被拦下）。
 * 优先用画像的结构化教育事实（噪声低）；画像没有教育行时才退回简历原文前段。
 */
export function resolveSchoolTier(education?: string[] | null, resumeText?: string): SchoolTierResult {
  const eduLines = (education || [])
    .map((line) => normalizeSchoolText(line))
    .filter((line) => line.length >= 2);
  // 独立学院 / 大学下设学院（如「华中科技大学文华学院」「北京大学光华管理学院」）：主体不是
  // 985/211 本校（或层级待考），一律不认定精英——保守方向是「不写校名」，不冒险写出去。
  const scope = eduLines.length ? eduLines.join('\n') : normalizeSchoolText(String(resumeText || '').slice(0, 2000));
  const scopeForElite = scope
    .split('\n')
    .filter((line) => !/大学[\u4e00-\u9fa5]{2,10}学院/.test(line))
    .join('\n');
  const eliteSchools: string[] = [];
  if (scopeForElite) {
    for (const name of ELITE_SCHOOLS) {
      if (scopeForElite.includes(name) && !eliteSchools.includes(name)) eliteSchools.push(name);
      if (eliteSchools.length >= 3) break;
    }
    if (eliteSchools.length < 3) {
      for (const [alias, full] of Object.entries(ELITE_ALIASES)) {
        if (scopeForElite.includes(alias) && !eliteSchools.includes(full)) eliteSchools.push(full);
        if (eliteSchools.length >= 3) break;
      }
    }
  }
  return { eliteSchools, allowSchoolName: eliteSchools.length > 0 };
}

/** 院校层级词：非 985/211 场景下出现即违规。 */
const SCHOOL_TIER_WORD_RE = /985|211|双一流|双非|重点大学|名牌大学|知名高校|名校|重点院校|知名院校/;
/** 通用校名模式：2-10 个汉字 + 大学/学院。 */
const GENERIC_SCHOOL_RE = /[\u4e00-\u9fa5]{2,10}?(?:大学|学院)/g;
/** 通用模式会把句子前缀一起切进来（「我是深圳大学」），逐字剥掉这些日常字。 */
const LEADING_NOISE_RE =
  /^(?:我|你|他|她|它|们|在|于|就|读|是|的|了|和|与|及|或|等|从|到|对|为|本|该|贵|这|那|其|所|被|把|让|给|很|更|最|再|又|也|都|还|只|不|没|会|能|要|想|说|做|完)+/;
/** 非校名的日常表达后缀（大学期间 / 大学四年 / 大学本科…）。 */
const SCHOOL_SUFFIX_NOISE = /(?:期间|四年|三年|两年|生活|阶段|本科|英语|学习|时)$/;

/** 剥掉句子前缀后判断是否为「像校名」的词（如「我是深圳大学」→「深圳大学」）。 */
function isRealSchoolName(candidate: string): boolean {
  const name = String(candidate || '').replace(LEADING_NOISE_RE, '');
  if (name.length < 3) return false;
  if (/^(?:大学|学院|学校)$/.test(name)) return false;
  return !SCHOOL_SUFFIX_NOISE.test(name);
}

/**
 * 文本里是否出现院校名称 / 院校层级字样（本地兜底拦截用：判「非 985/211」时不写校名，
 * 一旦命中即视为违规 → 回退本地兜底模板）。
 * 三类判据：① 院校层级词；② 985/211 完整校名（非精英场景出现必属幻觉）；③ 通用校名模式
 * （已排除「我在大学期间」这类日常表达，避免误伤而白白丢弃 AI 生成的招呼语）。
 */
export function hasSchoolMention(text: string): boolean {
  const raw = String(text || '');
  if (!raw) return false;
  if (SCHOOL_TIER_WORD_RE.test(raw)) return true;
  if (ELITE_SCHOOLS.some((name) => raw.includes(name))) return true;
  return (raw.match(GENERIC_SCHOOL_RE) || []).some((m) => isRealSchoolName(m));
}

/**
 * 生成注入提示词的「校名披露」规则（本地核验结论 + 硬性要求）。
 * 由调用方追加在打招呼语提示词之后，AI 不得自行推翻该结论。
 */
export function buildSchoolDisclosureRule(tier: SchoolTierResult): string {
  if (tier.allowSchoolName) {
    return `\n\n【校名披露（本地核验结论，必须遵守）】简历院校命中 985/211：${tier.eliteSchools.join('、')}。
- 允许在身份句里写出上述院校名称（照抄简历原文，不得改写、缩写或美化）。
- 除该院校外，不得出现任何其他院校名称；禁止写「重点大学 / 名校 / 双一流」等院校层级字样。`;
  }
  return `\n\n【校名披露（本地核验结论，必须遵守）】简历院校未命中 985/211 名单（本地已核验，含未识别到院校的情况）。
- **禁止在招呼语中出现任何院校名称、院校简称或院校层级字样**（含「大学 / 学院 / 学校」名称与 985 / 211 / 双一流 / 重点大学 / 名校 / 知名高校等）。
- 提及教育背景时只写「学历 + 专业 + 年级」（如「我是计算机科学与技术专业在读本科生」）；学历信息不足时直接省略教育背景，不要用「某高校 / 知名学府」等模糊说法替代。
- 岗位描述里出现的院校要求（如「211 院校优先」）不得写进招呼语。`;
}
