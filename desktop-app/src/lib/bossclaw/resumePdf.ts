// 定制简历 PDF 渲染（HTML → Electron printToPDF，零额外依赖，多模板 + 照片框）
// 模板参考 GitHub 优秀项目 mmmlllnnn/ResumeCollection（全网简历模板合集，
// 200+ 中文简历样式）：按其中最具代表性的风格落地为 5 套：
//   - classic 蓝白经典   （蓝白商务双线，照片右上角，通用岗）
//   - column  左右分栏   （左 38% 浅蓝信息栏 + 右内容区，照片在左栏）
//   - dark    深色侧栏   （左 30% 深色栏 + 圆形照片，资深/展示型）
//   - simple  极简单栏   （黑白灰大留白，照片左上角，金融/管理岗）
//   - fresh   清新绿     （绿色调，照片右上角，成长型/设计向）
// 全部模板保留「个人照片插入框」：未上传照片时渲染虚线占位框，上传后显示照片。
//
// 实现口径：
//   - 输出纯 HTML 字符串（内联 CSS），由主进程 jc:save-pdf 加载到隐藏窗口
//     webContents.printToPDF 输出 A4 PDF（文本层可被 ATS 检索）；
//   - 打印边距由 CSS @page 控制（主进程 printToPDF 传 margins:'none'）；
//   - 中文字体微软雅黑，无需嵌入字体；照片为 data URL 内联，无外部资源；
//   - 所有文本经 HTML 转义；关键字段禁用 letter-spacing（Chromium 打印会
//     把字距实现为字符间空格，破坏 ATS 连续检索）。

