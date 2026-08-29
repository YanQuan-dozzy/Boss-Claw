import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemeMode } from '../theme';

export type RouteKey =
  | 'home'
  | 'workbench'
  | 'resume'
  | 'directions'
  | 'tasks'
  | 'stats'
  | 'openclaw'
  | 'autochat'
  | 'assistant'
  | 'settings';

export interface NavItem {
  key: RouteKey;
  label: string;
}

export type { ThemeMode };

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '首页' },
  { key: 'workbench', label: '工作台' },
  { key: 'resume', label: '简历中心' },
  { key: 'directions', label: '投递方向' },
  { key: 'tasks', label: '任务进度' },
  { key: 'stats', label: '数据统计' },
  { key: 'assistant', label: '定制简历' },
  { key: 'openclaw', label: 'OpenClaw' },
  { key: 'autochat', label: '自动沟通' },
  { key: 'settings', label: '设置' },
];

export type EngineStatus = 'running' | 'stopped' | 'disconnected';

interface AppState {
  theme: ThemeMode;
  activeRoute: RouteKey;
  autoAssist: boolean;
  bridgeStatus: 'connected' | 'disconnected';
  bossLoggedIn: boolean | null;
  sidebarCollapsed: boolean;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setRoute: (r: RouteKey) => void;
  setAutoAssist: (v: boolean) => void;
  setBridgeStatus: (s: 'connected' | 'disconnected') => void;
  setBossLoggedIn: (v: boolean | null) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebarCollapsed: () => void;
  /**
   * 标题栏「投递引擎」指示器状态。
   * 与 bridgeStatus 解耦：用户开关按钮 (autoAssist) 即决定状态——
   * 否则本地桥接未启动时（默认 disconnected）用户点「开始投递」标题栏始终停在「已停止」，
   * 完全无法反馈用户的操作。本工具核心是 webview 通道，桥接只是可选的辅助模块，
   * 即便桥接断开也应允许用户主动启动引擎（实际投递靠 webview + Camoufox 通道执行）。
   * 桥接未连接的状态由 StatusBar / Sidebar / OpenClaw 等独立展示。
   */
  engineStatus: EngineStatus;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => {
      /** 直接由 autoAssist 派生：启动 = running，否则 = stopped */
      const deriveEngineStatus = (aa: boolean): EngineStatus => (aa ? 'running' : 'stopped');

      return {
        theme: 'light',
        activeRoute: 'home',
        autoAssist: false,
        bridgeStatus: 'disconnected',
        bossLoggedIn: null,
        sidebarCollapsed: false,
        engineStatus: 'stopped',
        setTheme: (t) => set({ theme: t }),
        toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
        setRoute: (r) => set({ activeRoute: r }),
        setAutoAssist: (v) => set({ autoAssist: v, engineStatus: deriveEngineStatus(v) }),
        setBridgeStatus: (s) =>
          set((state) => ({
            bridgeStatus: s,
            // engineStatus 不再依赖 bridgeStatus，但仍触发 selector 刷新避免遗漏订阅者
            engineStatus: deriveEngineStatus(state.autoAssist),
          })),
        setBossLoggedIn: (v) => set({ bossLoggedIn: v }),
        setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
        toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      };
    },
    {
      name: 'bossclaw-app',
      // bridgeStatus / bossLoggedIn 是运行时探测结果，不能持久化：
      // 否则上次「已连接 / 已登录」会被带到下次启动，导致未运行时仍显示「已连接 / 已登录」
      partialize: (s) => {
        const { bridgeStatus: _bridge, bossLoggedIn: _login, ...rest } = s;
        return rest;
      },
    }
  )
);
