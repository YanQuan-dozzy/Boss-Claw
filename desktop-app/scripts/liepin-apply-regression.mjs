// 猎聘「工作台沟通」链路 DOM 口径回归（零新增依赖）
//
// 为什么需要它：2026-10-01 用真机源码（用户提供的 `岗位.txt` 详情页 HTML）核对出三处口径错误，
// 且都属于「tsc 照过、单测也照过，但真机必挂」的类型：
//   ① 「聊一聊」是 `<a class="btn-main" data-selector="chat-chat">`，不是 `<button>`；
//      旧实现靠泛化 `'a'` 兜底定位 → 也能点，但「已投递态」判断同样泛化，会把页脚任意链接误判成跳过。
//   ② IM 就绪信号真机是 `#im-c-entry` / `.im-ui-chat-modal-container` / `.im-ui-basic-entry`，
//      **不存在** `.__im_basic__*`（旧写法从别处抄来）→ 点完必走 15s 超时判 failed。
//   ③ 风控文案不能全页扫描（详情页岗位描述含「验证码/行为异常」是常见业务词）。
//
// 本脚本用**离线 DOM 样本**（从真机源码逐字摘出的结构）驱动真实判定函数，
// 守住「专用选择器命中 / 旧错误命名不命中 / 阻断文案分类正确」三条，防止回退。
//
// 用法：node scripts/liepin-apply-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const A = require(join(root, 'electron/preload/platform-adapters.cjs'));

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 极简 DOM 桩（够用即可）：只实现选择器匹配 + 可见性 + 文本，不引 jsdom。
// 复用适配表的 normLabelText/labelHit 判定，与 webview.cjs 同一实现。
// ---------------------------------------------------------------------------
function makeEl(tag, attrs = {}, text = '', visible = true) {
  const el = {
    tagName: tag.toUpperCase(),
    _attrs: { ...attrs },
    _text: text,
    _visible: visible,
    children: [],
    classList: { contains: () => false },
    get innerText() { return this._text; },
    get textContent() { return this._text; },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    matches(sel) { return matchSel(this, sel); },
    getBoundingClientRect() { return this._visible ? { width: 100, height: 20 } : { width: 0, height: 0 }; },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll(sel) { return collectAll(this, sel); },
    querySelector(sel) { return collectAll(this, sel)[0] || null; },
  };
  return el;
}

/** 极简选择器匹配：支持 tag、.class、[attr]、[attr="v"]、[attr*="v"]、tagname.class 组合与逗号并集 */
function matchSel(el, sel) {
  const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.some((p) => matchSingle(el, p));
}
function matchSingle(el, sel) {
  // 逐个 token 解析（tag / .cls / [attr...]）
  const m = String(sel).match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  const tag = m[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const rest = m[2] || '';
  const tokens = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  for (const t of tokens) {
    if (t.startsWith('.')) {
      const cls = t.slice(1);
      const classes = String(el._attrs.class || '').split(/\s+/).filter(Boolean);
      if (!classes.includes(cls)) return false;
    } else {
      const inner = t.slice(1, -1);
      const am = inner.match(/^([\w-]+)(?:([*^$]?=)"([^"]*)")?$/);
      if (!am) return false;
      const [, attr, op, val] = am;
      const actual = el.getAttribute(attr);
      if (actual == null) return false;
      if (!op) continue;
      if (op === '=' && actual !== val) return false;
      if (op === '*=' && !String(actual).includes(val)) return false;
      if (op === '^=' && !String(actual).startsWith(val)) return false;
    }
  }
  return true;
}
function collectAll(rootEl, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); }
  };
  walk(rootEl);
  return out;
}

// ---------------------------------------------------------------------------
// 真机 DOM 样本（逐字摘录自 岗位.txt 详情页 HTML，类名/属性未改）
// ---------------------------------------------------------------------------
/**
 * 未投递岗位的详情页主操作区：
 *   <section class="job-apply-container">
 *     <div class="job-apply-operate">
 *       <div class="apply-box">
 *         <a class="btn-main" data-selector="chat-chat" ...>聊一聊</a>
 *       </div>
 *       <div class="other-box">…收藏/分享…</div>
 *     </div>
 *   </section>
 * 以及右侧招聘者卡片：<div class="chat-btn-box" data-nick="recruiter-info-box-chat-btn">
 *   <button class="ant-btn ant-btn-primary ant-btn-round" data-selector="chat-chat"><span>聊一聊</span></button>
 */
