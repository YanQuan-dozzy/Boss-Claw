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

type PopupStyle = { left?: string; top?: string };
type PopupLike = { style: PopupStyle; isConnected?: boolean };

/** 供离线回归使用的极小 Document 视图（真实 document 天然满足） */
export type PopupDocLike = {
  querySelectorAll(selectors: string): ArrayLike<PopupLike>;
};

/** 弹层是否仍停在 rc-trigger 的未对齐默认位置 */
export function isPopupUnpositioned(popup: { style: PopupStyle }): boolean {
  return popup.style.left === UNPOSITIONED_LEFT && popup.style.top === UNPOSITIONED_TOP;
}

/** 当前是否存在「可见但未对齐」的 Select 弹层（true = 首帧对齐丢失，需要补发 resize） */
export function hasStuckSelectPopup(doc: PopupDocLike): boolean {
  const popups = doc.querySelectorAll(VISIBLE_SELECT_POPUP_SELECTOR);
  for (let i = 0; i < popups.length; i += 1) {
    const popup = popups[i];
    // isConnected === false（已从文档移除）时跳过：rc-trigger 此时不会再对齐，补发也无意义
    if (popup.isConnected !== false && isPopupUnpositioned(popup)) return true;
  }
  return false;
}

/**
 * 检测并补发一次 resize（rc-trigger 的 useWatch 监听 window resize 后会重新对齐弹层）。
 * @returns 是否真的补发（false = 当前没有未对齐弹层，调用方无需处理）
 */
export function rescueStuckSelectPopups(doc: PopupDocLike, dispatchResize: () => void): boolean {
  if (!hasStuckSelectPopup(doc)) return false;
  dispatchResize();
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
  const timers = new Set<number>();

  const scheduleChecks = (): void => {
    for (const delay of RECHECK_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (disposed) return;
        rescueStuckSelectPopups(document, () => {
          window.dispatchEvent(new Event('resize'));
        });
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

  return () => {
    disposed = true;
    observer.disconnect();
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}
