// 内置浏览器「可访问 URL 白名单」—— 仅招聘平台。
// 唯一权威实现。BrowserView（webview）/ CloakView（隐身）共用此模块做导航拦截。
// 口径：hostname 域名后缀匹配（host === domain || host.endsWith('.' + domain)）。
import { PLATFORM_META, type JobPlatform } from './platforms';

export type WhitelistGroup = 'platform' | 'comprehensive' | 'fresh' | 'bluecollar';

export interface BrowserSite {
  /** hostname 匹配用，含后缀，如 'zhipin.com' */
  domain: string;
  label: string;
  homeUrl: string;
  group: WhitelistGroup;
  groupLabel: string;
}

/** 4 个现有招聘平台（与 PLATFORM_META 同源），组内归属「平台」 */
const PLATFORM_SITES: BrowserSite[] = (
  ['boss', 'liepin', 'zhaopin', 'job51'] as JobPlatform[]
).map((id) => ({
  domain: PLATFORM_META[id].domain,
  label: PLATFORM_META[id].label,
  homeUrl: PLATFORM_META[id].homeUrl,
  group: 'platform' as const,
  groupLabel: '平台',
}));

/** 白名单全表（平台 + 综合/中高端 + 应届生/实习 + 蓝领/兼职/生活） */
export const BROWSER_WHITELIST: BrowserSite[] = [
  ...PLATFORM_SITES,
  // —— 综合 / 中高端 ——
  { domain: 'chinahr.com', label: '中华英才网', homeUrl: 'https://www.chinahr.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'lagou.com', label: '拉勾网', homeUrl: 'https://www.lagou.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'kanzhun.com', label: '看准网', homeUrl: 'https://www.kanzhun.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'iguopin.com', label: '国聘', homeUrl: 'https://www.iguopin.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'ciiczhaopin.com', label: '中智招聘', homeUrl: 'https://www.ciiczhaopin.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'job1001.com', label: '一览英才网', homeUrl: 'https://www.job1001.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'maimai.cn', label: '脉脉', homeUrl: 'https://maimai.cn', group: 'comprehensive', groupLabel: '综合·中高端' },
  { domain: 'linkedin.com', label: '领英', homeUrl: 'https://www.linkedin.com', group: 'comprehensive', groupLabel: '综合·中高端' },
  // —— 应届生 / 实习 ——
  { domain: 'yingjiesheng.com', label: '应届生', homeUrl: 'https://www.yingjiesheng.com', group: 'fresh', groupLabel: '应届生·实习' },
  { domain: 'shixiseng.com', label: '实习僧', homeUrl: 'https://www.shixiseng.com', group: 'fresh', groupLabel: '应届生·实习' },
  { domain: 'dajie.com', label: '大街网', homeUrl: 'https://www.dajie.com', group: 'fresh', groupLabel: '应届生·实习' },
  // —— 蓝领 / 兼职 / 生活 ——
  { domain: '58.com', label: '58同城', homeUrl: 'https://www.58.com', group: 'bluecollar', groupLabel: '蓝领·兼职·生活' },
  { domain: 'ganji.com', label: '赶集网', homeUrl: 'https://www.ganji.com', group: 'bluecollar', groupLabel: '蓝领·兼职·生活' },
  { domain: 'quanzhi.com', label: '全职招聘网', homeUrl: 'https://www.quanzhi.com', group: 'bluecollar', groupLabel: '蓝领·兼职·生活' },
  { domain: 'jianzhimao.com', label: '兼职猫', homeUrl: 'https://www.jianzhimao.com', group: 'bluecollar', groupLabel: '蓝领·兼职·生活' },
  { domain: 'doumi.com', label: '斗米', homeUrl: 'https://www.doumi.com', group: 'bluecollar', groupLabel: '蓝领·兼职·生活' },
];

const WHITELIST_DOMAINS = BROWSER_WHITELIST.map((s) => s.domain);

/** 取 URL hostname（转小写）；失败回退空串。复用 BrowserView 里同样基于 new URL 兜底解析的模式 */
export function whitelistHostOf(url: string): string {
  const u = String(url || '');
  try {
    return new URL(u, 'https://localhost').hostname.toLowerCase();
  } catch {
    return (u.split('/')[2] || '').toLowerCase();
  }
}

/** 域名是否命中白名单（host === domain || host.endsWith('.' + domain)） */
export function isWhitelistedDomain(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return WHITELIST_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/** URL 是否允许在内置浏览器访问（白名单内招聘平台） */
export function isWhitelistedUrl(url: string): boolean {
  return isWhitelistedDomain(whitelistHostOf(url));
}

/** 非「平台」分组的白名单分组顺序（供便签页展示；「平台」分组由调用方按启用状态组装） */
export const WHITELIST_GROUPS = (['comprehensive', 'fresh', 'bluecollar'] as WhitelistGroup[]).map((g) => ({
  group: g,
  label: BROWSER_WHITELIST.find((s) => s.group === g)?.groupLabel || g,
}));

/** 取某分组下的白名单站点 */
export function whitelistSitesOf(group: WhitelistGroup): BrowserSite[] {
  return BROWSER_WHITELIST.filter((s) => s.group === group);
}