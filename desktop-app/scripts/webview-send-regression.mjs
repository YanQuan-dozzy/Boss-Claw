// Real Chromium DOM regressions of the production preload functions. No account,
// Electron IPC, remote page, or real delivery is involved. Click receipts use Chromium
// native mouse input; the input IPC and message response remain isolated fixture adapters.
// Run: node scripts/webview-send-regression.mjs
// Use BOSSCLAW_TEST_BROWSER for an existing Chromium binary; CI uses Playwright Chromium.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { chromium } = require('playwright-core');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'electron/preload/webview.cjs'), 'utf8');
const fixture = await readFile(join(root, 'scripts/fixtures/webview-send/conversation.html'), 'utf8');
const required = ['chatInput', 'createChatSendContext', 'currentChatSendInput', 'sendButton', 'captureOwnMessages', 'confirmOwnMessage', 'sendChatMessage', 'domApplyOnce', 'trustedClickElement', 'elementCenter'];
const replaced = new Set(['notify', 'waitFor', 'trustedInput', 'trustedHoverElement', 'sleep', 'jitterDelay', 'isContinueChatEntry', 'enterChat', 'communicateButton', 'notifyDiag', 'humanize', 'lastCursor']);

// AST ranges preserve the exact production declarations. Resolve helpers recursively;
// never evaluate the preload's IPC initialization or its unrelated top-level actions.
const ast = ts.createSourceFile('webview.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(ast.parseDiagnostics.length, 0, 'production preload must parse');
const declarations = new Map();
function inventory(statements) {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    }
    // The preload encloses its declarations in an immediately invoked function.
    if (ts.isExpressionStatement(statement)) {
      let expression = statement.expression;
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isCallExpression(expression)) {
        let callee = expression.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (ts.isFunctionExpression(callee) && callee.body) inventory(callee.body.statements);
      }
    }
  }
}
inventory(ast.statements);
const selected = new Map();
function include(name) {
  if (replaced.has(name) || selected.has(name)) return;
  const declaration = declarations.get(name);
  assert.ok(declaration, `missing production declaration: ${name}`);
  selected.set(name, declaration);
  function dependencies(node) {
    if (ts.isIdentifier(node) && declarations.has(node.text) && node.text !== name) {
      const parent = node.parent;
      const isProperty = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent));
      const isDeclaration = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node;
      if (!isProperty && !isDeclaration) include(node.text);
    }
    ts.forEachChild(node, dependencies);
  }
  dependencies(declaration);
}
for (const name of required) include(name);
const production = [...selected.values()].sort((a, b) => a.pos - b.pos).map((node) =>
  ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast)).join('\n');
