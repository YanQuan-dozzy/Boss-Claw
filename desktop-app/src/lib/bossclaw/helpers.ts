// 移植自 job-claw-main\source\src\background.js 的本地规则辅助函数
import { uniq } from './defaults';
import { DIRECTION_RULES, type DirectionRule } from './directionCatalog';

export function cleanResumeText(value: string): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function lineMatches(text: string, pattern: RegExp, limit = 6): string[] {
  return uniq(
    cleanResumeText(text)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 4 && line.length <= 180 && pattern.test(line))
  ).slice(0, limit);
}

// 纯小标题行（如「教育经历」「荣誉证书」「自我评价」），不含实质内容，不能当作简历事实引用
export function isHeadingLine(line: string): boolean {
  const s = String(line || '')
    .trim()
    .replace(/[：:\s]/g, '')
    .replace(/^\d{1,2}[.、)）]\s*/, '');
  return /^(教育经历|教育背景|在校经历|在校|学(?:习|生)经历|培训经历|实(?:习)?经历|工作经历|项目经历|项目经验|相关技能|技能特长|专业技能|技能|荣誉证书|荣誉奖项|获奖经历|获奖|证书荣誉|证书|自我评价|个人评价|评价|基本信息|基础信息|个人信息|个人资料|实践经历|校园经历|社会实践|科研成果|学术成果|输出|总结)$/.test(s);
}

export function extractSkills(text: string): string[] {
  const source = cleanResumeText(text);
  const catalog: [string, RegExp][] = [
    ['JavaScript', /\bjavascript\b|(?<!\.)\bjs\b/i],
    ['TypeScript', /\btypescript\b|\bts\b/i],
    ['HTML', /\bhtml5?\b/i],
    ['CSS', /\bcss3?\b|sass|less/i],
    ['Vue', /\bvue(?:\.js|3|2)?\b/i],
    ['React', /\breact(?:\.js)?\b/i],
    ['Next.js', /\bnext\.?js\b/i],
    ['Node.js', /\bnode\.?js\b/i],
    ['Express', /\bexpress\b/i],
    ['Vite', /\bvite\b/i],
    ['Webpack', /\bwebpack\b/i],
    ['Tailwind CSS', /\btailwind\b/i],
    ['ECharts', /\becharts\b/i],
    ['D3.js', /\bd3(?:\.js)?\b/i],
    ['Tauri', /\btauri\b/i],
    ['Electron', /\belectron\b/i],
    ['Chrome Extension', /chrome\s*(?:extension|扩展)|浏览器扩展/i],
    ['Python', /\bpython\b/i],
    ['Java', /\bjava\b/i],
    ['C/C++', /\bc\+\+\b|\bc语言\b/i],
    ['Go', /\bgolang\b|\bgo语言\b/i],
    ['SQL', /\bsql\b/i],
    ['MySQL', /\bmysql\b/i],
    ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
    ['Redis', /\bredis\b/i],
    ['RabbitMQ', /\brabbit\s*mq\b/i],
    ['Spring Boot', /spring\s*boot/i],
    ['MyBatis', /\bmybatis\b/i],
    ['Flask', /\bflask\b/i],
    ['Django', /\bdjango\b/i],
    ['FastAPI', /\bfastapi\b/i],
    ['Git', /\bgit\b|github/i],
    ['Docker', /\bdocker\b/i],
    ['WebSocket', /\bwebsocket\b/i],
    ['MCP', /\bmcp\b/i],
    ['Linux', /\blinux\b/i],
    ['Playwright', /\bplaywright\b/i],
    ['Selenium', /\bselenium\b/i],
    ['PyTorch', /\bpytorch\b/i],
    ['TensorFlow', /\btensorflow\b/i],
    ['OpenCV', /\bopencv\b/i],
    ['RAG', /\brag\b|检索增强生成/i],
    ['LLM', /\bllm\b|大语言模型|语言模型/i],
    ['AI Agent', /\bagent\b|智能体/i],
    ['OCR', /\bocr\b|文字识别/i],
    ['数据可视化', /数据可视化|可视化看板/i],
  ];
  return catalog.filter(([, pattern]) => pattern.test(source)).map(([name]) => name).slice(0, 40);
}

export function extractDegree(text: string): string {
  const source = cleanResumeText(text);
  if (/博士|ph\.?d/i.test(source)) return '博士';
  if (/硕士|研究生|master/i.test(source)) return '硕士';
  if (/本科|学士|bachelor/i.test(source)) return '本科';
  if (/大专|专科|associate/i.test(source)) return '大专';
  return '不限';
}

