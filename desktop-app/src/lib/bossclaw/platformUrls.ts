// 多平台搜索 URL 构建器（BOSS 之外的 猎聘 / 智联招聘 / 前程无忧 51Job）
// 口径来源：GitHub 调研 get_jobs(loks666, 8.3k★) / Auto-JobHunter(jolie-z)
//   - 猎聘：https://www.liepin.com/zhaopin/?city=&dq=&salary=&currentPage=0&key=
//   - 智联：https://www.zhaopin.com/sou/jl{city}/p{page}?sl={salary}（新版路径式）
//   - 51Job：https://we.51job.com/pc/search?jobArea=&salary=&keyword=
// 城市码为硬编码主表 + 已知码直接透传；未知城市回退「全国/不限」（不臆造码）。
import type { AppConfig, DirectionPlan, JobPlatform } from './types';
import { selectedDirectionItems } from './directions';
import { buildJobSearchUrl } from './searchUrl';

// ==================== 猎聘 liepin ====================
export const LIEPIN_BASE_URL = 'https://www.liepin.com/zhaopin/';
// 城市码（Auto-JobHunter 实测 + get_jobs 配置口径；未知城市回退全国 410）
export const LIEPIN_CITY_CODES: Record<string, string> = {
  全国: '410', 北京: '010', 上海: '020', 天津: '030', 重庆: '040',
  广州: '050020', 深圳: '050090', 杭州: '070020', 成都: '280020',
  武汉: '170020', 南京: '060020', 苏州: '060080',
};
// 薪资码（猎聘为年薪档）
export const LIEPIN_SALARY_CODES: Record<string, string> = {
  不限: '', '10万以下': '1', '10-15万': '2', '15-20万': '3', '20-30万': '4',
  '30-40万': '5', '40-50万': '6', '50万以上': '7',
};

function isNoFilter(value: string | undefined | null): boolean {
  const v = String(value || '').trim();
  return !v || v === '不限' || v === '全部' || v === '不限制' || v === '全国';
}

export function resolveLiepinCityCode(city?: string): string {
  const c = String(city || '').trim();
  if (!c || isNoFilter(c)) return LIEPIN_CITY_CODES['全国'];
  if (LIEPIN_CITY_CODES[c]) return LIEPIN_CITY_CODES[c];
  for (const [name, code] of Object.entries(LIEPIN_CITY_CODES)) {
    if (name.startsWith(c) || c.startsWith(name)) return code;
  }
  return LIEPIN_CITY_CODES['全国'];
}

export function resolveLiepinSalaryCode(salary?: string): string {
  const s = String(salary || '').trim();
  if (!s || isNoFilter(s)) return '';
  if (/^\d{1,2}$/.test(s)) return s;
  return LIEPIN_SALARY_CODES[s] || '';
}

export interface LiepinSearchQuery {
  keyword?: string;
  city?: string;
  salary?: string;
  page?: number;
}

export function buildLiepinSearchUrl(query: LiepinSearchQuery = {}): string {
  const params = new URLSearchParams();
  params.set('city', resolveLiepinCityCode(query.city));
  params.set('dq', resolveLiepinCityCode(query.city));
  const salary = resolveLiepinSalaryCode(query.salary);
  if (salary) params.set('salary', salary);
  params.set('currentPage', String(Math.max(0, (query.page || 1) - 1)));
  const kw = String(query.keyword || '').trim();
  if (kw) params.set('key', kw);
  return `${LIEPIN_BASE_URL}?${params.toString()}`;
}

// ==================== 智联招聘 zhaopin ====================
export const ZHAOPIN_BASE_URL = 'https://www.zhaopin.com/sou/';
// jl 城市码（公开爬虫口径：北京 530 / 上海 489 / 深圳 765 / 天津 532 / 重庆 481 …
// 其余城市实施时以平台官方城市树运行时补全，未知城市省略 jl = 全国）
export const ZHAOPIN_CITY_CODES: Record<string, string> = {
  全国: '', 北京: '530', 上海: '489', 深圳: '765', 天津: '532',
  重庆: '481', 广州: '763', 杭州: '653', 成都: '801', 武汉: '736',
  南京: '635', 苏州: '639', 西安: '854', 郑州: '713', 长沙: '749',
  青岛: '857', 厦门: '683', 沈阳: '483', 大连: '682', 济南: '636',
};
// sl 薪资码（智联：2K以下=1 … 50K以上=7）
export const ZHAOPIN_SALARY_CODES: Record<string, string> = {
  不限: '', '2K以下': '1', '2-5K': '2', '5-10K': '3', '10-15K': '4',
  '15-25K': '5', '25-50K': '6', '50K以上': '7',
};

export function resolveZhaopinCityCode(city?: string): string {
  const c = String(city || '').trim();
  if (!c || isNoFilter(c)) return '';
  if (ZHAOPIN_CITY_CODES[c]) return ZHAOPIN_CITY_CODES[c];
  for (const [name, code] of Object.entries(ZHAOPIN_CITY_CODES)) {
    if (code && (name.startsWith(c) || c.startsWith(name))) return code;
  }
  return ''; // 未知 → 全国
}

export function resolveZhaopinSalaryCode(salary?: string): string {
  const s = String(salary || '').trim();
  if (!s || isNoFilter(s)) return '';
  if (/^\d{1,2}$/.test(s)) return s;
  return ZHAOPIN_SALARY_CODES[s] || '';
}

export interface ZhaopinSearchQuery {
  keyword?: string;
  city?: string;
  salary?: string;
  page?: number;
}

