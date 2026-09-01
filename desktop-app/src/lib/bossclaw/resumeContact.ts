// 定制简历结构化组织：从简历原文提取联系信息 + 把「简历/画像/定制结果」组装为分节内容
//
// 对齐 ai-job-search 的 /setup + /apply 方法论：
//   - /setup：把简历整理为结构化 profile（联系信息 / 摘要 / 技能 / 经历 / 项目 / 教育 / 证书）；
//   - /apply：针对岗位 JD 产出定制内容（定制摘要 / 相关经历亮点 / 匹配技能），只引用真实事实；
// 本模块输出 ResumeDocData，供 resumePdf.buildResumeHtml 渲染为 A4 PDF（也可扩展其他输出格式）。
//
// 安全不变量（对齐 AGENTS.md 2.1）：
//   - 联系信息提取结果只是「初值」，导出前必须在 UI 中经用户人工确认（人工确认模式）；
//   - 所有分节内容只来自简历原文 / 职业画像 / 已通过事实与口吻校验的定制结果，禁止编造。

import type { Profile } from './types';
import { uniq } from './defaults';
import type { TailorResult } from './jobAssistant';

// ===== 输出数据结构（与具体输出格式解耦：PDF / 其他格式共用） =====
export interface ResumeDocSection {
  /** 小节标识（summary / skills / highlights / experience / projects / education / certificates） */
  id: string;
  /** 小节标题（如 个人摘要 / 核心技能 / 岗位相关经历亮点 …） */
  title: string;
  /** 小节内容 */
  items: string[];
  /** 渲染方式：summary 段落 / skills 标签化 / bullets 列表 */
  kind: 'paragraph' | 'skills' | 'bullets';
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
  sections: ResumeDocSection[];
  /** 个人照片 data URL（base64，JPEG/PNG）；可选，未上传时模板渲染占位框 */
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

// ===== 分节清单 =====
export interface ResumeSectionMeta {
  id: string;
  title: string;
  kind: ResumeDocSection['kind'];
  /** 默认勾选 */
  default: boolean;
  /** 提示文案（UI 展示） */
  hint: string;
}

export const RESUME_SECTION_META: ResumeSectionMeta[] = [
  { id: 'summary', title: '个人摘要', kind: 'paragraph', default: true, hint: '岗位定制摘要（AI 已校验，只引用简历事实）' },
  { id: 'skills', title: '核心技能', kind: 'skills', default: true, hint: '岗位要求且简历具备的技能优先排列' },
  { id: 'highlights', title: '岗位相关经历亮点', kind: 'bullets', default: true, hint: '按岗位相关性重排的量化改写要点（数字仅来自简历）' },
  { id: 'experience', title: '工作/实习经历', kind: 'bullets', default: true, hint: '简历原文经历要点（未做改动）' },
  { id: 'projects', title: '项目经历', kind: 'bullets', default: true, hint: '简历原文项目要点（未做改动）' },
  { id: 'education', title: '教育背景', kind: 'bullets', default: true, hint: '简历原文教育信息' },
  { id: 'certificates', title: '证书/荣誉', kind: 'bullets', default: false, hint: '简历原文证书信息（可选）' },
];

// ===== 组装 =====
/** 从简历/画像/定制结果组装分节数据；contact 用用户确认后的值（未提供则用提取初值） */
export function buildResumeDocData(
  resumeText: string,
  profile: Profile | null,
  tailor: TailorResult | null,
  contactOverride?: Partial<ResumeDocContact>,
  selectedIds?: string[]
): ResumeDocData {
  const extracted = extractContactInfo(resumeText, targetTitleFromProfile(profile));
  const contact: ResumeDocContact = {
    name: String(contactOverride?.name ?? extracted.name ?? '').trim(),
    phone: String(contactOverride?.phone ?? extracted.phone ?? '').trim(),
    email: String(contactOverride?.email ?? extracted.email ?? '').trim(),
    targetTitle: String(contactOverride?.targetTitle ?? extracted.targetTitle ?? '').trim(),
  };

  const enabled = (id: string): boolean => !selectedIds || selectedIds.includes(id);
  const sections: ResumeDocSection[] = [];

  if (enabled('summary')) {
    const summary = String(tailor?.tailoredSummary ?? profile?.summary ?? '').trim();
    if (summary) sections.push({ id: 'summary', title: '个人摘要', items: [summary], kind: 'paragraph' });
  }

  if (enabled('skills')) {
    // 定制高亮技能优先，再补画像技能，去重；确保岗位要求且简历具备的技能排在前面
    const skills = uniq([...(tailor?.highlightedSkills ?? []), ...(profile?.facts?.skills ?? [])]).slice(0, 30);
    if (skills.length) sections.push({ id: 'skills', title: '核心技能', items: skills, kind: 'skills' });
  }

  if (enabled('highlights')) {
    const items = (tailor?.tailoredExperiences ?? []).filter(Boolean);
    if (items.length) sections.push({ id: 'highlights', title: '岗位相关经历亮点', items, kind: 'bullets' });
  }

  if (enabled('experience')) {
    const items = (profile?.facts?.experiences ?? []).filter(Boolean);
    if (items.length) sections.push({ id: 'experience', title: '工作/实习经历', items, kind: 'bullets' });
  }

  if (enabled('projects')) {
    const items = (profile?.facts?.projects ?? []).filter(Boolean);
    if (items.length) sections.push({ id: 'projects', title: '项目经历', items, kind: 'bullets' });
  }

  if (enabled('education')) {
    const items = (profile?.facts?.education ?? []).filter(Boolean);
    if (items.length) sections.push({ id: 'education', title: '教育背景', items, kind: 'bullets' });
  }

  if (enabled('certificates')) {
    const items = (profile?.facts?.certificates ?? []).filter(Boolean);
    if (items.length) sections.push({ id: 'certificates', title: '证书/荣誉', items, kind: 'bullets' });
  }

  return { contact, sections };
}

/** 是否有至少一个可导出的分节 */
export function hasExportableSections(profile: Profile | null, tailor: TailorResult | null): boolean {
  const data = buildResumeDocData('', profile, tailor);
  return data.sections.length > 0;
}
