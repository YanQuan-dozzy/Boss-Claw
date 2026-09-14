// 定制简历 PDF 渲染（HTML → Electron printToPDF，零额外依赖，多模板 + 可选照片）
// 模板参考 GitHub 优秀项目 mmmlllnnn/ResumeCollection（全网简历模板合集，
// 200+ 中文简历样式）：按其中最具代表性的风格落地为 5 套：
//   - classic 蓝白经典   （蓝白商务双线，照片右上角，通用岗）
//   - column  左右分栏   （左 38% 浅蓝信息栏 + 右内容区，照片在左栏）
//   - dark    深色侧栏   （左 30% 深色栏 + 圆形照片，资深/展示型）
//   - simple  极简单栏   （黑白灰大留白，照片左上角，金融/管理岗）
//   - fresh   清新绿     （绿色调，照片右上角，成长型/设计向）
//
// 版式口径（2026-09-14 定）：
//   - 模块固定顺序：教育经历 → 实习经历 → 工作经历 → 项目经历 → 专业技能 → 个人荣誉 → 自我评价；
//     顺序由 resumeContact.buildResumeDocData 决定，本文件只按 data.modules 顺序渲染；
//   - **空模块由上游过滤**，这里永远不会出现「（暂无）」之类的占位文字；
//   - **分栏模板的侧栏只放「照片 + 姓名 + 联系方式」**，七个模块统一走主栏，
//     保证固定顺序不被模板破坏；
//   - **未上传照片时不渲染任何照片框**（不出现虚线框，也不出现「照片」二字）。
//
// 实现口径：
//   - 输出纯 HTML 字符串（内联 CSS），由主进程 jc:save-pdf 加载到隐藏窗口
//     webContents.printToPDF 输出 A4 PDF（文本层可被 ATS 检索）；
//   - 打印边距由 CSS @page 控制（主进程 printToPDF 传 margins:'none'）；
//   - 中文字体微软雅黑，无需嵌入字体；照片为 data URL 内联，无外部资源；
//   - 所有文本经 HTML 转义；关键字段禁用 letter-spacing（Chromium 打印会
//     把字距实现为字符间空格，破坏 ATS 连续检索）。

import type { ResumeDocData, ResumeDocModule } from './resumeContact';

