// lib/bossclaw/companyDueDiligence.ts —— 企业背调 B 层（负面信号）+ C 层（AI 评级）
//
// 分层与边界（先读）：
//   · A 层（companyProfile.ts）：只读公司主页自身的工商字段；
//   · **B 层（本文件前两节）**：联网搜到的**页面正文**里的负面信号。数据来源只有一处 ——
//     用户在内置浏览器打开搜索结果页 / 官方核查页后，由 `page-read` 取回的正文与链接（不自己发爬虫请求）。
//   · **C 层（本文件后两节）**：把 A + B 的事实交给模型，得到低/中/高 + 依据；
//     **每条依据必须挂到具体来源编号，并且引用一段能在来源原文里逐字找到的话**；挂不上就丢掉这条依据；
//     一条都挂不上 → 不给评级。
//
// 三条不可协商的口径：
//   1. **不做自动拦截**：评级只写 `job.dueDiligence`，不改 status / 排序 / 投递队列（与 A 层一致）；
//   2. **可解释性优先于覆盖率**：宁可只给一条有来源、有原文引用的依据，也不接受「综合来看风险偏高」这种无出处结论；
//   3. **不把中性词当负面**：「裁员」「罚款」这类词单独出现不算信号（大量正常新闻也会命中），
//      必须与「拖欠/违法/不给/仲裁/被执行」等强词共现才算 —— 规则见 NEGATIVE_RULES 的 strong/weak 设计。
//
// 2026-11-17 优化（对照 ghost-job / company-research-agent / due-diligence-agents）：
//   · 官方核查入口：信用中国、国家企业信用信息公示系统、执行信息公开网、裁判文书网（用户自己打开，不自动抓）；
//   · 多页累积：每读一页就合并去重（不再用新结果覆盖旧结果），并保留最近 10 次扫描记录；
//   · 来源分级 + 同名判定 + 年份：搜索结果里大量同名企业，片段没出现公司名时标「同名待核实」；
//   · C 层引用逐字校验：模型给出的 quote 必须在被引来源原文里能找到，否则丢弃该来源；
//   · 报告导出：把工商字段、信号、评级拼成可复制的 Markdown（不生成 PDF，保持可复核）。

import type { AppConfig } from './types';
import type { ChatMessage } from './llm';
import { callModel, extractJson } from './llm';
import { bizRiskHints, type CompanyBizProfile } from './companyProfile';

// ===== 一、搜索入口（B 层的「怎么找」）=====
// 为什么只给链接、不自动抓：
//   搜索引擎对自动化请求的反爬（验证码/JS 挑战）会直接把结果变成空页，且「绕过」属于本项目
//   明确不做的事（见 docs 方案 §7）。这里生成查询链接，由用户在内置浏览器里正常打开，
//   再读当前页正文 —— 拿到的就是用户自己看到的内容，可复核、可复现。

export type SearchEngine = 'bing' | 'baidu' | 'sogou';

const ENGINE_TEMPLATE: Record<SearchEngine, (q: string) => string> = {
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  baidu: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  sogou: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
};

/** 三组查询词：劳资纠纷 / 投诉曝光 / 社保合同。刻意不用站点限定（各平台收录差异大）。 */
export function buildSearchLinks(company: string, engine: SearchEngine = 'bing'): Array<{ label: string; url: string; query: string }> {
  const name = String(company || '').trim();
  if (!name) return [];
  const tpl = ENGINE_TEMPLATE[engine] || ENGINE_TEMPLATE.bing;
  const queries = [
    { label: '欠薪 / 仲裁', query: `${name} 欠薪 拖欠工资 劳动仲裁` },
    { label: '投诉 / 曝光', query: `${name} 骗局 投诉 曝光 跑路` },
    { label: '社保 / 合同', query: `${name} 不缴社保 试用期 劳动合同 纠纷` },
  ];
  return queries.map((q) => ({ label: q.label, query: q.query, url: tpl(q.query) }));
}

// ===== 一·B、官方核查入口（权威来源，仍然由用户自己打开）=====
// 参考 ghost-job 只做「联网搜负面」不够：欠薪/纠纷的权威记录在官方站点上，
// 但这些站点都有验证码或 JS 表单，不能拼一个可直达的查询 URL。这里给入口 + 提示，
// 面板在打开前会把公司名复制到剪贴板，用户粘贴即可。

export interface OfficialLink {
  key: string;
  label: string;
  url: string;
  hint: string;
}

export function buildOfficialLinks(company: string): OfficialLink[] {
  const name = String(company || '').trim();
  if (!name) return [];
  return [
    {
      key: 'gsxt',
      label: '工商公示',
      url: 'https://www.gsxt.gov.cn/index.html',
      hint: '国家企业信用信息公示系统：注册登记、行政处罚、经营异常。打开后粘贴公司全称查询',
    },
    {
      key: 'credit',
      label: '信用中国',
      url: 'https://www.creditchina.gov.cn/',
      hint: '信用中国：信用信息报告、行政许可与行政处罚。打开后在搜索框粘贴公司名',
    },
    {
      key: 'shixin',
      label: '失信被执行人',
      url: 'https://zxgk.court.gov.cn/shixin/',
      hint: '中国执行信息公开网：失信被执行人名单。输入公司名查询',
    },
    {
      key: 'zhixing',
      label: '被执行人',
      url: 'https://zxgk.court.gov.cn/zhzxgk/',
      hint: '中国执行信息公开网：被执行人信息。输入公司名查询',
    },
    {
      key: 'wenshu',
      label: '裁判文书',
      url: 'https://wenshu.court.gov.cn/',
      hint: '中国裁判文书网：涉诉文书。打开后搜索公司名（部分文书需登录）',
    },
  ];
}

