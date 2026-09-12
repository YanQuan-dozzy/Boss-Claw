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
 */
export function cleanTitle(title?: string | null, salary?: string | null): string {
  if (!title) return '岗位';
  const t = decodeSalaryDigits(title).trim();
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