import type { ResumeDocData, ResumeDocSection } from './resumeContact';

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
/* ===== 照片插入框（未上传 → 虚线占位；上传 → 照片） ===== */
.photo-box { flex-shrink: 0; }
.photo-box img { display: block; width: 100%; height: 100%; object-fit: cover; }
.photo-placeholder {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  border: 1.5px dashed #c3ccd6; color: #a8b2bd; font-size: 9pt; background: #fafbfc;
}
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
/* ===== 摘要 ===== */
.para-block p, .summary { text-align: justify; }
/* ===== 技能标签 ===== */
.skill-chips { margin: 2px 0; }
.skill-chip {
  display: inline-block; margin: 2px 5px 2px 0; padding: 1px 9px;
  background: var(--chip-bg, #eef3fa); color: var(--chip-text, #2b5a9e); border: 1px solid var(--chip-border, #d3e0f0);
  border-radius: 10px; font-size: 9.5pt; line-height: 1.6;
}
/* ===== 要点列表 ===== */
ul.bullets { margin: 3px 0; padding-left: 16px; }
ul.bullets li { margin-bottom: 3px; text-align: justify; }
ul.bullets li::marker { color: var(--accent, #2b5a9e); }
/* 打印控制：避免小节标题与内容分页分离 */
.resume-section { break-inside: avoid-page; }
`;

// ===== 各模板样式（CSS 变量覆盖 + 布局差异） =====
const TEMPLATE_CSS: Record<string, string> = {
  // 蓝白经典：证件照 3:4 圆角，右上角
  classic: `
.tpl-classic .photo-box { width: 25mm; height: 33mm; border: 1px solid #d5e0ee; border-radius: 3px; overflow: hidden; }
.tpl-classic .resume-header::after { content: ""; display: block; border-bottom: 1px solid var(--line, #d5e2f2); position: absolute; left: 0; right: 0; bottom: -4px; }
.tpl-classic .resume-header { position: relative; }
`,

  // 左右分栏：左 38% 浅蓝栏（照片+基本信息+技能+教育）+ 右内容区
  column: `
@page { size: A4; margin: 0; }
.tpl-column { --text:#2a3a4d; --text-2:#4c6074; --text-3:#7890a6; --heading:#1d3c5e; --accent:#2b5a9e; --line:#d9e4f0; --chip-bg:#e7eef7; --chip-text:#2b5a9e; --chip-border:#cfddec; }
.tpl-column .resume { display: flex; min-height: 297mm; }
.tpl-column .left { width: 38%; background: #eef3f9; padding: 14mm 8mm; font-size: 9.5pt; }
.tpl-column .left .photo-box { width: 30mm; height: 40mm; margin: 0 auto 10mm; border: 1px solid #c9d6e4; overflow: hidden; }
.tpl-column .left .col-name { font-size: 19pt; font-weight: 700; color: #1d3c5e; text-align: center; margin: 0 0 2px; }
.tpl-column .left .col-title { font-size: 10pt; color: #4c6074; text-align: center; margin: 0 0 10px; }
.tpl-column .left .col-contact { font-size: 9pt; color: #40536a; margin-bottom: 12px; line-height: 1.8; }
.tpl-column .left .col-section { margin-bottom: 12px; }
.tpl-column .left .col-section-title { font-size: 10.5pt; font-weight: 700; color: #1d3c5e; border-bottom: 1.5px solid #2b5a9e; padding-bottom: 3px; margin: 0 0 7px; }
.tpl-column .left .col-chip { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 8px; background: #e2ebf5; border: 1px solid #c9d9ea; border-radius: 10px; font-size: 8.5pt; color: #2b5a9e; }
.tpl-column .left ul.col-bullets { margin: 3px 0; padding-left: 14px; }
.tpl-column .left ul.col-bullets li { margin-bottom: 3px; }
.tpl-column .right { flex: 1; padding: 14mm 11mm; }
.tpl-column .resume-section-title { border-left: 4px solid #2b5a9e; }
`,

  // 深色侧栏：左 30% 深灰蓝 + 圆形照片居中
  dark: `
@page { size: A4; margin: 0; }
.tpl-dark { --text:#2a2a2a; --text-2:#555; --heading:#1d2733; }
.tpl-dark .resume { display: flex; min-height: 297mm; }
.tpl-dark .left {
  width: 30%; background: #263445; color: #e8eef5; padding: 14mm 7mm;
  font-size: 9pt; line-height: 1.7;
}
.tpl-dark .left .photo-box { width: 28mm; height: 28mm; margin: 0 auto 10mm; border-radius: 50%; overflow: hidden; border: 2.5px solid #5b8fc9; }
.tpl-dark .left .col-name { font-size: 19pt; font-weight: 700; color: #fff; text-align: center; margin: 0 0 4px; }
.tpl-dark .left .col-title { font-size: 10pt; color: #a8c3e8; text-align: center; margin: 0 0 12px; }
.tpl-dark .left .col-contact { font-size: 8.5pt; color: #c9d6e5; margin-bottom: 16px; }
.tpl-dark .left .col-contact div { margin-bottom: 4px; }
.tpl-dark .left .col-section { margin-bottom: 14px; }
.tpl-dark .left .col-section-title { font-size: 10.5pt; font-weight: 700; color: #fff; border-left: 3px solid #5b8fc9; padding-left: 7px; margin: 0 0 7px; }
.tpl-dark .left .col-chip { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 7px; border: 1px solid #48657f; border-radius: 10px; font-size: 8pt; color: #d7e3ef; }
.tpl-dark .left ul.col-bullets { margin: 3px 0; padding-left: 14px; }
.tpl-dark .left ul.col-bullets li { margin-bottom: 3px; }
.tpl-dark .right { flex: 1; padding: 14mm 12mm 14mm 10mm; }
.tpl-dark .resume-section-title { border-left: 4px solid #2b5a9e; }
`,

  // 极简单栏：黑白灰、照片左上角
  simple: `
.tpl-simple { --text:#2a2a2a; --text-2:#666; --text-3:#999; --heading:#111; --line:#e2e2e2; }
.tpl-simple .resume-header { border-bottom: 1px solid #d5d5d5; }
.tpl-simple .resume-name { font-size: 20pt; font-weight: 600; color: #111; margin-bottom: 4px; }
.tpl-simple .photo-box { width: 24mm; height: 32mm; border: 1px solid #ddd; overflow: hidden; }
.tpl-simple .resume-section-title { border-left: none; padding-left: 0; border-bottom: 1px solid #e2e2e2; padding-bottom: 4px; font-size: 11pt; color: #333; }
.tpl-simple .resume-section-body { padding-left: 0; }
.tpl-simple .skill-chip { background: #f5f5f5; border-color: #eee; color: #444; border-radius: 2px; }
.tpl-simple ul.bullets li::marker { color: #999; }
`,

  // 清新绿：绿色调、照片右上角圆角
  fresh: `
.tpl-fresh { --accent:#1f7a5c; --heading:#144d3a; --line:#cfe3d9; --text-2:#4c6b5f; --text-3:#7d9489; --chip-bg:#e8f2ed; --chip-text:#1f7a5c; --chip-border:#cfe3d9; }
.tpl-fresh .resume-header { border-bottom: 2px solid #1f7a5c; }
.tpl-fresh .photo-box { width: 25mm; height: 33mm; border: 1px solid #cfe3d9; border-radius: 12px; overflow: hidden; }
.tpl-fresh .resume-name { color: #144d3a; }
.tpl-fresh .resume-section-title { border-left-color: #1f7a5c; }
.tpl-fresh .skill-chip { border-radius: 3px; }
.tpl-fresh ul.bullets li::marker { color: #1f7a5c; }
`,
};

// ===== 照片框渲染 =====
function renderPhotoBox(photo: string | undefined, placeholderText = '照片'): string {
  if (photo) {
    return `<div class="photo-box"><img src="${htmlEscape(photo)}" alt="个人照片"/></div>`;
  }
  return `<div class="photo-box"><div class="photo-placeholder">${placeholderText}</div></div>`;
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

function renderSectionBody(sec: ResumeDocSection): string {
  if (sec.kind === 'skills') {
    const chips = sec.items.map((s) => `<span class="skill-chip">${htmlEscape(s)}</span>`).join('');
    return `<div class="skill-chips">${chips}</div>`;
  }
  if (sec.kind === 'bullets') {
    const lis = sec.items.map((s) => `<li>${htmlEscape(s)}</li>`).join('');
    return `<ul class="bullets">${lis}</ul>`;
  }
  const paras = sec.items
    .map((s) =>
      String(s || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${htmlEscape(line)}</p>`)
        .join('')
    )
    .join('');
  return `<div class="para-block">${paras}</div>`;
}

function renderSections(sections: ResumeDocSection[]): string {
  return sections
    .map((sec) => {
      if (!sec.title || !sec.items?.length) return '';
      return (
        `<section class="resume-section">` +
        `<h2 class="resume-section-title">${htmlEscape(sec.title)}</h2>` +
        `<div class="resume-section-body">${renderSectionBody(sec)}</div>` +
        `</section>`
      );
    })
    .join('');
}

/** 分栏模板（column/dark）：左栏放 照片+姓名+联系+技能+教育+证书，右栏放其余 */
function renderSplit(data: ResumeDocData): string {
  const { contact, sections, photo } = data;
  const sideIds = new Set(['skills', 'education', 'certificates']);
  const sideSections = sections.filter((s) => sideIds.has(s.id));
  const mainSections = sections.filter((s) => !sideIds.has(s.id));

  const contactBits: string[] = [];
  if (contact.phone.trim()) contactBits.push(`<div>电话 ${htmlEscape(contact.phone.trim())}</div>`);
  if (contact.email.trim()) contactBits.push(`<div>邮箱 ${htmlEscape(contact.email.trim())}</div>`);
  if (contact.targetTitle.trim()) contactBits.push(`<div>求职意向 ${htmlEscape(contact.targetTitle.trim())}</div>`);

  const sideBody = sideSections
    .map((sec) => {
      if (sec.kind === 'skills') {
        const chips = sec.items.map((s) => `<span class="col-chip">${htmlEscape(s)}</span>`).join('');
        return `<div class="col-section"><div class="col-section-title">${htmlEscape(sec.title)}</div><div class="skill-chips">${chips}</div></div>`;
      }
      const lis = sec.items.map((s) => `<li>${htmlEscape(s)}</li>`).join('');
      return `<div class="col-section"><div class="col-section-title">${htmlEscape(sec.title)}</div><ul class="col-bullets">${lis}</ul></div>`;
    })
    .join('');

  return (
    `<div class="resume">` +
    `<aside class="left">` +
    renderPhotoBox(photo) +
    (contact.name ? `<div class="col-name">${htmlEscape(contact.name)}</div>` : '') +
    (contact.targetTitle ? `<div class="col-title">${htmlEscape(contact.targetTitle)}</div>` : '') +
    (contactBits.length ? `<div class="col-contact">${contactBits.join('')}</div>` : '') +
    sideBody +
    `</aside>` +
    `<main class="right">${renderSections(mainSections)}</main>` +
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
  return (
    `<div class="resume">` +
    `<header class="resume-header">` +
    (photoFirst ? photoBox + nameBlock : nameBlock + photoBox) +
    `</header>` +
    renderSections(data.sections) +
    `</div>`
  );
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