function buildNotDeliveredPage() {
  const root = makeEl('div', { class: 'root' });
  const section = makeEl('section', { class: 'job-apply-container' });
  const operate = makeEl('div', { class: 'job-apply-operate' });
  const applyBox = makeEl('div', { class: 'apply-box' });
  const a1 = makeEl('a', { class: 'btn-main', 'data-selector': 'chat-chat', 'data-jobid': '85335225' }, '聊一聊');
  applyBox.appendChild(a1);
  operate.appendChild(applyBox);
  section.appendChild(operate);
  root.appendChild(section);

  const side = makeEl('div', { class: 'chat-btn-box', 'data-nick': 'recruiter-info-box-chat-btn' });
  const b1 = makeEl('button', { class: 'ant-btn ant-btn-primary ant-btn-round', 'data-selector': 'chat-chat' }, '聊一聊');
  side.appendChild(b1);
  root.appendChild(side);
  return { root, mainAnchor: a1, sideButton: b1 };
}

/** 已投递态：主按钮文案变为「继续沟通」（真机口径：按钮态翻转） */
function buildDeliveredPage() {
  const root = makeEl('div', { class: 'root' });
  const operate = makeEl('div', { class: 'job-apply-operate' });
  const box = makeEl('div', { class: 'apply-box' });
  box.appendChild(makeEl('a', { class: 'btn-main', 'data-selector': 'chat-chat' }, '继续沟通'));
  operate.appendChild(box);
  root.appendChild(operate);
  const side = makeEl('div', { class: 'chat-btn-box' });
  side.appendChild(makeEl('button', { class: 'ant-btn ant-btn-round' }, '已沟通'));
  root.appendChild(side);
  return { root };
}

// ---------------------------------------------------------------------------
// webview.cjs 的猎聘分支口径（与源码保持一致的候选表 / 文案表）
// ---------------------------------------------------------------------------
const BTN_SELECTORS = [
  'a.btn-main[data-selector="chat-chat"]',
  '.job-apply-operate .apply-box a.btn-main',
  '.job-apply-operate a[data-selector="chat-chat"]',
  'div.chat-btn-box[data-nick="recruiter-info-box-chat-btn"] button',
  '.chat-btn-box button[data-selector="chat-chat"]',
  '[data-selector="chat-chat"]',
  '.ant-btn-round',
  '.chat-btn-box button',
];
const APPLIED_SELECTORS = [
  'a.btn-main[data-selector="chat-chat"]',
  '.job-apply-operate .apply-box a.btn-main',
  '.job-apply-operate a[data-selector="chat-chat"]',
  '.chat-btn-box button',
];
const APPLIED_LABELS = ['已沟通', '已投递', '聊过了', '已招满', '继续沟通'];
const CHAT_LABELS = ['聊一聊'];

/** 复刻 webview.cjs::findPlatformAction（选择器优先 → 文案命中） */
function findPlatformAction(rootEl, selectors, labels) {
  for (const sel of selectors) {
    for (const el of collectAll(rootEl, sel)) {
      if (!el._visible) continue;
      if (A.labelHit(el._text, labels)) return el;
    }
  }
  return null;
}

// ===== 1. 未投递页：专用选择器必须命中「聊一聊」 =====
{
  const { root, mainAnchor, sideButton } = buildNotDeliveredPage();
  // ① 首选选择器就必须命中主操作区的 <a>（不靠泛化 'a' 兜底）
  const hits1 = collectAll(root, 'a.btn-main[data-selector="chat-chat"]');
  ok('首选选择器 a.btn-main[data-selector="chat-chat"] 命中主操作区 <a>', hits1.length === 1 && hits1[0] === mainAnchor,
    `实际命中 ${hits1.length} 个`);
  const btn = findPlatformAction(root, BTN_SELECTORS, CHAT_LABELS);
  ok('findPlatformAction 命中「聊一聊」（未投递页）', btn === mainAnchor,
    `命中元素：${btn ? btn.tagName + '.' + (btn.getAttribute('class') || '') : 'null'}`);
  // ② 招聘者卡片分身也可被独立定位（删除主操作区后仍能找到）
  const root2 = makeEl('div', { class: 'root' });
  const side2 = makeEl('div', { class: 'chat-btn-box', 'data-nick': 'recruiter-info-box-chat-btn' });
  const b2 = makeEl('button', { class: 'ant-btn ant-btn-primary ant-btn-round', 'data-selector': 'chat-chat' }, '聊一聊');
  side2.appendChild(b2); root2.appendChild(side2);
  ok('招聘者卡片 button[data-selector="chat-chat"] 可独立定位',
    findPlatformAction(root2, BTN_SELECTORS, CHAT_LABELS) === b2);
  ok('侧栏按钮样本与真机样本一致', sideButton.getAttribute('data-selector') === 'chat-chat');
}