export function buildZhaopinSearchUrl(query: ZhaopinSearchQuery = {}): string {
  const city = resolveZhaopinCityCode(query.city);
  const page = Math.max(1, query.page || 1);
  let url = `${ZHAOPIN_BASE_URL}${city ? `jl${city}` : ''}/p${page}`;
  const salary = resolveZhaopinSalaryCode(query.salary);
  if (salary) url += `?sl=${salary}`;
  const kw = String(query.keyword || '').trim();
  // 新版路径式 URL 不含 kw；关键词由引擎在页内搜索框输入（与 get_jobs ZhiLian.java 一致）
  return url + (kw ? `${salary ? '&' : '?'}kw=${encodeURIComponent(kw)}` : '');
}

// ==================== 前程无忧 51job ====================
export const JOB51_BASE_URL = 'https://we.51job.com/pc/search?';
// jobArea 城市码（51job-spider 口径：北京 010000 / 上海 020000 / 广州 030000 / 深圳 040000 …）
export const JOB51_AREA_CODES: Record<string, string> = {
  全国: '', 北京: '010000', 上海: '020000', 广州: '030000', 深圳: '040000',
  天津: '050000', 重庆: '060000', 杭州: '070000', 南京: '080000', 苏州: '090000',
  武汉: '100000', 西安: '110000', 成都: '120000', 长沙: '130000', 郑州: '140000',
  青岛: '150000', 厦门: '160000', 福州: '170000', 济南: '180000', 大连: '190000',
  沈阳: '200000', 合肥: '210000', 昆明: '220000', 南昌: '230000', 南宁: '240000',
  哈尔滨: '250000', 长春: '260000', 石家庄: '270000', 太原: '280000', 贵阳: '290000',
};
// salary 码（51job：1=1K以下 … 13=50K以上）
export const JOB51_SALARY_CODES: Record<string, string> = {
  不限: '', '1K以下': '1', '1-2K': '2', '2-3K': '3', '3-4.5K': '4',
  '4.5-6K': '5', '6-8K': '6', '8-10K': '7', '10-15K': '8', '15-20K': '9',
  '20-30K': '10', '30-40K': '11', '40-50K': '12', '50K以上': '13',
};

export function resolveJob51AreaCode(city?: string): string {
  const c = String(city || '').trim();
  if (!c || isNoFilter(c)) return '';
  if (JOB51_AREA_CODES[c]) return JOB51_AREA_CODES[c];
  for (const [name, code] of Object.entries(JOB51_AREA_CODES)) {
    if (code && (name.startsWith(c) || c.startsWith(name))) return code;
  }
  return ''; // 未知 → 全国
}

export function resolveJob51SalaryCode(salary?: string): string {
  const s = String(salary || '').trim();
  if (!s || isNoFilter(s)) return '';
  if (/^\d{1,2}$/.test(s)) return s;
  return JOB51_SALARY_CODES[s] || '';
}

export interface Job51SearchQuery {
  keyword?: string;
  city?: string;
  salary?: string;
}

export function buildJob51SearchUrl(query: Job51SearchQuery = {}): string {
  const params = new URLSearchParams();
  const area = resolveJob51AreaCode(query.city);
  if (area) params.set('jobArea', area);
  const salary = resolveJob51SalaryCode(query.salary);
  if (salary) params.set('salary', salary);
  const kw = String(query.keyword || '').trim();
  if (kw) params.set('keyword', kw);
  const qs = params.toString();
  return qs ? `${JOB51_BASE_URL}${qs}` : JOB51_BASE_URL;
}

// ==================== 统一入口 ====================
export interface PlatformSearchQuery {
  keyword?: string;
  city?: string;
  salary?: string;
  page?: number;
}

/** 按平台构建搜索 URL（boss 复用 searchUrl.ts 的 BOSS 口径） */
export function buildPlatformSearchUrl(platform: JobPlatform, query: PlatformSearchQuery = {}): string {
  switch (platform) {
    case 'liepin':
      return buildLiepinSearchUrl(query);
    case 'zhaopin':
      return buildZhaopinSearchUrl(query);
    case 'job51':
      return buildJob51SearchUrl(query);
    case 'boss':
    default:
      return buildJobSearchUrl({
        keyword: query.keyword, city: query.city, salary: query.salary, page: query.page,
      });
  }
}

export interface PlatformSearchQueueItem {
  platform: JobPlatform;
  url: string;
  keyword: string;
  location: string;
  employmentType: string;
}

/**
 * 按平台 × 已确认投递方向 × 城市 × 求职类型 生成搜索 URL 队列（对齐 buildSearchQueue 语义）。
 * 非 BOSS 平台暂不附加 experience/degree/scale/jobType 参数（平台参数口径不同，保持最小面）。
 */
export function buildPlatformSearchQueue(
  platform: JobPlatform,
  directionPlan: DirectionPlan | null,
  config: AppConfig,
): PlatformSearchQueueItem[] {
  const directions = selectedDirectionItems(directionPlan);
  const locations = config.targetLocations?.filter(Boolean).length ? config.targetLocations : ['全国'];
  const employmentTypes = config.employmentTypes?.filter(Boolean).length ? config.employmentTypes : ['不限'];

  const queue: PlatformSearchQueueItem[] = [];
  const seen = new Set<string>();
  for (const direction of directions) {
    for (const location of locations) {
      for (const keyword of direction.keywords) {
        for (const employmentType of employmentTypes) {
          const url = buildPlatformSearchUrl(platform, {
            keyword, city: location, salary: config.salary, page: 1,
          });
          if (seen.has(url)) continue;
          seen.add(url);
          queue.push({ platform, url, keyword, location, employmentType });
        }
      }
    }
  }
  return queue;
}
