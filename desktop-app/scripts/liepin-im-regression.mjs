// Electron 离线真实 DOM 回归；不登录、不联网、不向任何招聘者发送消息。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'electron/preload/webview.cjs'), 'utf8');
const A = require(join(root, 'electron/preload/platform-adapters.cjs'));
const IM = require(join(root, 'electron/preload/liepin-im.cjs'));
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const injected = [
  section('function visible(el)', '// 原始文本行'),
  section('const all = (sel', 'async function waitFor'),
  section('const PLATFORM_NORM', '// ===== 智联「继续沟通」入口'),
  section('async function platformApply', '// platform-apply：非 BOSS'),
  `const normLabelText = ${A.normLabelText.toString()};`,
  `const ADAPTERS = {labelHit: ${A.labelHit.toString()}, labelExactHit: ${A.labelExactHit.toString()}, LOGIN_WALL_TEXT_RE: ${A.LOGIN_WALL_TEXT_RE}};`,
  IM.readLiepinImState.toString(), IM.findNewLiepinConversation.toString(), IM.normalizeLiepinText.toString(), IM.isLiepinDefaultGreeting.toString(), IM.readLiepinDeliveryState.toString(),
  `const PLATFORM = "liepin";
   let writtenWidget=null;
   const trustedInput=async(_action,value)=>{
    writes++; if(test.inputFail) return {ok:false};
    writtenWidget=readLiepinImState(document).widgets.find(w=>w.editor && (w.editor.ownerDocument.activeElement===w.editor || w.editor.getRootNode().activeElement===w.editor));
    if(!writtenWidget) return {ok:false}; const input=writtenWidget.editor;
    if('value' in input) input.value=value; else input.textContent=value;
    if(test.afterInput) eval(test.afterInput);
    return {ok:true};
   };
   const clickElement=async(el)=>{
    el.click(); if(!/^(发送|发送消息)$/.test(el.textContent.replace(/\\s+/g,''))) return;
    sends++; const input=writtenWidget.editor;
    if(!test.retainEditor) {if('value' in input) input.value='';else input.textContent='';}
    if(test.noBubble) return;
    const bubble=input.ownerDocument.createElement('div'); bubble.className=test.bubbleClass||'message-right'; bubble.style.width='250px';
    bubble.textContent=test.bubbleText||greeting;
    if(test.bubbleHtml)bubble.innerHTML=test.bubbleHtml;
    if(test.bubbleChild)bubble.insertAdjacentHTML('beforeend',test.bubbleChild);
    const root=test.wrongWindow ? document.querySelector('.other-chat') : writtenWidget.element;
    (root.nodeType===9 ? root.body : root).appendChild(bubble);
    if(test.afterSend) eval(test.afterSend);
   };`,
  'const waitFor = async (check) => { const until = Date.now()+700; do { const result = check(); if(result) return result; await new Promise(r=>setTimeout(r,20)); } while(Date.now()<until); return null; };',
].join('\n');

