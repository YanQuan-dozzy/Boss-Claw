// 多轮补充回归：真实生成流程（仅替换模型调用）+ Electron 中实际 React 页面交互。
// 使用隔离临时目录和离线模型，不读取用户资料、不联网、不投递。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'bossclaw-tailor-iteration-'));
const modelMock = { name: 'offline-model', setup(api) {
  api.onLoad({ filter: /[\\/]llm\.ts$/ }, ({ path }) => ({
    contents: readFileSync(path, 'utf8').replace('export async function cachedCallModel(', 'async function originalCachedCallModel(')
      + '\nexport const cachedCallModel = (...args: any[]) => (globalThis as any).__modelHook(...args);', loader: 'ts',
  }));
} };
const bundle = async (contents, outfile, platform) => build({
  stdin: { contents, loader: 'tsx', resolveDir: root }, tsconfig: join(root, 'tsconfig.json'),
  bundle: true, format: platform === 'node' ? 'cjs' : 'iife', platform, outfile, logLevel: 'silent', plugins: [modelMock],
});
const profile = {
  summary: '本科在读，参与知识库项目。',
  facts: { education: ['本科在读'], projects: ['知识库项目'], experiences: [], skills: ['熟悉 Python'], certificates: [], capabilities: [] },
  primaryDirections: [], secondaryDirections: [], searchKeywords: [], excludeDirections: [],
  hardConstraints: { locations: [], employmentTypes: [], salary: '', experience: '', degree: '本科' },
};
const resume = '示例候选人，本科在读，熟悉 Python，参与知识库项目。';
const job = { title: 'AI 应用实习生', company: '示例甲公司', description: '开发 Python 知识库，负责文档切分、RAG 检索与测试。', salary: '150元/天', location: '广州', platform: 'boss' };
const coverLetter = '您好，我想应聘贵公司的AI应用实习生岗位。我是本科在读学生，参与过知识库项目，熟悉Python，负责相关功能开发和验证。希望结合已有项目经验，参与贵公司的知识库应用开发，在实际任务中进一步完善检索、测试和接口联调流程。我对岗位所涉及的应用开发与问题排查工作很感兴趣，希望有机会详细交流我的项目职责和实践过程，谢谢。';
const draft = (text = '参与知识库项目。', after = 72) => ({
  highlightedSkills: ['Python'], tailoredSummary: profile.summary, tailoredExperiences: [text], coverLetter,
  skillGaps: ['需要补充检索测试细节'], suggestions: ['补充项目职责'],
  resume: { projects: [{ heading: '知识库项目', meta: 'Python', bullets: [{ text, source: text }] }], skills: [{ text: '熟悉 Python', source: '熟悉 Python' }] },
  jdPoints: [{ point: '检索测试', layer: 'duty', verdict: 'addable', evidence: '待补充具体职责' }], matchScore: { before: 60, after },
});
const nodeBundle = join(temporary, 'logic.cjs');
await bundle("export * from './src/lib/bossclaw/jobAssistant'; export * from './src/lib/bossclaw/tailorBatch';", nodeBundle, 'node');
const { tailorForJob, appendTailorSupplement, normalizeAiMatch, upsertTailorHistory, finalizeJdPoints, normalizeTailorDoc, writeTailorPointSupplement } = require(nodeBundle);
const calls = [];
let replies = [];
globalThis.__modelHook = async (messages) => {
  calls.push(messages);
  const next = replies.shift();
  if (next instanceof Error) throw next;
  assert.ok(next, '模型调用数量超出预期');
  return next;
};
const model = { apiKey: 'offline-fixture-key', model: 'offline', provider: 'custom', baseUrl: 'https://offline.invalid', contextWindow: 128000 };
replies = [draft(), { matchScore: { before: 60, after: 72 } }];
const first = await tailorForJob(job, resume, profile, model);
assert.equal(first.method, 'ai');
const one = appendTailorSupplement(undefined, '  负责文档切分，测试30条问题。  ', 1);
assert.equal(one[0].text, '负责文档切分，测试30条问题。');
const reviewedDoc = draft('负责文档切分并测试30条问题。').resume;
reviewedDoc.projects[0].bullets[0].source = one[0].text;
replies = [draft(one[0].text, 80), { resume: reviewedDoc, matchScore: { before: 67, after: 84 } }];
const second = await tailorForJob(job, resume, profile, model, undefined, '导入的文件经历', { supplements: one, previousResult: first });
assert.equal(second.aiMatch.after, 84, '评分必须对应回审后的文档');
assert.equal(second.previousScore, 72);
assert.equal(second.supplements.length, 1);
assert.ok(second.rewrites.some((r) => r.from === 'extra'), '文本补充可溯源');
const two = appendTailorSupplement(one, '负责检索评估；请保留测试细节，目标100分。', 2);
replies = [draft(two[1].text, 89), { matchScore: { before: 74, after: 91 } }];
const third = await tailorForJob(job, resume, profile, model, undefined, undefined, { supplements: two, previousResult: second });
assert.equal(third.aiMatch.after, 91, '目标100分不得覆盖模型实际评分');
assert.equal(third.previousScore, 84);
assert.deepEqual(third.supplements, two);
for (const request of calls.slice(-2)) {
  const prompt = request.map((m) => m.content).join('\n');
  assert.ok(prompt.includes(one[0].text) && prompt.includes(two[1].text), '草稿与回审都要收到全部轮次');
  assert.ok(prompt.includes('上一版（仅编辑参考，不是事实来源）'));
  assert.ok(prompt.includes('不得转换成已具备的事实'));
}
assert.deepEqual(one, [{ text: '负责文档切分，测试30条问题。', createdAt: 1 }], '不能修改上一版补充');
assert.deepEqual(appendTailorSupplement(two, '  '), two);
assert.equal(normalizeAiMatch({ before: 'bad', after: 80 }), null);
replies = [draft(), { resume: draft('不同的最终正文').resume }];
assert.equal((await tailorForJob(job, resume, profile, model)).aiMatch, null, '正文已修订但无评分时不能展示旧稿分数');
const historyItem = (id, company, result) => ({ id, jobId: id, company, job, jobTitle: job.title, jobDesc: job.description, createdAt: 1, result });
const saved = upsertTailorHistory([historyItem('a', '示例甲公司', first), historyItem('b', '示例乙公司', first)], historyItem('a', '示例甲公司', third));
assert.equal(saved.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(saved))[0].result.supplements, two);
assert.equal(upsertTailorHistory(saved, { ...historyItem('old', '示例甲公司', third), jobId: undefined }).length, 2, '旧记录也按公司区分');
console.log('PASS: 多轮上下文、事实/指令区分、最终稿评分、来源、历史持久化与兼容。');