// ===== 二、负面信号提取（B 层核心，纯函数）=====

export type NegativeCategory =
  | 'wage' | 'dispute' | 'fraud' | 'operation' | 'layoff' | 'penalty'
  | 'insurance' | 'contract' | 'safety' | 'supplier' | 'recruit';

/** 来源层级：官方 > 媒体 > 招聘平台 > 社区讨论 > 未知（只用于提示权重，不改变信号本身） */
export type SourceTier = 'official' | 'jobboard' | 'media' | 'forum' | 'unknown';

export const SOURCE_TIER_LABEL: Record<SourceTier, string> = {
  official: '官方来源',
  jobboard: '招聘平台',
  media: '媒体报道',
  forum: '社区讨论',
  unknown: '来源未知',
};

const TIER_HOSTS: Record<Exclude<SourceTier, 'unknown'>, string[]> = {
  official: [
    'gsxt.gov.cn', 'creditchina.gov.cn', 'zxgk.court.gov.cn', 'wenshu.court.gov.cn',
    'gov.cn', 'samr.gov.cn', 'mohrss.gov.cn', 'chinatax.gov.cn', '12333.gov.cn', 'court.gov.cn',
  ],
  jobboard: ['zhipin.com', 'liepin.com', 'zhaopin.com', '51job.com', 'kanzhun.com', 'maimai.cn', 'lagou.com'],
  media: [
    'xinhuanet.com', 'people.com.cn', 'thepaper.cn', 'sina.com.cn', 'sohu.com', '163.com', 'qq.com',
    'ifeng.com', 'caixin.com', 'yicai.com', 'jiemian.com', '36kr.com', 'huxiu.com', 'eastmoney.com',
    'stcn.com', 'cnstock.com',
  ],
  forum: ['tieba.baidu.com', 'zhihu.com', 'douban.com', 'weibo.com', 'xiaohongshu.com', 'tianya.cn', 'v2ex.com', 'github.com'],
};

/** 来源分级：只看域名，不做内容判断。空 URL / 非法 URL → unknown */
export function sourceTierOf(url: string | undefined): SourceTier {
  const raw = String(url || '').trim();
  if (!raw) return 'unknown';
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'unknown'; }
  if (!host) return 'unknown';
  const order: Array<Exclude<SourceTier, 'unknown'>> = ['official', 'jobboard', 'media', 'forum'];
  for (const tier of order) {
    if (TIER_HOSTS[tier].some((d) => host === d || host.endsWith(`.${d}`))) return tier;
  }
  return 'unknown';
}

/** 同名判定：片段里是否真的出现了这家公司（全称，或去地区/后缀后的核心词） */
const REGION_PREFIX_RE = /^(?:北京|上海|天津|重庆|深圳|广州|杭州|南京|苏州|成都|武汉|西安|长沙|郑州|青岛|厦门|福州|合肥|济南|昆明|宁波|无锡|东莞|佛山|珠海|中山|大连|沈阳|哈尔滨|长春|石家庄|太原|南昌|贵阳|南宁|海口|兰州|银川|西宁|乌鲁木齐|呼和浩特|拉萨|香港|澳门|台湾)(?:市|省|自治区|特别行政区)?/;
/** 这些词单独作为核心词没有区分度，不能用来判断「片段在说这家公司」 */
const GENERIC_NAME_TOKENS = new Set(['公司', '集团', '科技', '网络', '信息', '技术', '文化', '传媒', '咨询', '管理', '服务', '实业', '贸易', '中国', '国际', '有限', '股份']);

function normalizeName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000（）()【】\[\]·.,，、&]/g, '');
}

/** 公司名 → 可用于文本匹配的核心词（去掉地区前缀与「有限公司/科技」等通用后缀） */
export function companyCoreTokens(company: string): string[] {
  const full = normalizeName(company);
  if (!full) return [];
  // 后缀要一层层从末尾剥（「某某科技有限公司」→「某某科技」→「某某」），
  // 不能用一次 `(?:...)+$`：正则会从最左的「科技」开始匹配，反而把「有限公司」留下。
  let stripped = full.replace(REGION_PREFIX_RE, '');
  for (let i = 0; i < 6; i += 1) {
    const next = stripped.replace(/(?:有限责任公司|股份有限公司|有限公司|集团公司|集团|公司|科技|网络|信息|技术|文化|传媒|咨询|管理|服务|实业|贸易|电子商务|中国|国际)$/, '');
    if (next === stripped) break;
    stripped = next;
  }
  const out = new Set<string>([full]);
  if (stripped.length >= 2 && !GENERIC_NAME_TOKENS.has(stripped)) out.add(stripped);
  return Array.from(out);
}

/** 片段是否提到了这家公司：全称命中，或核心词（≥2 字且非通用词）命中 */
export function mentionsCompany(text: string, company: string): boolean {
  const t = normalizeName(text);
  if (!t) return false;
  const tokens = companyCoreTokens(company).filter((token) => token.length >= 2);
  return tokens.some((token) => t.includes(token));
}

/** 从片段里提取年份（用于提示「两三年前的旧报道」；取不到就不标） */
export function signalYear(text: string, nowYear = new Date().getFullYear()): number | undefined {
  const s = String(text || '');
  const abs = s.match(/(20\d{2})\s*(?:年|[-/.]\d{1,2})/);
  if (abs) {
    const y = Number(abs[1]);
    if (y >= 2000 && y <= nowYear + 1) return y;
  }
  if (/今年/.test(s)) return nowYear;
  if (/去年/.test(s)) return nowYear - 1;
  if (/前年/.test(s)) return nowYear - 2;
  return undefined;
}

