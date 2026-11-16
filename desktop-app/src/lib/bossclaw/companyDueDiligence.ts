// lib/bossclaw/companyDueDiligence.ts —— 企业背调 B 层（负面信号）+ C 层（AI 评级）
//
// 分层与边界（先读）：
//   · A 层（companyProfile.ts）：只读公司主页自身的工商字段；
//   · **B 层（本文件前两节）**：联网搜到的**页面正文**里的负面信号。数据来源只有一处 ——
//     用户在内置浏览器打开搜索结果页后，由 `page-read` 取回的正文与链接（不自己发爬虫请求）。
//   · **C 层（本文件后两节）**：把 A + B 的事实交给模型，得到低/中/高 + 依据；
//     **每条依据必须挂到具体来源编号**，挂不上就丢掉这条依据；一条都挂不上 → 不给评级。
//
// 三条不可协商的口径：
//   1. **不做自动拦截**：评级只写 `job.dueDiligence`，不改 status / 排序 / 投递队列（与 A 层一致）；
//   2. **可解释性优先于覆盖率**：宁可只给一条有来源的依据，也不接受「综合来看风险偏高」这种无出处结论；
//   3. **不把中性词当负面**：「裁员」「罚款」这类词单独出现不算信号（大量正常新闻也会命中），
//      必须与「拖欠/违法/不给/仲裁/被执行」等强词共现才算 —— 规则见 NEGATIVE_RULES 的 strong/weak 设计。

import type { AppConfig } from './types';
import type { ChatMessage } from './llm';
import { callModel, extractJson } from './llm';
import type { CompanyBizProfile } from './companyProfile';

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

/** 两组查询词：一组盯劳资纠纷，一组盯投诉/曝光。刻意不用站点限定（各平台收录差异大）。 */
export function buildSearchLinks(company: string, engine: SearchEngine = 'bing'): Array<{ label: string; url: string; query: string }> {
  const name = String(company || '').trim();
  if (!name) return [];
  const tpl = ENGINE_TEMPLATE[engine] || ENGINE_TEMPLATE.bing;
  const queries = [
    { label: '欠薪 / 仲裁', query: `${name} 欠薪 拖欠工资 劳动仲裁` },
    { label: '投诉 / 曝光', query: `${name} 骗局 投诉 曝光 跑路` },
  ];
  return queries.map((q) => ({ label: q.label, query: q.query, url: tpl(q.query) }));
}

// ===== 二、负面信号提取（B 层核心，纯函数）=====

export type NegativeCategory = 'wage' | 'dispute' | 'fraud' | 'operation' | 'layoff' | 'penalty';

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
}

interface Rule {
  category: NegativeCategory;
  label: string;
  weight: 1 | 2 | 3;
  /** 触发词：命中即候选（关键词取这一段） */
  trigger: RegExp;
  /**
   * 共现要求：同一段落里还必须出现这些词之一。
   * 「裁员」「罚款」单独出现时在新闻里是中性叙述（大厂裁员报道、交通罚款），
   * 只有带上「暴力/违法/不给赔偿」「行政处罚/责令」才是求职者该知道的信号。
   */
  context?: RegExp;
}

const NEGATIVE_RULES: Rule[] = [
  { category: 'wage', label: '欠薪 / 拖欠工资', weight: 3, trigger: /欠薪|拖欠工资|克扣工资|不发工资|工资拖欠|拖薪/ },
  { category: 'dispute', label: '劳动纠纷 / 仲裁', weight: 3, trigger: /劳动仲裁|劳动纠纷|违法解除|起诉员工|集体讨薪/ },
  { category: 'fraud', label: '欺诈 / 跑路', weight: 3, trigger: /诈骗|骗局|传销|非法集资|卷款|跑路|套路贷|高利贷/ },
  { category: 'operation', label: '失信 / 被执行', weight: 2, trigger: /失信被执行|限制高消费|被执行人|经营异常|股权冻结|破产重整/ },
  { category: 'penalty', label: '行政处罚', weight: 2, trigger: /罚款|处罚/, context: /行政处罚|责令整改|违法经营|偷税漏税/ },
  { category: 'layoff', label: '裁员报道', weight: 1, trigger: /裁员|优化人员/, context: /暴力|违法|不给赔偿|不赔偿|变相|大规模|集体/ },
];