// 用户报告的情景：补充“了解”后正文已写入，模型还引用原项目未写明的旧 addable。
const skillPoints = ['了解数据库表设计', '了解 SQL 语法', '了解主流 Web 框架'].map(point => ({
  point, layer: 'must', verdict: 'addable', evidence: '项目用 MySQL/SQLite 建表存储数据但未写明表设计',
}));
const skillsDraft = draft();
skillsDraft.jdPoints = skillPoints;
skillsDraft.resume.skills = skillPoints.map(p => ({ text: p.point, source: p.point }));
const facts = skillPoints.map(p => p.point).join('\n');
replies = [skillsDraft, { jdPoints: skillPoints, matchScore: { before: 60, after: 74 } }];
const skillsResult = await tailorForJob(job, resume, profile, model, undefined, undefined, {
  supplements: appendTailorSupplement([], facts, 3), previousResult: first,
});
assert.ok(skillsResult.jdPoints.every(p => p.verdict === 'covered' && p.statusVerified), '最终技能已体现时不能沿用旧可补充');
assert.ok(skillsResult.jdPoints.every(p => p.evidence.startsWith('最终正文：')), '依据更新为本次正文');
assert.ok(!JSON.stringify(skillsResult.doc).includes('精通'), '了解不能升级为精通');
const plainDoc = normalizeTailorDoc({ skills: [{ text: '熟悉 MySQL，使用 SQLite 存储数据', source: facts }] });
const stillAddable = finalizeJdPoints(skillPoints, skillPoints, plainDoc, true);
assert.ok(stillAddable.every(p => p.verdict === 'addable'), '只在source或数据库名中出现不等于正文已体现');
for (const text of ['尚未了解数据库表设计', '希望了解数据库表设计', '了解数据库表设计是学习目标']) {
  const noEvidence = finalizeJdPoints([skillPoints[0]], undefined, normalizeTailorDoc({ skills: [{ text, source: text }] }), true)[0];
  assert.equal(noEvidence.statusVerified, false, '否定和愿望不能自动变成已体现');
}
const stronger = { ...skillPoints[0], point: '熟悉数据库表设计' };
assert.equal(finalizeJdPoints([stronger], undefined, normalizeTailorDoc({ skills: [{ text: facts, source: facts }] }), true)[0].statusVerified, false, '了解不足以满足熟悉');
const semantic = { point: '检索测试', layer: 'duty', verdict: 'addable', evidence: '旧依据' };
const validUpdate = { ...semantic, verdict: 'covered', evidence: '最终项目已写明检索评估' };
assert.equal(finalizeJdPoints([semantic], [validUpdate], plainDoc, true)[0].verdict, 'covered', '采纳回审的语义复核');
for (const invalid of [undefined, [], [{ ...validUpdate, verdict: 'bad' }], [{ ...validUpdate, layer: 'must' }], [validUpdate, validUpdate]]) {
  assert.equal(finalizeJdPoints([semantic], invalid, plainDoc, true)[0].statusVerified, false, '正文改变但无有效复核时不能展示旧结论');
}
const retained = finalizeJdPoints([semantic, skillPoints[0]], [validUpdate, { ...validUpdate, point: '未知新增要点' }], plainDoc, true);
assert.deepEqual(retained.map(p => p.point), [semantic.point, skillPoints[0].point], '部分复核不增删或重排原清单');
assert.equal(retained[1].statusVerified, false);
console.log('PASS: 技能已写入后升级为已体现、最终正文依据、否定/愿望/水平不足、复核失效与清单身份。');