export function extractLocations(text: string): string[] {
  const source = cleanResumeText(text);
  const cities = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '西安', '南京', '武汉', '苏州',
    '重庆', '天津', '长沙', '郑州', '青岛', '厦门', '合肥', '济南', '宁波', '东莞',
    '珠海', '佛山', '无锡', '兰州', '太原', '南阳', '东京', '大阪',
  ];
  return cities.filter((city) => source.includes(city)).slice(0, 6);
}

export function extractExplicitDirections(text: string): string[] {
  const source = cleanResumeText(text);
  const matches: string[] = [];
  const pattern = /(?:求职意向|求职方向|目标岗位|意向岗位|应聘岗位|期望职位)\s*[:：]?\s*([^\n]{2,100})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) && matches.length < 3) {
    matches.push(
      ...String(match[1] || '')
        .split(/[，,、/|]/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && item.length <= 28)
    );
  }
  return uniq(matches).slice(0, 3);
}

// 判断是否「在校学生/应届/实习」简历：显式关键词，或教育时间区间结束年份在未来（如 2023.9-2027.6）
export function isStudentResume(text: string): boolean {
  const source = cleanResumeText(text);
  if (/实习|在校|应届|校招|在读|应届生/i.test(source)) return true;
  const currentYear = new Date().getFullYear();
  const years = [...source.matchAll(/20\d{2}/g)].map((item) => Number(item[0]));
  if (years.some((year) => year > currentYear)) return true;
  const graduation = source.match(/(20\d{2})\s*(?:届|年\s*毕业|年\s*应届|年\s*6月)/);
  if (graduation && Number(graduation[1]) >= currentYear) return true;
  return false;
}

// 按方向名反查目录规则（用于补齐搜索词/证据/短板）
export function findDirectionRule(name: string): DirectionRule | undefined {
  const key = normalizeDirectionKey(name);
  const exact = DIRECTION_RULES.find((rule) => normalizeDirectionKey(rule.name) === key || normalizeDirectionKey(rule.internName) === key);
  if (exact) return exact;
  return DIRECTION_RULES.find((rule) => {
    const ruleKey = normalizeDirectionKey(rule.name);
    return ruleKey.includes(key) || key.includes(ruleKey);
  });
}

function matchCount(source: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matched = source.match(global);
  return matched ? matched.length : 0;
}