/** 命中片段：取命中位置前后各 window 字符，压掉换行与多余空白（提示框里一行能看完） */
function snippetAround(text: string, index: number, length: number, window = 40): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix).slice(0, 160);
}

/** 段落切分：搜索结果页每条结果大致是一个段落块；靠换行 + 结果数判断，不依赖具体 DOM */
function splitBlocks(text: string): string[] {
  return String(text || '')
    .split(/\n{2,}|\r\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
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
 */
export function extractNegativeSignals(
  text: string,
  opts: { url?: string; title?: string; links?: Array<{ text?: string; href?: string }> } = {}
): NegativeSignal[] {
  const pageUrl = String(opts.url || '');
  const pageTitle = String(opts.title || '').slice(0, 120);
  const blocks = splitBlocks(text);
  const out: NegativeSignal[] = [];
  const seenCategory = new Map<NegativeCategory, number>();
  const seenKeyword = new Set<string>();

  for (const block of blocks) {
    for (const rule of NEGATIVE_RULES) {
      if ((seenCategory.get(rule.category) || 0) >= 2) continue;
      // 共现要求：中性词必须与强语境同段出现，否则跳过（避免「裁员」「罚款」误报）
      if (rule.context && !rule.context.test(block)) continue;
      const m = block.match(rule.trigger);
      if (!m || m.index == null) continue;
      const keyword = m[0];
      const key = `${rule.category}:${keyword}`;
      if (seenKeyword.has(key)) continue;
      seenKeyword.add(key);
      const snippet = snippetAround(block, m.index, keyword.length);
      const linkUrl = pickSourceLink(snippet, opts.links) || pickSourceLink(block, opts.links);
      out.push({
        id: `S${out.length + 1}`,
        category: rule.category,
        label: rule.label,
        weight: rule.weight,
        keyword,
        snippet,
        sourceUrl: linkUrl || pageUrl,
        sourceTitle: pageTitle,
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

/** 信号摘要（UI 一行 / prompt 用）：类别 + 关键词 + 来源域名 */
export function signalHeadline(signal: NegativeSignal): string {
  const host = (() => {
    try { return new URL(signal.sourceUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  return [signal.label, `「${signal.keyword}」`, host ? `来自 ${host}` : ''].filter(Boolean).join(' · ');
}

/** 是否需要提示「信号多但都同源」——同一页面反复命中时可信度有限，UI 要说清楚 */
export function distinctSourceCount(signals: NegativeSignal[]): number {
  return new Set(signals.map((s) => s.sourceUrl || '(unknown)')).size;
}

// ===== 三、C 层：AI 评级（可解释优先）=====

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RatingReason {
  text: string;
  /** 依据的来源编号：'A' = 工商字段，'S1'… = 负面信号 */
  sources: string[];
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
  /** 最近一次扫描的来源页（可能来自多个搜索页，这里只记最后一次；每条信号自带 URL） */
  scan?: { url: string; title?: string; scannedAt: number };
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

const RATING_SYSTEM_PROMPT = `你是企业尽职调查助手。用户会给出：某公司的工商登记字段（编号 [A]）与从公开网页搜到的负面信号（编号 [S1]、[S2]…，每条含类别、命中关键词、原文片段与来源链接）。

请给出一个**可解释**的风险判断，严格遵守：
1. level 只能是 low / medium / high：
   - high：出现欠薪/跑路/诈骗/失信被执行等**直接指向经营或履约风险**的信号，或有明确的法律纠纷报道；
   - medium：有负面信号但强度较弱、或仅来自单一来源、或信号与该公司关系需核实；
   - low：没有可核实的负面信号，或只有中性信息（例如正常融资、招聘扩张）。
2. reasons 每条都必须**挂到具体来源编号**：sources 只能取 [A] 或 [S1]、[S2]…，不得编造编号；**挂不上来源的判断就不要写**。
3. reasons 最多 5 条，每条一句话（≤60 字），写清「信号 → 对求职者的具体影响」，不要复述原文。
4. summary ≤80 字，只能说整体倾向 + 最大不确定性；**不得**给出「不要投递」这类决策，是否投递由用户决定。
5. 同名企业很多：若片段里看不出说的就是这家公司，就在 summary 里点明「需人工核实是否同名企业」。
6. 若信息不足以判断（例如负面信号都来自单一来源且语义模糊），level 给 medium，并在 summary 说明「信息不足」。

【输出 schema】只输出以下字段，字段名与类型不可变更：
{"level":"low|medium|high","summary":"...","reasons":[{"text":"...","sources":["S1"]}]}

【输出样例】
{"level":"medium","summary":"有一条劳动仲裁报道，但仅来自单一来源，且需确认是否同名企业。","reasons":[{"text":"出现劳动仲裁相关报道（关键词「劳动仲裁」），入职前应核实是否存在未结争议。","sources":["S1"]}]}

只输出一个 json 对象，不要任何解释文字、不要代码块围栏。`;

/** 构造评级消息（导出以便回归断言「来源编号必须进 prompt」） */
export function buildRatingMessages(input: {
  company: string;
  biz?: CompanyBizProfile;
  signals: NegativeSignal[];
}): ChatMessage[] {
  const signals = input.signals.map((s) => ({
    编号: s.id,
    类别: s.label,
    关键词: s.keyword,
    片段: s.snippet,
    来源: s.sourceUrl,
  }));
  const payload = {
    公司: String(input.company || '').trim(),
    工商字段: { 编号: 'A', 内容: bizFactsText(input.biz) },
    负面信号: signals.length ? signals : '（本次未采集到负面信号）',
  };
  return [
    { role: 'system', content: RATING_SYSTEM_PROMPT },
    { role: 'user', content: `请基于以下事实给出可解释的风险判断：\n${JSON.stringify(payload, null, 2)}` },
  ];
}

const VALID_LEVELS: RiskLevel[] = ['low', 'medium', 'high'];

/**
 * 严格解析 AI 评级：**任何挂不上来源的依据都被丢弃**；一条都不剩就报错（宁可不给评级）。
 * 这是本功能最重要的一条：无出处的结论比没有结论更糟 —— 用户会当成事实去拒绝一个机会。
 */
export function parseRating(raw: unknown, allowedSources: string[]): DueDiligenceRating {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try { parsed = extractJson(raw); } catch { throw new Error('AI 返回的评级不是合法 JSON'); }
  }
  const level = String(parsed?.level || '').trim().toLowerCase() as RiskLevel;
  if (!VALID_LEVELS.includes(level)) throw new Error(`AI 返回的风险等级不可识别：${String(parsed?.level ?? '')}`);
  const allowed = new Set(allowedSources.map((s) => s.toUpperCase()));
  const rawReasons = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
  const reasons: RatingReason[] = [];
  for (const item of rawReasons) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) continue;
    const sources: string[] = (Array.isArray(item?.sources) ? item.sources : [])
      .map((s: unknown) => String(s || '').trim().toUpperCase())
      .filter((s: string) => allowed.has(s));
    if (!sources.length) continue; // 无来源 → 丢弃
    reasons.push({ text, sources: Array.from(new Set(sources)).slice(0, 3) });
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
 * 调用模型产出评级。前置条件由调用方保证（有 API Key、有至少一条可引用来源）。
 * 失败一律抛错，UI 侧保持「只展示 A/B」的状态 —— 不给兜底评级。
 */
export async function rateCompany(input: {
  company: string;
  biz?: CompanyBizProfile;
  signals: NegativeSignal[];
  config: AppConfig['model'];
}): Promise<DueDiligenceRating> {
  if (!input.config?.apiKey) throw new Error('请先在「设置」页填写 AI API Key');
  if (!input.signals.length && !input.biz) throw new Error('没有任何可引用的来源，无法给出评级');
  const allowed = ['A', ...input.signals.map((s) => s.id)];
  const raw = await callModel(buildRatingMessages(input), input.config, {
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 1200,
    purpose: '企业背调评级',
  });
  const rating = parseRating(raw, allowed);
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
