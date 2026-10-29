// HR 活跃度过滤：确定性规则，由用户在设置中指定，非 AI 判断。
// 与 BOSS 页面提取到的活跃度文本（webview.cjs detectHrActive）配合，
// 用于在「加入任务」时跳过长期不活跃的岗位，避免浪费每日打招呼配额。
//
// 7 级口径对齐 AI-BossJob 的活跃度分级（由高到低）：
//   在线(7) > 刚刚活跃(6) > 今日活跃(5) > 3日内活跃(4) > 本周活跃(3) > 本月活跃(2) > 半年前活跃(1)
import type { HrActivityFilter } from './types';

// 「在线」必须**整段就是在线状态**，不能是含「在线」二字的其它语义（审查 #98）。
// 旧实现 `if (/在线/.test(s)) return 7;` 置于所有判断之前 —— 卡片文本里的「在线简历」「在线沟通」
// 「在线咨询」等都会被判成最高活跃度，使「仅在线」筛选放行长期不活跃的岗位（浪费每日配额）。
// 允许的形态：整段 == 在线 / 在线中 / 当前在线 / 正在在线，或「在线」作为独立词元出现
// （前后为分隔符或字符串边界，如「张女士 · 在线」）。
const ONLINE_LABEL_RE = /(?:^|[^\u4e00-\u9fa5A-Za-z0-9])在线(?:[^\u4e00-\u9fa5A-Za-z0-9]|$)/;
const ONLINE_PHRASE_RE = /^(?:当前在线|正在在线|在线中|在线状态)$/;

// 将活跃度文本映射为等级（越高越活跃）；0 表示「未识别」（不参与过滤，避免误杀）
export function hrActivityRank(hrActive: string | null | undefined): number {
  const s = String(hrActive || '').trim();
  if (!s) return 0;
  if (ONLINE_LABEL_RE.test(s) || ONLINE_PHRASE_RE.test(s)) return 7;
  if (/刚刚活跃|刚活跃|几分钟前活跃/.test(s)) return 6;
  if (/今日活跃|今天活跃/.test(s)) return 5;
  const days = s.match(/(\d+)\s*日内活跃/);
  if (days) {
    const n = Number(days[1]);
    if (n <= 3) return 4; // 3日内活跃
    if (n <= 7) return 3; // 本周活跃
    if (n <= 30) return 2; // 本月活跃
    return 1; // 超过一个月 → 半年前活跃档
  }
  // 「N周内活跃」「N月内活跃」按 N 分档（对齐 abclq/Boss-Claw 的 L7 修复）：
  // 旧实现识别不到「2周内活跃」→ 放行；「2月内活跃」被 /月内活跃/ 兜住 → 误判为「本月活跃(2)」。
  const weeks = s.match(/([0-9]+|[一二两三四五六七八九十])\s*(?:个)?(?:周|星期)内活跃/);
  if (weeks) {
    const n = cnNum(weeks[1]);
    if (n <= 1) return 3; // 1周内 = 本周活跃
    if (n <= 4) return 2; // 2~4周内 ≈ 本月活跃
    return 1;
  }
  const months = s.match(/([0-9]+|[一二两三四五六七八九十半])\s*(?:个)?月内活跃/);
  if (months) {
    const n = cnNum(months[1]);
    return n <= 1 ? 2 : 1; // 1个月内/半月内 = 本月活跃；2个月及以上 → 半年前活跃档
  }
  if (/本周活跃/.test(s)) return 3;
  if (/本月活跃/.test(s)) return 2;
  if (/半年前活跃|数月前活跃|很久前活跃|近半年活跃|半年内活跃|半年活跃/.test(s)) return 1;
  return 0;
}

// 阿拉伯数字或单个中文数字 → 数值（「半」按 0.5 计）
function cnNum(t: string): number {
  const map: Record<string, number> = { 半: 0.5, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return /^[0-9]+$/.test(t) ? Number(t) : map[t] ?? Number.POSITIVE_INFINITY;
}

const HR_FILTER_RANK: Record<HrActivityFilter, number> = {
  any: 0,
  month: 2,
  week: 3,
  '3days': 4,
  today: 5,
  justActive: 6,
  online: 7,
};

export function meetsHrActivityFilter(hrActive: string | null | undefined, filter: HrActivityFilter | undefined | null): boolean {
  if (!filter || filter === 'any') return true;
  const rank = hrActivityRank(hrActive);
  // 未识别到活跃度（rank=0）时不视为不满足，避免误杀：无法判断 ≠ 不满足
  if (rank === 0) return true;
  return rank >= HR_FILTER_RANK[filter];
}

export const HR_ACTIVITY_FILTER_OPTIONS: { value: HrActivityFilter; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'month', label: '本月活跃及以上' },
  { value: 'week', label: '本周活跃及以上' },
  { value: '3days', label: '3日内活跃及以上' },
  { value: 'today', label: '今日活跃及以上' },
  { value: 'justActive', label: '刚刚活跃及以上' },
  { value: 'online', label: '仅在线' },
];

export const HR_ACTIVITY_FILTER_LABEL: Record<HrActivityFilter, string> = {
  any: '不限',
  month: '本月活跃及以上',
  week: '本周活跃及以上',
  '3days': '3日内活跃及以上',
  today: '今日活跃及以上',
  justActive: '刚刚活跃及以上',
  online: '仅在线',
};
