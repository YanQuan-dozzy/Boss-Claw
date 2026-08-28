// 渲染端通用 hooks 集合。
// 仅做无副作用、可在任意组件复用的工具函数；不包含与 BOSS/业务强耦合的逻辑。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 浅比较两个值是否相等。
 * 用于 useEffect/useMemo 依赖比较，避免对象/数组引用每次都重建造成的多余触发。
 */
export function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 间隔轮询 hook：返回当前可取消函数与立即触发方法。
 * 用法：
 *   useInterval(async () => { ... }, 15000);
 */
export function useInterval(fn: () => void | Promise<void>, delayMs: number | null, opts?: { immediate?: boolean }): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const immediate = Boolean(opts?.immediate);

  useEffect(() => {
    if (delayMs == null || delayMs <= 0) return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      Promise.resolve(fnRef.current()).catch(() => {});
    };
    if (immediate) run();
    const t = setInterval(run, delayMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [delayMs, immediate]);
}

/**
 * 上一次的某值；常用于「上一次 vs 当前」的对比日志或行为分支。
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

/**
 * 通用防抖值：value 在最后一次变化后 delayMs 才更新。
 * 用于把高频变化的 store 字段（logs / pending）降低渲染频率。
 */
export function useDebouncedValue<T>(value: T, delayMs = 100): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * 安全的 setTimeout 包装：组件卸载时自动 clearTimeout。
 */
export function useTimeout(fn: () => void, delayMs: number | null): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (delayMs == null || delayMs < 0) return undefined;
    const t = setTimeout(() => fnRef.current(), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
}

/**
 * 固定化的回调：fn 不会随每次渲染重新创建，但始终能拿到最新的 closure。
 * 适用于需要把回调传给未 useMemo 的子组件、又不想每次 render 都触发的场景。
 */
export function useLatestCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: any[]) => ref.current(...args), []) as unknown as T;
}

/**
 * 简易媒体查询订阅：用于主题跟随等场景。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const apply = () => setMatches(mql.matches);
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [query]);
  return matches;
}

/**
 * 单一空对象：用于 useEffect 依赖是对象/函数时的稳定占位。
 */
export const EMPTY: Readonly<Record<string, never>> = Object.freeze({});

/**
 * 同步执行但防抖的「调用一次」函数：连点按钮只触发最后一次。
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(fn: T, delayMs = 200): (...args: Parameters<T>) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return useCallback((...args: Parameters<T>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fnRef.current(...args), delayMs);
  }, [delayMs]);
}

/**
 * 把任意稳定的派生统计量按依赖记忆；避免内联 useMemo。
 */
export function useStableMemo<T>(fn: () => T, deps: React.DependencyList): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, deps);
}
