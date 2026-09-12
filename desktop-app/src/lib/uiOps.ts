// src/lib/uiOps.ts —— 应用自身 DOM 的合成交互工具集
// ---------------------------------------------------------------------------
// 供 controlRuntime 的 ui* 系列动作（scope='app'）使用：像人工一样读取可见交互元素、
// 点击、输入、提交、滚动、等待。React 受控输入必须用「原生 value setter + input/change」，
// 直接 el.value = v 不会触发 onChange；统一用 setter.call 绕过受控拦截。
//
// 安全约定（与 MCP 控制链一致）：
//   · 只在标准 input/textarea 做合成输入；[contenteditable]（如 BOSS 聊天框）一律不碰，
//     由 deliveryDraft 走可信输入通道。
//   · 不返回未脱敏 DOM 源码；text/ariaLabel 各自截断，防止撑爆 MCP 响应。

export const EL_TEXT_MAX = 120;
export const EL_LIST_MAX = 60;

export interface InteractiveEl {
  role?: string;
  ariaLabel?: string;
  text?: string;
  placeholder?: string;
  tag: string;
  type?: string;
  selector: string;
  visible: boolean;
  disabled?: boolean;
  id?: string;
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function textOf(el: Element): string {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, EL_TEXT_MAX);
}

/** 推导可读的「选择器」，偏好 id/data-testid/aria-label/text，尽量唯一可复现 */
function selectorHint(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const testid = el.getAttribute('data-testid');
  if (testid) return `${tag}[data-testid="${CSS.escape(testid)}"]`;
  const label = el.getAttribute('aria-label');
  if (label) return `${tag}[aria-label*="${CSS.escape(label.slice(0, 20))}"]`;
  return tag;
}

const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'a[href]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[data-testid]',
].join(',');

function describe(el: Element): InteractiveEl {
  const tag = el.tagName.toLowerCase();
  const out: InteractiveEl = {
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    text: textOf(el),
    placeholder: (el as HTMLInputElement).placeholder || undefined,
    tag,
    type: (el as HTMLInputElement).type || undefined,
    selector: selectorHint(el),
    visible: isVisible(el),
    disabled: (el as HTMLButtonElement).disabled ? true : undefined,
    id: el.id || undefined,
  };
  return out;
}

/**
 * 按 selector（CSS 选择器）或 label（aria-label / text / placeholder 的 includes 匹配）+ index 找一个
 * 交互元素；只返回可见元素。selector 指定时优先，label 在命中候选中做二次过滤。
 */
export function queryInteractive(
  selector?: string,
  label?: string,
  index = 0
): HTMLElement | null {
  let candidates: Element[];
  if (selector && typeof selector === 'string' && selector.trim()) {
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch {
      return null;
    }
  } else {
    candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  }
  let visible = candidates.filter(isVisible);
  if (label && typeof label === 'string') {
    const l = label.trim();
    visible = visible.filter(
      (el) =>
        textOf(el).includes(l) ||
        (el.getAttribute('aria-label') || '').includes(l) ||
        (el as HTMLInputElement).placeholder?.includes(l)
    );
  }
  if (!visible.length) return null;
  return (visible[Math.min(Math.max(index, 0), visible.length - 1)] as HTMLElement) || null;
}

/** 采集可见交互元素快照，供 agent 「看见」界面可操作点 */
export function snapshotInteractive(
  root: Document | Element = document,
  selector?: string,
  limit = EL_LIST_MAX
): InteractiveEl[] {
  let candidates: Element[];
  if (selector && typeof selector === 'string' && selector.trim()) {
    try {
      candidates = Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  } else {
    candidates = Array.from((root as Document).querySelectorAll ? (root as Document).querySelectorAll(INTERACTIVE_SELECTOR) : []);
    if (!candidates.length && root !== document) candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  }
  const visible = candidates.filter(isVisible);
  const cap = Math.min(Math.max(Number(limit) || EL_LIST_MAX, 1), 200);
  return visible.slice(0, cap).map(describe);
}

/** 点击元素；对 button 之外的元素用合成 pointer+click 事件 */
export function clickElement(target: HTMLElement): boolean {
  if (!target) return false;
  (target as HTMLButtonElement).click();
  return true;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** 为标准 input/textarea 程序化赋值（React 受控），触发 input+change */
export function typeInto(target: HTMLElement, value: string): boolean {
  if (!target) return false;
  if (target.matches('[contenteditable]')) return false; // 聊天框请用 deliveryDraft
  const isField = (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && !(target as HTMLInputElement).disabled;
  if (!isField) return false;
  const el = target as HTMLInputElement;
  el.focus();
  setNativeValue(el, String(value ?? ''));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** 提交：优先 form.requestSubmit()，否则目标本身是按钮则 click */
export function submitBy(target: HTMLElement): boolean {
  if (!target) return false;
  const form = (target as HTMLInputElement).form;
  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return true;
  }
  if (target.matches('button, input[type="submit"]')) {
    (target as HTMLButtonElement).click();
    return true;
  }
  return false;
}

/** 滚动：to(top/bottom) 走 scrollIntoView，dy 走 scrollBy（无元素则滚动文档） */
export function scrollElement(target: HTMLElement | null, dy?: number, to?: 'top' | 'bottom'): boolean {
  if (to === 'top' || to === 'bottom') {
    const el = target || document.scrollingElement;
    if (!el) return false;
    (el as HTMLElement).scrollIntoView({ block: to === 'top' ? 'start' : 'end', behavior: 'smooth' });
    return true;
  }
  if (dy) {
    const el = target || document.scrollingElement;
    if (!el) return false;
    (el as HTMLElement).scrollBy(0, Number(dy));
    return true;
  }
  return false;
}

export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** 轮询等待某个 selector 命中（app 作用域），默认 10s 超时 */
export async function waitForSelector(
  selector: string,
  timeoutMs = 10_000,
  stepMs = 250
): Promise<HTMLElement | null> {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 10_000);
  for (;;) {
    const el = queryInteractive(selector);
    if (el) return el;
    if (Date.now() >= deadline) return null;
    await waitFor(Math.max(50, Number(stepMs) || 250));
  }
}