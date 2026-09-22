// 多平台搜索 URL 构建器（BOSS 之外的 猎聘 / 智联招聘 / 前程无忧 51Job）
// 口径来源：GitHub 调研 get_jobs(loks666, 8.3k★) / Auto-JobHunter(jolie-z)
//   - 猎聘：https://www.liepin.com/zhaopin/?city=&dq=&salary=&currentPage=0&key=
//   - 智联：https://www.zhaopin.com/sou/jl{city}/p{page}?sl={salary}（新版路径式）
//   - 51Job：https://we.51job.com/pc/search?jobArea=&salary=&keyword=
// 城市/薪资码为硬编码主表 + 已知码直接透传；未知城市回退「全国/不限」（不臆造码）。
//
// ⚠️「基础求职条件」的扩展筛选由 `camoufox/platforms/filters.py` 统一翻译（唯一权威）。
//   **智联是例外**：搜索 URL 会被「内置浏览器列表级采集」直接打开，筛选必须真实进 URL 才能在
//   页面上生效，故本文件为智联镜像一套同码值表（双源同步：与 filters.py 的 ZHAOPIN_EXP/EDU/
//   SCALE/COMPANY_TYPE/FINANCING/JOB_TYPE 逐一对应；改动码值必须两边同步，并以
//   `scripts/zhaopin-url-regression.mjs` + `python ../tmp/probe-platforms.py` 双验）。
//   猎聘 / 前程无忧仍只带 城市/薪资/关键词（其 URL 仅用于展示 / 记录 / 组合去重，筛选走隐身采集）。
import type { AppConfig, DirectionPlan, JobPlatform } from './types';
import { selectedDirectionItems } from './directions';
import { buildJobSearchUrl, RANDOM_COLLECT_LABEL } from './searchUrl';

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
  广东: '548', // 省级码：全广东（用户实测链接 jl=548）
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

// ==================== 智联「基础求职条件」→ URL 参数（镜像 filters.py，双源同步） ====================
// 下列码表与 `camoufox/platforms/filters.py` 的 ZHAOPIN_* 逐一对应（2026-09 用户实测链接），
// 只用于「内置浏览器列表级采集」打开 Zhaopin 搜索页时让筛选真实生效；隐身穿墙采集仍走 filters.py。
const ZHAOPIN_CRITERIA_EXP: Record<string, string> = {
  经验不限: '-1', 无经验: '0000', '1年以下': '0001', '1年以内': '0001',
  '1-3年': '0103', '3-5年': '0305', '5-10年': '0510', '10年以上': '1099',
};
const ZHAOPIN_CRITERIA_EDU: Record<string, string> = {
  博士: '1', 硕士: '3', 本科: '4', 大专: '5', 高中: '7',
};
const ZHAOPIN_CRITERIA_SCALE: Record<string, string> = {
  '0-20人': '1', '20人以下': '1', '20-99人': '2', '100-299人': '3',
  '300-499人': '8', '100-499人': '3,8', '500-999人': '4',
  '1000-9999人': '5', '10000人以上': '6',
};
const ZHAOPIN_CRITERIA_COMPANY_TYPE: Record<string, string> = {
  国企: '1', 外企: '2', 民营: '5',
};
const ZHAOPIN_CRITERIA_FINANCING: Record<string, string> = {
  不需要融资: '8', 未融资: '1', 有融资: '2;3;4;5;6',
};
const ZHAOPIN_CRITERIA_JOB_TYPE: Record<string, string> = {
  全职: '2', 实习: '4', 校招: '5', 兼职: '1',
};

/** 多选列表 → 码值（按 `,` 连接，与 filters.py MULTI_SEP['zhaopin'] 一致；未命中项忽略） */
function zhaopinCriteriaCodes(list: string[] | undefined, table: Record<string, string>): string {
  const codes = (list ?? []).map((x) => table[x]).filter(Boolean);
  return codes.length ? codes.join(',') : '';
}