const pointInput = { point: semantic, text: '没有做过插件开发，做过 Web 接口模块。', job, resumeText: resume, profile, model,
  extraMaterials: '本人负责接口测试。', supplements: two };
replies = [{ text: '参与 Web 接口模块开发，没有插件开发经历。', missingDetails: ['使用哪个框架？', '负责哪个接口？', '如何测试？', '多余问题'] }];
const pointWriting = await writeTailorPointSupplement(pointInput);
assert.equal(pointWriting.missingDetails.length, 3);
assert.ok(pointWriting.text.includes('没有插件开发经历'));
const writingPrompt = calls.at(-1).map(m => m.content).join('\n');
for (const required of [pointInput.text, '本人负责接口测试。', one[0].text, two[1].text, '不能把了解升级成熟练/精通', '必须保留否定或计划性质']) assert.ok(writingPrompt.includes(required));
const writingCalls = calls.length;
await assert.rejects(() => writeTailorPointSupplement({ ...pointInput, text: ' ' }), /请先写/);
await assert.rejects(() => writeTailorPointSupplement({ ...pointInput, model: { ...model, apiKey: '' } }), /配置 AI/);
assert.equal(calls.length, writingCalls, '无输入或模型配置时不得调用模型');
for (const invalid of ['', { wrong: 'object' }]) {
  replies = [{ text: invalid }];
  await assert.rejects(() => writeTailorPointSupplement(pointInput), /未返回有效草稿/);
}
console.log('PASS: 单要点 AI 整理保留全部事实来源、能力水平和否定，限制待补问题、拒绝空草稿。');

