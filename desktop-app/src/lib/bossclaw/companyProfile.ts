// lib/bossclaw/companyProfile.ts —— 企业工商信息（P1-5 / A 层：只用招聘平台自己的公司主页字段）
//
// 定位（先读这段，避免把「背调」做成「背调评级」）：
//   · A 层 = **只读公开信息**：法人 / 注册资本 / 成立日期 / 经营状态 / 信用代码 / 注册地址 / 参保人数；
//     数据来源只有一处 —— 内置浏览器当前打开的公司主页正文（`page-read` 的 bodyText），
//     不引入任何第三方工商 API、不抓非公开数据、不入库个人信息。
//   · B 层（联网搜负面）与 C 层（AI 评级）**本期不做**：见 docs/功能完善方案-2026-11-15.md P1-5。
//   · 本模块产出的是「事实 + 确定性提示」，**不参与投递判定**：不做自动跳过、不改 status、不影响排序。
//     理由：评级误判成本高（错杀好公司 / 漏掉陷阱），而「不投」这种决定必须留给人。
//
// 解析口径（为什么用「标签驱动」而不是 CSS 选择器）：
//   公司主页的 DOM class 随平台改版频繁变化，但「法定代表人」「注册资本」这些**中文标签是产品语义**，
//   改版时反而稳定。因此这里对**整页正文文本**做标签扫描：标签后到下一个标签之前的那段就是值，
//   同行的「法定代表人：张三」与分行的「法定代表人」换行「张三」两种排版都能吃到。
//   代价是无法区分「页脚里顺手提到注册资本」这类噪声 —— 用逐字段的格式校验（日期 / 金额 / 状态词 /
//   信用代码形状）兜住，校验不过就当没采到，**宁缺勿猜**。

/** 工商经营状态的归一值（只保留对「要不要继续接触这家公司」有意义的差异） */
export type BizStatus = 'active' | 'cancelled' | 'revoked' | 'moved' | 'unknown';

export interface CompanyBizFields {
  /** 法定代表人（原文，2–10 字） */
  legalPerson?: string;
  /** 注册资本原文（如「1000万人民币」） */
  registeredCapitalText?: string;
  /** 注册资本归一为「万元人民币」；非人民币币种或解析不出时缺省（不猜汇率） */
  registeredCapitalWan?: number;
  /** 成立日期（YYYY-MM-DD） */
  establishedAt?: string;
  /** 经营状态原文（如「存续（在营、开业、在册）」） */
  businessStatusText?: string;
  /** 经营状态归一 */
  businessStatus?: BizStatus;
  /** 统一社会信用代码（18 位，含字母） */
  creditCode?: string;
  /** 注册地址 */
  registeredAddress?: string;
  /** 参保人数原文（如「128 人」） */
  insuredCountText?: string;
  /** 参保人数（纯数字） */
  insuredCount?: number;
}

export interface CompanyBizProfile {
  fields: CompanyBizFields;
  /** 未采到的字段标签（UI 明说「未采集」，不留给用户自己猜空白代表什么） */
  missing: string[];
  /** 采集来源页面 URL 与标题（可追溯：报告里能回指到哪一页） */
  sourceUrl: string;
  sourceTitle?: string;
  /** 采集时刻（毫秒） */
  parsedAt: number;
}

/** 字段中文名 → 正文里可能出现的标签（同义词，长标签必须排在短标签前面） */
const FIELD_LABELS: Array<{ key: keyof CompanyBizFields | 'insuredCountText'; label: string; aliases: string[] }> = [
  { key: 'legalPerson', label: '法定代表人', aliases: ['法定代表人', '法人代表', '法定代表'] },
  { key: 'registeredCapitalText', label: '注册资本', aliases: ['注册资本', '注册资金'] },
  { key: 'establishedAt', label: '成立日期', aliases: ['成立日期', '成立时间', '注册日期', '注册时间'] },
  { key: 'businessStatusText', label: '经营状态', aliases: ['经营状态', '登记状态', '企业状态', '核准状态'] },
  { key: 'creditCode', label: '统一社会信用代码', aliases: ['统一社会信用代码', '社会信用代码', '纳税人识别号'] },
  { key: 'registeredAddress', label: '注册地址', aliases: ['注册地址', '企业地址', '注册地', '住所'] },
  { key: 'insuredCountText', label: '参保人数', aliases: ['参保人数', '社保人数'] },
];

/** 所有标签按长度降序拼接的正则片段（长标签优先，避免「法人代表」被「法人」截断） */
const LABEL_PATTERN = (() => {
  const all = FIELD_LABELS.flatMap((f) => f.aliases).sort((a, b) => b.length - a.length);
  return all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
})();

/**
 * 占位文案黑名单：主页上字段位经常写「暂无」「未公示」「查看详情」。
 * 这些不是值 —— 当成值会得到「法定代表人：暂无」这种把噪声写进事实的脏数据，
 * 而「法人叫暂无」比「没采到」危险得多（用户会当结论读）。命中即视为未采集。
 */