/** 智联 「基础求职条件」→ URL 查询串（无匹配项返回 ''；空/不限选项自然跳过） */
export function appendZhaopinCriteria(criteria: PlatformSearchCriteria | undefined | null): string {
  if (!criteria) return '';
  const parts: string[] = [];
  const we = zhaopinCriteriaCodes(criteria.experiences, ZHAOPIN_CRITERIA_EXP);
  if (we) parts.push(`we=${we}`);
  const el = zhaopinCriteriaCodes(criteria.degrees, ZHAOPIN_CRITERIA_EDU);
  if (el) parts.push(`el=${el}`);
  const cs = criteria.companyScale ? ZHAOPIN_CRITERIA_SCALE[criteria.companyScale] : '';
  if (cs) parts.push(`cs=${cs}`);
  const ct = criteria.companyType ? ZHAOPIN_CRITERIA_COMPANY_TYPE[criteria.companyType] : '';
  if (ct) parts.push(`ct=${ct}`);
  const fs = zhaopinCriteriaCodes(criteria.financing, ZHAOPIN_CRITERIA_FINANCING);
  if (fs) parts.push(`fs=${fs}`);
  const et = zhaopinCriteriaCodes(criteria.employmentTypes, ZHAOPIN_CRITERIA_JOB_TYPE);
  if (et) parts.push(`et=${et}`);
  return parts.join('&');
}

export interface ZhaopinSearchQuery {
  keyword?: string;
  city?: string;
  salary?: string;
  page?: number;
  /** 「基础求职条件」：随 URL 进入智联搜索页（求职类型/学历/经验/规模/性质/融资） */
  criteria?: PlatformSearchCriteria;
}

export function buildZhaopinSearchUrl(query: ZhaopinSearchQuery = {}): string {
  const city = resolveZhaopinCityCode(query.city);
  const page = Math.max(1, query.page || 1);
  let url = `${ZHAOPIN_BASE_URL}${city ? `jl${city}` : ''}/p${page}`;
  const qs: string[] = [];
  const salary = resolveZhaopinSalaryCode(query.salary);
  if (salary) qs.push(`sl=${salary}`);
  const kw = String(query.keyword || '').trim();
  // 新版路径式 URL 不含 kw；关键词由引擎在页内搜索框输入（与 get_jobs ZhiLian.java 一致）
  if (kw) qs.push(`kw=${encodeURIComponent(kw)}`);
  const criteriaQs = appendZhaopinCriteria(query.criteria);
  if (criteriaQs) qs.push(criteriaQs);
  if (qs.length) url += `?${qs.join('&')}`;
  return url;
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
  /** 「基础求职条件」：智联会拼进 URL（面向内置浏览器列表采集）；其余平台仍只走 criteria 下发 */
  criteria?: PlatformSearchCriteria;
}

/** 按平台构建搜索 URL（boss 复用 searchUrl.ts 的 BOSS 口径；zhaopin 会带上 criteria 筛选） */
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
  /** 展示/记录/打开用搜索 URL；**智联已把 criteria 筛选拼进 URL**（内置浏览器列表采集直接生效），
   *  其余平台仅 城市+薪资+关键词，筛选由 criteria 经 filters.py 附加到隐身穿墙采集 */
  url: string;
  keyword: string;
  location: string;
  employmentType: string;
  /**
   * 「基础求职条件」原始条件（全平台共用一份设置）：传给 Camoufox 隐身采集，
   * 由 `camoufox/platforms/filters.py` 按平台翻译成各自筛选参数
   * （猎聘 workYearCode/eduLevel、智联 we/el/cs、前程无忧 workYear/degree/companySize/jobType）。
   * 城市 / 薪资 / 关键词仍由本文件的 URL 构建器处理。
   */
  criteria: PlatformSearchCriteria;
  /** 来源投递方向（用于「任务进度」卡片归属，采集时同步生成 TaskRun） */
  directionId: string;
  directionName: string;
  directionPriority: number;
  directionScore: number;
}

/**
 * 设置页「基础求职条件」快照（字段名与 AppConfig 对齐，Python 侧兼容 camelCase）。
 * 说明：刻意用 **type 别名**而非 interface —— TS 只对类型别名/对象字面量推导隐式索引签名，
 * 这样它可直接作为 JSON payload（`Record<string, unknown>`）传给 Camoufox 通道，无需强转。
 */