assert.ok(!/\brequire\s*\(/.test(production), 'extracted send helpers must not initialize Electron or other modules');

const harness = `
const state = window.__sendTest = {
  clicks: [], hovers: [], inputs: [], notifications: [], waits: [], synthetic: [],
  clickOK: true, clickDelivered: true, clickWrongTarget: false, hoverOK: true, onClick: null, onPoll: null, beforeClick: null, onSettle: null, now: 100000,
};
Date.now = () => state.now;
const sleep = async (ms) => {
  state.now += Number(ms) || 0;
  if (ms === 51 && state.onSettle) await state.onSettle(state.pathTarget);
};
const jitterDelay = sleep;
let lastCursor = null;
const humanize = {
  buildMousePath(from, to) {
    state.pathTarget = document.elementFromPoint(to.x, to.y);
    return [{ ...from }, { ...to }];
  },
  settleDelayMs() { return 51; },
};
function notify(channel, data) { state.notifications.push({ channel, data }); }
async function waitFor(check, timeout = 12000, label = '') {
  const wait = { timeout, label, polls: 0 };
  state.waits.push(wait);
  for (let elapsed = 0; elapsed < timeout; elapsed += 200) {
    wait.polls += 1;
    if (state.onPoll) await state.onPoll(wait);
    const value = await check();
    if (value) return value;
    state.now += 200;
  }
  return null;
}
async function trustedInput(action, text, extra) {
  if (action === 'insertText') {
    state.inputs.push({ action, text });
    const editor = document.activeElement;
    if (!editor || (!editor.isContentEditable && !editor.matches('textarea,input'))) return { ok: false };
    if ('value' in editor) editor.value = text;
    else editor.textContent = text;
    return { ok: true };
  }
  if (action === 'hoverAt') {
    const target = state.pathTarget;
    state.hovers.push({ id: target?.id || '', path: extra.path });
    if (state.beforeClick) await state.beforeClick(target);
    return { ok: state.hoverOK };
  }
  if (action !== 'clickAt') throw new Error('unexpected trusted input: ' + action);
  if (extra.path) throw new Error('protected final clickAt must not carry an asynchronous path');
  const element = document.elementFromPoint(extra.x, extra.y);
  state.clicks.push({ id: element?.id || '', action, x: extra.x, y: extra.y });
  if (state.clickOK && state.clickDelivered) {
    const other = document.querySelector('#chat-input').getBoundingClientRect();
    await window.__sendNativeClick(state.clickWrongTarget ? other.left + 12 : extra.x,
      state.clickWrongTarget ? other.top + 12 : extra.y);
    if (!state.clickWrongTarget && state.onClick) await state.onClick(element);
  }
  return { ok: state.clickOK };
}
async function trustedHoverElement() { return true; }
function isContinueChatEntry() { return false; }
async function enterChat() { return null; }
function communicateButton() { return null; }
function notifyDiag(message) { notify('apply-stage', { stage: 'log', message }); }
const nativeClick = HTMLElement.prototype.click;
HTMLElement.prototype.click = function () { state.synthetic.push('element.click'); return nativeClick.call(this); };
const nativeDispatch = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function (event) {
  if (/^(click|keydown|keyup|keypress)$/.test(event.type)) state.synthetic.push(event.type);
  return nativeDispatch.call(this, event);
};
${production}
window.h = {
  state,
  greeting: '您好，我对贵公司的开发岗位很感兴趣，希望进一步了解岗位要求并交流我的项目经验。',
  input: () => document.querySelector('#current-panel #chat-input'),
  panel: () => document.querySelector('#current-panel'),
  button: () => document.querySelector('#current-panel #text-send'),
  context: () => createChatSendContext(document.querySelector('#current-panel #chat-input')),
  assert(value, message) { if (!value) throw new Error(message); },
  equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': actual=' + actual + ', expected=' + expected); },
  draft(text) { this.input().textContent = text === undefined ? this.greeting : text; },
  append(text, { panel = this.panel(), own = true, id = 'new-message', className = '', textClass = 'text' } = {}) {
    const row = document.createElement('li');
    row.className = 'message-item ' + (className || (own ? 'item-myself' : 'item-other'));
    if (id) row.setAttribute('data-message-id', id);
    const body = document.createElement('div');
    body.className = textClass;
    body.textContent = text;
    row.append(body);
    panel.querySelector('.im-list').append(row);
    return row;
  },
  otherPanel({ hidden = false } = {}) {
    const panel = this.panel().cloneNode(true);
    panel.id = 'other-panel';
    panel.querySelector('.chat-header').textContent = '测试 HR 乙 另一离线公司 另一测试岗位';
    panel.querySelector('#chat-input').id = 'other-input';
    panel.querySelector('#text-send').id = 'other-send';
    panel.querySelector('#image-send').id = 'other-image';
    panel.querySelector('#messages').id = 'other-messages';
    panel.hidden = hidden;
    document.body.prepend(panel);
    return panel;
  },
  confirm: confirmOwnMessage,
  baseline: captureOwnMessages,
  current: currentChatSendInput,
  sendButton,
  chatInput,
  createContext: createChatSendContext,
  send: sendChatMessage,
  apply: domApplyOnce,
};
`;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
test('input itself .chat-input still resolves sibling text send; image is first', () => {
  const h = window.h, ctx = h.context();
  h.assert(ctx && ctx.panel === h.panel(), 'context must bind the conversation');
  h.equal(h.sendButton(h.input(), { context: ctx })?.id, 'text-send', 'choose text send');
});
test('hidden old conversation does not affect active input or send scope', () => {
  const h = window.h; h.otherPanel({ hidden: true });
  h.equal(h.chatInput(), h.input(), 'ignore hidden stale input');
  h.equal(h.sendButton(h.input(), { context: h.context() })?.id, 'text-send', 'scope current send');
});
test('two visible chat panels make send context creation fail closed', () => {
  const h = window.h; h.otherPanel();
  h.equal(h.context(), null, 'ambiguous panel context');
});
test('another visible panel invalidates an existing send context', () => {
  const h = window.h; const ctx = h.context(); h.otherPanel();
  h.equal(h.current(ctx), null, 'multiple active editors');
  h.equal(h.sendButton(h.input(), { context: ctx }), null, 'no ambiguous-panel send');
});
test('global unrelated send cannot replace missing local send', () => {
  const h = window.h; h.button().remove();
  const button = document.createElement('button'); button.className = 'send-message'; button.textContent = '发送'; document.body.append(button);
  h.equal(h.sendButton(h.input(), { context: h.context() }), null, 'global button excluded');
});
test('image-only send is not a text send', () => {
  const h = window.h; h.button().remove();
  h.equal(h.sendButton(h.input(), { context: h.context() }), null, 'image control excluded');
});
test('icon-only button with explicit text send aria-label is recognized', () => {
  const h = window.h; h.button().textContent = ''; h.button().setAttribute('aria-label', '发送');
  h.equal(h.sendButton(h.input(), { context: h.context() })?.id, 'text-send', 'aria label send');
});
test('icon-only image aria-label is excluded despite send class', () => {
  const h = window.h; h.button().remove(); document.querySelector('#image-send').textContent = '';
  h.equal(h.sendButton(h.input(), { context: h.context() }), null, 'aria image control excluded');
});
test('two semantic local sends fail closed', () => {
  const h = window.h; h.button().after(h.button().cloneNode(true));
  h.equal(h.sendButton(h.input(), { context: h.context() }), null, 'ambiguous local send');
});
test('disabled button is discoverable only when explicitly requested', () => {
  const h = window.h; h.button().disabled = true;
  h.equal(h.sendButton(h.input(), { context: h.context() }), null, 'disabled default');
  h.equal(h.sendButton(h.input(), { context: h.context(), allowDisabled: true }), h.button(), 'disabled allowed');
});
test('removed editor invalidates current send context', () => {
  const h = window.h; const ctx = h.context(); h.input().remove();
  h.equal(h.current(ctx), null, 'removed editor');
});
test('search controls cannot establish a chat send context', () => {
  const h = window.h; h.input().setAttribute('aria-label', '搜索职位、公司');
  h.equal(h.context(), null, 'search editor excluded');
});
test('two visible editors in one panel make send context ambiguous', () => {
  const h = window.h; const copy = h.input().cloneNode(true); copy.id = 'second-chat-input'; h.input().after(copy);
  h.equal(h.context(), null, 'duplicate editor excluded');
});
test('textarea editor binds the same conversation scope', () => {
  const h = window.h; const textarea = document.createElement('textarea'); textarea.id = 'chat-input'; textarea.className = 'chat-input';
  textarea.setAttribute('aria-label', '消息输入框'); h.input().replaceWith(textarea);
  const ctx = h.context(); h.assert(ctx, 'textarea context');
  h.equal(h.sendButton(textarea, { context: ctx })?.id, 'text-send', 'textarea text send');
});
test('header identity changes invalidate context', () => {
  const h = window.h; const ctx = h.context(); ctx.header.textContent = '另一位 HR 另一岗位';
  h.equal(h.current(ctx), null, 'changed recipient');
});
test('URL session change invalidates context', () => {
  const h = window.h; const ctx = h.context(); history.replaceState({}, '', '?conversation=other');
  h.equal(h.current(ctx), null, 'changed session URL');
});
test('draft text alone never confirms an own message', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.equal(h.confirm(h.greeting, ctx, before), false, 'draft is not delivery');
});
test('historic identical own bubble never confirms a new send', () => {
  const h = window.h; h.append(h.greeting); const ctx = h.context(), before = h.baseline(ctx);
  h.equal(h.confirm(h.greeting, ctx, before), false, 'historic full bubble');
});
test('historic greeting prefix does not confirm', () => {
  const h = window.h; h.append(h.greeting.slice(0, 30)); const ctx = h.context(), before = h.baseline(ctx);
  h.equal(h.confirm(h.greeting, ctx, before), false, 'historic prefix');
});
test('new opponent identical text does not confirm', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.append(h.greeting, { own: false });
  h.equal(h.confirm(h.greeting, ctx, before), false, 'opponent text');
});
test('new partial own message does not confirm', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.append(h.greeting.slice(0, 30));
  h.equal(h.confirm(h.greeting, ctx, before), false, 'full body equality required');
});
test('new matching bubble in another conversation does not confirm', () => {
  const h = window.h; const other = h.otherPanel({ hidden: true }); const ctx = h.context(), before = h.baseline(ctx);
  h.append(h.greeting, { panel: other });
  h.equal(h.confirm(h.greeting, ctx, before), false, 'other conversation');
});
for (const ownClass of ['item-myself', 'item-self']) {
  for (const textClass of ['text', 'message-content', 'message-text']) {
    test(`new full own bubble confirms (${ownClass}/${textClass})`, () => {});
    cases[cases.length - 1].fn = new Function(`
      const h = window.h, ctx = h.context(), before = h.baseline(ctx);
      h.append(h.greeting, { className: ${JSON.stringify(ownClass)}, textClass: ${JSON.stringify(textClass)} });
      h.equal(h.confirm(h.greeting, ctx, before), true, 'new own full bubble');
    `);
  }
}
test('new full bubble while draft remains is not confirmation', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.append(h.greeting);
  h.equal(h.confirm(h.greeting, ctx, before), false, 'editor must clear');
});
test('new full own bubble without a message ID can confirm by node evidence', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.append(h.greeting, { id: '' });
  h.equal(h.confirm(h.greeting, ctx, before), true, 'new node after baseline tail');
});
test('short greeting requires full exact text rather than a length heuristic', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.append('您好');
  h.equal(h.confirm('您好', ctx, before), true, 'short full text');
});
// M-9 留痕：原实现确认阈值 <12 严于发送侧 ≥8，8-11 字招呼语真实发送后无法确认 → 误判 failed。
// A 的机制改为「全文精确匹配 + 新增气泡证据」，长度阈值整体退场；此用例固定 8-11 字窗口，
// 防止阈值以任何形式被重新引入。
test('8-11 char greeting confirms on full exact bubble (M-9 lineage)', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx);
  const greeting = '您好，我想应聘这个岗位';
  h.equal(greeting.length >= 8 && greeting.length <= 11, true, 'fixture stays inside the 8-11 char window');
  h.append(greeting);
  h.equal(h.confirm(greeting, ctx, before), true, 'M-9 window confirms by full text');
});
test('matching own message inserted before baseline tail is not new-send proof', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); const row = h.append(h.greeting);
  ctx.messages.prepend(row);
  h.equal(h.confirm(h.greeting, ctx, before), false, 'historic position');
});
for (const status of ['failed', 'sending']) {
  test(`matching own bubble in ${status} state does not confirm`, new Function(`
    const h = window.h, ctx = h.context(), before = h.baseline(ctx);
    h.append(h.greeting).setAttribute('data-status', ${JSON.stringify(status)});
    h.equal(h.confirm(h.greeting, ctx, before), false, 'not a completed bubble');
  `));
}
test('recreated historic own bubble with same message ID does not confirm', () => {
  const h = window.h; const old = h.append(h.greeting, { id: 'historic-copy' }); const ctx = h.context(), before = h.baseline(ctx);
  old.remove(); h.append(h.greeting, { id: 'historic-copy' });
  h.equal(h.confirm(h.greeting, ctx, before), false, 'historic identity survives redraw');
});
test('message list redraw invalidating the baseline tail fails closed', () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx);
  ctx.messages.replaceChildren(); h.append(h.greeting);
  h.equal(h.confirm(h.greeting, ctx, before), false, 'missing baseline tail');
});
test('historical duplicate greeting blocks send before clicking', async () => {
  const h = window.h; h.append(h.greeting); const ctx = h.context(), before = h.baseline(ctx); h.draft();
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'duplicate send blocked'); h.equal(h.state.clicks.length, 0, 'no duplicate click');
});
test('button never enabling times out without a click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.button().classList.add('disable');
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'enable timeout'); h.equal(h.state.clicks.length, 0, 'disabled never clicked');
  h.assert(h.state.waits.some(wait => wait.timeout === 4000), 'bounded 4s enable wait');
});
test('rebuild disabled send into enabled node during polling selects fresh node', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.button().disabled = true;
  h.state.onPoll = (wait) => {
    if (wait.timeout === 4000 && wait.polls === 2) {
      const fresh = h.button().cloneNode(true); fresh.disabled = false; fresh.id = 'rebuilt-send'; h.button().replaceWith(fresh);
    }
  };
  h.state.onClick = () => { h.input().textContent = ''; h.append(h.greeting); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, true, 'fresh button send succeeds'); h.equal(h.state.clicks[0]?.id, 'rebuilt-send', 'fresh node clicked');
  h.equal(h.state.clicks.length, 1, 'one click');
});
test('editor removed while waiting prevents send', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.button().disabled = true;
  h.state.onPoll = (wait) => { if (wait.timeout === 4000 && wait.polls === 2) { h.input().remove(); h.button().disabled = false; } };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'invalid editor blocked'); h.equal(h.state.clicks.length, 0, 'no invalid-editor click');
});
test('draft that differs from intended greeting prevents send', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft('另一个草稿');
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'draft mismatch'); h.equal(h.state.clicks.length, 0, 'mismatched draft not clicked');
});
test('trusted click false never reports success or retries', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.state.clickOK = false;
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'failed trusted click'); h.equal(h.state.clicks.length, 1, 'no fallback or retry');
});
test('IPC dispatch success without a native button click fails without retry', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.state.clickDelivered = false;
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'dispatch is not a click receipt'); h.equal(h.state.clicks.length, 1, 'one dispatch, no retry');
  const logs = h.state.notifications.filter(entry => entry.data.stage === 'log').map(entry => entry.data.message).join('|');
  h.assert(logs.includes('输入事件派发=通过') && logs.includes('按钮原生点击回执=失败'), 'message retains both receipt stages');
  h.assert(logs.includes('文字发送停止') && !logs.includes(h.greeting), 'failure survives without task and contains no greeting');
});
test('native click on another element is rejected despite successful IPC dispatch', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.state.clickWrongTarget = true;
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'wrong native click target'); h.equal(h.state.clicks.length, 1, 'no retry');
  h.assert(h.state.notifications.some(entry => entry.data.message?.includes('按钮原生点击回执=失败')), 'wrong-target receipt failure retained');
});
test('recipient change immediately before trusted click is rejected by final guard', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = () => { ctx.header.textContent = '不同 HR 不同岗位'; };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'changed identity guard'); h.equal(h.state.clicks.length, 0, 'no changed-recipient click');
  h.equal(h.state.hovers.length, 1, 'production hover completed before final guard');
});
test('URL change immediately before trusted click is rejected by final guard', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = () => { history.replaceState({}, '', '?conversation=changed'); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'changed URL guard'); h.equal(h.state.clicks.length, 0, 'no changed-session click');
});
test('button rebuilt after enable check is rejected before trusted click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = (button) => { button.replaceWith(button.cloneNode(true)); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'stale button guard'); h.equal(h.state.clicks.length, 0, 'no disconnected button click');
});
test('button disabled after enable check is rejected before trusted click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = (button) => { button.disabled = true; };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'disabled button guard'); h.equal(h.state.clicks.length, 0, 'no disabled click');
});
test('identical own bubble appearing before trusted click prevents duplicate send', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = () => { h.append(h.greeting); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'new duplicate guard'); h.equal(h.state.clicks.length, 0, 'no duplicate click');
});
for (const phase of ['settle', 'hover']) {
  test(`button moved during ${phase} uses fresh final coordinates`, new Function(`
    return (async () => {
      const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
      const original = h.button().getBoundingClientRect();
      const move = button => { button.style.transform = 'translate(90px, 25px)'; };
      h.state[${JSON.stringify(phase === 'settle' ? 'onSettle' : 'beforeClick')}] = move;
      h.state.onClick = element => {
        h.equal(element, h.button(), 'fresh coordinates hit the moved text button');
        const rect = element.getBoundingClientRect();
        h.state.clickedCenter = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        h.input().textContent = ''; h.append(h.greeting);
      };
      const result = await h.send(ctx, h.greeting, before);
      h.equal(result.ok, true, 'moved button send confirmed'); h.equal(h.state.clicks.length, 1, 'one moved-button click');
      const click = h.state.clicks[0];
      h.equal(click.x, h.state.clickedCenter.x, 'fresh X');
      h.equal(click.y, h.state.clickedCenter.y, 'fresh Y');
      h.assert(click.x !== Math.round(original.left + original.width / 2), 'old X never used');
      h.equal(h.state.hovers.length, 1, 'production hover performed once');
    })();
  `));
}
test('overlay covering text send after hover blocks trusted click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.beforeClick = button => {
    const rect = button.getBoundingClientRect();
    const overlay = document.createElement('div'); overlay.id = 'blocking-overlay';
    Object.assign(overlay.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', height: rect.height + 'px', zIndex: '9999', background: '#ddd' });
    document.body.append(overlay);
  };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'overlay blocks send'); h.equal(h.state.clicks.length, 0, 'overlay never clicked');
  h.equal(h.state.hovers.length, 1, 'overlay appeared during production hover');
});
test('overlay covering only button center uses an unobscured point within the same button', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  const rect = h.button().getBoundingClientRect(), cover = document.createElement('div');
  Object.assign(cover.style, { position: 'fixed', left: rect.left + rect.width * 0.3 + 'px', top: rect.top + 'px',
    width: rect.width * 0.4 + 'px', height: rect.height + 'px', zIndex: '9999', background: '#ddd' });
  document.body.append(cover);
  h.state.onClick = element => { h.equal(element, h.button(), 'same text button hit'); h.input().textContent = ''; h.append(h.greeting); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, true, 'partly covered send confirmed'); h.equal(h.state.clicks.length, 1, 'only one click');
  h.equal(cover.isConnected, true, 'overlay not removed');
});
test('partly clipped button with center outside viewport uses only the visible button portion', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  Object.assign(h.button().style, { position: 'fixed', left: innerWidth - 12 + 'px', top: '600px', width: '80px', margin: '0' });
  h.state.onClick = element => { h.equal(element, h.button(), 'visible portion belongs to text button'); h.input().textContent = ''; h.append(h.greeting); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, true, 'partly clipped send confirmed'); h.equal(h.state.clicks.length, 1, 'one clipped-button click');
  h.assert(h.state.clicks[0].x < innerWidth && h.state.clicks[0].x > innerWidth - 12, 'click stays in visible intersection');
});
test('failed hover receipt blocks the final trusted click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft(); h.state.hoverOK = false;
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'failed hover blocks send'); h.equal(h.state.clicks.length, 0, 'no click after failed hover');
  h.equal(h.state.hovers.length, 1, 'one hover attempt');
});
test('one trusted text click plus fresh full own bubble confirms success', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.onClick = () => { h.input().textContent = ''; h.append(h.greeting); };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, true, 'confirmed send'); h.equal(h.state.clicks.length, 1, 'exactly one click');
  h.equal(h.state.clicks[0].id, 'text-send', 'text button only');
});
test('confirmation timeout never triggers Enter or another click', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.onClick = () => { h.input().textContent = ''; };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'unconfirmed send'); h.equal(h.state.clicks.length, 1, 'one click after full timeout');
  h.assert(h.state.waits.some(wait => wait.timeout === 8000), 'bounded 8s confirmation wait');
  h.equal(h.state.synthetic.length, 0, 'no synthetic click or keyboard fallback');
  h.equal(result.clicked, true, 'report that the single click already occurred');
  h.assert(h.state.notifications.every(entry => entry.data.sent !== true), 'no success notification without confirmation');
});
test('recipient changes after click prevent confirmation and retry', async () => {
  const h = window.h, ctx = h.context(), before = h.baseline(ctx); h.draft();
  h.state.onClick = () => { h.input().textContent = ''; h.append(h.greeting); ctx.header.textContent = '不同收件人'; };
  const result = await h.send(ctx, h.greeting, before);
  h.equal(result.ok, false, 'cannot confirm after recipient change'); h.equal(h.state.clicks.length, 1, 'no second send');
});
test('domApplyOnce ambiguous panels stop before any input', async () => {
  const h = window.h; h.otherPanel();
  await h.apply({ greeting: h.greeting });
  h.equal(h.state.inputs.length, 0, 'ambiguous panel never filled'); h.equal(h.state.clicks.length, 0, 'ambiguous panel never clicked');
  h.assert(h.state.notifications.some(entry => entry.data.stage === 'failed' && entry.data.sent === false), 'preflight failure reported');
  h.assert(h.state.notifications.every(entry => entry.data.stage !== 'verify_result'), 'no success receipt');
});
test('domApplyOnce historical duplicate stops before any input', async () => {
  const h = window.h; h.append(h.greeting);
  await h.apply({ greeting: h.greeting });
  h.equal(h.state.inputs.length, 0, 'duplicate never filled'); h.equal(h.state.clicks.length, 0, 'duplicate never clicked');
  h.assert(h.state.notifications.some(entry => entry.data.stage === 'failed' && entry.data.sent === false), 'duplicate failure reported');
  h.assert(h.state.notifications.every(entry => entry.data.stage !== 'verify_result'), 'no duplicate success receipt');
});
test('domApplyOnce trusted click failure has no verify_result receipt', async () => {
  const h = window.h; h.state.clickOK = false;
  await h.apply({ greeting: h.greeting });
  h.equal(h.state.inputs.length, 1, 'one input receipt'); h.equal(h.state.clicks.length, 1, 'one click attempt');
  h.assert(h.state.notifications.some(entry => entry.data.stage === 'failed'), 'failed click reported');
  h.assert(h.state.notifications.every(entry => entry.data.stage !== 'verify_result' && entry.data.sent !== true), 'no successful send receipt');
});
test('domApplyOnce confirmation timeout has no verify_result receipt or retry', async () => {
  const h = window.h; h.state.onClick = () => { h.input().textContent = ''; };
  await h.apply({ greeting: h.greeting });
  h.equal(h.state.inputs.length, 1, 'one input'); h.equal(h.state.clicks.length, 1, 'one click');
  h.assert(h.state.notifications.some(entry => entry.data.stage === 'failed'), 'unconfirmed send failure reported');
  h.assert(h.state.notifications.every(entry => entry.data.stage !== 'verify_result' && entry.data.sent !== true), 'no unconfirmed success receipt');
});
test('domApplyOnce confirmed new own bubble produces exactly one sent:true verify_result', async () => {
  const h = window.h; h.state.onClick = () => { h.input().textContent = ''; h.append(h.greeting); };
  await h.apply({ greeting: h.greeting });
  h.equal(h.state.inputs.length, 1, 'one input'); h.equal(h.state.clicks.length, 1, 'one trusted click');
  const success = h.state.notifications.filter(entry => entry.data.stage === 'verify_result');
  h.equal(success.length, 1, 'one verify_result'); h.equal(success[0].data.sent, true, 'confirmed sent receipt');
  h.equal(success[0].data.ok, true, 'confirmed ok receipt');
  h.equal(h.state.notifications.filter(entry => entry.data.sent === true).length, 1, 'only final result claims sent');
});