const greeting = '您好，我对该岗位很感兴趣，具备相关项目经验，希望进一步沟通。';
const defaultGreeting = '您好！我对贵公司发布的AI开发工程师（AI应用方向）（TEST001）岗位很感兴趣，期待进一步了解。';
const reportedDefaultGreeting = '您好！我对贵公司发布的  Python后端软件开发实习生 【 深圳-南山区 】很感兴趣，期待进一步了解。';
assert.equal(IM.isLiepinDefaultGreeting(reportedDefaultGreeting), true, '用户报告的默认句不含额外“岗位”二字');
assert.equal(IM.isLiepinDefaultGreeting(defaultGreeting), true, '保留原默认模板兼容');
for (const actual of [greeting, '您好，我已确认面试时间，谢谢。', reportedDefaultGreeting + '我已确认面试时间。']) assert.equal(IM.isLiepinDefaultGreeting(actual), false, '普通文案/实际沟通不能视为平台默认句');
const modal = '<div class="im-ui-chat-modal-container"><div class="chat-header">招聘者甲</div><textarea placeholder="请输入消息"></textarea><button>发送</button></div>';
// 公开猎聘组件：chat-input 内的 textarea 和 input-actions/basic-send-btn。
const officialModal = '<div class="im-ui-chat-modal-container"><div class="chat-header">招聘者甲</div><div class="im-ui-chat-input"><div class="im-ui-input-content"><textarea class="im-ui-textarea" maxlength="800" placeholder="请输入文字，按Enter键发送"></textarea></div><div class="im-ui-input-actions"><button class="im-ui-basic-send-btn"><span>发送</span></button></div></div></div>';
const officialMessage = (message, direction = 'send', extra = '') => `<div class="im-ui-message-item"><div class="im-ui-message-item-body im-ui-message-item-${direction}"><div class="userAvatar">头像</div><div class="im-ui-message-item-content-wrap"><div class="im-ui-message-item-normal-message-wrapper"><div><p>${message}</p></div><div class="im-ui-message-item-extra-info"><span class="im-ui-message-item-opposite-readed">未读</span>${extra}</div></div></div></div></div>`;
const mount = '<div id="im-c-entry" style="width:0;height:0"><textarea style="position:absolute;top:60px;left:20px" placeholder="请输入消息"></textarea><button style="position:absolute;top:120px;left:20px">发送</button></div>';
const append = (html) => `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});`;
const tests = [
  { name: '普通聊天窗口', click: append(modal), stage: 'success' },
  { name: '官方输入区域的发送按钮', click: append(officialModal), stage: 'success' },
  { name: '官方输入区域完整166字文案发送确认', greeting: greeting.repeat(6).slice(0,166), click: append(officialModal), stage: 'success' },
  { name: '官方输入区域位于开放shadow root', click: `const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);root.attachShadow({mode:'open'}).innerHTML=${JSON.stringify(officialModal)};`, stage: 'success' },
  { name: '官方输入区域位于同源iframe', click: `const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);const frame=document.createElement('iframe');frame.srcdoc=${JSON.stringify(officialModal)};root.append(frame);`, stage: 'success' },
  { name: '官方按钮有中文间空格仍识别', click: append(officialModal.replace('<span>发送</span>', '<span>发 送</span>')), stage: 'success' },
  { name: '官方输入区域不受其他发送按钮干扰', click: append(officialModal.replace('<div class="im-ui-chat-input">', '<button class="image-confirm">发送</button><div class="im-ui-chat-input">')), stage: 'success' },
  { name: '官方按钮缺失时不点输入区域外的发送按钮', click: append(officialModal.replace('<button class="im-ui-basic-send-btn"><span>发送</span></button>', '').replace('<div class="im-ui-chat-input">', '<button>发送</button><div class="im-ui-chat-input">')), stage: 'failed', review: true, sends: 0, messageIncludes: '未找到唯一可用的发送按钮' },
  { name: '官方按钮禁用时不点其他发送按钮', click: append(officialModal.replace('class="im-ui-basic-send-btn"', 'class="im-ui-basic-send-btn" disabled').replace('<div class="im-ui-chat-input">', '<button>发送</button><div class="im-ui-chat-input">')), stage: 'failed', review: true, sends: 0, messageIncludes: '官方按钮 1，禁用 1，可用 0' },
  { name: '官方按钮隐藏时不点其他发送按钮', click: append(officialModal.replace('class="im-ui-basic-send-btn"', 'class="im-ui-basic-send-btn" style="display:none"').replace('<div class="im-ui-chat-input">', '<button>发送</button><div class="im-ui-chat-input">')), stage: 'failed', review: true, sends: 0, messageIncludes: '官方按钮 1，禁用 0，可用 0' },
  { name: '官方输入区域多个官方按钮不猜测', click: append(officialModal.replace('</button>', '</button><button class="im-ui-basic-send-btn">发送</button>')), stage: 'failed', review: true, sends: 0, messageIncludes: '官方按钮 2，禁用 0，可用 2' },
  { name: '官方按钮延迟启用后发送', click: append(officialModal.replace('class="im-ui-basic-send-btn"', 'class="im-ui-basic-send-btn" disabled')), afterInput: "setTimeout(()=>{writtenWidget.element.querySelector('.im-ui-basic-send-btn').disabled=false;},150);", stage: 'success' },
  { name: '输入被截断时不发送并显示字数', click: append(officialModal), afterInput: "writtenWidget.editor.value=writtenWidget.editor.value.slice(0,-1);", stage: 'failed', review: true, sends: 0, messageIncludes: '输入文字核对失败' },
  { name: '填写时切换会话显示会话变化', click: append(officialModal), afterInput: "document.querySelector('.chat-header').textContent='招聘者丙';", stage: 'failed', review: true, sends: 0, messageIncludes: '目标会话已变化' },
  { name: '首个窗口隐藏，第二个可见', before: append(modal.replace('class="im-ui-chat-modal-container"', 'class="im-ui-chat-modal-container" style="display:none"')), click: append(modal), stage: 'success' },
  { name: '无尺寸挂载点的可见编辑区', click: append(mount), stage: 'success' },
  { name: '开放 shadow root', click: "const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);root.attachShadow({mode:'open'}).innerHTML='<textarea placeholder=请输入消息></textarea><button>发送</button>';", stage: 'success' },
  { name: '同源 iframe 编辑区', click: "const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);const frame=document.createElement('iframe');frame.srcdoc='<textarea placeholder=请输入消息></textarea><button>发送</button>';root.append(frame);", stage: 'success' },
  { name: '只有我的沟通入口', before: append('<div class="im-ui-basic-entry-title">我的沟通</div>'), stage: 'failed', review: true },
  { name: '隐藏窗口不算成功', click: append(modal.replace('class="im-ui-chat-modal-container"', 'class="im-ui-chat-modal-container" style="display:none"')), stage: 'failed', review: true },
  { name: '透明窗口不算成功', click: append(modal.replace('class="im-ui-chat-modal-container"', 'class="im-ui-chat-modal-container" style="opacity:0"')), stage: 'failed', review: true },
  { name: '页面其他输入区不算会话', before: append('<textarea placeholder="留言"></textarea>'), stage: 'failed', review: true },
  { name: '挂载点内搜索框不算会话', click: append('<div id="im-c-entry"><textarea placeholder="搜索联系人"></textarea></div>'), stage: 'failed', review: true },
  { name: '无提示词的单行搜索框不算会话', click: append('<div id="im-c-entry"><input role="textbox"></div>'), stage: 'failed', review: true },
  { name: '旧会话没有切换', before: append(modal), stage: 'failed', review: true },
  { name: '旧窗口切换目标招聘者', before: append(modal), click: "document.querySelector('.chat-header').textContent='招聘者乙';", stage: 'success' },
  { name: '仅按钮变为继续聊不算发送成功', click: "document.querySelector('.btn-main').textContent='继续聊';", stage: 'failed', review: true },
  { name: '继续聊打开空会话，补发真实招呼语', label: '继续聊', click: append(modal), stage: 'success' },
  { name: '延迟创建聊天窗口', click: `setTimeout(()=>{${append(modal)}},150);`, stage: 'success' },
  { name: '安全验证优先于聊天成功', click: append(modal + '<div class="ant-modal">请完成安全验证</div>'), stage: 'risk', code: 35 },
  { name: '隐藏 iframe 不算成功', click: "const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);const frame=document.createElement('iframe');frame.style.display='none';frame.srcdoc='<textarea></textarea>';root.append(frame);", stage: 'failed', review: true },
  { name: '不可读取的 iframe 不猜成功', click: "const root=document.createElement('div');root.id='im-c-entry';document.body.append(root);const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.srcdoc='<textarea></textarea>';root.append(frame);", stage: 'failed', review: true },
  { name: '窗口打开但没有文字消息不算成功', click: append(modal), noBubble: true, stage: 'failed', review: true },
  { name: '页面正文出现招呼语不算消息', before: append(`<p>${greeting}</p>`), click: append(modal), noBubble: true, stage: 'failed', review: true },
  { name: '另一个窗口的消息不算成功', before: append('<div class="other-chat"></div>'), click: append(modal), wrongWindow: true, stage: 'failed', review: true },
  { name: '输入框仍有文字不算已发送', click: append(modal), retainEditor: true, stage: 'failed', review: true },
  { name: '招聘方同文消息不算我方发送', click: append(modal), bubbleClass: 'message-left incoming', stage: 'failed', review: true },
  { name: '发送失败消息不算成功', click: append(modal), bubbleClass: 'message-right send-fail', stage: 'failed', review: true },
  { name: '发送中消息不算成功', click: append(modal), bubbleClass: 'message-right sending', stage: 'failed', review: true },
  { name: '前缀相同的其他消息不算成功', click: append(modal), bubbleText: greeting + '其他内容', stage: 'failed', review: true },
  { name: '目标会话变化立即停止', click: append(modal), afterSend: "document.querySelector('.chat-header').textContent='招聘者丙';", stage: 'failed', review: true },
  { name: '已有同文招呼语不重复发送', click: append(modal.replace('</textarea>', `</textarea><div class="message-right">${greeting}</div>`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '继续聊已有我方消息不重复发送', label: '继续聊', click: append(modal.replace('</textarea>', '</textarea><div class="message-right">以前的真实招呼语</div>')), stage: 'skip', sends: 0, writes: 0 },
  { name: '已有草稿不覆盖', click: append(modal.replace('</textarea>', '用户尚未发送的草稿</textarea>')), stage: 'failed', review: true, sends: 0, writes: 0 },
  { name: '真实输入失败不点击发送', click: append(modal), inputFail: true, stage: 'failed', review: true, sends: 0 },
  { name: '没有发送按钮保留草稿', click: append(modal.replace('<button>发送</button>', '')), stage: 'failed', review: true, sends: 0 },
  { name: '多个发送按钮拒绝猜测', click: append(modal.replace('<button>发送</button>', '<button>发送</button><button>发送</button>')), stage: 'failed', review: true, sends: 0 },
  { name: '语义明确的单行消息框', click: append(modal.replace('<textarea placeholder="请输入消息"></textarea>', '<input type="text" placeholder="请输入消息">')), stage: 'success' },
  { name: 'contenteditable 编辑器', click: append(modal.replace('<textarea placeholder="请输入消息"></textarea>', '<div contenteditable="true" style="width:200px;height:50px"></div>')), stage: 'success' },
  { name: '空招呼语不点击聊一聊', greeting: '', stage: 'failed', clicks: 0, sends: 0, writes: 0 },
  { name: '无法确认消息来自本人时不猜成功', click: append(modal), bubbleClass: 'message-unknown', stage: 'failed', review: true },
  { name: '原文提及安全验证的业务经历不算风控', greeting: '您好，我参与过安全验证与验证码业务模块的开发，希望进一步沟通。', click: append(modal), stage: 'success' },
  { name: '同一投递请求重复到达只发一次', click: append(modal), duplicateSame: true, stage: 'success' },
  { name: '并发第二个投递请求被拒绝', click: append(modal), duplicateOther: true, stage: 'success' },
  { name: '猎聘官方本人消息类确认发送', click: append(modal), bubbleClass: 'im-ui-message-item-body im-ui-message-item-send', stage: 'success' },
  { name: '猎聘官方招聘方消息类不算本人发送', click: append(modal), bubbleClass: 'im-ui-message-item-body im-ui-message-item-receive', stage: 'failed', review: true },
  { name: '猎聘官方发送中图标不算成功', click: append(modal), bubbleClass: 'im-ui-message-item-body im-ui-message-item-send', bubbleChild: '<span class="im-ui-message-item-loadingicon im-ui-message-item-loadingicon-send" style="display:inline-block;width:16px;height:16px"></span>', stage: 'failed', review: true },
  { name: '猎聘官方失败图标不算成功', click: append(modal), bubbleClass: 'im-ui-message-item-body im-ui-message-item-send', bubbleChild: '<span class="im-ui-message-item-failed-icon im-ui-message-item-failed-icon-send" style="display:inline-block;width:16px;height:16px"></span>', stage: 'failed', review: true },
  { name: '猎聘官方发送完成隐藏加载图标后确认', click: append(modal), bubbleClass: 'im-ui-message-item-body im-ui-message-item-send', bubbleChild: '<span class="im-ui-message-item-loadingicon im-ui-message-item-loadingicon-send" style="display:inline-block;width:16px;height:16px"></span>', afterSend: "setTimeout(()=>{document.querySelector('.im-ui-message-item-loadingicon').style.display='none';},150);", stage: 'success' },
  { name: '平台默认句不阻止发送工作台文案', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}`)), stage: 'success' },
  { name: '继续聊仅有平台默认句时发送工作台文案', label: '继续聊', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}`)), stage: 'success' },
  { name: '默认句带已读状态且文案以官方结构发送', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}`)), bubbleClass: 'fixture-message', bubbleHtml: officialMessage(greeting), stage: 'success' },
  { name: '默认句与已有工作台文案不重复发送', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}${officialMessage(greeting)}`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '默认句与其他真实我方消息不重复发送', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}${officialMessage('我已确认面试时间，谢谢。')}`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '默认句与招聘方实际回复视为已有沟通', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}${officialMessage('请问什么时候可以到岗？', 'receive')}`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '默认句不遮蔽未发送草稿', click: append(modal.replace('</textarea>', `已有待发草稿</textarea>${officialMessage(defaultGreeting)}`)), stage: 'failed', review: true, sends: 0, writes: 0 },
  { name: '默认句不替代新增文案的发送确认', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}`)), noBubble: true, stage: 'failed', review: true },
  { name: '普通您好文案不被当作平台默认句', click: append(modal.replace('</textarea>', `</textarea>${officialMessage('您好，我做过检索系统项目，希望沟通具体工作内容。')}`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '用户报告的默认句没有岗位二字仍发送工作台文案', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}`)), stage: 'success' },
  { name: '继续聊含无岗位二字的默认句仍发送当前文案', label: '继续聊', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}`)), stage: 'success' },
  { name: '用户默认句加已发送的当前文案仍跳过', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}${officialMessage(greeting)}`)), stage: 'skip', sends: 0, writes: 0, messageIncludes: '与当前工作台文案相同' },
  { name: '用户默认句加HR回复仍跳过首次招呼', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}${officialMessage('请问什么时候可以到岗？', 'receive')}`)), stage: 'skip', sends: 0, writes: 0, messageIncludes: '已有招聘方回复' },
  { name: '用户默认句加实际面试沟通仍跳过', click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}${officialMessage('我已确认面试时间，谢谢。')}`)), stage: 'skip', sends: 0, writes: 0, messageIncludes: '默认句以外的本人消息' },
  { name: '当前文案就是平台默认句时不重复发同文', greeting: reportedDefaultGreeting, click: append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}`)), stage: 'skip', sends: 0, writes: 0 },
  { name: '填写期间收到HR回复保留草稿不发送', click: append(modal), afterInput: `writtenWidget.element.insertAdjacentHTML('beforeend',${JSON.stringify(officialMessage('请问什么时候可以到岗？', 'receive'))});`, stage: 'failed', review: true, sends: 0 },
  { name: '填写期间当前文案已出现时不重复发', click: append(modal), afterInput: `writtenWidget.element.insertAdjacentHTML('beforeend',${JSON.stringify(officialMessage(greeting))});`, stage: 'failed', review: true, sends: 0 },
  { name: '填写期间出现平台默认句仍发送真实文案', click: append(modal), afterInput: `writtenWidget.element.insertAdjacentHTML('beforeend',${JSON.stringify(officialMessage(reportedDefaultGreeting))});`, stage: 'success' },
];
const sharedTests = [
  { name: '共享快照选择官方按钮并暴露计数', script: `${append(officialModal.replace('<div class="im-ui-chat-input">', '<button>发送</button><div class="im-ui-chat-input">'))}const state=snapshotLiepinDelivery(document,{greeting});return state.sendReady&&state.readiness.officialSendButtons===1&&state.readiness.sendCandidates===1&&document.querySelector('[data-bossclaw-liepin-send="active"]').classList.contains('im-ui-basic-send-btn');` },
  { name: '共享快照官方按钮禁用不使用其他按钮', script: `${append(officialModal.replace('class="im-ui-basic-send-btn"','class="im-ui-basic-send-btn" disabled').replace('<div class="im-ui-chat-input">', '<button>发送</button><div class="im-ui-chat-input">'))}const state=snapshotLiepinDelivery(document,{greeting});return !state.sendReady&&state.readiness.disabledOfficialSendButtons===1&&state.readiness.sendCandidates===0;` },
  { name: '共享快照只标记新会话', script: `${append(modal)}snapshotLiepinDelivery(document,{phase:'before'});const old=document.querySelector('textarea');const unchanged=snapshotLiepinDelivery(document);${append(modal.replace('招聘者甲','招聘者乙'))}const target=snapshotLiepinDelivery(document);return !unchanged.ready&&target.ready&&old.getAttribute('data-bossclaw-liepin-editor')==='previous'&&document.querySelectorAll('[data-bossclaw-liepin-editor="active"]').length===1&&document.querySelectorAll('[data-bossclaw-liepin-send="active"]').length===1;` },
  { name: '共享快照在选中后拒绝切换招聘者', script: `${append(modal)}snapshotLiepinDelivery(document,{phase:'before'});document.querySelector('.chat-header').textContent='招聘者乙';const selected=snapshotLiepinDelivery(document);document.querySelector('.chat-header').textContent='招聘者丙';return selected.ready&&snapshotLiepinDelivery(document).changed===true;` },
  { name: '共享快照遇到多个新会话不猜目标', script: `${append(modal+modal.replace('招聘者甲','招聘者乙'))}return !snapshotLiepinDelivery(document).ready&&document.querySelectorAll('[data-bossclaw-liepin-send="active"]').length===0;` },
  { name: '共享快照只认可本人完整文字气泡', script: `${append(modal)}const root=document.querySelector('.im-ui-chat-modal-container');root.insertAdjacentHTML('beforeend','<div class="message-left">'+greeting+'</div><div class="message-right">'+greeting+'</div>');const state=snapshotLiepinDelivery(document,{greeting});return state.matching===1&&state.outgoing===1;` },
  { name: '共享快照区分默认句和实际沟通', script: `${append(modal.replace('</textarea>', `</textarea>${officialMessage(defaultGreeting)}`))}const defaults=snapshotLiepinDelivery(document,{greeting});${append('')}document.querySelector('.im-ui-chat-modal-container').insertAdjacentHTML('beforeend',${JSON.stringify(officialMessage(greeting))});const sent=snapshotLiepinDelivery(document,{greeting});return defaults.defaultOutgoing===1&&defaults.nonDefaultOutgoing===0&&defaults.incoming===0&&sent.defaultOutgoing===1&&sent.nonDefaultOutgoing===1&&sent.matching===1;` },
  { name: 'Camoufox共享快照识别用户无岗位二字的默认句', script: `${append(modal.replace('</textarea>', `</textarea>${officialMessage(reportedDefaultGreeting)}`))}const state=snapshotLiepinDelivery(document,{greeting});return state.defaultOutgoing===1&&state.nonDefaultOutgoing===0&&state.matching===0;` },
];
const temp = mkdtempSync(join(tmpdir(), 'bossclaw-liepin-im-test-'));
const entry = join(temp, 'main.cjs');
const reportPath = join(temp, 'report.json');
writeFileSync(entry, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.setName('BossClawLiepinImRegression');
fs.mkdirSync(path.join(__dirname,'profile'),{recursive:true});
app.setPath('userData',path.join(__dirname,'profile'));
app.setPath('sessionData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>callback({cancel:true}));
 const results=[];
 try {
  for (const test of ${JSON.stringify(tests)}) {
   await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>textarea{width:200px;height:50px} .im-ui-chat-modal-container{width:300px;padding:10px}</style><a class="btn-main" data-selector="chat-chat">'+(test.label||'聊一聊')+'</a>'));
   const script='(async()=>{let clicked=0,writes=0,sends=0;const test='+JSON.stringify(test)+';const greeting='+JSON.stringify(test.greeting===undefined?${JSON.stringify(greeting)}:test.greeting)+';const results=[];const notify=(channel,data)=>{if(channel==="platform-apply-result")results.push(data);};'+${JSON.stringify(injected)}+String.fromCharCode(10)+(test.before||'')+String.fromCharCode(10)+'document.querySelector(".btn-main").addEventListener("click",()=>{clicked++;'+(test.click||'')+'});const task=platformApply({seq:"test",platform:"liepin",greeting});if(test.duplicateSame)await platformApply({seq:"test",platform:"liepin",greeting});if(test.duplicateOther)await platformApply({seq:"other",platform:"liepin",greeting});await task;return {clicked,writes,sends,results};})()';
   results.push({name:test.name,...await win.webContents.executeJavaScript(script)});
   fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(results));
  }
  for(const test of ${JSON.stringify(sharedTests)}){
   await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>textarea{width:200px;height:50px} .im-ui-chat-modal-container{width:300px;padding:10px}</style>'));
   const script='(()=>{const greeting='+${JSON.stringify(JSON.stringify(greeting))}+';'+${JSON.stringify([IM.readLiepinImState, IM.normalizeLiepinText, IM.isLiepinDefaultGreeting, IM.readLiepinDeliveryState, IM.snapshotLiepinDelivery].map(fn=>fn.toString()).join('\n'))}+String.fromCharCode(10)+test.script+'})()';
   results.push({name:test.name,passed:await win.webContents.executeJavaScript(script)});
  }
  fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(results));
 }catch(error){fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({error:error.stack}));}
 finally{win.destroy();app.quit();}
});
`);
const electron = process.env.BOSSCLAW_ELECTRON || require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
new vm.Script(readFileSync(entry, 'utf8'), { filename: entry });
const proc = spawnSync(electron, [entry], { env, windowsHide: true, timeout: 60000, encoding: 'utf8' });
assert.equal(proc.status, 0, proc.error?.message || proc.stderr);
const results = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.ok(Array.isArray(results), results.error);
for (let i = 0; i < tests.length; i++) {
  const expected = tests[i], actual = results[i];
  assert.equal(actual.results.length, expected.duplicateOther ? 2 : 1, `${expected.name}: 每个请求只能回传一次终态`);
  const result = actual.results.find(result=>result.seq==='test');
  if(expected.duplicateOther)assert.equal(actual.results.find(result=>result.seq==='other').needsReview,true);
  assert.equal(result.stage, expected.stage, `${expected.name}: ${JSON.stringify(result)}`);
  assert.equal(actual.clicked, expected.clicks ?? 1, expected.name);
  if (expected.review) assert.equal(result.needsReview, true, expected.name);
  if (expected.code) assert.equal(result.code, expected.code, expected.name);
  if (expected.messageIncludes) assert.ok((result.message||result.error||'').includes(expected.messageIncludes), `${expected.name}: ${JSON.stringify(result)}`);
  if (expected.stage === 'success') { assert.equal(result.greetingConfirmed, true, expected.name); assert.equal(actual.sends, 1, expected.name); }
  if (expected.sends !== undefined) assert.equal(actual.sends, expected.sends, expected.name);
  if (expected.writes !== undefined) assert.equal(actual.writes, expected.writes, expected.name);
}
for(let i=0;i<sharedTests.length;i++)assert.equal(results[tests.length+i]?.passed,true,sharedTests[i].name);

