// BOSS 直聘搜索页 URL 构建器
// 对齐 https://www.zhipin.com/web/geek/jobs 的筛选参数口径（2026-08 联网核对）：
//   city      -> 城市代码（全国=100010000，杭州=101210100 …）
//   query     -> 搜索关键词（岗位名/技能）
//   jobType   -> 职位类型（1901 全职 / 1902 实习 / 1903 兼职）
//   experience-> 经验要求（108 在校生 / 102 应届生 / 103 1年以内 / 104 1-3年 / 105 3-5年 / 106 5-10年 / 107 10年以上）
//   degree    -> 学历要求（202 大专 / 203 本科 / 204 硕士 / 205 博士 …）
//   salary    -> 薪资区间（可选，见 SALARY_CODES）
import type { AppConfig, DirectionPlan } from './types';
import { selectedDirectionItems } from './directions';

// 搜索列表页基地址
export const BASE_JOBS_URL = 'https://www.zhipin.com/web/geek/jobs';

// 城市代码：格式为 101 + 省(2位) + 市(2位) + 00；全国为特殊值 100010000
export const CITY_CODES: Record<string, string> = {
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  天津: '101030100',
  重庆: '101040100',
  哈尔滨: '101050100',
  长春: '101060100',
  沈阳: '101070100',
  呼和浩特: '101080100',
  石家庄: '101090100',
  太原: '101100100',
  西安: '101110100',
  济南: '101120100',
  乌鲁木齐: '101130100',
  拉萨: '101140100',
  西宁: '101150100',
  兰州: '101160100',
  银川: '101170100',
  郑州: '101180100',
  南京: '101190100',
  武汉: '101200100',
  杭州: '101210100',
  合肥: '101220100',
  福州: '101230100',
  厦门: '101230200',
  南昌: '101240100',
  长沙: '101250100',
  贵阳: '101260100',
  成都: '101270100',
  广州: '101280100',
  深圳: '101280600',
  昆明: '101290100',
  南宁: '101300100',
  海口: '101310100',
};

// 职位类型：BOSS 的 jobType 编码
export const JOB_TYPE_CODES: Record<string, string> = {
  全职: '1901',
  实习: '1902',
  兼职: '1903',
};

// 经验要求：BOSS 的 experience 编码（「经验不限 / 不限」= 不附加过滤，返回空）
export const EXPERIENCE_CODES: Record<string, string> = {
  应届生: '102',
  '1年以内': '103',
  '1-3年': '104',
  '3-5年': '105',
  '5-10年': '106',
  '10年以上': '107',
  在校生: '108',
};

// 学历要求：BOSS 的 degree 编码（「不限」= 不附加过滤，返回空）
export const DEGREE_CODES: Record<string, string> = {
  大专: '202',
  本科: '203',
  硕士: '204',
  博士: '205',
  高中: '206',
  '中专/中技': '208',
  初中及以下: '209',
};

// 薪资区间（可选）：BOSS web 端 salary 编码（0 不限；1-8 由低到高）
export const SALARY_CODES: Record<string, string> = {
  不限: '0',
  '3K以下': '1',
  '3-5K': '2',
  '5-10K': '3',
  '10-15K': '4',
  '15-20K': '5',
  '20-30K': '6',
  '30-50K': '7',
  '50K以上': '8',
};

// 无明确求职类型时（不限 / 校招等）不附加 jobType 过滤
function isNoFilter(value: string | undefined | null): boolean {
  const v = String(value || '').trim();
  return !v || v === '不限' || v === '全部' || v === '不限制';
}

// ===== 运行时城市编码解析（合并硬编码表 + BOSS 官方城市表）=====
// 硬编码 CITY_CODES 仅覆盖主要城市，用户设置的小城市会解析失败、导致搜索 URL 丢失 city 参数、
// 被 BOSS 回退到当前定位城市。这里在运行时拉取 BOSS 官方 citysites.json 补全全量城市编码。
const CITY_CACHE_KEY = 'bossclaw-city-codes';
let extraCityCodes: Record<string, string> = {};
let cityCodesPromise: Promise<void> | null = null;