/** 超过两年（含）的报道只作线索，不能单独支撑「高风险」 */
export function isStaleSignal(signal: Pick<NegativeSignal, 'year'>, nowYear = new Date().getFullYear()): boolean {
  return signal.year != null && signal.year <= nowYear - 2;
}

export interface NegativeSignal {
  /** 稳定编号（S1…），C 层评级靠它挂来源 */
  id: string;
  category: NegativeCategory;
  /** 中文类别名（UI 标签） */
  label: string;
  /** 命中的关键词原文 */
  keyword: string;
  /** 命中上下文（前后各约 40 字，压成一行） */
  snippet: string;
  /** 来源页面 URL（结果页或单条结果，能取到就取单条） */
  sourceUrl: string;
  /** 来源页面标题 */
  sourceTitle?: string;
  /** 强度：3 = 直接指向经营/法律风险；2 = 明显负面；1 = 仅提示需进一步核实 */
  weight: 1 | 2 | 3;
  /** 来源层级（官方 / 媒体 / 招聘平台 / 社区 / 未知） */
  tier?: SourceTier;
  /** 片段里出现的年份（用于提示时效） */
  year?: number;
  /** 片段里是否明确出现这家公司：unclear = 可能是在说同名企业 */
  identity?: 'matched' | 'unclear';
}

interface Rule {
  category: NegativeCategory;
  label: string;
  weight: 1 | 2 | 3;
  /** 触发词：命中即候选（关键词取这一段） */
  trigger: RegExp;
  /**
   * 共现要求：命中位置附近还必须出现这些词之一。
   * 「裁员」「罚款」单独出现时在新闻里是中性叙述（大厂裁员报道、交通罚款），
   * 只有带上「暴力/违法/不给赔偿」「行政处罚/责令」才是求职者该知道的信号。
   */
  context?: RegExp;
}

const NEGATIVE_RULES: Rule[] = [
  { category: 'wage', label: '欠薪 / 拖欠工资', weight: 3, trigger: /欠薪|拖欠工资|克扣工资|不发工资|工资拖欠|拖薪/ },
  { category: 'dispute', label: '劳动纠纷 / 仲裁', weight: 3, trigger: /劳动仲裁|劳动纠纷|违法解除|起诉员工|集体讨薪|劳动监察/ },
  { category: 'fraud', label: '欺诈 / 跑路', weight: 3, trigger: /诈骗|骗局|传销|非法集资|卷款|跑路|套路贷|高利贷/ },
  { category: 'operation', label: '失信 / 被执行', weight: 2, trigger: /失信被执行|限制高消费|被执行人|经营异常(?:名录)?|股权冻结|破产重整|破产清算|严重违法失信|非正常户|税务异常/ },
  { category: 'penalty', label: '行政处罚', weight: 2, trigger: /罚款|处罚/, context: /行政处罚|责令整改|违法经营|偷税漏税|虚假宣传|价格欺诈|无证经营|非法经营/ },
  { category: 'layoff', label: '裁员报道', weight: 1, trigger: /裁员|优化人员|人员优化/, context: /暴力|违法|不给赔偿|不赔偿|变相|大规模|集体|强制/ },
  { category: 'insurance', label: '社保 / 公积金', weight: 2, trigger: /不缴社保|未缴社保|社保欠缴|不交社保|断缴社保|不缴公积金|未缴公积金|不交公积金/ },
  { category: 'contract', label: '合同 / 试用期', weight: 2, trigger: /不签劳动合同|未签劳动合同|不签合同|违法约定试用期|试用期违法/ },
  { category: 'safety', label: '安全事故 / 工伤', weight: 3, trigger: /安全事故|工伤死亡|生产事故|爆炸事故|火灾事故/, context: /死亡|受伤|瞒报|追责|处罚|事故调查/ },
  { category: 'supplier', label: '拖欠货款 / 供应商', weight: 2, trigger: /拖欠货款|拖欠供应商|拖欠工程款|欠款不还|货款拖欠/ },
  { category: 'recruit', label: '招聘收费 / 培训贷', weight: 3, trigger: /培训贷|招聘收费|收取押金|入职收费|虚假招聘|招聘诈骗/ },
];

/** 命中片段：取命中位置前后各 window 字符，压掉换行与多余空白（提示框里一行能看完） */
function snippetAround(text: string, index: number, length: number, window = 40): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix).slice(0, 160);
}

/** 纯 UI 文案块（「登录」「相关搜索」这类）不参与提取，避免把导航词当正文 */
const UI_ONLY_RE = /^(?:登录|注册|首页|上一页|下一页|相关搜索|相关推荐|热门推荐|猜你喜欢|查看更多|展开全部|收起|广告|百度百科|搜狗百科|维基百科)(?:[\s|·,，、]+(?:登录|注册|首页|上一页|下一页|相关搜索|相关推荐|热门推荐|猜你喜欢|查看更多|展开全部|收起|广告|百度百科|搜狗百科|维基百科))*$/;

/** 段落切分：搜索结果页每条结果大致是一个段落块；靠换行判断，不依赖具体 DOM */
function splitBlocks(text: string): string[] {
  return String(text || '')
    .split(/\n{2,}|\r\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && !UI_ONLY_RE.test(s));
}