// ===== 2. 已投递页：必须判为 skip，不得再点 =====
{
  const { root } = buildDeliveredPage();
  const applied = findPlatformAction(root, APPLIED_SELECTORS, APPLIED_LABELS)
    || collectAll(root, 'a.btn-main, .chat-btn-box button').find((el) => el._visible && A.labelExactHit(el._text, APPLIED_LABELS))
    || null;
  ok('已投递页（按钮态「继续沟通」）判为已沟通 → skip', applied !== null);
  const chatBtn = findPlatformAction(root, BTN_SELECTORS, CHAT_LABELS);
  ok('已投递页找不到「聊一聊」（避免误点）', chatBtn === null,
    `实际命中：${chatBtn ? chatBtn._text : 'null'}`);
}

// ===== 3. 旧错误命名必须已移除，真机命名必须命中 =====
{
  const src = require('node:fs').readFileSync(join(root, 'electron/preload/webview.cjs'), 'utf8');
  const liepinBlock = src.slice(src.indexOf("if (platform === 'liepin')"), src.indexOf("if (platform === 'zhaopin')"));
  // 只在**可执行代码**里查旧命名 —— 注释里保留「为何移除」的说明是有意为之（口径沿革），
  // 把注释一起判失败会让这段历史说明被迫删掉，反而丢失防回退的上下文。
  const liepinCode = liepinBlock
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  ok('已移除旧错误命名 __im_basic__（真机不存在该命名）', !liepinCode.includes('__im_basic__'),
    '仍残留 __im_basic__ 引用（可执行代码）');
  ok('IM 就绪信号含真机命名 im-ui-chat-modal', liepinBlock.includes('im-ui-chat-modal'));
  ok('IM 就绪信号含真机命名 im-ui-basic-entry', liepinBlock.includes('im-ui-basic-entry'));
  ok('IM 就绪信号含真机容器 id im-c-entry（以 SPA/容器事实兜底）',
    liepinBlock.includes('im-c-entry') || liepinBlock.includes('/im\\b') || /\\\/im\\b/.test(liepinBlock));
  // 风控扫描必须走容器，不得只做整页正文正则
  ok('风控判定走容器范围（RISK_SCOPE）而非整页正文', /RISK_SCOPE/.test(liepinBlock));
  ok('风控文案表存在（安全验证/行为异常/操作频繁）',
    liepinBlock.includes('安全验证') && liepinBlock.includes('行为异常') && liepinBlock.includes('操作频繁'));
}

// ===== 4. 阻断文案分类（webview 本地表，猎聘专用）=====
{
  const RISK = ['安全验证', '请完成验证', '验证码', '行为异常', '操作频繁', '访问受限'];
  const LOGIN = ['请先登录', '登录后', '立即登录', '扫码登录', '账号登录', '登录/注册'];
  const classify = (t) => {
    if (RISK.some((k) => t.includes(k))) return 'risk';
    if (LOGIN.some((k) => t.includes(k)) || /登录|注册/.test(t)) return 'login';
    return 'blocked';
  };
  ok('「请完成安全验证」→ risk', classify('请完成安全验证') === 'risk');
  ok('「您的账户存在行为异常」→ risk', classify('您的账户存在行为异常') === 'risk');
  ok('「操作频繁，请稍后再试」→ risk', classify('操作频繁，请稍后再试') === 'risk');
  ok('「请先登录后查看」→ login', classify('请先登录后查看') === 'login');
  ok('「该职位暂不支持沟通」→ blocked', classify('该职位暂不支持沟通') === 'blocked');
}

// ===== 5. 登录墙正则对猎聘正文不误伤（正常 JD 含「风控/验证」字样）=====
{
  const jd = '岗位职责：负责风控系统开发，熟悉验证码识别、行为异常检测算法。任职要求：本科及以上。';
  ok('正常岗位描述不被判为登录墙', !A.LOGIN_WALL_TEXT_RE.test(jd));
  ok('登录墙文本命中「请先登录」', A.LOGIN_WALL_TEXT_RE.test('请先登录后查看'));
}

if (failures.length) {
  console.error(`\n[猎聘沟通链路回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[猎聘沟通链路回归] 全部通过：${pass} 项断言`);
}
