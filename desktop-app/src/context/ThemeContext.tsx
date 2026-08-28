import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ThemeMode } from '../theme';
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

function subscribeSystemTheme(callback: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

function getSystemThemeSnapshot(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const mode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const systemSnapshot = useSyncExternalStore<'light' | 'dark'>(subscribeSystemTheme, getSystemThemeSnapshot, () => 'light');

  const effective = mode === 'system' ? systemSnapshot : mode === 'dark' ? 'dark' : 'light';

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