function getResolvedCityMap(): Record<string, string> {
  return { ...CITY_CODES, ...extraCityCodes };
}

// 递归遍历城市树，收集所有 {name, code} / {cityName, cityCode} 对（兼容不同字段命名）
function walkCityTree(node: any, out: Record<string, string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => walkCityTree(n, out));
    return;
  }
  const code = node.code ?? node.cityCode ?? node.citycode;
  const name = node.name ?? node.cityName ?? node.cityname;
  if (typeof code === 'string' && typeof name === 'string' && /^\d{9}$/.test(code)) {
    const cityName = String(name).replace(/市$/, '');
    out[cityName] = code;
    out[String(name)] = code;
  }
  for (const key of Object.keys(node)) {
    if (key === 'code' || key === 'name' || key === 'cityCode' || key === 'cityName') continue;
    const v = (node as any)[key];
    if (v && typeof v === 'object') walkCityTree(v, out);
  }
}

// 拉取并缓存 BOSS 官方城市编码表（CORS 无关：经主进程 jc:fetch-url 转发）。
// 失败时静默回退到硬编码表，不影响离线使用。
export async function loadBossCityCodes(force = false): Promise<void> {
  if (cityCodesPromise && !force) return cityCodesPromise;
  cityCodesPromise = (async () => {
    try {
      const cached = typeof localStorage !== 'undefined' && localStorage.getItem(CITY_CACHE_KEY);
      if (cached) {
        try {
          extraCityCodes = { ...extraCityCodes, ...JSON.parse(cached) };
        } catch { /* 忽略损坏缓存 */ }
      }
    } catch { /* localStorage 不可用时忽略 */ }
    if (Object.keys(extraCityCodes).length && !force) return;
    try {
      const url = 'https://www.zhipin.com/wapi/zpgeek/common/data/citysites.json';
      const resp: any =
        typeof window !== 'undefined' && (window as any).electron?.fetchUrl
          ? await (window as any).electron.fetchUrl(url)
          : null;
      const text = resp && resp.ok ? resp.text : typeof resp === 'string' ? resp : null;
      if (!text) return;
      const data = JSON.parse(text);
      const map: Record<string, string> = {};
      walkCityTree(data, map);
      if (Object.keys(map).length) {
        extraCityCodes = { ...extraCityCodes, ...map };
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(CITY_CACHE_KEY, JSON.stringify(extraCityCodes));
        } catch { /* 忽略写入失败 */ }
      }
    } catch { /* 网络失败时回退硬编码表 */ }
  })();
  return cityCodesPromise;
}

export function resolveCityCode(city?: string): string {
  const c = String(city || '').trim();
  if (!c) return '';
  if (/^\d{9}$/.test(c)) return c; // 已是城市代码
  const combined = getResolvedCityMap();
  const key = c.replace(/市$/, '');
  if (combined[key]) return combined[key];
  // 前缀/包含匹配（如「北京」或「北京市」），并支持「全国/不限」视为全国
  if (/全国|不限|全部/.test(key)) return CITY_CODES['全国'];
  for (const [name, code] of Object.entries(combined)) {
    if (name.startsWith(key) || key.startsWith(name)) return code;
  }
  return '';
}

export function resolveJobTypeCode(jobType?: string): string {
  const t = String(jobType || '').trim();
  if (!t || isNoFilter(t)) return '';
  if (/^\d{4}$/.test(t)) return t; // 已是 jobType 代码
  return JOB_TYPE_CODES[t] || '';
}

export function resolveExperienceCode(experience?: string): string {
  const e = String(experience || '').trim();
  if (!e || isNoFilter(e) || /经验不限/.test(e)) return '';
  if (/^\d{3}$/.test(e)) return e; // 已是 experience 代码
  if (EXPERIENCE_CODES[e]) return EXPERIENCE_CODES[e];
  for (const [name, code] of Object.entries(EXPERIENCE_CODES)) {
    if (e.includes(name) || name.includes(e)) return code;
  }
  return '';
}

