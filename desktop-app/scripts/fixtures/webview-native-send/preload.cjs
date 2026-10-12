'use strict';
const { ipcRenderer } = require('electron');
const humanize = require('./humanize.cjs');
const fs = require('node:fs');
const path = require('node:path');
let notifications = [], events = [], mutateOnHover = false, moveOverlayOnHover = false, activeConfig, geometry;
function notify(channel, data) { notifications.push({ channel, data }); }
function placeOverlay(button, mode) {
  const rect = button.getBoundingClientRect();
  let overlay = document.querySelector('#fixture-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'fixture-overlay'; document.body.append(overlay); }
  const left = mode === 'center' ? rect.left + rect.width * 0.3 : rect.left;
  const width = mode === 'center' ? rect.width * 0.4 : mode === 'left' ? rect.width * 0.6 : rect.width;
  overlay.style.cssText = 'position:fixed;z-index:999999;background:rgba(255,0,0,.3);pointer-events:auto;left:' + left
    + 'px;top:' + rect.top + 'px;width:' + width + 'px;height:' + rect.height + 'px';
}

// Directly evaluate the AST-selected production declarations in this preload's
// lexical scope. trustedInput and all timing/native IPC helpers remain real.
eval(fs.readFileSync(path.join(__dirname, 'production-helpers.cjs'), 'utf8') + `
ipcRenderer.on('fixture-run', async (_event, cfg) => {
  try {
    activeConfig = cfg; notifications = []; events = []; lastCursor = null; mutateOnHover = false; moveOverlayOnHover = false; geometry = {};
    const input = document.querySelector('#chat-input'), button = document.querySelector('#text-send');
    document.querySelector('#messages').innerHTML = '<li class="message-item item-myself" data-message-id="historic-1"><div class="text">历史消息</div></li>';
    document.querySelector('#fixture-style')?.remove();
    document.querySelector('#fixture-overlay')?.remove();
    const style = document.createElement('style'); style.id = 'fixture-style';
    style.textContent = cfg.layout === 'fixed'
      ? 'body{margin:0}.chat-conversation{width:90%;height:1400px}.chat-message{height:1000px;overflow:auto}.chat-editor{position:fixed;bottom:0;left:0;width:90%;background:white}'
      : '.chat-conversation{width:85%}';
    document.head.append(style);
    button.style.cssText = cfg.clipped ? 'position:fixed;right:-30px;top:240px;margin:0;width:48px;height:40px' : 'position:relative';
    button.innerHTML = cfg.nested
      ? '<span id="nested-icon" style="position:absolute;inset:0"><svg width="100%" height="100%"><rect width="100%" height="100%" fill="transparent"/></svg></span><span>发送</span>'
      : '发送';
    window.scrollTo(0, cfg.layout === 'fixed' ? 550 : 0);
    if (cfg.layout === 'fixed') document.querySelector('.chat-message').scrollTop = 250;
    input.textContent = ''; input.focus();
    const text = '离线原生输入测试 ' + cfg.name;
    const typed = await trustedInput('insertText', text);
    await sleep(120);
    const context = createChatSendContext(input), before = context && captureOwnMessages(context);
    if (cfg.overlay) placeOverlay(button, cfg.overlay === 'full' ? 'full' : 'center');
    const rect = button.getBoundingClientRect(), centerX = Math.round(rect.left + rect.width / 2), centerY = Math.round(rect.top + rect.height / 2);
    const centerHit = document.elementFromPoint(centerX, centerY);
    geometry = { initialPoint: visibleClickPoint(button), center: { x: centerX, y: centerY },
      centerWithinSend: centerHit === button || Boolean(centerHit && button.contains(centerHit)),
      centerOutsideViewport: centerX >= innerWidth || centerX < 0 || centerY >= innerHeight || centerY < 0 };
    mutateOnHover = Boolean(cfg.guardFailure);
    moveOverlayOnHover = cfg.overlay === 'moving';
    const result = await sendChatMessage(context, text, before);
    ipcRenderer.send('fixture-result', { name: cfg.name, cfg, text, typed, result, events, notifications, geometry,
      input: input.textContent,
      ownMessages: [...document.querySelectorAll('.item-myself .text')].map(element => element.textContent),
      viewport: { width: innerWidth, height: innerHeight, scrollY, devicePixelRatio },
      buttonRect: button.getBoundingClientRect().toJSON(),
      focus: { document: document.hasFocus(), active: document.activeElement?.id } });
  } catch (error) { ipcRenderer.send('fixture-result', { name: cfg.name, error: error.stack, events, notifications }); }
});
`);

window.addEventListener('DOMContentLoaded', () => {
  for (const type of ['mousemove', 'mousedown', 'mouseup', 'click', 'beforeinput', 'input']) {
    document.addEventListener(type, event => {
      if (type !== 'mousemove' || events.filter(entry => entry.type === 'mousemove').length < 30) {
        const button = document.querySelector('#text-send');
        events.push({ type, trusted: event.isTrusted, target: event.target.id || event.target.tagName,
          withinSend: event.target === button || button.contains(event.target),
          x: event.clientX, y: event.clientY, inputType: event.inputType });
      }
      if (type === 'mousemove' && mutateOnHover) {
        mutateOnHover = false;
        document.querySelector('#chat-input').textContent = 'guard mutated draft';
      }
      if (type === 'mousemove' && moveOverlayOnHover) {
        moveOverlayOnHover = false;
        placeOverlay(document.querySelector('#text-send'), 'left');
        geometry.changedOnNativeHover = true;
        const previous = geometry.initialPoint;
        geometry.initialPointNowCovered = Boolean(previous && document.elementFromPoint(previous.x, previous.y)?.id === 'fixture-overlay');
      }
    }, true);
  }
  document.querySelector('#text-send').addEventListener('click', event => {
    if (!event.isTrusted || activeConfig?.noBubble) return;
    const input = document.querySelector('#chat-input');
    if (!input.textContent) return;
    const row = document.createElement('li'); row.className = 'message-item item-myself'; row.dataset.messageId = 'new-' + Date.now();
    const text = document.createElement('div'); text.className = 'text'; text.textContent = input.textContent;
    row.append(text); document.querySelector('#messages').append(row); input.textContent = '';
  });
  ipcRenderer.send('fixture-guest-ready');
});
