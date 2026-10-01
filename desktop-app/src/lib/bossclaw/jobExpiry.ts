// 岗位 JD「截止日期」过期判定（确定性硬约束，非 AI 判断）
//
// 背景（2026-10-01 用户报告）：
//   猎聘 JD 正文末尾常带一行「截止日期：2027年07月16日」（真机样本见
//   scripts/liepin-jd-regression.mjs 的 JD_BODY 夹具）。此前采集链路对 JD **只做关键词排除**，
//   没有任何时间维度判定 —— 明明写死过期的岗位照样入库、照样进投递队列、照样生成招呼语，
//   白白消耗配额与 AI Token，还可能给 HR 留下「不看要求乱投」的印象。
//
// 设计口径（**唯一权威，禁止在别处复制解析逻辑**）：
//   1. 只在 JD 文本（标题 + 描述 + 卡片文本）里**显式出现**截止日期时才判定 ——
//      没写截止日期 ≠ 过期（绝大多数岗位不写），一律放行；
//   2. 解析结果是**日期**（本地时区当日 00:00），判定「截止日当天仍然有效」：过期 = 截止日 < 今天；
//      日期解析不出来（如「长期有效」「招满即止」）→ 不判定、放行；
//   3. 年限做合理性护栏：只认 [2000, 2100] 内的 4 位年，避免把「截止日期：3 日内」这类
//      非日期文本或工龄数字误判成年份；
//   4. 纯函数、零依赖、可离线回归（scripts/liepin-jd-regression.mjs）。
import type { AppConfig, JobMeta } from './types';

/** 「截止日期」这类标签的识别正则（标签与日期之间允许冒号/空格，中英文全角半角都认） */
const DEADLINE_LABEL_RE =
  /(?:投递|申请|报名|招聘|简历投递)?(?:截止|截至)\s*(?:日期|时间|日)?|有效(?:期|至)|失效(?:日|期)?/;

/** 标签后紧跟的完整日期：2027年07月16日 / 2027-07-16 / 2027/7/16 / 2027.07.16 */
const FULL_DATE_RE = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/;

/** 标签后只有「月日」（如「截止日期：07月16日」）——年份缺失，按当前年推断（见 inferYear） */
const MONTH_DAY_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/;

export interface JdDeadline {
  /** 截止日期（本地时区当日 00:00 的时间戳） */
  ts: number;
  /** 原文命中的日期片段（用于日志与提示，如「2027年07月16日」） */
  raw: string;
  /** 是否已过期（截止日 < 今天 0 点；截止日当天不算过期） */
  expired: boolean;
}

/** 今天 0 点（本地时区）——过期判定的比较基准，保证「分母」一致 */
export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 由年/月/日构造本地时区当日 0 点；非法（如 2027年02月30日）返回 null */
function makeDayTs(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 2000 || year > 2100) return null; // 年限护栏：防把其它数字当成年份
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  // 溢出日期（2 月 30 日 → 3 月 2 日）判非法，避免静默挪日期
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

/**
 * 缺年份时的推断（「截止日期：07月16日」）：
 * 取「今年该月日」；若它已早于今天超过 180 天，认为是跨年的下一年（如 12 月看到「01月05日」）。
 * 只在超过半年的跨度上才判跨年，避免把「今年已过的短期截止」误推到明年而漏拦。
 */
function inferYear(month: number, day: number, todayTs: number): number {
  const thisYear = new Date(todayTs).getFullYear();
  const ts = makeDayTs(thisYear, month, day);
  if (ts == null) return thisYear;
  const HALF_YEAR = 180 * 24 * 3600 * 1000;
  return todayTs - ts > HALF_YEAR ? thisYear + 1 : thisYear;
}

/**
 * 在文本中查「截止日期」并解析。
 *
 * @param text 待检文本（岗位标题 / 描述 / 卡片文本拼接均可）
 * @param now  当前时间戳（默认 Date.now()，测试可注入）
 * @returns 命中且解析成功时返回 JdDeadline；无截止日期标签 / 日期不可解析时返回 null（**不判定**）
 */
