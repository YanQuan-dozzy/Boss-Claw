import { useEffect, useState } from 'react';
import { effectiveTheme, type ThemeMode } from '../theme';

/**
 * 解析当前实际生效的主题（light/dark）。
 * App 与 Root 共用，消除重复的 matchMedia 监听逻辑；
 * 当 mode === 'system' 时跟随系统浅色/深色偏好自动切换。
 */
export function useEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  const [effective, setEffective] = useState<'light' | 'dark'>(() => effectiveTheme(mode));

  useEffect(() => {
    const apply = () => setEffective(effectiveTheme(mode));
    apply();
    if (mode === 'system' && window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [mode]);

  return effective;
}