export function inferDirections(text: string, skills: string[]): string[] {
  const source = cleanResumeText(text);
  const student = isStudentResume(source);
  const explicit = extractExplicitDirections(source);
  if (explicit.length) {
    // 在校生/应届生优先实习：显式求职意向也映射为实习岗位名（如"全栈开发工程师"→"全栈开发实习生"）
    return explicit.map((name) => {
      if (!student) return name;
      const rule = findDirectionRule(name);
      return rule ? rule.internName : name;
    });
  }
  const has = (name: string) => skills.includes(name);
  const count = (...names: string[]) => names.filter(has).length;

  // 技术方向信号（按技能族聚合，避免「命中任一前端技能就判前端」）
  const FRONTEND_SKILLS = ['JavaScript', 'TypeScript', 'Vue', 'React', 'HTML', 'CSS', 'Next.js', 'Vite', 'Webpack', 'Tailwind CSS'];
  const BACKEND_FRAMEWORKS = ['Spring Boot', 'MyBatis', 'Express', 'Flask', 'Django', 'FastAPI', 'Redis', 'RabbitMQ', 'MySQL', 'PostgreSQL', 'Node.js', 'WebSocket'];
  const BACKEND_LANGUAGES = ['Java', 'Go', 'C/C++', 'Python'];
  const AI_SKILLS = ['RAG', 'LLM', 'AI Agent', 'MCP'];

  const frontendHits = count(...FRONTEND_SKILLS);
  const backendFrameworkHits = count(...BACKEND_FRAMEWORKS);
  const backendLanguageHits = count(...BACKEND_LANGUAGES);
  const aiHits = count(...AI_SKILLS);

  const explicitFrontend = /前端|web前端|网页开发/i.test(source);
  const explicitBackend = /后端|服务端/i.test(source);
  const explicitAI = /ai\s*应用|人工智能应用|智能体|rag|大模型|mcp/i.test(source);

  // 全栈：明确自述全栈，或前端 + 后端信号都较强
  const fullstack = /全栈|full.?stack|前后端/i.test(source) || (frontendHits >= 2 && (backendFrameworkHits >= 1 || backendLanguageHits >= 2));
  // 后端：明确提及后端，或有具体后端框架（或 ≥2 门后端语言）
  const backend = explicitBackend || backendFrameworkHits >= 1 || backendLanguageHits >= 2;
  // AI 应用：需较强 AI 信号（≥2 个应用层 AI 技能，或明确 AI 方向关键词），避免仅「提过一句 LLM」就生成 AI 方向
  const ai = aiHits >= 2 || explicitAI;
  // 前端：仅当前端有信号、且无后端/全栈信号时才作为独立方向
  const frontendOnly = (frontendHits >= 1 || explicitFrontend) && !backend && !fullstack;

  const scored: { name: string; score: number }[] = [];
  const techName = (key: 'fullstack' | 'ai' | 'backend' | 'frontend' | 'data-viz') => {
    const rule = DIRECTION_RULES.find((item) => item.key === key)!;
    return student ? rule.internName : rule.name;
  };
  if (fullstack) scored.push({ name: techName('fullstack'), score: 100 });
  if (ai) scored.push({ name: techName('ai'), score: 90 });
  if (backend) scored.push({ name: techName('backend'), score: 80 });
  if (frontendOnly) scored.push({ name: techName('frontend'), score: 70 });
  if (/数据可视化|echarts|d3|大屏/i.test(source) || has('数据可视化') || has('ECharts') || has('D3.js')) {
    scored.push({ name: techName('data-viz'), score: 55 });
  }

  // 通用/其他行业方向：只按目录关键词命中打分（相关技能仅用于证据展示，不参与打分，避免共享技能误触发）
  for (const rule of DIRECTION_RULES) {
    if (rule.tech) continue;
    const hits = matchCount(source, rule.test);
    if (hits <= 0) continue;
    scored.push({ name: student ? rule.internName : rule.name, score: 30 + Math.min(hits, 6) * 8 });
  }

  // 按分数降序，去重后取前 3
  const ordered: string[] = [];
  const seen = new Set<string>();
  scored.sort((left, right) => right.score - left.score);
  for (const item of scored) {
    const key = normalizeDirectionKey(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(item.name);
  }
  // 去掉被更具体方向覆盖的泛化方向（如「运营专员」被「电商运营专员」覆盖）
  const filtered: string[] = [];
  for (const name of ordered) {
    const key = normalizeDirectionKey(name);
    if (filtered.some((kept) => normalizeDirectionKey(kept).includes(key))) continue;
    filtered.push(name);
  }
  if (!filtered.length) filtered.push(student ? '软件开发实习生' : '软件开发工程师');
  return filtered.slice(0, 3);
}

export function buildSearchKeywords(directions: string[], skills: string[]): string[] {
  const keywords = [...directions];
  for (const name of directions) {
    const rule = findDirectionRule(name);
    if (rule) keywords.push(...rule.keywords);
  }
  // 技术方向补充技能搜索词（如 React 开发 / Vue 开发）
  const joined = directions.join(' ');
  if (/前端|全栈|后端|开发|工程师/.test(joined)) {
    for (const skill of skills.slice(0, 6)) {
      if (/^[A-Za-z+#.]/.test(skill)) keywords.push(`${skill} 开发`);
    }
  }
  return uniq(keywords).slice(0, 12);
}

export function normalizeStringList(value: unknown, limit = 30): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(/[，,\n]/);
  return uniq(
    values
      .map((item) => (typeof item === 'string' ? item.trim() : String((item as any)?.name || (item as any)?.title || '').trim()))
      .filter(Boolean)
  ).slice(0, limit);
}

export function clampNumber(value: unknown, min: number, max: number, fallback = min): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeDirectionKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/实习生|工程师|开发|岗位|职位|校招|社招|应届/g, '')
    .replace(/[\s,，/\\|·•()（）【】\[\]_-]+/g, '')
    .trim();
}

/** 类型守卫：判断对象是否为标准 Error */
export function isNativeError(e: unknown): e is Error {
  return e instanceof Error || (typeof e === 'object' && e !== null && 'message' in e && typeof (e as Record<string, unknown>).message === 'string');
}

/** 从 unknown 异常推导安全的可读错误文本，解决 catch (e: any) 隐患 */
export function getErrorMessage(error: unknown, fallback = '发生未知错误'): string {
  if (isNativeError(error)) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object' && error !== null) {
    const str = String((error as Record<string, unknown>).error || (error as Record<string, unknown>).message || '').trim();
    if (str) return str;
  }
  return fallback;
}