export function parseJdDeadline(text: string | null | undefined, now: number = Date.now()): JdDeadline | null {
  const src = String(text || '');
  if (!src) return null;

  // 以「截止/有效期」标签为锚点扫描：取第一个能解析出合法日期的命中，避免被前文噪声带偏
  const labelRe = new RegExp(DEADLINE_LABEL_RE.source, 'g');
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelRe.exec(src))) {
    // 标签后 24 个字符内找日期（「截止日期：2027年07月16日」标签与日期紧邻，留足冒号/空格余量）
    const window = src.slice(labelMatch.index, labelMatch.index + labelMatch[0].length + 24);
    const full = window.match(FULL_DATE_RE);
    if (full) {
      const ts = makeDayTs(Number(full[1]), Number(full[2]), Number(full[3]));
      if (ts != null) {
        return { ts, raw: full[0], expired: ts < startOfToday(now) };
      }
    }
    // 缺年份的「MM月DD日」兜底（标签后紧邻，需与「招N人」等噪声区分）
    const md = window.match(MONTH_DAY_RE);
    if (md) {
      const month = Number(md[1]);
      const day = Number(md[2]);
      const year = inferYear(month, day, startOfToday(now));
      const ts = makeDayTs(year, month, day);
      if (ts != null) {
        return { ts, raw: md[0], expired: ts < startOfToday(now) };
      }
    }
    if (labelRe.lastIndex <= labelMatch.index) labelRe.lastIndex = labelMatch.index + 1; // 防零宽死循环
  }
  return null;
}

/**
 * 该岗位是否因「JD 截止日期已过」应被排除（**设置项开关由调用方把关**）。
 * 与 isJdKeywordExcluded 同级：确定性规则、不依赖 AI、不消耗 Token。
 *
 * @returns { expired, reason, deadline } —— 无截止日期 / 日期不可解析时 expired=false（放行）
 */
export function checkJobExpiry(
  job: Pick<JobMeta, 'title' | 'description' | 'cardText'> | null | undefined,
  now: number = Date.now()
): { expired: boolean; reason: string; deadline: JdDeadline | null } {
  const text = [String(job?.title || ''), String(job?.description || ''), String(job?.cardText || '')].join('\n');
  const deadline = parseJdDeadline(text, now);
  if (!deadline || !deadline.expired) return { expired: false, reason: '', deadline };
  const d = new Date(deadline.ts);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    expired: true,
    reason: `岗位 JD 标注截止日期 ${ymd}，已过期`,
    deadline,
  };
}

/**
 * 「截止日期过期拦截」是否对该配置 / 该平台生效。
 *
 * 口径说明：本次需求（2026-10-01）明确「给猎聘平台专门增加」——触发源是**猎聘 JD 里的
 * 截止日期字段**，因此默认值只在猎聘平台开启（见 PLATFORM_EXPIRY_DEFAULT），
 * 但开关本身是通用能力，用户在设置页可自行对其他平台开启。
 *
 * 用户显式配置（config.excludeExpiredJobs 为布尔）**优先于**平台默认值：关掉即对所有平台失效，
 * 打开即对所有平台生效 —— 保证「设置页那个开关」的语义与用户直觉一致。
 *
 * @param config 全局配置（可为旧数据缺字段，此时回落 defaultValue）
 * @param platform 岗位所属平台（仅用于默认值查表，故调用方通常直接传 PLATFORM_EXPIRY_DEFAULT[platform]）
 * @param defaultValue 配置缺失时的兜底（按平台查 PLATFORM_EXPIRY_DEFAULT）
 */
export function isExpiryFilterEnabled(
  config: Partial<AppConfig> | null | undefined,
  platform: string | null | undefined,
  defaultValue: boolean
): boolean {
  const v = config?.excludeExpiredJobs;
  if (typeof v === 'boolean') return v;
  // 配置缺失（旧持久化数据）→ 按平台默认；未登记的平台 fail-safe 到 defaultValue
  const byPlatform = PLATFORM_EXPIRY_DEFAULT[String(platform || '')];
  return typeof byPlatform === 'boolean' ? byPlatform : defaultValue;
}

/** 各平台「排除已过截止日期岗位」的默认值：仅猎聘默认开启（其 JD 带截止日期字段） */
export const PLATFORM_EXPIRY_DEFAULT: Record<string, boolean> = {
  boss: false,
  liepin: true,
  zhaopin: false,
  job51: false,
};