export type PlatformSearchCriteria = {
  salary?: string;
  experiences?: string[];
  degrees?: string[];
  companyScale?: string;
  employmentTypes?: string[];
  /** 公司性质（单选；智联 ct：国企=1/外企=2/民营=5，其余平台未验证不附加） */
  companyType?: string;
  /** 融资阶段（多选；智联 fs：不需要融资=8/未融资=1/有融资=2;3;4;5;6，其余平台未验证不附加） */
  financing?: string[];
};

/** 从全局配置提取「基础求职条件」（非 BOSS 平台隐身采集共用） */
export function platformSearchCriteria(config: AppConfig): PlatformSearchCriteria {
  return {
    salary: config.salary,
    experiences: config.experiences ?? [],
    degrees: config.degrees ?? [],
    companyScale: config.companyScale,
    employmentTypes: config.employmentTypes ?? [],
    companyType: config.companyType,
    financing: config.financing ?? [],
  };
}

/** 「基础求职条件」日志摘要：只列出用户**实际设置**的项（空 / 不限不显示） */
export function describePlatformCriteria(c?: PlatformSearchCriteria | null): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.salary && c.salary !== '不限') parts.push(`薪资=${c.salary}`);
  if (c.employmentTypes?.length) parts.push(`求职类型=${c.employmentTypes.join('/')}`);
  if (c.degrees?.length) parts.push(`学历=${c.degrees.join('/')}`);
  if (c.experiences?.length) parts.push(`经验=${c.experiences.join('/')}`);
  if (c.companyScale && c.companyScale !== '不限') parts.push(`公司规模=${c.companyScale}`);
  if (c.companyType && c.companyType !== '不限') parts.push(`公司性质=${c.companyType}`);
  if (c.financing?.length) parts.push(`融资阶段=${c.financing.join('/')}`);
  return parts.join(' · ');
}

/**
 * 按平台 × 已确认投递方向 × 城市 × 求职类型 生成搜索 URL 队列（对齐 buildSearchQueue 语义）。
 *
 * 「基础求职条件」现在**对所有平台通用**：队列项携带 criteria（学历 / 经验 / 公司规模 /
 * 求职类型 / 薪资），非 BOSS 平台由 Camoufox 平台模块（`camoufox/platforms/filters.py`）
 * 翻译为各平台筛选参数后拼进搜索 URL —— 各维度是否已接通见该文件 FILTER_CAPABILITIES
 * 能力表（码值未验证的维度按「不臆造码、宁可多召回不误杀」原则不附加）。
 * 开启「无关键字采集」时同上：URL 只去掉关键词字段，其余用户设置不变。
 */
export function buildPlatformSearchQueue(
  platform: JobPlatform,
  directionPlan: DirectionPlan | null,
  config: AppConfig,
): PlatformSearchQueueItem[] {
  const locations = config.targetLocations?.filter(Boolean).length ? config.targetLocations : ['全国'];
  const employmentTypes = config.employmentTypes?.filter(Boolean).length ? config.employmentTypes : ['不限'];
  const criteria = platformSearchCriteria(config);

  const queue: PlatformSearchQueueItem[] = [];
  const seen = new Set<string>();

  // 无关键字采集：同 buildSearchQueue —— 只删除关键词字段，其余筛选按用户设置保留。
  if (config.collectWithoutKeyword) {
    for (const location of locations) {
      for (const employmentType of employmentTypes) {
        const url = buildPlatformSearchUrl(platform, {
          city: location, salary: config.salary, page: 1, criteria,
        });
        if (seen.has(url)) continue;
        seen.add(url);
        queue.push({
          platform, url, keyword: '', location, employmentType, criteria,
          directionId: '',
          directionName: RANDOM_COLLECT_LABEL,
          directionPriority: 0,
          directionScore: 0,
        });
      }
    }
    return queue;
  }

  const directions = selectedDirectionItems(directionPlan);
  for (const direction of directions) {
    for (const location of locations) {
      for (const keyword of direction.keywords) {
        for (const employmentType of employmentTypes) {
          const url = buildPlatformSearchUrl(platform, {
            keyword, city: location, salary: config.salary, page: 1, criteria,
          });
          if (seen.has(url)) continue;
          seen.add(url);
          queue.push({
            platform, url, keyword, location, employmentType, criteria,
            directionId: direction.id,
            directionName: direction.name,
            directionPriority: direction.priority,
            directionScore: direction.score,
          });
        }
      }
    }
  }
  return queue;
}