// 运行真实工作台处理函数：未知结果要释放锁、保留标签、暂停队列；确认成功才计数。
const wb = readFileSync(join(root, 'src/pages/Workbench.tsx'), 'utf8');
const start = wb.indexOf('  const deliverNonBoss = async');
const end = wb.indexOf('  /** 通道 B：', start);
const compiled = await transform(wb.slice(start, end) + '\nglobalThis.deliverNonBoss = deliverNonBoss;', { loader: 'ts' });
for (const response of [{ ok: false, stage: 'failed', needsReview: true, error: '结果未确认', tabId: 'test' }, { ok: true, stage: 'success', tabId: 'test' }]) {
  const calls = { closed: 0, paused: 0, delivered: 0, next: 0, released: 0, statuses: [], applyArgs: null };
  const currentGreeting = greeting + '这是最新修改后的招呼语。';
  const context = vm.createContext({
    claimDelivery: () => true, releaseDelivery: () => calls.released++, setApplyStage: () => {}, addLog: () => {},
    awaitDeliveryGap: async () => {}, platformLabel: () => '猎聘',
    useDataStore: { getState: () => ({ pending: [{ id: 'test', deliveryGreeting: currentGreeting }] }) },
    webviewApi: { current: { platformApply: async (...args) => {calls.applyArgs=args;return response;}, closeTab: () => calls.closed++ } },
    useAppStore: { getState: () => ({ autoAssist: true }) },
    handleDelivered: () => calls.delivered++, updatePending: (_id, data) => calls.statuses.push(data.status),
    recomputeStats: () => {}, pauseAssist: () => calls.paused++, requestRunNext: () => calls.next++,
  });
  vm.runInContext(compiled.code, context);
  await context.deliverNonBoss({ id: 'test', deliveryGreeting: greeting, job: { platform: 'liepin', title: '测试岗位' } }, 'https://www.liepin.com/job/1.shtml');
  assert.equal(calls.released, 1);
  assert.equal(calls.applyArgs[3], currentGreeting, '工作台必须传递最新招呼语');
  assert.equal(calls.closed, 0);
  assert.equal(calls.next, 0);
  assert.equal(calls.paused, response.ok ? 0 : 1);
  assert.equal(calls.delivered, response.ok ? 1 : 0);
  if (!response.ok) assert.deepEqual(calls.statuses, ['failed']);
}
console.log(`猎聘 IM 回归通过：${tests.length} 个真实 DOM 场景、${sharedTests.length} 个共享快照场景、2 个工作台结果处理场景。报告：${reportPath}`);
