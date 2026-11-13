// lib/antdPopupAlignGuard.ts —— antd Select 弹层「未对齐」兜底（issue #13）
//
// 现象（issue #13）：设置页「HR 活跃度过滤」用物理鼠标点击展开时，弹层 DOM 已挂载且
// display/visibility/opacity 都正常，但内联定位一直停在 rc-trigger 的未对齐默认值
// `left: -1000vw; top: -1000vh`（视口 1440×900 即 `inset: -9000px auto auto -14400px`），
// 用户看不到下拉列表；重开一次 / 键盘选择都正常，派发一次 window resize 后弹层立刻对齐。
//
// 根因在 @rc-component/trigger 的 useAlign：弹层挂载后 `ready` 没有被置 true，首帧对齐丢失。
// 当前 antd 5.29.3 已是最新 5.x，@rc-component/trigger 2.3.1 也已是最新 2.x，没有可直接升级
// 的修复版本；而 rc-trigger 的 useWatch 会在 open 期间监听 window resize 并重新对齐
// （issue 里的临时绕过、CDP 点击后的重排都依赖这条路径），所以这里统一做「检测 + 补一次 resize」。
//
// 为什么放在全局而不是逐个 Select 加 onOpenChange：
//   · 全仓 40+ 处 Select（含 AutoComplete 的 rc-select 弹层），逐个注入 prop 必然漏；
//   · 触发时机不受控（鼠标 / 键盘 / 程序 open 都会挂载弹层），用 MutationObserver 观察
//     portal 容器插入最贴近「弹层已挂载」这个事实，不依赖任何调用点配合。
//
// 约束：只在「可见的 Select 弹层仍停在默认位置」时补发一次 resize，正常路径零副作用
// （健康弹层在首帧内就已对齐，复查时不会再命中）。

/** rc-trigger Popup 未对齐时的默认内联定位（见 @rc-component/trigger/es/Popup/index.js） */
const UNPOSITIONED_LEFT = '-1000vw';
const UNPOSITIONED_TOP = '-1000vh';

/** 只关心「当前可见」的 Select 弹层；关闭动画/已关闭的弹层带 -hidden 类，不参与检测 */
export const VISIBLE_SELECT_POPUP_SELECTOR = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';

/**
 * 复查时机（毫秒，自弹层容器插入起算）：
 *   · 120ms —— 正常对齐发生在挂载后的 layout effect/微任务里，此时仍未对齐基本可判定丢失；
 *   · 450ms —— 进场动效期间 rc-trigger 的 triggerAlign 会被 inMotion 拦住，等动效结束再补一次；
 *   · 1200ms —— 极端掉帧/后台节流下的最后兜底。
 * 每次复查只在「仍停在默认位置」时补发 resize，正常弹层在第一轮就已对齐，后续全是 no-op。
 */
const RECHECK_DELAYS_MS = [120, 450, 1200] as const;

type PopupStyle = {
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
  inset?: string;
};
type PopupRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type PopupLike = {
  style: PopupStyle;
  isConnected?: boolean;
  offsetHeight?: number;
  getBoundingClientRect?: () => PopupRect;
};

/** 供离线回归使用的极小 Document 视图（真实 document 天然满足） */
export type PopupDocLike = {
  querySelectorAll(selectors: string): ArrayLike<PopupLike>;
};

/**
 * 弹层是否仍停在 rc-trigger 的未对齐默认位置。
 *
 * 注意：CSS 里的 `left: -1000vw; top: -1000vh` 在真实 DOM 的 `style.left/top` 中会被
 * 浏览器解析成像素值（1440×900 视口下是 `-14400px / -9000px`），不再保留 `vw` 单位。
 * 因此不能只比较字符串，还要按「-1000vw = -10 × 视口宽」判断像素值。
 */
export function isPopupUnpositioned(
  popup: { style: PopupStyle },
  viewport?: { width: number; height: number },
): boolean {
  const left = popup.style.left || '';
  const top = popup.style.top || '';
  // 兼容 mock / 少数浏览器保留单位的形态
  if (left === UNPOSITIONED_LEFT && top === UNPOSITIONED_TOP) return true;

  const width = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const height = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  if (!(width > 0 && height > 0)) return false;

  const leftPx = Number.parseFloat(left);
  const topPx = Number.parseFloat(top);
  if (!Number.isFinite(leftPx) || !Number.isFinite(topPx)) return false;

  // 1vw = 1% 视口宽；-1000vw = -10 × 视口宽（同理 -1000vh = -10 × 视口高）
  return leftPx <= -10 * width + 1 && topPx <= -10 * height + 1;
}

/** 弹层是否已完全离开视口（含未对齐默认位置与 rc-trigger 偏移叠加后的正/负远端） */
export function isPopupOffscreen(popup: PopupLike): boolean {
  if (isPopupUnpositioned(popup)) return true;
  if (typeof popup.getBoundingClientRect !== 'function') return false;
  if (typeof window === 'undefined') return false;
  const rect = popup.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!(width > 0 && height > 0)) return false;
  return rect.right <= 0 || rect.left >= width || rect.bottom <= 0 || rect.top >= height;
}