function htmlEscape(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== 模板元数据（UI 选择器展示用） =====
export interface ResumeTemplateMeta {
  id: string;
  name: string;
  desc: string;
  /** 主题色（UI 色块预览） */
  color: string;
  /** 是否为侧栏/分栏布局 */
  split?: boolean;
}

export const RESUME_TEMPLATES: ResumeTemplateMeta[] = [
  { id: 'classic', name: '蓝白经典', desc: '蓝白商务风，通用/技术岗首选', color: '#2b5a9e' },
  { id: 'column', name: '左右分栏', desc: '左浅蓝信息栏 + 右内容区，应届/通用', color: '#5b8fc9', split: true },
  { id: 'dark', name: '深色侧栏', desc: '深色侧栏 + 圆形照片，资深/展示型', color: '#263445', split: true },
  { id: 'simple', name: '极简单栏', desc: '黑白灰大留白，金融/管理/保守行业', color: '#3a3f45' },
  { id: 'fresh', name: '清新绿', desc: '绿色调清爽，成长型/设计向', color: '#1f7a5c' },
];

export function isKnownTemplate(id: string): boolean {
  return RESUME_TEMPLATES.some((t) => t.id === id);
}

// ===== 公共样式（CSS 变量 + 基础排版，模板通过变量/覆盖差异化） =====
const BASE_CSS = `
@page { size: A4; margin: 13mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Source Han Sans SC", sans-serif;
  color: var(--text, #333); font-size: 10.5pt; line-height: 1.6;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.resume { max-width: 100%; }
/* ===== 照片（仅在上传后渲染；未上传不出现任何照片框/占位） ===== */
.photo-box { flex-shrink: 0; overflow: hidden; }
.photo-box img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* ===== 头部 ===== */
.resume-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 2px solid var(--accent, #2b5a9e); }
.resume-header-main { flex: 1; min-width: 0; }
.resume-name { margin: 0 0 6px; font-size: 21pt; font-weight: 700; color: var(--heading, #1f3a63); }
/* 注意：不使用 letter-spacing——Chromium 打印会把字距实现为字符间空格，破坏 ATS 检索。 */
.resume-contact { font-size: 9.5pt; color: var(--text-2, #555); }
.resume-contact .sep { margin: 0 7px; color: var(--line, #b0b8c4); }
.resume-contact .label { color: var(--text-3, #8a94a6); margin-right: 2px; }
/* ===== 分节 ===== */
.resume-section { margin-bottom: 12px; }
.resume-section-title {
  margin: 0 0 7px; padding: 2px 0 2px 9px; font-size: 12pt; font-weight: 700; color: var(--heading, #1f3a63);
  border-left: 4px solid var(--accent, #2b5a9e); line-height: 1.4;
}
.resume-section-body { padding-left: 13px; }
.resume-section-body p { margin: 3px 0; }
/* ===== 结构化块（教育/实习/工作/项目） ===== */
.exp-block { margin-bottom: 9px; }
.exp-block:last-child { margin-bottom: 0; }
.exp-heading { margin: 0; font-size: 10.8pt; font-weight: 700; color: var(--heading, #1f3a63); }
.exp-heading .exp-time { font-weight: 400; color: var(--text-2, #555); }
.exp-meta { margin: 1px 0 2px; font-size: 9.5pt; color: var(--text-2, #555); }
/* ===== 行式内容（专业技能分组行 / 个人荣誉） ===== */
.resume-line { margin: 2px 0; }
.resume-line .line-label { font-weight: 700; color: var(--heading, #1f3a63); }
/* ===== 段落（自我评价） ===== */
.para-block p, .summary { text-align: justify; }
/* ===== 要点列表 ===== */
ul.bullets { margin: 3px 0 2px; padding-left: 16px; }
ul.bullets li { margin-bottom: 3px; text-align: justify; }
ul.bullets li::marker { color: var(--accent, #2b5a9e); }
/* 打印控制：避免小节标题与内容分页分离 */
.resume-section { break-inside: avoid-page; }
`;

// ===== 各模板样式（CSS 变量覆盖 + 布局差异） =====
const TEMPLATE_CSS: Record<string, string> = {
  // 蓝白经典：证件照 3:4 圆角，右上角
  classic: `
.tpl-classic .photo-box { width: 25mm; height: 33mm; border: 1px solid #d5e0ee; border-radius: 3px; }
.tpl-classic .resume-header::after { content: ""; display: block; border-bottom: 1px solid var(--line, #d5e2f2); position: absolute; left: 0; right: 0; bottom: -4px; }
.tpl-classic .resume-header { position: relative; }
`,

  // 左右分栏：左 38% 浅蓝信息栏（照片 + 姓名 + 联系方式），右内容区放七个模块
  column: `
@page { size: A4; margin: 0; }
.tpl-column { --text:#2a3a4d; --text-2:#4c6074; --text-3:#7890a6; --heading:#1d3c5e; --accent:#2b5a9e; --line:#d9e4f0; }
.tpl-column .resume { display: flex; min-height: 297mm; }
.tpl-column .left { width: 34%; background: #eef3f9; padding: 16mm 8mm; font-size: 9.5pt; }
.tpl-column .left .photo-box { width: 30mm; height: 40mm; margin: 0 auto 10mm; border: 1px solid #c9d6e4; }
.tpl-column .left .col-name { font-size: 19pt; font-weight: 700; color: #1d3c5e; text-align: center; margin: 0 0 4px; }
.tpl-column .left .col-title { font-size: 10pt; color: #4c6074; text-align: center; margin: 0 0 12px; }
.tpl-column .left .col-contact { font-size: 9pt; color: #40536a; line-height: 1.9; }
.tpl-column .left .col-contact div { word-break: break-all; }
.tpl-column .right { flex: 1; padding: 16mm 11mm; }
`,

  // 深色侧栏：左 30% 深灰蓝 + 圆形照片居中
  dark: `
@page { size: A4; margin: 0; }
.tpl-dark { --text:#2a2a2a; --text-2:#555; --heading:#1d2733; }
.tpl-dark .resume { display: flex; min-height: 297mm; }
.tpl-dark .left {
  width: 30%; background: #263445; color: #e8eef5; padding: 18mm 7mm;
  font-size: 9pt; line-height: 1.7;
}
.tpl-dark .left .photo-box { width: 28mm; height: 28mm; margin: 0 auto 12mm; border-radius: 50%; border: 2.5px solid #5b8fc9; }
.tpl-dark .left .col-name { font-size: 19pt; font-weight: 700; color: #fff; text-align: center; margin: 0 0 4px; }
.tpl-dark .left .col-title { font-size: 10pt; color: #a8c3e8; text-align: center; margin: 0 0 14px; }
.tpl-dark .left .col-contact { font-size: 8.5pt; color: #c9d6e5; }
.tpl-dark .left .col-contact div { margin-bottom: 5px; word-break: break-all; }
.tpl-dark .right { flex: 1; padding: 16mm 12mm 16mm 10mm; }
.tpl-dark .right { --heading:#1d2733; }
`,

  // 极简单栏：黑白灰、照片左上角
  simple: `
.tpl-simple { --text:#2a2a2a; --text-2:#666; --text-3:#999; --heading:#111; --line:#e2e2e2; }
.tpl-simple .resume-header { border-bottom: 1px solid #d5d5d5; }
.tpl-simple .resume-name { font-size: 20pt; font-weight: 600; color: #111; margin-bottom: 4px; }
.tpl-simple .photo-box { width: 24mm; height: 32mm; border: 1px solid #ddd; }
.tpl-simple .resume-section-title { border-left: none; padding-left: 0; border-bottom: 1px solid #e2e2e2; padding-bottom: 4px; font-size: 11pt; color: #333; }
.tpl-simple .resume-section-body { padding-left: 0; }
.tpl-simple ul.bullets li::marker { color: #999; }
`,

  // 清新绿：绿色调、照片右上角圆角
  fresh: `
.tpl-fresh { --accent:#1f7a5c; --heading:#144d3a; --line:#cfe3d9; --text-2:#4c6b5f; --text-3:#7d9489; }
.tpl-fresh .resume-header { border-bottom: 2px solid #1f7a5c; }
.tpl-fresh .photo-box { width: 25mm; height: 33mm; border: 1px solid #cfe3d9; border-radius: 12px; }
.tpl-fresh .resume-name { color: #144d3a; }
.tpl-fresh .resume-section-title { border-left-color: #1f7a5c; }
.tpl-fresh ul.bullets li::marker { color: #1f7a5c; }
`,
};

// ===== 照片框渲染（未上传照片时不渲染任何内容） =====
function renderPhotoBox(photo: string | undefined): string {
  if (!photo) return '';
  return `<div class="photo-box"><img src="${htmlEscape(photo)}" alt=""/></div>`;
}

// ===== 渲染函数 =====
function renderContactLine(contact: ResumeDocData['contact']): string {
  const bits: string[] = [];
  if (contact.targetTitle.trim()) bits.push(`<span><span class="label">求职意向</span>${htmlEscape(contact.targetTitle.trim())}</span>`);
  if (contact.phone.trim()) bits.push(`<span><span class="label">电话</span>${htmlEscape(contact.phone.trim())}</span>`);
  if (contact.email.trim()) bits.push(`<span><span class="label">邮箱</span>${htmlEscape(contact.email.trim())}</span>`);
  if (!bits.length) return '';
  return `<div class="resume-contact">${bits.join('<span class="sep">|</span>')}</div>`;
}

/** 专业技能分组行：「后端：Java、Spring Boot」→ 类别名加粗，技能列表常规 */
function renderSkillLine(line: string): string {
  const idx = line.search(/[:：]/);
  if (idx > 0 && idx <= 12) {
    const label = line.slice(0, idx);
    const rest = line.slice(idx + 1).replace(/^[\s，,、]+/, '');
    return `<p class="resume-line"><span class="line-label">${htmlEscape(label)}：</span>${htmlEscape(rest)}</p>`;
  }
  return `<p class="resume-line">${htmlEscape(line)}</p>`;
}

function renderModuleBody(mod: ResumeDocModule): string {
  if (mod.kind === 'blocks') {
    return (mod.blocks || [])
      .map((b) => {
        const heading = b.heading ? `<p class="exp-heading">${htmlEscape(b.heading)}</p>` : '';
        const meta = b.meta ? `<p class="exp-meta">${htmlEscape(b.meta)}</p>` : '';
        const bullets = b.bullets.length
          ? `<ul class="bullets">${b.bullets.map((s) => `<li>${htmlEscape(s)}</li>`).join('')}</ul>`
          : '';
        return `<div class="exp-block">${heading}${meta}${bullets}</div>`;
      })
      .join('');
  }
  const lines = (mod.lines || []).filter(Boolean);
  if (mod.kind === 'paragraph') {
    return `<div class="para-block">${lines.map((l) => `<p>${htmlEscape(l)}</p>`).join('')}</div>`;
  }
  return lines
    .map((l) => (mod.id === 'skills' ? renderSkillLine(l) : `<p class="resume-line">${htmlEscape(l)}</p>`))
    .join('');
}

/** 渲染模块列表（顺序由上游 data.modules 决定；空模块已被上游过滤） */
function renderModules(modules: ResumeDocModule[]): string {
  return modules
    .map((mod) => {
      const body = renderModuleBody(mod);
      if (!body) return '';
      return (
        `<section class="resume-section">` +
        `<h2 class="resume-section-title">${htmlEscape(mod.title)}</h2>` +
        `<div class="resume-section-body">${body}</div>` +
        `</section>`
      );
    })
    .join('');
}

/** 分栏模板（column/dark）：侧栏只放 照片 + 姓名 + 联系方式，七个模块统一走主栏 */
function renderSplit(data: ResumeDocData): string {
  const { contact, modules, photo } = data;
  const contactBits: string[] = [];
  if (contact.targetTitle.trim()) contactBits.push(`<div>求职意向 ${htmlEscape(contact.targetTitle.trim())}</div>`);
  if (contact.phone.trim()) contactBits.push(`<div>电话 ${htmlEscape(contact.phone.trim())}</div>`);
  if (contact.email.trim()) contactBits.push(`<div>邮箱 ${htmlEscape(contact.email.trim())}</div>`);

  return (
    `<div class="resume">` +
    `<aside class="left">` +
    renderPhotoBox(photo) +
    (contact.name ? `<div class="col-name">${htmlEscape(contact.name)}</div>` : '') +
    (contact.targetTitle ? `<div class="col-title">${htmlEscape(contact.targetTitle)}</div>` : '') +
    (contactBits.length ? `<div class="col-contact">${contactBits.join('')}</div>` : '') +
    `</aside>` +
    `<main class="right">${renderModules(modules)}</main>` +
    `</div>`
  );
}

/** 单栏模板（classic/simple/fresh）：头部左信息右照片（simple 照片在左） */
function renderStandard(data: ResumeDocData, photoFirst = false): string {
  const contactLine = renderContactLine(data.contact);
  const nameBlock =
    `<div class="resume-header-main">` +
    (data.contact.name ? `<h1 class="resume-name">${htmlEscape(data.contact.name)}</h1>` : '') +
    contactLine +
    `</div>`;
  const photoBox = renderPhotoBox(data.photo);
  const header =
    data.contact.name || contactLine || photoBox
      ? `<header class="resume-header">${photoFirst ? photoBox + nameBlock : nameBlock + photoBox}</header>`
      : '';
  return `<div class="resume">${header}${renderModules(data.modules)}</div>`;
}

/** 把结构化定制简历渲染为指定模板的 A4 打印 HTML（由主进程 printToPDF 输出 PDF） */
export function buildResumeHtml(data: ResumeDocData, templateId = 'classic'): string {
  const tplId = isKnownTemplate(templateId) ? templateId : 'classic';
  const tplCss = TEMPLATE_CSS[tplId] || '';
  let body: string;
  if (tplId === 'column' || tplId === 'dark') body = renderSplit(data);
  else if (tplId === 'simple') body = renderStandard(data, true);
  else body = renderStandard(data, false);
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>` +
    `${htmlEscape(data.contact.name || '定制简历')} - ${htmlEscape(data.contact.targetTitle || '求职')}</title>` +
    `<style>${BASE_CSS}${tplCss}</style></head>` +
    `<body class="tpl-${tplId}">${body}</body></html>`
  );
}

/** 生成默认导出文件名：{意向岗位}-{姓名}-定制简历-{yyyyMMdd}.pdf */
export function defaultPdfFileName(contact: Pick<ResumeDocData['contact'], 'name' | 'targetTitle'>, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const base = [contact.targetTitle, contact.name, '定制简历', date].filter(Boolean).join('-');
  return `${base.replace(/[\\/:*?"<>|\n\r]/g, '').slice(0, 80) || '定制简历'}.pdf`;
}