const PLACEHOLDER_RE = /^(?:暂无|无|未公示|不公示|未公开|未披露|未填写|查看|查看详情|点击查看|详情|待补充|--?|—|N\/A)$/i;

/** 标签扫描：返回「标签 → 原始值文本」（同一标签只取第一次出现，页脚重复不算新值） */
function scanLabelValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`(${LABEL_PATTERN})[\\s:：]*`, 'g');
  const hits: Array<{ label: string; start: number; valueStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    hits.push({ label: m[1], start: m.index, valueStart: re.lastIndex });
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; // 防御：零宽匹配死循环
  }
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    const raw = text.slice(cur.valueStart, next ? next.start : cur.valueStart + 120);
    // 先剥掉「标签与值之间」的空白/冒号，再取第一行：
    //   同一行排版 `法定代表人：张伟` 与分行排版 `法定代表人\n张伟` 都能拿到「张伟」；
    //   直接 split 换行会把分行排版的值切没（首字符就是换行）。
    const value = raw
      .replace(/^[\s:：,，、|;；]+/, '')
      .split(/[\n\r]/)[0]
      .replace(/[\s:：,，、|;；]+$/, '')
      .trim();
    if (value && !PLACEHOLDER_RE.test(value) && !out.has(cur.label)) out.set(cur.label, value.slice(0, 60));
  }
  return out;
}

/** 从扫描结果里取某个字段（按别名顺序尝试） */
function pick(found: Map<string, string>, aliases: string[]): string | undefined {
  for (const a of aliases) {
    const v = found.get(a);
    if (v) return v;
  }
  return undefined;
}

/** 日期归一：支持 2015-06-01 / 2015/6/1 / 2015年6月1日 / 20150601 */
export function normalizeBizDate(raw: string): string | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  let y: number, mo: number, d: number;
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else {
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return undefined;
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  }
  if (!(y >= 1900 && y <= 2100) || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * 注册资本归一为「万元人民币」。
 * 只认人民币：美元/港元的注册资本与人民币不是一个量纲，硬折算等于编数据，故原样保留文本、不给归一值。
 */
export function normalizeCapitalWan(raw: string): number | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  if (/美元|港元|港币|欧元|日元|USD|HKD/i.test(s)) return undefined;
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(亿|万)?/);
  if (!m) return undefined;
  const num = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = m[2] || '万'; // 「1000」这类没写单位的，按平台习惯视为「万元」
  const wan = unit === '亿' ? num * 10000 : num;
  return Math.round(wan * 100) / 100;
}

/** 经营状态归一：先认「吊销/注销」这类终态词，再认正常态词 —— 顺序不能反（「吊销，未注销」同时含两个词） */
export function normalizeBizStatus(raw: string): BizStatus {
  const s = String(raw || '');
  if (!s.trim()) return 'unknown';
  if (/吊销/.test(s)) return 'revoked';
  if (/注销/.test(s)) return 'cancelled';
  if (/迁出/.test(s)) return 'moved';
  if (/存续|在营|在业|开业|正常|登记成立/.test(s)) return 'active';
  return 'unknown';
}

/**
 * 解析公司主页正文里的工商字段。
 * 一个字段都没解析出来时返回 **null** —— 不产「空壳 profile」：
 * 有 profile 就代表「采过且有内容」，UI 才不会把「没采到」显示成「没有信息」。
 */
export function parseCompanyBizProfile(
  text: string,
  opts: { url?: string; title?: string; parsedAt?: number } = {}
): CompanyBizProfile | null {
  const body = String(text || '');
  if (!body.trim()) return null;
  const found = scanLabelValues(body);
  const fields: CompanyBizFields = {};

  const legalPerson = pick(found, FIELD_LABELS[0].aliases);
  // 法人姓名 2–10 字、不含数字与标点；「查看全部」「暂无」这类说明文案会被挡掉
  if (legalPerson && /^[\u4e00-\u9fa5·]{2,10}$/.test(legalPerson.replace(/\s+/g, ''))) {
    fields.legalPerson = legalPerson.replace(/\s+/g, '');
  }

  const capitalText = pick(found, FIELD_LABELS[1].aliases);
  if (capitalText && /\d/.test(capitalText)) {
    fields.registeredCapitalText = capitalText;
    const wan = normalizeCapitalWan(capitalText);
    if (wan != null) fields.registeredCapitalWan = wan;
  }

  const established = pick(found, FIELD_LABELS[2].aliases);
  if (established) {
    const d = normalizeBizDate(established);
    if (d) fields.establishedAt = d;
  }

  const statusText = pick(found, FIELD_LABELS[3].aliases);
  if (statusText) {
    const st = normalizeBizStatus(statusText);
    // 认不出状态词的原文也保留（可能出现了新词），但归一值记 unknown，不给错误结论
    fields.businessStatusText = statusText;
    fields.businessStatus = st;
  }

  const credit = pick(found, FIELD_LABELS[4].aliases);
  if (credit) {
    const code = credit.replace(/\s+/g, '').toUpperCase();
    if (/^[0-9A-Z]{15,20}$/.test(code)) fields.creditCode = code;
  }

  const address = pick(found, FIELD_LABELS[5].aliases);
  if (address && address.replace(/\s+/g, '').length >= 6) fields.registeredAddress = address;

  const insured = pick(found, FIELD_LABELS[6].aliases);
  if (insured) {
    const n = insured.match(/(\d+)/);
    if (n) {
      fields.insuredCountText = insured;
      fields.insuredCount = Number(n[1]);
    }
  }

  const parsedKeys = Object.keys(fields).filter((k) => k !== 'businessStatus');
  if (!parsedKeys.length) return null;

  const missing: string[] = [];
  if (!fields.legalPerson) missing.push('法定代表人');
  if (!fields.registeredCapitalText) missing.push('注册资本');
  if (!fields.establishedAt) missing.push('成立日期');
  if (!fields.businessStatusText) missing.push('经营状态');
  if (!fields.creditCode) missing.push('统一社会信用代码');
  if (!fields.registeredAddress) missing.push('注册地址');
  if (!fields.insuredCountText) missing.push('参保人数');

  return {
    fields,
    missing,
    sourceUrl: String(opts.url || ''),
    sourceTitle: String(opts.title || '').slice(0, 120),
    parsedAt: Number(opts.parsedAt) || Date.now(),
  };
}