/** 当前是否存在「可见但未对齐」的 Select 弹层（true = 首帧对齐丢失，需要补救） */
export function hasStuckSelectPopup(doc: PopupDocLike): boolean {
  const popups = doc.querySelectorAll(VISIBLE_SELECT_POPUP_SELECTOR);
  for (let i = 0; i < popups.length; i += 1) {
    const popup = popups[i];
    // isConnected === false（已从文档移除）时跳过：rc-trigger 此时不会再对齐，补救也无意义
    if (popup.isConnected !== false && isPopupOffscreen(popup)) return true;
  }
  return false;
}

/**
 * 检测并补救可见但位置错误的弹层。
 *
 * 优先直接按当前打开的 Select 定位（比补发 resize 更可靠：rc-trigger 在弹层已预挂载时
 * 会把旧偏移再叠加一次，实测 -14400 → +15417）。没有定位回调或找不到 trigger 时，
 * 才退回原来的「补发一次 resize」。
 *
 * @returns 是否真的执行了补救（false = 当前没有未对齐弹层，调用方无需处理）
 */
export function rescueStuckSelectPopups(
  doc: PopupDocLike,
  dispatchResize: () => void,
  position?: (popup: PopupLike) => boolean,
): boolean {
  const popups = doc.querySelectorAll(VISIBLE_SELECT_POPUP_SELECTOR);
  let rescued = false;
  let positioned = false;
  for (let i = 0; i < popups.length; i += 1) {
    const popup = popups[i];
    if (popup.isConnected === false || !isPopupOffscreen(popup)) continue;
    rescued = true;
    if (position && position(popup)) positioned = true;
  }
  if (!rescued) return false;
  if (!positioned) dispatchResize();
  return true;
}

/**
 * 安装全局兜底：观察 body 下 portal 容器的插入（antd 弹层都挂在 body 直属容器里），
 * 发现 Select 弹层挂载后按 RECHECK_DELAYS_MS 复查定位。返回卸载函数。
 */
export function installAntdPopupAlignGuard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }

  let disposed = false;
  let batchActive = false;
  let batchRescued = false;
  const timers = new Set<number>();

  const clearTimers = (): void => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };

  /** 直接把弹层放到当前打开的 Select 下方/上方；成功返回 true。 */
  const positionNearTrigger = (popup: PopupLike): boolean => {
    const trigger = document.querySelector('.ant-select-open');
    if (!trigger) return false;
    const el = popup as unknown as HTMLElement;
    if (typeof el.getBoundingClientRect !== 'function') return false;
    const rect = trigger.getBoundingClientRect();
    const height = el.offsetHeight || 260;
    const gap = 4;
    const below = rect.bottom + gap;
    const top = below + height <= window.innerHeight ? below : Math.max(gap, rect.top - height - gap);
    el.style.position = 'absolute';
    el.style.inset = 'auto';
    el.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.zIndex = '1050';
    return true;
  };

  const scheduleChecks = (force = false): void => {
    // 同一次打开可能同时命中 pointerdown 和 MutationObserver；两次批次会各补发一次
    // resize，rc-trigger 会把第二次偏移再叠加一次（实测 -14400 → +15417）。
    // 因此安装级只允许一个批次；用户新开下拉（pointerdown/keydown）时 force 重置。
    if (batchActive && !force) return;
    if (force) clearTimers();
    batchActive = true;
    batchRescued = false;
    for (const delay of RECHECK_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (disposed) return;
        if (!batchRescued) {
          if (rescueStuckSelectPopups(
            document,
            () => {
              window.dispatchEvent(new Event('resize'));
            },
            positionNearTrigger,
          )) {
            batchRescued = true;
          }
        }
        // 最后一个复查点结束后释放批次，下一次打开可重新调度
        if (delay === RECHECK_DELAYS_MS[RECHECK_DELAYS_MS.length - 1]) batchActive = false;
      }, delay);
      timers.add(timer);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        // portal 容器本身不带弹层类名，弹层在它的子树里
        if (node.matches(VISIBLE_SELECT_POPUP_SELECTOR) || node.querySelector(VISIBLE_SELECT_POPUP_SELECTOR)) {
          scheduleChecks();
          return;
        }
      }
    }
  });

  // 只看 body 直属子节点：弹层 portal 容器由 @rc-component/portal 直接 append 到 body，
  // 不用 subtree 观察整个应用 DOM（那是每次渲染都触发的无谓开销）。
  observer.observe(document.body, { childList: true });

  // 关键补充：antd 的 Select 弹层 portal / 弹层 DOM 可能是预挂载的——打开时只改 style/class，
  // 不新增任何 DOM 节点，MutationObserver 不会触发（实测 v2.6.3：打开前后 mutDirect/mutSub 都为空）。
  // 因此再监听用户展开动作：鼠标 pointerdown + 键盘 ArrowDown/Enter/Space，直接安排复查。
  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.closest('.ant-select')) scheduleChecks(true);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (target instanceof Element && target.closest('.ant-select')) scheduleChecks(true);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    clearTimers();
    batchActive = false;
  };
}
