import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

// 品牌主色（参考图 teal 风格）
export const BRAND = '#078A83';

export type ThemeMode = 'light' | 'dark' | 'system';

// 解析实际生效的主题（system 跟随系统偏好）
export function effectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode === 'dark' ? 'dark' : 'light';
}

export function getTheme(mode: ThemeMode): ThemeConfig {
  const resolved = effectiveTheme(mode);
  return {
    algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: BRAND,
      borderRadius: 8,
      fontSize: 14,
    },
  };
}

// 浅色/深色下的 CSS 变量（供自定义布局使用）
export const cssVars = (mode: ThemeMode) => {
  const resolved = effectiveTheme(mode);
  return resolved === 'dark'
    ? {
        '--bg': '#1f1f1f',
        '--bg-elevated': '#262626',
        '--fg': 'rgba(255,255,255,0.88)',
        '--fg-muted': 'rgba(255,255,255,0.55)',
        '--border': '#303030',
        '--rail': '#1a1a1a',
        '--card-bg': '#262626',
        '--hover-bg': 'rgba(255,255,255,0.06)',
        '--accent-soft': 'rgba(19,181,172,0.18)',
        '--shadow-xs': '0 1px 2px rgba(0,0,0,0.30)',
        '--shadow-sm': '0 1px 2px rgba(0,0,0,0.35), 0 2px 10px rgba(0,0,0,0.35)',
        '--shadow-md': '0 4px 14px rgba(0,0,0,0.45)',
        '--shadow-lg': '0 10px 30px rgba(0,0,0,0.55)',
        '--brand': '#13b5ac',
        '--brand-strong': '#0ba39a',
      }
    : {
        '--bg': '#f6f7f9',
        '--bg-elevated': '#ffffff',
        '--fg': 'rgba(0,0,0,0.88)',
        '--fg-muted': 'rgba(0,0,0,0.55)',
        '--border': '#e8e8e8',
        '--rail': '#fbfcfd',
        '--card-bg': '#ffffff',
        '--hover-bg': 'rgba(0,0,0,0.045)',
        '--accent-soft': 'rgba(7,138,131,0.10)',
        '--shadow-xs': '0 1px 2px rgba(17,24,39,0.04)',
        '--shadow-sm': '0 1px 2px rgba(17,24,39,0.05), 0 2px 10px rgba(17,24,39,0.05)',
        '--shadow-md': '0 4px 14px rgba(17,24,39,0.08)',
        '--shadow-lg': '0 10px 30px rgba(17,24,39,0.12)',
        '--brand': '#078A83',
        '--brand-strong': '#066a65',
      };
};
