import React, { createContext, useContext, useEffect } from 'react';
import type { ThemeMode } from '../theme';
import { effectiveTheme } from '../theme';
import { useAppStore } from '../store/useAppStore';

interface ThemeContextType {
  mode: ThemeMode;
  effective: 'light' | 'dark';
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'system',
  effective: 'light',
  setTheme: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode; effective?: 'light' | 'dark' }> = ({ children, effective: effectiveProp }) => {
  const mode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  // P28：receive `effective` already computed by Root (single matchMedia source via useEffectiveTheme),
  // 避免此处再各自持有一份 matchMedia 监听造成双监听冗余。未传入时做一次同步降级计算。
  const effective: 'light' | 'dark' = effectiveProp ?? (mode === 'system' ? effectiveTheme('system') : mode === 'dark' ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effective);
    if (effective === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [effective]);

  return (
    <ThemeContext.Provider value={{ mode, effective, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