export interface BizRiskHint {
  level: 'warn' | 'info';
  text: string;
}

/** 从成立日期算到今天的整月数（用于「新公司」提示；按自然月，不按 30 天近似） */
function monthsSince(dateStr: string, now: number): number | null {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(now);
  let m = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth());
  if (n.getDate() < d.getDate()) m -= 1;
  return m >= 0 ? m : null;
}

/**
 * 确定性风险提示（**不是评级**）：每条都能从字段直接推出，用户自己能复核。
 * 刻意不做「综合评分 / 高·中·低风险」——那是 C 层的工作，且必须挂来源才能说。
 */
export function bizRiskHints(profile: CompanyBizProfile, now = Date.now()): BizRiskHint[] {
  const hints: BizRiskHint[] = [];
  const f = profile.fields;
  if (f.businessStatus === 'revoked' || f.businessStatus === 'cancelled') {
    hints.push({
      level: 'warn',
      text: `工商登记状态为「${f.businessStatusText || (f.businessStatus === 'revoked' ? '吊销' : '注销')}」，该公司可能已停止经营，签约与社保需格外确认。`,
    });
  } else if (f.businessStatus === 'moved') {
    hints.push({ level: 'info', text: '工商登记状态为「迁出」，注册地与经营地可能不一致。' });
  }
  if (f.establishedAt) {
    const months = monthsSince(f.establishedAt, now);
    if (months != null && months < 6) {
      hints.push({ level: 'info', text: `成立仅 ${months} 个月（${f.establishedAt}），属新设公司，稳定性需自行判断。` });
    }
  }
  if (f.registeredCapitalWan != null && f.registeredCapitalWan < 10) {
    hints.push({ level: 'info', text: `注册资本 ${f.registeredCapitalWan} 万元，规模偏小（注册资本不实缴，仅作参考）。` });
  }
  if (f.insuredCount === 0) {
    hints.push({ level: 'info', text: '参保人数为 0，可能无人缴纳社保或数据未更新。' });
  }
  if (profile.missing.length >= 5) {
    hints.push({
      level: 'info',
      text: '只采到少量字段，页面可能未展开「工商信息」区块，建议刷新公司主页后重采。',
    });
  }
  return hints;
}

/** 缓存是否还新鲜（默认 30 天；工商变更不频繁，过期只是提示重采，不阻塞） */
export function bizProfileFresh(profile: CompanyBizProfile | undefined | null, now = Date.now(), maxAgeDays = 30): boolean {
  if (!profile || !profile.parsedAt) return false;
  return now - profile.parsedAt <= maxAgeDays * 24 * 60 * 60 * 1000;
}

/** 当前页是否像「公司主页」（只用于给出更准确的引导文案，不作为解析前提） */
export function companyPageLike(url: string): boolean {
  const s = String(url || '');
  if (!s) return false;
  return /zhipin\.com\/(gongsi|company)/i.test(s)
    || /liepin\.com\/(company|gongsi)/i.test(s)
    || /zhaopin\.com\/(company|gongsi)/i.test(s)
    || /(^|[/.])(gongsi|company)[/.]?/i.test(s);
}

/** 一行摘要（岗位卡标签用）：优先经营状态，其次注册资本，都没有就不显示 */
export function bizProfileTag(profile: CompanyBizProfile | undefined | null): string {
  if (!profile) return '';
  const f = profile.fields;
  if (f.businessStatus === 'cancelled') return '已注销';
  if (f.businessStatus === 'revoked') return '已吊销';
  if (f.businessStatus === 'moved') return '已迁出';
  if (f.registeredCapitalWan != null) return `注册 ${f.registeredCapitalWan} 万`;
  if (f.establishedAt) return `成立 ${f.establishedAt.slice(0, 7)}`;
  return '';
}
