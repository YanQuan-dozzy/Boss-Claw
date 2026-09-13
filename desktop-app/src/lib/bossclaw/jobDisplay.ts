// 岗位展示层辅助函数：薪资清洗、元信息行格式化
// 与 webview.cjs 里的 isValidSalary 保持逻辑一致

/**
 * BOSS 直聘薪资「字体混淆」还原。
 * 平台把薪资中的数字替换为 Unicode 私有区（PUA）码位后再用自定义字体渲染，
 * DOM 取到的是 U+E031～U+E03A（以及小数点 U+E02F），直接展示是空白/乱码，
 * 也让 `/[1-9]/` 之类的可读性判断全部失效（表现为卡片上薪资整体消失）。
 * 实测该映射为固定线性偏移：PUA = 数字 ASCII + 0xE001（'0'→U+E031 … '9'→U+E03A，'.'→U+E02F）。
 */
export function decodeSalaryDigits(s: string | undefined | null): string {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/[\uE02F\uE031-\uE03A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe001));
}

/** 薪资文本是否含平台混淆字符（还原失败时的证据，便于诊断） */
export function hasEncodedSalary(s: string | undefined | null): boolean {
  return typeof s === 'string' && /[\uE000-\uF8FF]/.test(s);
}

/**
 * 判断薪资字段是否有效。
 * 有效：非空，且包含至少一个非零数字（如 20-40K、15K·13薪），或明确为「面议」。
 * 无效：空串、全 0 占位（如 000-000元/天）、乱码/不可读字符。
 * 判定前先做平台混淆还原，避免 PUA 数字被误判为「无薪资」。
 */
export function isValidSalary(s: string | undefined | null): boolean {
  if (!s || typeof s !== 'string') return false;
  const t = decodeSalaryDigits(s).trim();
  if (!t) return false;
  // 明确「面议」视为有效
  if (/面议/.test(t)) return true;
  // 必须包含 1-9 之间的数字，避免 000-000 这类占位值
  return /[1-9]/.test(t);
}

/** 返回有效薪资（已还原平台混淆字符），否则 undefined */
export function cleanSalary(s: string | undefined | null): string | undefined {
  if (!isValidSalary(s)) return undefined;
  return decodeSalaryDigits(s!).trim();
}

/**
 * 清理岗位标题：当薪资无效时，去掉标题尾部残留的薪资占位/乱码文本。
 * 例如 "AI 全栈开发实习生000-000元/天" → "AI 全栈开发实习生"。
 * 同时剔除 BOSS `<title>` 装饰（详情页 DOM 兜底可能把整段 document.title 当 title）：
 * 「中级JAVA工程师招聘」_星奥科技招聘-BOSS直聘 → 「中级JAVA工程师招聘」 → 中级JAVA工程师。
 * 仅当标题命中「_…招聘-BOSS直聘」等在案装饰形态才处理，避免误伤正常岗位名。
 */
export function cleanTitle(title?: string | null, salary?: string | null): string {
  if (!title) return '岗位';
  let t = decodeSalaryDigits(title).trim();
  // BOSS <title> 装饰剔除：形如 「…」_公司…-BOSS直聘 / …_公司招聘-BOSS直聘
  const dec = t.match(/(.+?)_[^_]+招聘?\s*[-–—]?\s*BOSS直聘\s*$/i);
  if (dec) t = dec[1].replace(/^「|」$/g, '').replace(/\s*招聘\s*$/, '').trim();
  t = t.trim();
  // 如果已知薪资无效（空/占位），尝试去掉标题尾部的薪资形态文本
  if (!isValidSalary(salary)) {
    const stripped = t.replace(/[\d\-–—\/\.\s]+元[\/天月年]\s*$/, '').trim();
    if (stripped !== t) return stripped || t;
    // 兜底：去掉尾部只含 0 的 K 薪形态
    const strippedK = t.replace(/\d[\d\-–—\/\.\s]*K\s*$/i, '').trim();
    if (strippedK !== t && !/[1-9]/.test(t.slice(strippedK.length))) return strippedK || t;
  }
  return t;
}

/**
 * 清洗公司名：把「地名」误当公司名的情况剔除。
 * 采集链路（webview.cjs 的 cardIdentity / extractJobDetail）在页面结构变化时，
 * 可能用宽泛的 `[class*="company"]` 选择器或「首行兜底」把地点串（如「深圳·南山区·科技园」）
 * 当作公司名写库，导致「数据统计 · 公司 Top」把地名当公司名展示。
 * 这里统一识别并丢弃：纯地点串、保留字（公司/企业）、以及含地点分隔符的疑似地名。
 */
const CHINA_CITIES =
  '北京|上海|广州|深圳|杭州|成都|西安|武汉|南京|苏州|天津|重庆|长沙|郑州|厦门|青岛|常州|宁波|无锡|佛山|东莞|合肥|济南|沈阳|大连|哈尔滨|石家庄|太原|昆明|贵阳|南宁|南昌|福州|海口|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台湾';

const LOCATION_SEP = /[·・•・]/;

/** 形如「城市·区·街道」或「城市·区」的整串地点（BOSS 卡片地点字段格式，首段必须是城市） */
const LOCATION_ONLY_RE = new RegExp(`^(?:${CHINA_CITIES})(?:${LOCATION_SEP.source}[\\u4e00-\\u9fa5A-Za-z0-9]+){1,3}$`);

const ORG_WORDS = /公司|集团|科技|技术|有限|工作室|研究所|研究院|厂|局|社|院|银行|大学|学院|医院|超市|酒店|传媒|网络|信息|软件|电子商务|股份|企业|中心|协会|事务所|律所|品牌/;

/**
 * 返回清洗后的公司名（已 trim，最长 80 字符），若判定为无效/地名则返回 undefined。
 * 用于：新建 PendingItem 写入前、以及统计「公司 Top」聚合时的容错过滤。
 */
export function cleanCompanyName(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  // 纯保留字（「公司」「企业」「雇主」）或长度不合理
  if (/^(公司|企业|雇主|单位|招聘方|公司名)$/.test(s)) return undefined;
  if (s.length < 2 || s.length > 80) return undefined;
  // 整串就是地点（城市·区·街道，首段为城市名）→ 视为地名丢弃
  if (LOCATION_ONLY_RE.test(s)) return undefined;
  // 含地点分隔符且不含任何组织词（如「公司/科技/集团」）→ 视为地名（如「深圳·南山区·科技园」）。
  // 注意：不要求首段是城市，但凡串内出现「·」且全文无组织词，即按地名处理，
  // 避免把「华为·杭州研究所」这类「组织·地点」误删（其含「研究所」组织词，不命中）。
  if (LOCATION_SEP.test(s) && !ORG_WORDS.test(s)) return undefined;
  return s;
}

/**
 * 拼接岗位元信息行（公司 · 地点 · 薪资）。
 * 薪资无效时自动省略，避免显示占位值/乱码。
 */
export function formatMetaLine(
  company?: string | null,
  location?: string | null,
  salary?: string | null,
  fallback?: string | null
): string {
  const parts: string[] = [];
  const comp = company?.trim();
  const loc = location?.trim();
  if (comp) parts.push(comp);
  if (loc && loc !== comp) parts.push(loc);
  const validSalary = cleanSalary(salary);
  if (validSalary) parts.push(validSalary);
  if (parts.length) return parts.join(' · ');
  return fallback?.trim() || '';
}
