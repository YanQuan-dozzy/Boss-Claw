'use strict';

// 只读猎聘 IM：挂载点/「我的沟通」入口存在，不等于本次会话已打开。
// 支持同一页面的多个窗口、无尺寸的挂载点、开放 shadow root 和同源子框架。
function readLiepinImState(doc) {
  const widgets = [];
  const seen = new Set();
  let rootsSeen = 0;
  let inaccessibleFrames = 0;
  const query = (root, selector) => {
    try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
  };
  const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => {
    try {
      let node = el;
      while (node) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        node = node.parentElement || node.getRootNode()?.host;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  };
  const readWidget = (root, modal) => {
    if (widgets.some((widget) => widget.element === root)) return;
    const editors = query(root, 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"][aria-multiline="true"], #chat-input, input[type="text"], input:not([type])')
      .filter((el) => shown(el) && !el.disabled && !el.readOnly
        && (el.tagName !== 'INPUT' || el.id === 'chat-input' || /消息|message/i.test([el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ')))
        && !/搜索|查找|search/i.test([el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('type')].join(' ')));
    const editor = editors.length === 1 ? editors[0] : null;
    const rendered = modal && [root, ...query(root, '*')].some((el) => shown(el) && text(el));
    if (!editor && !rendered) return;
    const heading = query(root, '[class*="header"], [class*="title"], [role="heading"]')
      .filter((el) => shown(el) && !String(el.className).includes('im-ui-basic-entry'))
      .slice(0, 6).map((el) => text(el).slice(0, 80)).join('|');
    // 同一编辑器的外层挂载点与内层弹窗只保留内层，避免把侧栏或其他会话当作当前消息范围。
    const outer = editor ? widgets.findIndex((widget) => widget.editor === editor) : -1;
    const widget = { element: root, heading, editor };
    if (outer >= 0) widgets[outer] = widget;
    else widgets.push(widget);
  };
  const inspect = (scope, insideIm = false) => {
    if (!scope || seen.has(scope) || seen.size >= 40) return;
    seen.add(scope);
    if (insideIm) readWidget(scope, false);
    if (scope.shadowRoot) inspect(scope.shadowRoot, insideIm);
    for (const root of query(scope, '#im-c-entry, [class*="im-ui-chat-modal"]')) {
      rootsSeen += 1;
      readWidget(root, String(root.className).includes('im-ui-chat-modal'));
      inspect(root, true);
    }
    for (const el of query(scope, '*')) {
      if (el.shadowRoot) inspect(el.shadowRoot, insideIm);
      if (insideIm && el.tagName === 'IFRAME' && shown(el)) {
        try {
          const child = el.contentDocument;
          if (child) inspect(child, true);
          else inaccessibleFrames += 1;
        } catch { inaccessibleFrames += 1; }
      }
    }
  };
  inspect(doc);
  return { widgets, rootsSeen, inaccessibleFrames };
}

function hasNewLiepinConversation(before, after) {
  return after.widgets.some((current) => {
    const previous = before.widgets.find((old) => old.element === current.element);
    return !previous || Boolean(current.heading && previous.heading && current.heading !== previous.heading);
  });
}

function findNewLiepinConversation(before, after) {
  const candidates = after.widgets.filter((current) => {
    if (!current.editor) return false;
    const previous = before.widgets.find((old) => old.element === current.element);
    return !previous || Boolean(current.heading && previous.heading && current.heading !== previous.heading);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function normalizeLiepinText(text) {
  return String(text || '').replace(/[\u200b\u200c\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

// 用户实际页面中的完整默认模板，职位名称后不一定另带“岗位”二字。
// 仍要求固定开头与结尾，不把普通求职或实际沟通文案当作平台默认句。
function isLiepinDefaultGreeting(text) {
  return /^您好[！!，,。]?\s*我对贵公司发布的.{1,240}很感兴趣[，,。]\s*期待进一步了解[。.!！]?$/.test(normalizeLiepinText(text));
}

/** 只在选中的会话里定位发送和消息；输入框、草稿、其他窗口与页面正文都不能证明已发送。 */
function readLiepinDeliveryState(widget, greeting) {
  const { element: root, editor } = widget;
  const query = (selector, scope = root) => { try { return Array.from(scope.querySelectorAll(selector)); } catch { return []; } };
  const shown = (el) => {
    try {
      let node = el;
      while (node) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        node = node.parentElement || node.getRootNode()?.host;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch { return false; }
  };
  const disabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || /(^|\s)disable(d)?(\s|$)/i.test(String(el.className || ''));
  const text = (el) => normalizeLiepinText(el.innerText || el.textContent || el.value);
  // 猎聘官方按钮位于当前编辑器自己的 chat-input footer 内。
  // 不让图片/拒绝理由弹窗等其他“发送”控件参与当前文字消息的选择。
  const inputRoot = editor?.closest('.im-ui-chat-input');
  const officialButtons = inputRoot && root.contains(inputRoot)
    ? Array.from(inputRoot.querySelectorAll('button.im-ui-basic-send-btn, [role="button"].im-ui-basic-send-btn')) : [];
  const sendLabel = (el) => /^(发送|发送消息)$/.test(text(el).replace(/\s+/g, ''));
  const sends = officialButtons.length ? officialButtons.filter((el) => shown(el) && !disabled(el) && sendLabel(el))
    : query('button, a, [role="button"], input[type="submit"], [class*="send"], [class*="Send"]', inputRoot && root.contains(inputRoot) ? inputRoot : root)
      .filter((el) => shown(el) && !disabled(el) && sendLabel(el));
  // 发送按钮内 span 和其父 button 不算两个按钮；多个独立按钮则拒绝猜测。
  const actions = sends.filter((el) => el.matches('button, a, [role="button"], input[type="submit"]'));
  const candidates = actions.length ? actions : sends;
  const buttons = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  const sendButton = buttons.length === 1 ? buttons[0] : null;
  const needle = normalizeLiepinText(greeting);
  const matching = [];
  const outgoing = [];
  const received = [];
  // 官方消息行的正文在 normal-message-wrapper 的首个子节点，旁边的头像/已读状态不是消息正文。
  const officialRows = query('.im-ui-message-item-send, .im-ui-message-item-receive');
  const officialContents = officialRows.map((row) => row.querySelector('.im-ui-message-item-normal-message-wrapper')?.firstElementChild || row);
  const fallbackContents = query('div, p, span, li, [data-message-id]')
    .filter((el) => !el.closest('.im-ui-message-item-send, .im-ui-message-item-receive'));
  for (const el of new Set([...officialContents, ...fallbackContents])) {
    if (!shown(el) || el === editor || el.contains(editor) || editor?.contains(el)) continue;
    if (el.closest('button, a, [role="button"], textarea, [contenteditable], [role="textbox"], [class*="header"], [class*="title"]')) continue;
    const content = text(el);
    if (!content) continue;
    let node = el;
    let incoming = false, own = false, failed = false, pending = false;
    while (node && node !== root) {
      const hint = [node.className, node.getAttribute('data-direction'), node.getAttribute('data-sender'), node.getAttribute('data-status')].join(' ');
      // 猎聘官方 fe-im-pc 组件以 message-item-send/receive 标识方向；pending/failed 图标在消息行内。
      incoming ||= node.classList.contains('im-ui-message-item-receive') || /incoming|received|receive-message|from-other|message-left|msg-left|is-other/i.test(hint)
        || /(^|[\s_-])(left|other|hr)([\s_-]|$)/i.test(hint) || node.getAttribute('data-is-self') === 'false';
      own ||= node.classList.contains('im-ui-message-item-send') || /outgoing|myself|item-my|is-self|from-self|message-right|msg-right/i.test(hint)
        || /(^|[\s_-])(self|mine|right|sent|send)([\s_-]|$)/i.test(hint) || node.getAttribute('data-is-self') === 'true';
      failed ||= /send-fail|send-error|message-fail|\bfailed\b/i.test(hint)
        || Array.from(node.querySelectorAll('[class*="fail"], [class*="error"]')).some((error) => shown(error));
      pending ||= /\bsending\b|\bpending\b/i.test(hint)
        || Array.from(node.querySelectorAll('[class*="im-ui-message-item-loadingicon"]')).some((icon) => shown(icon));
      node = node.parentElement;
    }
    if (failed || pending) continue;
    if (incoming) { if (!own) received.push(el); continue; }
    if (own) outgoing.push(el);
    if (own && needle && content === needle) matching.push(el);
  }
  const innermost = (items) => items.filter((el) => !items.some((other) => other !== el && el.contains(other)));
  const sent = innermost(outgoing);
  return {
    sendButton, editorText: normalizeLiepinText(editor?.value ?? editor?.innerText ?? ''),
    readiness: { sendCandidates: buttons.length, officialSendButtons: officialButtons.length,
      disabledOfficialSendButtons: officialButtons.filter(disabled).length },
    matching: innermost(matching), outgoing: sent,
    defaultOutgoing: sent.filter((el) => isLiepinDefaultGreeting(text(el))),
    nonDefaultOutgoing: sent.filter((el) => !isLiepinDefaultGreeting(text(el))),
    incoming: innermost(received),
  };
}

/** Camoufox 复用同一 DOM 判据；只回传计数和标记，不向日志暴露消息正文。 */
function snapshotLiepinDelivery(doc, { greeting = '', phase = 'target' } = {}) {
  const state = readLiepinImState(doc);
  const widgets = state.widgets.filter((widget) => widget.editor);
  const editorMark = 'data-bossclaw-liepin-editor';
  const headingMark = 'data-bossclaw-liepin-heading';
  if (phase === 'before') {
    for (const widget of widgets) {
      widget.editor.setAttribute(editorMark, 'previous');
      widget.editor.setAttribute(headingMark, widget.heading);
    }
    return { ready: false, roots: state.rootsSeen, conversations: widgets.length };
  }
  const targets = widgets.filter((widget) => widget.editor.getAttribute(editorMark) !== 'previous'
    || widget.editor.getAttribute(headingMark) !== widget.heading);
  if (targets.length !== 1) return { ready: false, conversations: targets.length };
  const target = targets[0];
  if (target.editor.getAttribute(editorMark) === 'active' && target.editor.getAttribute(headingMark) !== target.heading) return { ready: false, changed: true };
  const delivery = readLiepinDeliveryState(target, greeting);
  target.editor.setAttribute(editorMark, 'active');
  target.editor.setAttribute(headingMark, target.heading);
  for (const widget of widgets) for (const button of widget.element.querySelectorAll('[data-bossclaw-liepin-send]')) button.removeAttribute('data-bossclaw-liepin-send');
  if (delivery.sendButton) delivery.sendButton.setAttribute('data-bossclaw-liepin-send', 'active');
  return { ready: true, heading: target.heading, editorText: delivery.editorText, matching: delivery.matching.length,
    outgoing: delivery.outgoing.length, defaultOutgoing: delivery.defaultOutgoing.length,
    nonDefaultOutgoing: delivery.nonDefaultOutgoing.length, incoming: delivery.incoming.length,
    sendReady: !!delivery.sendButton, readiness: delivery.readiness };
}

module.exports = { readLiepinImState, hasNewLiepinConversation, findNewLiepinConversation, normalizeLiepinText, isLiepinDefaultGreeting, readLiepinDeliveryState, snapshotLiepinDelivery };
