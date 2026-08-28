import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

// 品牌主色系（绿色/青绿主题）
export const BRAND = '#0D9488'; // 主品牌色
export const BRAND_LIGHT = '#14B8A6'; // 亮青绿
export const BRAND_DARK = '#0F766E'; // 深青绿

// 投递专属扩展状态色
export const STATUS_COLORS = {
  success: '#10B981', // 翠绿
  warning: '#F59E0B', // 琥珀
  danger: '#EF4444',  // 红色
  info: '#0D9488',    // 主色
};

export type ThemeMode = 'light' | 'dark' | 'system';

export function effectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode === 'dark' ? 'dark' : 'light';
}

export function getTheme(mode: ThemeMode): ThemeConfig {
  const resolved = effectiveTheme(mode);
  const isDark = resolved === 'dark';
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: BRAND,
      colorSuccess: STATUS_COLORS.success,
      colorWarning: STATUS_COLORS.warning,
      colorError: STATUS_COLORS.danger,
      colorInfo: STATUS_COLORS.info,
      colorBgBase: isDark ? '#0B0F17' : '#F4F7FA',
      colorBgContainer: isDark ? '#141A24' : '#FFFFFF',
      colorBgElevated: isDark ? '#1C2433' : '#FFFFFF',
      colorText: isDark ? '#F3F4F6' : '#111827',
      colorTextSecondary: isDark ? '#9CA3AF' : '#4B5563',
      colorTextTertiary: isDark ? '#6B7280' : '#9CA3AF',
      colorBorder: isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(13, 148, 136, 0.14)',
      colorBorderSecondary: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(13, 148, 136, 0.08)',
      borderRadius: 12,
      fontSize: 14,
      fontFamily: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`,
    },
    components: {
      Button: {
        borderRadius: 8,
        fontWeight: 500,
        controlHeight: 36,
        controlHeightLG: 42,
        controlHeightSM: 28,
        colorPrimary: BRAND,
        colorPrimaryHover: BRAND_LIGHT,
        colorPrimaryActive: BRAND_DARK,
      },
      Card: {
        borderRadiusLG: 14,
        paddingLG: 20,
      },
      Modal: {
        borderRadiusLG: 16,
      },
      Tabs: {
        itemColor: isDark ? '#9CA3AF' : '#4B5563',
        itemSelectedColor: BRAND,
        itemHoverColor: BRAND_LIGHT,
      },
      Segmented: {
        borderRadius: 9999,
        trackPadding: 3,
      },
      Tag: {
        borderRadiusSM: 6,
      },
    },
  };
}

export const cssVars = (mode: ThemeMode) => {
  const resolved = effectiveTheme(mode);
  return resolved === 'dark'
    ? {
        '--bg': '#0B0F17',
        '--bg-gradient': 'radial-gradient(ellipse 80% 60% at 50% -20%, rgba(13, 148, 136, 0.15), rgba(11, 15, 23, 0))',
        '--bg-elevated': '#141A24',
        '--fg': '#F3F4F6',
        '--fg-muted': '#9CA3AF',
        '--fg-subtle': '#6B7280',
        '--border': 'rgba(255, 255, 255, 0.09)',
        '--border-brand': 'rgba(13, 148, 136, 0.35)',
        '--glass-bg': 'rgba(20, 26, 36, 0.72)',
        '--glass-border': 'rgba(255, 255, 255, 0.10)',
        '--rail': 'rgba(14, 19, 28, 0.85)',
        '--titlebar-bg': 'rgba(11, 15, 23, 0.82)',
        '--card-bg': '#141A24',
        '--hover-bg': 'rgba(255, 255, 255, 0.05)',
        '--accent-soft': 'rgba(13, 148, 136, 0.16)',
        '--brand-glow': 'rgba(13, 148, 136, 0.30)',
        '--brand-gradient': 'linear-gradient(135deg, #14B8A6 0%, #0D9488 100%)',
        '--shadow-xs': '0 1px 3px rgba(0,0,0,0.35)',
        '--shadow-sm': '0 2px 8px rgba(0,0,0,0.45)',
        '--shadow-md': '0 4px 20px rgba(13, 148, 136, 0.15), 0 2px 10px rgba(0,0,0,0.4)',
        '--shadow-lg': '0 12px 48px rgba(13, 148, 136, 0.22), 0 6px 24px rgba(0,0,0,0.5)',
        '--brand': '#0D9488',
        '--brand-light': '#14B8A6',
        '--brand-dark': '#0F766E',
        '--status-success': '#10B981',
        '--status-warning': '#F59E0B',
        '--status-danger': '#EF4444',
        '--status-info': '#0D9488',
        '--radius-card': '12px',
        '--radius-modal': '16px',
        '--radius-lg': '20px',
      }
    : {
        '--bg': '#F4F7FA',
        '--bg-gradient': 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(13, 148, 136, 0.08), rgba(244, 247, 250, 0))',
        '--bg-elevated': '#FFFFFF',
        '--fg': '#111827',
        '--fg-muted': '#4B5563',
        '--fg-subtle': '#9CA3AF',
        '--border': 'rgba(13, 148, 136, 0.12)',
        '--border-brand': 'rgba(13, 148, 136, 0.35)',
        '--glass-bg': 'rgba(255, 255, 255, 0.78)',
        '--glass-border': 'rgba(13, 148, 136, 0.15)',
        '--rail': 'rgba(244, 247, 250, 0.85)',
        '--titlebar-bg': 'rgba(244, 247, 250, 0.88)',
        '--card-bg': '#FFFFFF',
        '--hover-bg': 'rgba(13, 148, 136, 0.045)',
        '--accent-soft': 'rgba(13, 148, 136, 0.09)',
        '--brand-glow': 'rgba(13, 148, 136, 0.20)',
        '--brand-gradient': 'linear-gradient(135deg, #14B8A6 0%, #0D9488 100%)',
        '--shadow-xs': '0 1px 4px rgba(13, 148, 136, 0.05), 0 1px 2px rgba(0,0,0,0.03)',
        '--shadow-sm': '0 2px 10px rgba(13, 148, 136, 0.07), 0 1px 3px rgba(0,0,0,0.04)',
        '--shadow-md': '0 4px 20px rgba(13, 148, 136, 0.10), 0 2px 8px rgba(0,0,0,0.05)',
        '--shadow-lg': '0 12px 48px rgba(13, 148, 136, 0.16), 0 6px 24px rgba(0,0,0,0.08)',
        '--brand': '#0D9488',
        '--brand-light': '#14B8A6',
        '--brand-dark': '#0F766E',
        '--status-success': '#10B981',
        '--status-warning': '#F59E0B',
        '--status-danger': '#EF4444',
        '--status-info': '#0D9488',
        '--radius-card': '12px',
        '--radius-modal': '16px',
        '--radius-lg': '20px',
      };
};

