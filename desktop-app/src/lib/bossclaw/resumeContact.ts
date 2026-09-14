// 定制简历结构化组织：从简历原文提取联系信息 + 把「AI 定制七模块文档」组装为可排版的模块列表
//
// 对齐 ai-job-search 的 /setup + /apply 方法论：
//   - /setup：把简历整理为结构化 profile（联系信息 / 摘要 / 技能 / 经历 / 项目 / 教育 / 证书）；
//   - /apply：针对岗位 JD 产出定制内容（定制摘要 / 相关经历亮点 / 匹配技能），只引用真实事实；
// 本模块输出 ResumeDocData，供 resumePdf.buildResumeHtml 渲染为 A4 PDF（也可扩展其他输出格式）。
//
// 模块口径（2026-09-14 定）：
//   - 固定顺序：教育经历 → 实习经历 → 工作经历 → 项目经历 → 专业技能 → 个人荣誉 → 自我评价；
//   - **空模块整块不输出**（连标题一起省略），不渲染任何占位文字；
//   - 专业技能为「类别：技能 A、技能 B」分组行，一组一行；
//   - 实习/工作经历的标题按内容存在与否各自决定（只有一类时该模块自然只出现一次）。
//
// 安全不变量（对齐 AGENTS.md 2.1）：
//   - 联系信息提取结果只是「初值」，导出前必须在 UI 中经用户人工确认（人工确认模式）；
//   - 所有模块内容只来自简历原文 / 职业画像 / 经历补充材料 / 已通过事实与口吻校验的定制结果，禁止编造。
import type { Profile } from './types';
import type { TailorResult, TailorResumeDoc } from './jobAssistant';
import { buildLocalTailorDoc } from './jobAssistant';

// ===== 输出数据结构（与具体输出格式解耦：PDF / 其他格式共用） =====
/** 内容块（教育/实习/工作/项目共用）：首行标题 + 元信息行 + 要点 */
export interface ResumeDocBlock {
  heading: string;
  meta: string;
  bullets: string[];
}

export interface ResumeDocModule {
  /** 模块标识 */
  id: string;
  /** 模块标题（如 教育经历 / 实习经历 / 专业技能 …） */
  title: string;
  /** 渲染方式：blocks 结构化块 / lines 一行一条（专业技能分组行、个人荣誉）/ paragraph 段落（自我评价） */
  kind: 'blocks' | 'lines' | 'paragraph';
  blocks?: ResumeDocBlock[];
  lines?: string[];
}

export interface ResumeDocContact {
  name: string;
  phone: string;
  email: string;
  /** 求职意向岗位（如 前端开发工程师） */
  targetTitle: string;
}

export interface ResumeDocData {
  contact: ResumeDocContact;
  modules: ResumeDocModule[];
  /** 个人照片 data URL（base64，JPEG/PNG）；可选，未上传时**不渲染照片框** */
  photo?: string;
}

// ===== 联系信息提取（确定性本地规则，导出前须人工确认） =====
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const INTENT_RE = /(?:求职意向|意向岗位|应聘岗位|目标岗位|期望岗位|求职方向)\s*[:：]?\s*([^\n，。；;、|【】（）()]{2,24})/;

/** 从简历文本提取姓名（宽松启发式，结果须人工确认） */
function extractName(text: string): string {
  // 1) 显式标签：姓名：张三
  const labeled = text.match(/姓\s*名\s*[:：]\s*([\u4e00-\u9fa5·]{2,4})/);
  if (labeled) return labeled[1];
  // 2) 首行：纯 2-4 个汉字（常见简历第一行就是姓名）
  const firstLine = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine && /^[\u4e00-\u9fa5·]{2,4}$/.test(firstLine)) return firstLine;
  // 3) 首行形如「张三的简历」
  const withSuffix = text.match(/([\u4e00-\u9fa5·]{2,4})(?:的)?简历(?:\.docx?)?/);
  if (withSuffix) return withSuffix[1];
  return '';
}

export interface ExtractedContact {
  name: string;
  phone: string;
  email: string;
  targetTitle: string;
  /** 提取到的城市（期望城市/现居），无则空 */
  city: string;
}

/** 从简历原文提取联系信息（纯本地规则；导出前须在 UI 人工确认） */
export function extractContactInfo(resumeText: string, fallbackTargetTitle = ''): ExtractedContact {
  const text = String(resumeText || '');
  const phoneMatch = text.match(PHONE_RE);
  const emailMatch = text.match(EMAIL_RE);
  const intentMatch = text.match(INTENT_RE);
  const cityMatch = text.match(/(?:现居|期望城市|期望地点|目标城市|所在城市)\s*[:：]?\s*([\u4e00-\u9fa5·]{2,8})/);
  return {
    name: extractName(text),
    phone: phoneMatch ? phoneMatch[0] : '',
    email: emailMatch ? emailMatch[0] : '',
    targetTitle: intentMatch ? intentMatch[1].trim() : String(fallbackTargetTitle || '').trim(),
    city: cityMatch ? cityMatch[1].trim() : '',
  };
}

/** 从职业画像 hardConstraints 补充意向岗位（无显式意向时） */
export function targetTitleFromProfile(profile: Profile | null, fallback = ''): string {
  if (fallback) return fallback;
  if (!profile) return '';
  const dir = profile.primaryDirections?.[0]?.name;
  return String(dir || '').replace(/^（|）$/g, '').trim();
}

