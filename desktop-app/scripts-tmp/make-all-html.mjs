// 多模板冒烟（ResumeCollection 风格 5 套）：生成 A4 HTML + 校验模板/照片/占位框
import { buildResumeHtml, RESUME_TEMPLATES } from '../src/lib/bossclaw/resumePdf.ts';
import fs from 'node:fs';

// 测试照片：优先真实 JPEG（scripts-tmp/test-photo.jpg），否则回退 SVG data URL
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
let TEST_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300"><rect width="240" height="300" fill="#7fa3c8"/><circle cx="120" cy="110" r="48" fill="#fff"/><path d="M45 270 Q120 190 195 270 Z" fill="#fff"/></svg>'
).toString('base64');
if (existsSync('scripts-tmp/test-photo.jpg')) {
  TEST_PHOTO = 'data:image/jpeg;base64,' + readFileSync('scripts-tmp/test-photo.jpg').toString('base64');
}

const data = {
  contact: { name: '张三', phone: '13800138000', email: 'zhangsan@example.com', targetTitle: '前端开发工程师' },
  sections: [
    { id: 'summary', title: '个人摘要', items: ['计算机科学本科在读，具备 React / TypeScript 项目经验，主导过 2 个中大型 Web 项目从 0 到 1 落地，注重性能与工程规范。'], kind: 'paragraph' },
    { id: 'skills', title: '核心技能', items: ['React', 'TypeScript', 'Vite & Webpack', 'Node.js', 'Ant Design', 'Git / CI'], kind: 'skills' },
    { id: 'highlights', title: '岗位相关经历亮点', items: ['主导电商中台前端重构，首屏加载耗时从 3s 降至 1.2s', '搭建内部组件库，覆盖 20+ 业务页面'], kind: 'bullets' },
    { id: 'experience', title: '工作/实习经历', items: ['某科技有限公司 · 前端开发实习生（2024.06-2024.12）：负责营销活动页开发与埋点统计'], kind: 'bullets' },
    { id: 'projects', title: '项目经历', items: ['在线课程平台（React + TypeScript + Vite）：负责课程列表、播放页与后台管理'], kind: 'bullets' },
    { id: 'education', title: '教育背景', items: ['某大学 · 计算机科学与技术 · 本科 · 2022-2026'], kind: 'bullets' },
  ],
};

for (const t of RESUME_TEMPLATES) {
  // 带照片版本（photo=<TEST_PHOTO>）
  const html = buildResumeHtml({ ...data, photo: TEST_PHOTO }, t.id);
  fs.writeFileSync(`scripts-tmp/resume-${t.id}.html`, html);
  const checks = [
    `class="tpl-${t.id}"`,
    '<img',           // 照片嵌入
    'photo-box',      // 照片容器
    t.split ? 'class="left"' : 'resume-header',
    '张三',
  ];
  const missing = checks.filter((c) => !html.includes(c));
  console.log(`${t.id.padEnd(8)} photo ${String(html.length).padStart(5)} chars  ${missing.length ? 'MISSING: ' + missing.join(',') : 'OK'}`);

  // 无照片版本 → 应渲染占位框
  const noPhoto = buildResumeHtml(data, t.id);
  const phOk = noPhoto.includes('photo-placeholder');
  console.log(`${t.id.padEnd(8)} noPhoto placeholder: ${phOk ? 'OK' : 'MISSING placeholder'}`);
}
console.log('--- ALL GENERATED ---');