export function resolveDegreeCode(degree?: string): string {
  const d = String(degree || '').trim();
  if (!d || isNoFilter(d)) return '';
  if (/^\d{3}$/.test(d)) return d; // 已是 degree 代码
  if (DEGREE_CODES[d]) return DEGREE_CODES[d];
  for (const [name, code] of Object.entries(DEGREE_CODES)) {
    if (d.includes(name) || name.includes(d)) return code;
  }
  return '';
}

export function resolveSalaryCode(salary?: string): string {
  const s = String(salary || '').trim();
  if (!s || isNoFilter(s)) return '';
  if (/^\d{1,2}$/.test(s)) return s; // 已是 salary 代码
  return SALARY_CODES[s] || '';
}

// 支持逗号分隔/数组的多个值（BOSS 的 experience / degree 参数接受逗号分隔多值）
export function resolveExperienceCodes(experience?: string | string[]): string {
  const list = Array.isArray(experience) ? experience : String(experience || '').split(/[，,、]/);
  return [...new Set(list.map((e) => resolveExperienceCode(e)).filter(Boolean))].join(',');
}

export function resolveDegreeCodes(degree?: string | string[]): string {
  const list = Array.isArray(degree) ? degree : String(degree || '').split(/[，,、]/);
  return [...new Set(list.map((d) => resolveDegreeCode(d)).filter(Boolean))].join(',');
}

export interface JobSearchQuery {
  keyword?: string;
  city?: string;
  jobType?: string;
  experience?: string | string[];
  degree?: string | string[];
  salary?: string;
  page?: number;
}

export function buildJobSearchUrl(query: JobSearchQuery = {}): string {
  const params = new URLSearchParams();
  const keyword = String(query.keyword || '').trim();
  if (keyword) params.set('query', keyword);
  const city = resolveCityCode(query.city);
  if (city) params.set('city', city);
  const jobType = resolveJobTypeCode(query.jobType);
  if (jobType) params.set('jobType', jobType);
  const experience = resolveExperienceCodes(query.experience);
  if (experience) params.set('experience', experience);
  const degree = resolveDegreeCodes(query.degree);
  if (degree) params.set('degree', degree);
  const salary = resolveSalaryCode(query.salary);
  if (salary) params.set('salary', salary);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  const qs = params.toString();
  return qs ? `${BASE_JOBS_URL}?${qs}` : BASE_JOBS_URL;
}

export interface SearchQueueItem {
  url: string;
  keyword: string;
  location: string;
  employmentType: string;
  experience: string;
  degree: string;
}

// 由「已确认投递方向 × 城市 × 求职类型」生成去重后的搜索 URL 队列，供工作台搜索采集使用
export function buildSearchQueue(directionPlan: DirectionPlan | null, config: AppConfig): SearchQueueItem[] {
  const directions = selectedDirectionItems(directionPlan);
  const locations = config.targetLocations?.filter(Boolean).length ? config.targetLocations : ['全国'];
  const employmentTypes = config.employmentTypes?.filter(Boolean).length ? config.employmentTypes : ['不限'];
  const experience = config.experiences?.filter(Boolean) ?? [];
  const degree = config.degrees?.filter((d) => d && d !== '不限') ?? [];

  const queue: SearchQueueItem[] = [];
  const seen = new Set<string>();
  // 城市优先遍历：完成当前城市全部关键词后再切下一城（对齐 AI-BossJob 的「多城市轮询」语义）
  for (const direction of directions) {
    for (const location of locations) {
      for (const keyword of direction.keywords) {
        for (const employmentType of employmentTypes) {
          const url = buildJobSearchUrl({ keyword, city: location, jobType: employmentType, experience, degree });
          if (seen.has(url)) continue;
          seen.add(url);
          queue.push({
            url,
            keyword,
            location,
            employmentType,
            experience: experience.join(','),
            degree: degree.join(','),
          });
        }
      }
    }
  }
  return queue;
}