// 以下使用实际页面与实际生成函数，仅把模型网络边界替换为确定性回复。
const browserBundle = join(temporary, 'ui.js');
await bundle(`
import React from 'react'; import { createRoot } from 'react-dom/client';
import JobAssistant from './src/pages/JobAssistant';
import { useDataStore } from './src/store/useDataStore'; import { useSettingsStore } from './src/store/useSettingsStore';
import './src/index.css';
const profile=${JSON.stringify(profile)}, job=${JSON.stringify(job)}, coverLetter=${JSON.stringify(coverLetter)};
const base=${JSON.stringify(draft())};
base.jdPoints=[{point:'了解数据库表设计',layer:'must',verdict:'addable',evidence:'项目用MySQL存储数据但未写明表设计'}];
base.jdPoints.push({point:'核心插件及 Web 模块开发',layer:'duty',verdict:'missing',evidence:'未提供插件开发经历'});
const test:any=window; test.modelCalls=[]; test.failModel=false; test.pdfFiles=[];
test.__modelHook=async(messages:any[])=>{
 test.modelCalls.push(messages); await new Promise(r=>setTimeout(r,80)); if(test.failModel) throw new Error('离线模拟服务失败');
 if(messages[0].content.startsWith('你是求职者的简历编辑')) return {text:'参与 Web 接口模块开发，没有插件开发经历。',missingDetails:['你使用了哪个 Web 框架？']};
 const rounds=[...messages[1].content.matchAll(/【第(\\d+)轮用户补充】/g)].map((m:any)=>Number(m[1]));
 const round=Math.max(0,...rounds); const score=72+round*8;
 if(messages[0].content.startsWith('你是资深招聘方')) return {jdPoints:base.jdPoints,matchScore:{before:60,after:score}};
 const output=JSON.parse(JSON.stringify(base)); output.matchScore.after=score;
 if(round) output.resume.projects[0].bullets[0]={text:'第'+round+'轮补充已纳入知识库项目',source:round===1?'补充甲：文档切分与30条测试问题。':'补充乙：负责检索效果评估。'};
 if(round) output.resume.skills.push({text:'了解数据库表设计',source:'了解数据库表设计'});
 return output;
};
test.electron={savePdfBatch:async(files:any[])=>{test.pdfFiles=files;return {ok:true,directory:'离线测试',results:files.map(f=>({...f,ok:true,filePath:f.fileName}))}}};
useDataStore.setState({resumeText:${JSON.stringify(resume)},profile,pending:['a','b'].map((id,i)=>({id,status:'pending',createdAt:1,deliveryGreeting:'',job:{...job,company:i?'示例乙公司':'示例甲公司'}}))});
useSettingsStore.getState().setModel(${JSON.stringify(model)});
createRoot(document.getElementById('root')!).render(<JobAssistant/>);
`, browserBundle, 'browser');
const htmlPath = join(temporary, 'ui.html');
writeFileSync(htmlPath, '<meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>');
const reportPath = join(temporary, 'report.json');
const screenshotPath = join(temporary, '多轮补充.png');
const entry = join(temporary, 'main.cjs');
mkdirSync(join(temporary, 'profile'));
const runUi = async function () {
  const checks = [];
  const wait = async (predicate, name) => {
    const end = Date.now() + 8000;
    while (true) {
      let ready; try { ready = predicate(); } catch (error) { throw new Error(name + '：' + error.message); }
      if (ready) return;
      if (Date.now() > end) throw new Error('等待超时：' + name);
      await new Promise(r => setTimeout(r, 30));
    }
  };
  const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const button = (label, scope = document) => [...scope.querySelectorAll('button')].find(b => b.textContent.replace(/\s/g, '') === label.replace(/\s/g, ''));
  const history = () => JSON.parse(localStorage.getItem('bossclaw-tailor-history-v1') || '[]');
  const fill = (element, value) => {
    Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 批量定制的入口就在「定制简历」模块内：通过岗位多选下拉勾选两个岗位。
  // 注意：本段驱动 antd 多选的真实 DOM 事件，只能在真机 Electron 下验证（沙箱内 electron.exe 无法启动）。
  const selectJobs = async (count) => {
    const root = document.querySelector('[data-testid="tailor-job-select"]');
    if (!root) throw new Error('未找到岗位多选下拉');
    const selector = root.querySelector('.ant-select-selector');
    for (const type of ['mousedown', 'mouseup', 'click']) selector.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    await wait(() => document.querySelectorAll('.ant-select-item-option').length >= count, '岗位下拉选项');
    const options = [...document.querySelectorAll('.ant-select-item-option')];
    for (let i = 0; i < count; i++) {
      options[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      options[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    root.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };
  await selectJobs(2);
  await wait(() => document.querySelector('.tailor-batch-card'), '批量定制列表');
  await wait(() => button('开始批量生成'), '批量入口'); button('开始批量生成').click();
  await wait(() => history().length === 2, '生成两个岗位');
  check(history().every(h => h.result.aiMatch.after === 72), '初始评分');
  button('查看结果', document.querySelector('.tailor-batch-card')).click();
  await wait(() => document.querySelector('#tailor-supplement-text'), '补充文本框');
  check(button('补充并重新生成').disabled, '空输入不可提交');
  fill(document.querySelector('#tailor-supplement-text'), '补充甲：文档切分与30条测试问题。了解数据库表设计。');
  await wait(() => !button('补充并重新生成').disabled, '文字输入生效');
  const count = window.modelCalls.length; button('补充并重新生成').click(); button('补充并重新生成').click();
  await wait(() => document.querySelector('#tailor-supplement-text').disabled, '生成锁');
  check(document.querySelector('#tailor-supplement-text').disabled, '生成时禁用输入');
  await wait(() => history().find(h => h.jobId === 'a')?.result.supplements?.length === 1, '第一轮保存');
  await wait(() => !document.querySelector('#tailor-supplement-text').disabled, '第一轮结束');
  check(window.modelCalls.length - count === 2, '重复点击只生成一次');
  check(document.querySelector('#tailor-supplement-text').value === '', '成功后清空当前输入');
  check(document.querySelector('[data-testid="tailor-iteration-score"]').textContent.includes('72 分 → 本轮 80 分'), '上一版与本轮评分');
  const skillButton = [...document.querySelectorAll('.tailor-point-row')].find(b => b.textContent.includes('了解数据库表设计'));
  check(skillButton.textContent.includes('已体现') && !skillButton.textContent.includes('可补充'), '补充后要点卡片更新为已体现');
  skillButton.click();
  await wait(() => document.querySelector('.tailor-point-detail-modal .tailor-point-detail'), '要点详情');
  check(document.querySelector('.tailor-point-detail-modal').textContent.includes('最终正文：了解数据库表设计'), '详情依据更新为最终正文');
  document.querySelector('.tailor-point-detail-modal .ant-modal-close').click();
  fill(document.querySelector('#tailor-supplement-text'), '补充乙：负责检索效果评估。');
  await wait(() => !button('补充并重新生成').disabled, '第二轮输入'); button('补充并重新生成').click();
  await wait(() => history().find(h => h.jobId === 'a')?.result.supplements?.length === 2, '第二轮保存');
  await wait(() => !document.querySelector('#tailor-supplement-text').disabled, '第二轮结束');
  check(history().find(h => h.jobId === 'a').result.aiMatch.after === 88, '多轮后重新评分');
  check(history().find(h => h.jobId === 'b').result.supplements.length === 0, '补充不串到另一岗位');
  window.failModel = true; fill(document.querySelector('#tailor-supplement-text'), '失败时保留输入');
  await wait(() => !button('补充并重新生成').disabled, '失败测试输入'); button('补充并重新生成').click();
  await wait(() => document.querySelector('#tailor-supplement-text').disabled, '失败测试开始');
  await wait(() => !document.querySelector('#tailor-supplement-text').disabled, '失败测试结束');
  check(document.querySelector('#tailor-supplement-text').value === '失败时保留输入', 'AI失败保留输入');
  check(history().find(h => h.jobId === 'a').result.aiMatch.after === 88, 'AI失败保留上一版');
  window.failModel = false;
  // 从历史恢复后继续补充，必须保持原 jobId 和另一家公司记录。
  button('查看').click();
  await wait(() => document.querySelector('#tailor-supplement-text').value === '', '载入历史');
  check(document.querySelector('[data-testid="tailor-supplement"]').textContent.includes('已补充 2 轮'), '历史恢复累计补充');
  fill(document.querySelector('#tailor-supplement-text'), '补充丙：纠正测试样本为40条。');
  await wait(() => !button('补充并重新生成').disabled, '历史补充输入'); button('补充并重新生成').click();
  await wait(() => history().find(h => h.jobId === 'a')?.result.supplements?.length === 3, '历史迭代保存');
  await wait(() => !document.querySelector('#tailor-supplement-text').disabled, '历史迭代结束');
  check(history().length === 2 && history().some(h => h.jobId === 'b'), '历史迭代保留身份和另一公司');
  button('批量导出 PDF（2）').click();
  await wait(() => document.querySelector('.resume-export-modal'), '导出窗口');
  const name = document.querySelector('#name'); if (name) fill(name, '示例候选人');
  button('选择目录并批量保存').click();
  await wait(() => window.pdfFiles.length === 2, '导出最新批量数据');
  check(window.pdfFiles[0].html.includes('第3轮补充已纳入知识库项目'), '批量PDF使用迭代后的文档');
  check(!window.pdfFiles[1].html.includes('第3轮补充已纳入知识库项目'), '另一岗位导出独立');
  const close = document.querySelector('.resume-export-modal .ant-modal-close'); if(close) close.click();
  await wait(() => !document.querySelector('.resume-export-modal .ant-modal-wrap') || document.querySelector('.resume-export-modal .ant-modal-wrap').style.display === 'none', '导出窗口关闭');
  fill(document.querySelector('#tailor-supplement-text'), '全局尚未提交的草稿');
  [...document.querySelectorAll('.tailor-point-row')].find(b => b.textContent.includes('核心插件及 Web 模块开发')).click();
  const pointModal = () => document.querySelector('.tailor-point-detail-modal');
  const pointField = () => pointModal()?.querySelector('#tailor-point-supplement-text');
  await wait(() => pointField() && pointModal().querySelector('.tailor-point-detail-head')?.textContent.includes('核心插件及 Web 模块开发'), '不具备要点的补充框');
  check(button('AI 帮我整理／续写', pointModal()).disabled && button('补充这一项并重新生成', pointModal()).disabled, '单要点空输入禁用AI和提交');
  fill(pointField(), '没有做过插件开发，做过 Web 接口模块。');
  await wait(() => !button('AI 帮我整理／续写', pointModal()).disabled, '单要点输入');
  window.failModel = true; button('AI 帮我整理／续写', pointModal()).click();
  await wait(() => pointField().disabled, 'AI整理开始'); await wait(() => !pointField().disabled, 'AI整理失败');
  check(pointField().value === '没有做过插件开发，做过 Web 接口模块。', 'AI整理失败保留原输入');
  window.failModel = false;
  const pointCalls = window.modelCalls.length;
  button('AI 帮我整理／续写', pointModal()).click(); button('AI 帮我整理／续写', pointModal()).click();
  await wait(() => pointField().value.includes('参与 Web 接口模块'), 'AI草稿回填');
  await wait(() => !pointField().disabled, 'AI整理结束');
  check(window.modelCalls.length - pointCalls === 1, 'AI整理重复点击只调用一次');
  check(pointModal().textContent.includes('你使用了哪个 Web 框架？'), 'AI待补细节可见');
  check(history().find(h => h.jobId === 'a').result.supplements.length === 3, '未确认AI草稿不写入简历或历史');
  pointModal().querySelector('.ant-modal-close').click();
  [...document.querySelectorAll('.tailor-point-row')].find(b => b.textContent.includes('了解数据库表设计')).click();
  await wait(() => pointModal().textContent.includes('了解数据库表设计'), '换要点');
  check(pointField().value === '', '不同要点草稿独立');
  pointModal().querySelector('.ant-modal-close').click();
  [...document.querySelectorAll('.tailor-point-row')].find(b => b.textContent.includes('核心插件及 Web 模块开发')).click();
  await wait(() => pointModal().textContent.includes('核心插件及 Web 模块开发'), '恢复要点');
  check(pointField().value.includes('没有插件开发经历'), '关闭后重开保留AI草稿');
  window.failModel = true; button('补充这一项并重新生成', pointModal()).click();
  await wait(() => pointField().disabled, '单项提交开始'); await wait(() => !pointField().disabled, '单项提交失败');
  check(pointField().value.includes('没有插件开发经历') && history().find(h => h.jobId === 'a').result.supplements.length === 3, '单项生成失败保留草稿和上一版');
  window.failModel = false; button('补充这一项并重新生成', pointModal()).click(); button('补充这一项并重新生成', pointModal()).click();
  await wait(() => history().find(h => h.jobId === 'a').result.supplements.length === 4, '单项提交成功');
  await wait(() => !document.querySelector('#tailor-supplement-text').disabled, '单项提交结束');
  check(history().find(h => h.jobId === 'a').result.supplements.at(-1).text.includes('【岗位要点：核心插件及 Web 模块开发】'), '单项确认后带要点保存到累计补充');
  check(document.querySelector('#tailor-supplement-text').value === '全局尚未提交的草稿', '单项提交保留全局未提交草稿');
  button('查看结果', document.querySelectorAll('.tailor-batch-card .ant-list-item')[1]).click();
  await wait(() => document.querySelector('[data-testid="tailor-supplement"]').textContent.includes('补充内容'), '切换岗位');
  [...document.querySelectorAll('.tailor-point-row')].find(b => b.textContent.includes('核心插件及 Web 模块开发')).click();
  await wait(() => pointField(), '另一岗位要点');
  check(pointField().value === '' && history().find(h => h.jobId === 'b').result.supplements.length === 0, '另一岗位不带入补充或草稿');
  document.querySelector('.tailor-point-detail-modal').scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 3500));
  return checks;
};
writeFileSync(entry, `const {app,BrowserWindow}=require('electron'); const fs=require('fs');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))}); app.setPath('sessionData',${JSON.stringify(join(temporary, 'profile'))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1180,height:1000,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_req,cb)=>cb({cancel:true}));
try{await win.loadFile(${JSON.stringify(htmlPath)}); const checks=await win.webContents.executeJavaScript('('+${JSON.stringify(runUi.toString())}+')()');
fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({checks}));fs.writeFileSync(${JSON.stringify(screenshotPath)},(await win.webContents.capturePage()).toPNG());}
catch(error){fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({error:error.stack}));fs.writeFileSync(${JSON.stringify(screenshotPath)},(await win.webContents.capturePage()).toPNG());}
finally{win.destroy();app.quit();}});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const proc = spawnSync(process.env.BOSSCLAW_ELECTRON || require('electron'), [entry], { env, windowsHide: true, timeout: 60000, encoding: 'utf8' });
assert.equal(proc.status, 0, proc.error?.message || proc.stderr);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.ok(!report.error, report.error);
console.log(`PASS UI: ${report.checks.length} 项实际页面交互检查。报告：${reportPath}`);
console.log(`页面截图：${screenshotPath}`);