/** 把一条信号挂到具体结果链接上：优先「锚文本出现在片段里」且是 http(s) 的那条 */
export function pickSourceLink(snippet: string, links: Array<{ text?: string; href?: string }> | undefined): string {
  const list = Array.isArray(links) ? links : [];
  const s = String(snippet || '');
  let best = '';
  let bestLen = 0;
  for (const link of list) {
    const href = String(link?.href || '');
    if (!/^https?:\/\//i.test(href)) continue;
    const anchor = String(link?.text || '').replace(/\s+/g, ' ').trim();
    if (anchor.length < 6 || anchor.length > 80) continue;
    if (!s.includes(anchor.slice(0, Math.min(anchor.length, 40)))) continue;
    if (anchor.length > bestLen) { bestLen = anchor.length; best = href; }
  }
  return best;
}

/**
 * 从页面正文提取负面信号。
 * - 每个类别最多 2 条、总数最多 12 条（避免一页搜索结果刷出几十条同义信号）；
 * - 同一类别同一关键词只保留第一条；
 * - 每条都带原文片段 —— 用户能自己判断是不是在说这家公司（同名企业很常见）。
 * - 传了 company 时额外标 identity：片段没出现公司名 → unclear（UI 提示需核实同名企业）。
 */
export function extractNegativeSignals(
  text: string,
  opts: { url?: string; title?: string; links?: Array<{ text?: string; href?: string }>; company?: string } = {}
): NegativeSignal[] {
  const pageUrl = String(opts.url || '');
  const pageTitle = String(opts.title || '').slice(0, 120);
  const company = String(opts.company || '').trim();
  const blocks = splitBlocks(text);
  const out: NegativeSignal[] = [];
  const seenCategory = new Map<NegativeCategory, number>();
  const seenKeyword = new Set<string>();

  for (const block of blocks) {
    for (const rule of NEGATIVE_RULES) {
      if ((seenCategory.get(rule.category) || 0) >= 2) continue;
      const m = block.match(rule.trigger);
      if (!m || m.index == null) continue;
      const keyword = m[0];
      // 共现检查只看命中位置附近，避免长段落里「相隔很远的两句话」被拼成一条假信号
      if (rule.context) {
        const localStart = Math.max(0, m.index - 160);
        const localEnd = Math.min(block.length, m.index + keyword.length + 160);
        if (!rule.context.test(block.slice(localStart, localEnd))) continue;
      }
      const key = `${rule.category}:${keyword}`;
      if (seenKeyword.has(key)) continue;
      seenKeyword.add(key);
      const snippet = snippetAround(block, m.index, keyword.length);
      const linkUrl = pickSourceLink(snippet, opts.links) || pickSourceLink(block, opts.links);
      const sourceUrl = linkUrl || pageUrl;
      // 同名判定只看命中位置附近：搜索页一个段落里可能并排放着好几家公司
      const identityText = block.slice(
        Math.max(0, m.index - 300),
        Math.min(block.length, m.index + keyword.length + 300)
      );
      out.push({
        id: `S${out.length + 1}`,
        category: rule.category,
        label: rule.label,
        weight: rule.weight,
        keyword,
        snippet,
        sourceUrl,
        sourceTitle: pageTitle,
        tier: sourceTierOf(sourceUrl),
        year: signalYear(snippet) ?? signalYear(block),
        identity: company ? (mentionsCompany(identityText, company) ? 'matched' : 'unclear') : undefined,
      });
      seenCategory.set(rule.category, (seenCategory.get(rule.category) || 0) + 1);
      if (out.length >= 12) return renumber(out);
    }
  }
  return renumber(out);
}

/** 编号必须连续（C 层靠编号挂来源，跳号会让「来源 S3」查无此项） */
function renumber(signals: NegativeSignal[]): NegativeSignal[] {
  return signals.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

/** 去重时把「搜索引擎结果页」当成同一个来源：同一条结果在 Bing / 百度各读一次不该算两处证据 */
function sourceKeyForDedupe(url: string | undefined): string {
  const raw = String(url || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    if (/(^|\.)(bing\.com|baidu\.com|sogou\.com)$/.test(host)) return '(search-page)';
  } catch { /* 非法 URL 按原样比较 */ }
  return raw;
}

/** 信号去重键：类别 + 关键词 + 来源 + 片段（同一页重复读取不产生重复信号） */
function signalKey(signal: NegativeSignal): string {
  const norm = (s: string | undefined) => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[…"“”'‘’]/g, '');
  return [signal.category, signal.keyword, sourceKeyForDedupe(signal.sourceUrl), norm(signal.snippet).slice(0, 80)].join('|');
}

/**
 * 合并多次扫描：旧信号在前、新信号在后，按 signalKey 去重。
 * - 默认总数 24 条、同类别 3 条（比单页上限宽一点，允许多页互相补充）；
 * - 重新编号保证 C 层引用连续；
 * - 只做「追加」，不会因为新页面没命中就把旧证据删掉（这是原来最大的问题）。
 */
export function mergeSignals(
  existing: NegativeSignal[],
  incoming: NegativeSignal[],
  opts: { maxTotal?: number; maxPerCategory?: number } = {}
): NegativeSignal[] {
  const maxTotal = opts.maxTotal ?? 24;
  const maxPerCategory = opts.maxPerCategory ?? 3;
  const out: NegativeSignal[] = [];
  const seen = new Set<string>();
  const perCategory = new Map<NegativeCategory, number>();
  for (const signal of [...(existing || []), ...(incoming || [])]) {
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    const count = perCategory.get(signal.category) || 0;
    if (count >= maxPerCategory) continue;
    if (out.length >= maxTotal) break;
    seen.add(key);
    perCategory.set(signal.category, count + 1);
    out.push(signal);
  }
  return renumber(out);
}

/** 一次扫描记录（只留最近 10 次；用于说明「证据来自哪几页、什么时候读的」） */
export interface DueDiligenceScan {
  url: string;
  title?: string;
  scannedAt: number;
  /** 本页命中的信号数 */
  hits: number;
  /** 合并后新增的信号数（去重后的净增量） */
  added: number;
}

export function appendScan(scans: DueDiligenceScan[] | undefined, scan: DueDiligenceScan, max = 10): DueDiligenceScan[] {
  return [...(scans || []), scan].slice(-max);
}

/** 信号摘要（UI 一行 / prompt 用）：类别 + 关键词 + 来源域名 */
export function signalHeadline(signal: NegativeSignal): string {
  const host = (() => {
    try { return new URL(signal.sourceUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  return [signal.label, `「${signal.keyword}」`, host ? `来自 ${host}` : ''].filter(Boolean).join(' · ');
}

/** 是否需要提示「信号多但都同源」——同一页面反复命中时可信度有限，UI 要说清楚 */
export function distinctSourceCount(signals: NegativeSignal[]): number {
  return new Set(signals.map((s) => sourceKeyForDedupe(s.sourceUrl))).size;
}

/** B 层证据概况（确定性，不依赖模型）：UI 统计条与 prompt 都用这一份 */
export interface SignalStats {
  total: number;
  high: number;
  medium: number;
  low: number;
  /** 来源站点数（同一域名不同页面算多个 URL） */
  distinctSources: number;
  /** 官方来源站点数 */
  officialSources: number;
  /** 片段里没出现公司名、可能同名企业的条数 */
  identityUnclear: number;
  /** 两年前（含）的旧报道条数 */
  stale: number;
  latestYear?: number;
  singleSource: boolean;
}

export function summarizeSignals(signals: NegativeSignal[], nowYear = new Date().getFullYear()): SignalStats {
  const list = Array.isArray(signals) ? signals : [];
  const urls = new Set<string>();
  const officialHosts = new Set<string>();
  let high = 0;
  let medium = 0;
  let low = 0;
  let identityUnclear = 0;
  let stale = 0;
  let latestYear: number | undefined;
  for (const s of list) {
    if (s.weight === 3) high += 1;
    else if (s.weight === 2) medium += 1;
    else low += 1;
    const url = s.sourceUrl || '(unknown)';
    urls.add(sourceKeyForDedupe(url));
    if ((s.tier || sourceTierOf(url)) === 'official') {
      try { officialHosts.add(new URL(url).hostname); } catch { officialHosts.add(url); }
    }
    if (s.identity === 'unclear') identityUnclear += 1;
    if (isStaleSignal(s, nowYear)) stale += 1;
    if (s.year != null && (latestYear == null || s.year > latestYear)) latestYear = s.year;
  }
  return {
    total: list.length,
    high,
    medium,
    low,
    distinctSources: urls.size,
    officialSources: officialHosts.size,
    identityUnclear,
    stale,
    latestYear,
    singleSource: urls.size <= 1 && list.length > 1,
  };
}

/** 确定性的一句话证据概况（不能用 AI 时，用户至少知道「这些证据有多弱」） */
export function signalCoverageNote(stats: SignalStats): string {
  if (!stats.total) {
    return '本次未命中负面信号。这不等于公司没有风险，可能只是页面没覆盖到；建议换一组关键词，或用「官方核查」再查一次。';
  }
  const parts = [`共 ${stats.total} 条信号`, `${stats.distinctSources} 个来源`];
  if (stats.high) parts.push(`${stats.high} 条高权重`);
  if (stats.officialSources) parts.push(`${stats.officialSources} 个官方来源`);
  if (stats.identityUnclear) parts.push(`${stats.identityUnclear} 条未确认指向该公司`);
  if (stats.stale) parts.push(`${stats.stale} 条为 2 年前信息`);
  if (stats.singleSource) parts.push('全部来自同一来源，可信度有限');
  return parts.join(' · ');
}

// ===== 三、C 层：AI 评级（可解释 + 可逐字核对）=====

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RatingReason {
  text: string;
  /** 依据的来源编号：'A' = 工商字段，'S1'… = 负面信号 */
  sources: string[];
  /** 引用原文：必须能在被引来源里逐字找到（2026-11-17 新增，解析阶段校验） */
  quote?: string;
  /** quote 是否通过逐字校验；未提供 quote 时为 undefined，提供但校验失败时为 false（引用会被忽略） */
  quoteVerified?: boolean;
}

export interface DueDiligenceRating {
  level: RiskLevel;
  summary: string;
  reasons: RatingReason[];
  /** 产出评级的模型标识（仅供追溯，不参与任何判定） */
  model?: string;
  createdAt: number;
  /** 评级时可供引用的来源编号快照（来源集合变了就说明该重算） */
  sourceIds: string[];
}

/** 评级状态（落库到 job.dueDiligence） */
export interface DueDiligenceState {
  signals: NegativeSignal[];
  /** 最近一次扫描（兼容旧数据） */
  scan?: { url: string; title?: string; scannedAt: number };
  /** 最近 10 次扫描记录 */
  scans?: DueDiligenceScan[];
  rating?: DueDiligenceRating;
}

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/** A 层字段转成 prompt 里的可引用来源块（编号 A） */
function bizFactsText(biz?: CompanyBizProfile): string {
  if (!biz) return '（未采集工商信息）';
  const f = biz.fields;
  const rows = [
    f.legalPerson ? `法定代表人：${f.legalPerson}` : '',
    f.registeredCapitalText ? `注册资本：${f.registeredCapitalText}` : '',
    f.establishedAt ? `成立日期：${f.establishedAt}` : '',
    f.businessStatusText ? `经营状态：${f.businessStatusText}` : '',
    f.registeredAddress ? `注册地址：${f.registeredAddress}` : '',
    f.insuredCountText ? `参保人数：${f.insuredCountText}` : '',
  ].filter(Boolean);
  return rows.length ? rows.join('；') : '（未采集到有效字段）';
}

const RATING_SYSTEM_PROMPT = `你是企业尽职调查助手。用户会给出：某公司的工商登记字段（编号 [A]）与从公开网页搜到的负面信号（编号 [S1]、[S2]…，每条含类别、命中关键词、原文片段、来源链接、来源层级、年份与「是否明确指向该公司」）。

请给出一个**可解释、可逐字核对**的风险判断，严格遵守：
1. level 只能是 low / medium / high：
   - high：出现欠薪/跑路/诈骗/失信被执行等**直接指向经营或履约风险**的信号，且有**明确指向该公司**的来源；
   - medium：有负面信号但强度较弱、仅来自单一来源、来源层级较低，或信号与该公司关系需核实；
   - low：没有可核实的负面信号，或只有中性信息（例如正常融资、招聘扩张）。
2. reasons 每条都必须挂到具体来源编号：sources 只能取 [A] 或 [S1]、[S2]…，不得编造编号；并给出 quote —— 从所引来源的「片段 / 工商字段」里**逐字复制**的一小段原文（10–60 字），不得改写、拼接或引用未提供的内容。程序会逐字校验 quote；校验不通过时会忽略该引用（依据仍按来源编号保留），编造原文会降低这条依据的可信度。**挂不上来源的判断就不要写**。
3. reasons 最多 5 条，每条一句话（≤60 字），写清「信号 → 对求职者的具体影响」，不要复述原文。
4. summary ≤80 字，只能说整体倾向 + 最大不确定性；**不得**给出「不要投递」这类决策，是否投递由用户决定。
5. 同名企业很多：若片段里看不出说的就是这家公司，必须在 summary 里点明「需人工核实是否同名企业」；这类信号只能作为「需核实」的理由，不能单独构成 high。
6. 若信息不足以判断（例如负面信号都来自单一来源且语义模糊），level 给 medium，并在 summary 说明「信息不足」。
7. 来源层级：官方来源 > 媒体报道 > 招聘平台 > 社区讨论 > 未知。社区讨论只能作线索，不能单独支撑 high。
8. 时效：优先引用近 2 年信息；只有 2 年前旧报道时，level 最多 medium，并在 summary 说明信息较旧。
9. 不得把「未采集到信号」当作低风险证据；信息不足时按第 6 条处理。

【输出 schema】只输出以下字段，字段名与类型不可变更：
{"level":"low|medium|high","summary":"...","reasons":[{"text":"...","sources":["S1"],"quote":"..."}]}

【输出样例】
{"level":"medium","summary":"有一条劳动仲裁报道，但仅来自单一来源，且需确认是否同名企业。","reasons":[{"text":"出现劳动仲裁相关报道（关键词「劳动仲裁」），入职前应核实是否存在未结争议。","sources":["S1"],"quote":"2025 年多名员工申请劳动仲裁"}]}

只输出一个 json 对象，不要任何解释文字、不要代码块围栏。`;

/** 构造评级消息（导出以便回归断言「来源编号 + 证据概况必须进 prompt」） */
export function buildRatingMessages(input: {
  company: string;
  biz?: CompanyBizProfile;
  signals: NegativeSignal[];
}): ChatMessage[] {
  const stats = summarizeSignals(input.signals);
  const signals = input.signals.map((s) => ({
    编号: s.id,
    类别: s.label,
    关键词: s.keyword,
    片段: s.snippet,
    来源: s.sourceUrl,
    来源层级: SOURCE_TIER_LABEL[s.tier || sourceTierOf(s.sourceUrl)],
    年份: s.year ?? '未标注',
    是否明确指向该公司: s.identity === 'matched' ? '是' : s.identity === 'unclear' ? '否（需核实同名企业）' : '未判断',
  }));
  const payload = {
    公司: String(input.company || '').trim(),
    工商字段: { 编号: 'A', 内容: bizFactsText(input.biz) },
    证据概况: {
      信号数: stats.total,
      来源数: stats.distinctSources,
      高权重: stats.high,
      官方来源: stats.officialSources,
      同名待核实: stats.identityUnclear,
      两年前信息: stats.stale,
    },
    负面信号: signals.length ? signals : '（本次未采集到负面信号）',
  };
  return [
    { role: 'system', content: RATING_SYSTEM_PROMPT },
    { role: 'user', content: `请基于以下事实给出可解释的风险判断：\n${JSON.stringify(payload, null, 2)}` },
  ];
}

/** 中文模型有时不按 schema 输出英文等级；这里做一次宽容归一（仍只接受三档） */
const LEVEL_ALIASES: Record<string, RiskLevel> = {
  low: 'low', medium: 'medium', high: 'high',
  '低': 'low', '低风险': 'low', '中': 'medium', '中风险': 'medium', '高': 'high', '高风险': 'high',
};

function normalizeLevel(raw: unknown): RiskLevel | null {
  const key = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  return LEVEL_ALIASES[key] || null;
}

/** 来源编号容错：接受 S1 / 来源 S1 / 来源1 / [S1] / S1、S2 这类写法，只保留 A 与 S<数字> */
function normalizeSourceIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    const s = String(item || '').trim().toUpperCase();
    if (!s) continue;
    if (s === 'A' || /工商/.test(s)) out.push('A');
    for (const re of [/S\s*(\d+)/g, /来源\s*(\d+)/g]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) out.push(`S${m[1]}`);
    }
  }
  return Array.from(new Set(out));
}

/** 引用文本归一：去掉空白与标点，只比较「字面是否连续出现」 */
function normalizeCitation(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[“”"'‘’「」『』…·.,，。；;：:、!！?？\-—_()（）\[\]【】]/g, '');
}

/**
 * quote 是否真的来自来源原文。
 * 允许模型用「…」省略中间部分（逐段校验），但不允许改写、拼接或引用未给出的内容。
 */
export function quoteMatchesSource(quote: string, sourceText: string | undefined): boolean {
  const source = normalizeCitation(sourceText || '');
  if (!source) return false;
  const parts = String(quote || '')
    .split(/…|\.{3,}/)
    .map(normalizeCitation)
    .filter((p) => p.length >= 4);
  if (!parts.length) return false;
  return parts.every((p) => source.includes(p));
}

/**
 * 严格解析 AI 评级：
 * - **任何挂不上来源的依据都被丢弃**（这是硬门槛，保证每条结论都能回到某个来源）；
 * - quote 逐字校验是**软校验**：命中 → 标记 quoteVerified=true；不命中 → 丢弃这段引用但保留依据
 *   （否则中文模型一次转述就会让整个评级失败，用户会以为功能坏了）；
 * - 一条依据都不剩才报错（宁可不给评级）。
 * 这是本功能最重要的一条：无出处的结论比没有结论更糟 —— 用户会当成事实去拒绝一个机会。
 *
 * `allowedSources` 传数组时只校验编号（旧调用方）；传「编号 → 原文」映射时额外逐字校验 quote。
 */
export function parseRating(raw: unknown, allowedSources: string[] | Record<string, string>): DueDiligenceRating {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try { parsed = extractJson(raw); } catch { throw new Error('AI 返回的评级不是合法 JSON'); }
  }
  const level = normalizeLevel(parsed?.level);
  if (!level) throw new Error(`AI 返回的风险等级不可识别：${String(parsed?.level ?? '')}`);
  const sourceIds = Array.isArray(allowedSources) ? allowedSources : Object.keys(allowedSources);
  const sourceTexts = Array.isArray(allowedSources) ? undefined : allowedSources;
  const allowed = new Set(sourceIds.map((s) => s.toUpperCase()));
  const rawReasons = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
  const reasons: RatingReason[] = [];
  for (const item of rawReasons) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) continue;
    let sources = normalizeSourceIds(item?.sources).filter((s) => allowed.has(s));
    if (!sources.length) continue; // 无来源 → 丢弃
    const rawQuote = String(item?.quote || '').replace(/\s+/g, ' ').trim();
    const quote = rawQuote ? rawQuote.slice(0, 120) : '';
    let quoteVerified: boolean | undefined;
    let quoteOut = quote;
    if (quote && sourceTexts) {
      // 逐字校验：命中则只保留能对上原文的来源；不命中则忽略引用，依据本身仍保留
      const matched = sources.filter((id) => quoteMatchesSource(quote, sourceTexts[id] || sourceTexts[id.toLowerCase()]));
      quoteVerified = matched.length > 0;
      if (matched.length) sources = matched;
      else quoteOut = '';
    }
    reasons.push({
      text,
      sources: Array.from(new Set(sources)).slice(0, 3),
      ...(quoteOut ? { quote: quoteOut, quoteVerified } : {}),
    });
    if (reasons.length >= 5) break;
  }
  if (!reasons.length) throw new Error('AI 给出的结论没有可核对的来源，已拒收（避免无依据的风险判断）');
  return {
    level,
    summary: String(parsed?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    reasons,
    createdAt: Date.now(),
    sourceIds: Array.from(allowed),
  };
}

/**
 * 调用模型产出评级。前置条件只有「至少一条可引用来源」；
 * 是否配置 API Key 由 `callModel` 处理 —— 未配置时会尝试外部 agent 代答，都没有才抛错。
 * 失败一律抛错，UI 侧保持「只展示 A/B」的状态 —— 不给兜底评级。
 */
export async function rateCompany(input: {
  company: string;
  biz?: CompanyBizProfile;
  signals: NegativeSignal[];
  config: AppConfig['model'];
}): Promise<DueDiligenceRating> {
  if (!input.signals.length && !input.biz) throw new Error('没有任何可引用的来源，无法给出评级');
  const sourceTexts: Record<string, string> = { A: bizFactsText(input.biz) };
  for (const signal of input.signals) sourceTexts[signal.id] = signal.snippet;
  let raw: unknown;
  try {
    raw = await callModel(buildRatingMessages(input), input.config, {
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 1200,
      purpose: '企业背调评级',
    });
  } catch (e) {
    // 背调评级没有本地兜底：无 Key 且无 agent 时给一条比通用文案更准确的提示
    if (String((e as { code?: string })?.code || '') === 'AI_AGENT_UNAVAILABLE') {
      throw new Error('未配置大模型 API Key，且当前没有可用 agent：背调评级需要模型能力，请在「设置 → AI / LLM 配置」填写 Key。工商字段与负面信号不受影响。');
    }
    throw e;
  }
  const rating = parseRating(raw, sourceTexts);
  return { ...rating, model: String(input.config.model || '') };
}

/** 评级是否需要重算：来源集合变了（新增/减少信号）或超过 30 天 */
export function ratingStale(state: DueDiligenceState | undefined, now = Date.now(), maxAgeDays = 30): boolean {
  const rating = state?.rating;
  if (!rating) return true;
  if (now - rating.createdAt > maxAgeDays * 24 * 3600 * 1000) return true;
  // 只比编号集合：编号由 extractNegativeSignals 按顺序重排，集合变化即「依据变了、该重算」
  const current = ['A', ...(state?.signals || []).map((s) => s.id)].join(',');
  return current !== (rating.sourceIds || []).join(',');
}

// ===== 四、报告与卡片摘要（不参与投递判定）=====

function mdCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 把 A/B/C 三层拼成可复制的 Markdown 背调报告（不做 PDF，避免引入打印链路） */
export function buildDueDiligenceReport(input: {
  company: string;
  biz?: CompanyBizProfile;
  state?: DueDiligenceState;
  now?: number;
}): string {
  const now = Number(input.now) || Date.now();
  const company = String(input.company || '').trim() || '（未知公司）';
  const state = input.state;
  const signals = state?.signals || [];
  const stats = summarizeSignals(signals, new Date(now).getFullYear());
  const fmtTime = (ts?: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const lines: string[] = [
    `# 企业背调报告 · ${company}`,
    '',
    `> 生成于 ${fmtTime(now)} · 数据来源：招聘平台公司主页 + 用户手动读取的公开网页 + AI 评估（如有）。`,
    '> **非权威结论，仅供求职筛选参考**；报告不替代官方核查，也不构成法律或投资意见。',
    '',
    '## 一、工商信息',
    '',
  ];
  const f = input.biz?.fields;
  if (f) {
    lines.push('| 字段 | 值 |', '| --- | --- |');
    const rows: Array<[string, unknown]> = [
      ['法定代表人', f.legalPerson],
      ['注册资本', f.registeredCapitalText],
      ['成立日期', f.establishedAt],
      ['经营状态', f.businessStatusText],
      ['统一社会信用代码', f.creditCode],
      ['注册地址', f.registeredAddress],
      ['参保人数', f.insuredCountText],
    ];
    for (const [label, value] of rows) lines.push(`| ${label} | ${mdCell(value || '未采集')} |`);
    if (input.biz?.missing?.length) lines.push('', `未采集字段：${input.biz.missing.join('、')}`);
    if (input.biz) {
      const hints = bizRiskHints(input.biz, now);
      if (hints.length) lines.push('', '确定性提示：', ...hints.map((h) => `- ${h.text}`));
    }
  } else {
    lines.push('未采集工商信息。可在公司主页展开「工商信息」后点「读取当前页面」。');
  }

  lines.push('', `## 二、负面信号（${signals.length} 条 / ${stats.distinctSources} 个来源）`, '');
  if (signals.length) {
    lines.push('| 编号 | 类别 | 强度 | 年份 | 来源层级 | 原文片段 | 来源 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of signals) {
      const tier = SOURCE_TIER_LABEL[s.tier || sourceTierOf(s.sourceUrl)];
      const url = /^https?:\/\//i.test(s.sourceUrl) ? s.sourceUrl : '';
      lines.push(`| ${s.id} | ${mdCell(s.label)} | ${s.weight} | ${s.year ?? '未标注'} | ${tier} | ${mdCell(s.snippet)} | ${url ? `[打开](${url})` : '未记录'} |`);
    }
  } else {
    lines.push('本次未命中负面信号（不代表没有风险，建议换关键词或用官方核查再查一次）。');
  }
  lines.push('', `证据概况：${signalCoverageNote(stats)}`);

  const scans: DueDiligenceScan[] = state?.scans?.length
    ? state.scans
    : state?.scan
      ? [{ ...state.scan, hits: signals.length, added: signals.length }]
      : [];
  if (scans.length) {
    lines.push('', '读取记录：', ...scans.map((s) => `- ${fmtTime(s.scannedAt)} · 命中 ${s.hits} 条 / 新增 ${s.added} 条 · ${s.url}`));
  }

  lines.push('', '## 三、AI 评级', '');
  const rating = state?.rating;
  if (rating) {
    lines.push(`等级：**${RISK_LEVEL_LABEL[rating.level]}**`, '', `摘要：${rating.summary || '（无）'}`, '');
    for (const r of rating.reasons) {
      lines.push(`- ${r.text}（来源 ${r.sources.join('、')}）`);
      if (r.quote) lines.push(`  - 引用原文：「${r.quote}」`);
    }
    lines.push('', `评估模型：${rating.model || '未记录'} · 评估于 ${fmtTime(rating.createdAt)}`);
  } else {
    lines.push('尚未生成 AI 评级。没有 API Key 时只展示工商信息与负面信号，不影响使用。');
  }

  lines.push('', '## 四、官方核查入口', '');
  for (const link of buildOfficialLinks(company)) {
    lines.push(`- [${link.label}](${link.url})：${link.hint}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 岗位卡摘要：只有中/高风险才出标签；低风险不打扰用户 */
export function dueDiligenceTag(state?: DueDiligenceState): { text: string; level: RiskLevel; label: string; summary: string; stale: boolean } | null {
  const rating = state?.rating;
  if (!rating || rating.level === 'low') return null;
  return {
    text: rating.level === 'high' ? '背调·高风险' : '背调·中风险',
    level: rating.level,
    label: RISK_LEVEL_LABEL[rating.level],
    summary: String(rating.summary || ''),
    // 依据集合变了 / 超过 30 天：卡片仍显示评级，但工具提示会提醒重新评估
    stale: ratingStale(state),
  };
}
