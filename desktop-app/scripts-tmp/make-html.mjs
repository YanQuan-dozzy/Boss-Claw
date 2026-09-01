// 生成样例定制简历 A4 HTML（验收用，数据为虚构演示）→ 供 electron printToPDF 脚本转 PDF
import { buildResumeHtml, defaultPdfFileName } from '../src/lib/bossclaw/resumePdf.ts';
import fs from 'node:fs';

const data = {
  contact: { name: '张三', phone: '13800138000', email: 'zhangsan@example.com', targetTitle: '前端开发工程师' },
  sections: [
    { id: 'summary', title: '个人摘要', items: ['计算机科学本科在读，具备 React / TypeScript 项目经验，主导过 2 个中大型 Web 项目从 0 到 1 落地，注重性能与工程规范。主要关注前端开发方向，希望加入贵公司参与核心业务建设。'], kind: 'paragraph' },
    { id: 'skills', title: '核心技能', items: ['React', 'TypeScript', 'Vite & Webpack', 'Node.js', 'Ant Design', 'Git / CI', '性能优化'], kind: 'skills' },
    { id: 'highlights', title: '岗位相关经历亮点', items: ['主导电商中台前端重构，首屏加载耗时从 3s 降至 1.2s（简历真实数据）', '搭建内部组件库，覆盖 20+ 业务页面，重复代码减少约 30%', '参与 3 个上线项目，服务日活 5 万用户'], kind: 'bullets' },
    { id: 'experience', title: '工作/实习经历', items: ['某科技有限公司 · 前端开发实习生（2024.06-2024.12）：负责营销活动页开发与埋点统计，活动参与人数 10 万+', '某软件公司 · Web 开发实习生（2023.07-2023.09）：参与内部管理系统开发，使用 Vue2 与 Element UI'], kind: 'bullets' },
    { id: 'projects', title: '项目经历', items: ['在线课程平台（React + TypeScript + Vite）：负责课程列表、播放页与后台管理，首屏优化后 LCP 降至 1.5s', '简历解析工具（Node.js + PDF 解析）：实现 PDF/DOCX 文本提取，服务内部 3 个团队'], kind: 'bullets' },
    { id: 'education', title: '教育背景', items: ['某大学 · 计算机科学与技术 · 本科 · 2022-2026'], kind: 'bullets' },
  ],
};

const html = buildResumeHtml(data);
fs.writeFileSync('scripts-tmp/sample-resume.html', html);
console.log('html written:', html.length, 'chars');
console.log('fileName:', defaultPdfFileName(data.contact));
