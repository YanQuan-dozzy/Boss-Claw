// 公司 / 招聘方黑名单（确定性过滤）
// 在「设置 → 求职偏好」中让用户输入不想投的公司名或不想沟通的招聘方姓名，
// 加入任务时按确定性规则跳过（不依赖 AI 判断，与「城市反选」同级的硬过滤）。
//
// 匹配策略：
// - 公司名做「双向子串匹配」：黑名单「腾讯」命中实际公司「腾讯科技（深圳）有限公司」，
//   反之黑名单全称「XX科技有限公司」也能命中采集到的简称「XX科技」；
// - 招聘方姓名做「单向子串匹配」：黑名单「王老师」命中「王老师（HR）」等带后缀展示。
// 均忽略空白与大小写差异。
import type { AppConfig } from './types';

const normalize = (v: string) => String(v || '').replace(/\s+/g, '').toLowerCase();

/** 双向子串匹配：value 含 entry 或 entry 含 value（用于公司名，兼容简称/全称差异） */
function matchEitherWay(value: string, entries: string[]): string | null {
  const v = normalize(value);
  if (!v) return null;
  for (const raw of entries) {
    const e = normalize(raw);
    if (!e) continue;
    if (v.includes(e) || e.includes(v)) return String(raw).trim();
  }
  return null;
}

/** 单向子串匹配：value 含 entry（用于招聘方姓名，兼容「王老师（HR）」等展示后缀） */
function matchContains(value: string, entries: string[]): string | null {
  const v = normalize(value);
  if (!v) return null;
  for (const raw of entries) {
    const e = normalize(raw);
    if (!e) continue;
    if (v.includes(e)) return String(raw).trim();
  }
  return null;
}

export interface CompanyBlacklistResult {
  excluded: boolean;
  /** 命中时的跳过原因（含命中的黑名单条目），未命中时为空字符串 */
  reason: string;
}

/**
 * 判断某岗位是否命中「公司 / 招聘方黑名单」。
 * - job.company 命中任一被排除的公司名（双向子串）→ 排除；
 * - job.recruiterName 命中任一被排除的招聘方姓名（单向子串）→ 排除。
 * 黑名单为空时恒不排除（返回 excluded:false）。
 * @returns excluded=true 表示该岗位应被跳过，不进入投递队列
 */
export function isCompanyExcluded(
  job: { company?: string | null; recruiterName?: string | null } | null | undefined,
  config: AppConfig
): CompanyBlacklistResult {
  const companies = config.excludedCompanies || [];
  const recruiters = config.excludedRecruiters || [];
  if (!companies.length && !recruiters.length) return { excluded: false, reason: '' };

  const company = String(job?.company || '').trim();
  const recruiter = String(job?.recruiterName || '').trim();

  if (companies.length && company) {
    const hit = matchEitherWay(company, companies);
    if (hit) return { excluded: true, reason: `公司「${company}」命中公司黑名单「${hit}」，已跳过` };
  }

  if (recruiters.length && recruiter) {
    const hit = matchContains(recruiter, recruiters);
    if (hit) return { excluded: true, reason: `招聘方「${recruiter}」命中招聘方黑名单「${hit}」，已跳过` };
  }

  return { excluded: false, reason: '' };
}