const fixtureURL = 'http://bossclaw.test/web/geek/chat?conversation=fixture';
const browser = await chromium.launch({ headless: true, ...(process.env.BOSSCLAW_TEST_BROWSER ? { executablePath: process.env.BOSSCLAW_TEST_BROWSER } : {}) });
let failed = 0;
try {
  for (const { name, fn } of cases) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.exposeFunction('__sendNativeClick', (x, y) => page.mouse.click(x, y));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (route.request().url() === fixtureURL && route.request().isNavigationRequest()) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
      }
      return route.abort('blockedbyclient');
    });
    try {
      await page.goto(fixtureURL, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.addScriptTag({ content: harness });
      await page.evaluate(fn);
      const evidence = await page.evaluate(() => ({ synthetic: window.h.state.synthetic, clicks: window.h.state.clicks }));
      assert.deepEqual(evidence.synthetic, [], 'no synthetic click or keyboard fallback in any case');
      assert.ok(evidence.clicks.length <= 1, 'at most one trusted click in any case');
      assert.deepEqual(errors, [], 'no browser page errors');
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n  ${error.message}`);
      if (errors.length) console.error(`  Browser errors: ${errors.join('; ')}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`Webview send DOM regressions: ${cases.length - failed}/${cases.length} passed; network isolated; real sends: 0.`);
if (failed) process.exitCode = 1;
