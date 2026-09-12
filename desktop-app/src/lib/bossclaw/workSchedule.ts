// ===== 工作制度识别（双休 / 大小周 / 单休 / 每周 N 天 / 月休 N 天）=====
// 用途：日薪（元/天）折算月薪时，工作日基数是关键参数——
//   双休 22 天/月、大小周 24 天/月、单休 26 天/月；不区分会把单休岗位的日薪
//   显著低估（200 元/天单休 ≈ 5.2K/月，而非按 22 天算出的 4.4K/月），进而误判薪资匹配度。
// 识别来源：岗位描述（JD）/ 卡片文本 / 福利标签（BOSS「周末双休」）/ 标题。
// 口径：52 周 ÷ 12 月 ≈ 4.333 周/月；月休 N 天 → 30 - N 个工作日/月。
import type { JobMeta } from './types';

export interface WorkSchedule {
  /** 每周工作天数（5 / 5.5 / 6 …） */
  weeklyDays: number;
  /** 月工作日（日薪折算基数） */
  monthlyWorkDays: number;
  /** 展示标签（双休 / 大小周 / 单休 / 每周 N 天 / 月休 N 天 / 未说明） */
  label: string;
  /** 是否命中明确的工作制度信号（未命中时按标准双休兜底） */
  detected: boolean;
  /** 命中的原文片段（可解释，最长 40 字） */
  evidence?: string;
}

export const DEFAULT_WEEKLY_DAYS = 5;
/** 平均周数/月（52 / 12 ≈ 4.333） */
export const WEEKS_PER_MONTH = 52 / 12;

/** 每周天数 → 月工作日（四舍五入到整天；20–31 天做护栏） */
export function monthlyWorkDaysOf(weeklyDays: number): number {
  const d = Math.round(Math.max(1, Math.min(7, Number(weeklyDays) || DEFAULT_WEEKLY_DAYS)) * WEEKS_PER_MONTH);
  return Math.max(20, Math.min(31, d));
}

/** 月休天数 → 月工作日（按 30 天/月近似；20–28 天护栏） */
export function monthlyWorkDaysFromRest(restDays: number): number {
  const d = 30 - Math.max(0, Math.min(10, Number(restDays) || 0));
  return Math.max(20, Math.min(28, d));
}

function clip(s: string, n = 40): string {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// 判定优先级：明确的「每周 N 天 / 月休 N 天」数字 > 行业俗语（大小周 / 单休 / 双休）。
// 理由：数字是硬事实；俗语在 JD 里常被「非双休」「周末双休」等措辞包裹，放在数字之后更稳。
const RE_WEEKLY_DAYS = /(?:每|一)\s*周\s*(?:工作|上班|出勤)?\s*(\d(?:\.\d)?)\s*天|(\d(?:\.\d)?)\s*天\s*(?:工作|上班)?制|(五天半|5\.5\s*天)/;
const RE_MONTHLY_REST = /月\s*休\s*(\d{1,2})\s*天|每月\s*(?:休息|休)\s*(\d{1,2})\s*天/;
const RE_BIG_SMALL_WEEK = /大小周|大小休|单双休|单双轮休/;
const RE_SINGLE_REST = /做六休一|单休|六天制|六天工作制|周休一天|每周休一天|六日制/;
const RE_DOUBLE_REST = /周末双休|做五休二|双休|五天制|五天工作制|周末休息/;

/**
 * 识别岗位的工作制度。未命中任何信号 → 标准双休（5 天/周、22 天/月）兜底且 `detected=false`。
 * 传入 JobMeta 即可（读取 title / description / cardText / welfare 四个来源）。
 */
export function detectWorkSchedule(input?: Partial<JobMeta> | null): WorkSchedule {
  const welfareRaw = (input as { welfare?: unknown } | null | undefined)?.welfare;
  const welfare = Array.isArray(welfareRaw) ? welfareRaw.map(String).join(' ') : '';
  const text = [input?.title, input?.description, input?.cardText, welfare].filter(Boolean).join('\n');
  const fallback = (): WorkSchedule => ({
    weeklyDays: DEFAULT_WEEKLY_DAYS,
    monthlyWorkDays: monthlyWorkDaysOf(DEFAULT_WEEKLY_DAYS),
    label: '未说明',
    detected: false,
  });
  if (!String(text).trim()) return fallback();

  // ① 每周 N 天 / 一周 N 天 / N 天工作制 / 五天半
  const weekly = text.match(RE_WEEKLY_DAYS);
  if (weekly) {
    const w = weekly[3] ? 5.5 : Number(weekly[1] || weekly[2]);
    if (Number.isFinite(w) && w >= 3 && w <= 7) {
      return { weeklyDays: w, monthlyWorkDays: monthlyWorkDaysOf(w), label: `每周 ${w} 天`, detected: true, evidence: clip(weekly[0]) };
    }
  }
  // ② 月休 N 天（如「月休 4 天」→ 26 天/月）
  const rest = text.match(RE_MONTHLY_REST);
  if (rest) {
    const n = Number(rest[1] || rest[2]);
    if (Number.isFinite(n) && n >= 0 && n <= 12) {
      const days = monthlyWorkDaysFromRest(n);
      return {
        weeklyDays: Math.round((days / WEEKS_PER_MONTH) * 10) / 10,
        monthlyWorkDays: days,
        label: `月休 ${n} 天`,
        detected: true,
        evidence: clip(rest[0]),
      };
    }
  }
  // ③ 大小周 / 单双休 → 平均 5.5 天/周
  const bigSmall = text.match(RE_BIG_SMALL_WEEK);
  if (bigSmall) {
    return { weeklyDays: 5.5, monthlyWorkDays: monthlyWorkDaysOf(5.5), label: '大小周', detected: true, evidence: clip(bigSmall[0]) };
  }
  // ④ 单休系 → 6 天/周
  const single = text.match(RE_SINGLE_REST);
  if (single) {
    return { weeklyDays: 6, monthlyWorkDays: monthlyWorkDaysOf(6), label: '单休', detected: true, evidence: clip(single[0]) };
  }
  // ⑤ 双休系 → 5 天/周
  const double = text.match(RE_DOUBLE_REST);
  if (double) {
    return { weeklyDays: 5, monthlyWorkDays: monthlyWorkDaysOf(5), label: '双休', detected: true, evidence: clip(double[0]) };
  }
  return fallback();
}

/** 日薪 → 月薪（千元）：日薪 × 月工作日 ÷ 1000 */
export function dailyToMonthlyK(daily: number, monthlyWorkDays = monthlyWorkDaysOf(DEFAULT_WEEKLY_DAYS)): number {
  return (Number(daily) * Number(monthlyWorkDays)) / 1000;
}

/** 时薪 → 月薪（千元）：时薪 × 8 小时/天 × 月工作日 ÷ 1000 */
export function hourlyToMonthlyK(hourly: number, monthlyWorkDays = monthlyWorkDaysOf(DEFAULT_WEEKLY_DAYS)): number {
  return (Number(hourly) * 8 * Number(monthlyWorkDays)) / 1000;
}

/** 折算依据文案（UI 提示统一口径，如「按 单休 26 天/月 折算」） */
export function scheduleBasisText(schedule: WorkSchedule, daily = true): string {
  if (schedule.detected) return `按 ${schedule.label} ${schedule.monthlyWorkDays} 天/月 折算`;
  return daily ? `按标准双休 ${schedule.monthlyWorkDays} 天/月 折算` : `按标准双休口径（${schedule.monthlyWorkDays} 天/月）`;
}