// ===== 七模块定义（固定顺序；空模块不输出） =====
export interface ResumeSectionMeta {
  id: string;
  title: string;
  kind: ResumeDocModule['kind'];
  /** 默认勾选 */
  default: boolean;
  /** 提示文案（UI 展示） */
  hint: string;
}

export const RESUME_SECTION_META: ResumeSectionMeta[] = [
  { id: 'education', title: '教育经历', kind: 'blocks', default: true, hint: '学校 + 专业 | 学历 + 时间（原文事实）' },
  { id: 'internships', title: '实习经历', kind: 'blocks', default: true, hint: '实习经历要点，按岗位相关性重排' },
  { id: 'works', title: '工作经历', kind: 'blocks', default: true, hint: '正式工作经历要点（无则不输出该模块）' },
  { id: 'projects', title: '项目经历', kind: 'blocks', default: true, hint: '项目名称 / 技术栈 / 量化要点' },
  { id: 'skills', title: '专业技能', kind: 'lines', default: true, hint: '按 AI 依 JD 归类的分组技能，一组一行' },
  { id: 'honors', title: '个人荣誉', kind: 'lines', default: true, hint: '获奖与证书（原文事实）' },
  { id: 'selfEval', title: '自我评价', kind: 'paragraph', default: true, hint: '自我评价段落' },
];

/** 模块 id → 中文标题（顺序即最终渲染顺序） */
const MODULE_TITLES: Record<string, string> = {
  education: '教育经历',
  internships: '实习经历',
  works: '工作经历',
  projects: '项目经历',
  skills: '专业技能',
  honors: '个人荣誉',
  selfEval: '自我评价',
};

const clean = (s: unknown): string => String(s ?? '').trim();

/** 把文档块转成渲染块，丢掉空块 */
function toBlocks(blocks: TailorResumeDoc[keyof TailorResumeDoc]): ResumeDocBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: ResumeDocBlock[] = [];
  for (const b of blocks as any[]) {
    const heading = clean(b?.heading);
    const meta = clean(b?.meta);
    const bullets = (Array.isArray(b?.bullets) ? b.bullets : [])
      .map((x: any) => clean(typeof x === 'string' ? x : x?.text))
      .filter(Boolean);
    if (!heading && !meta && !bullets.length) continue;
    out.push({ heading, meta, bullets });
  }
  return out;
}

// ===== 组装 =====
/**
 * 从定制结果组装分节数据；contact 用用户确认后的值（未提供则用提取初值）。
 * tailor 为空时用职业画像本地兜底文档（保证未定制时也能导出）。
 * selectedIds 为「用户勾选 + 用户排序后」的模块 id 列表：**既决定输出哪些模块，也决定输出顺序**；
 * 未传则按 RESUME_SECTION_META 的默认顺序输出全部（空模块仍会被省略）。
 */
export function buildResumeDocData(
  resumeText: string,
  profile: Profile | null,
  tailor: TailorResult | null,
  contactOverride?: Partial<ResumeDocContact>,
  selectedIds?: string[]
): ResumeDocData {
  const extracted = extractContactInfo(resumeText, targetTitleFromProfile(profile));
  const contact: ResumeDocContact = {
    name: clean(contactOverride?.name ?? extracted.name),
    phone: clean(contactOverride?.phone ?? extracted.phone),
    email: clean(contactOverride?.email ?? extracted.email),
    targetTitle: clean(contactOverride?.targetTitle ?? extracted.targetTitle),
  };

  const doc: TailorResumeDoc = tailor?.doc ?? buildLocalTailorDoc(profile);

  /** 按模块 id 生成模块；没有内容的模块返回 null（空模块整块不输出） */
  const buildModule = (id: string): ResumeDocModule | null => {
    if (id === 'education' || id === 'internships' || id === 'works' || id === 'projects') {
      const blocks = toBlocks(doc[id]);
      return blocks.length ? { id, title: MODULE_TITLES[id], kind: 'blocks', blocks } : null;
    }
    if (id === 'skills') {
      const lines = (doc.skills || []).map((s) => clean(s?.text)).filter(Boolean);
      return lines.length ? { id, title: MODULE_TITLES.skills, kind: 'lines', lines } : null;
    }
    if (id === 'honors') {
      const lines = (doc.honors || []).map(clean).filter(Boolean);
      return lines.length ? { id, title: MODULE_TITLES.honors, kind: 'lines', lines } : null;
    }
    if (id === 'selfEval') {
      const text = clean(doc.selfEval?.text);
      return text ? { id, title: MODULE_TITLES.selfEval, kind: 'paragraph', lines: [text] } : null;
    }
    return null;
  };

  // 输出顺序 = 用户给定顺序（勾选且排序后）；未给定则用默认顺序
  const order = selectedIds && selectedIds.length ? selectedIds : RESUME_SECTION_META.map((m) => m.id);
  const modules: ResumeDocModule[] = [];
  for (const id of order) {
    const mod = buildModule(id);
    if (mod) modules.push(mod);
  }

  return { contact, modules };
}

/** 是否有至少一个可导出的模块 */
export function hasExportableSections(profile: Profile | null, tailor: TailorResult | null): boolean {
  return buildResumeDocData('', profile, tailor).modules.length > 0;
}
