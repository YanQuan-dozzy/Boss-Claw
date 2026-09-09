import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { ThemeMode } from '../theme';
import type { JobPlatform } from '@/lib/bossclaw/platforms';

export type RouteKey =
  | 'home'
  | 'workbench'
  | 'resume'
  | 'directions'
  | 'tasks'
  | 'schedule'
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
  { key: 'schedule', label: '定时任务' },
  { key: 'stats', label: '数据统计' },
  { key: 'assistant', label: '定制简历' },
  { key: 'openclaw', label: 'OpenClaw' },
  { key: 'autochat', label: '自动沟通' },
  { key: 'settings', label: '设置' },
];

export type EngineStatus = 'running' | 'stopped' | 'disconnected';

/**
 * 侧边栏「当前动作」多源协调优先级：自动沟通(2) > 工作台投递/采集(1)。
 * 低优先级源不覆盖高优先级源（避免两者并存时互相闪烁）；
 * 高优先级源停止后由对方通过订阅自己的信号作为重跑触发来恢复文本。
 */
export const ACTION_SOURCE_PRIORITY: Record<string, number> = {
  autochat: 2,
  workbench: 1,
};

interface AppState {
  theme: ThemeMode;
  activeRoute: RouteKey;
  autoAssist: boolean;
  bridgeStatus: 'connected' | 'disconnected';
  bossLoggedIn: boolean | null;
  sidebarCollapsed: boolean;
  /** 侧边栏底部动态动作状态（与 StatusBar 的 OpenClaw 状态区分开） */
  currentAction: { text: string; source: string | null };
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setRoute: (r: RouteKey) => void;
  setAutoAssist: (v: boolean) => void;
  setBridgeStatus: (s: 'connected' | 'disconnected') => void;
  setBossLoggedIn: (v: boolean | null) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setCurrentAction: (source: string, text: string) => void;
  clearCurrentAction: (source: string) => void;
  /**
   * 标题栏「投递引擎」指示器状态。
   * 与 bridgeStatus 解耦：用户开关按钮 (autoAssist) 即决定状态——
   * 否则本地桥接未启动时（默认 disconnected）用户点「开始投递」标题栏始终停在「已停止」，
   * 完全无法反馈用户的操作。本工具核心是 webview 通道，桥接只是可选的辅助模块，
   * 即便桥接断开也应允许用户主动启动引擎（实际投递靠 webview + Camoufox 通道执行）。
   * 桥接未连接的状态由 StatusBar / Sidebar / OpenClaw 等独立展示。
   */
  engineStatus: EngineStatus;
  /**
   * 设置页请求在工作台 webview 打开某平台登录页。
   * Settings 设置此状态并切到工作台；Workbench 消费后清空。
   */
  browserLoginRequest: { platform: JobPlatform; loginUrl: string } | null;
  requestBrowserLogin: (platform: JobPlatform, loginUrl: string) => void;
  clearBrowserLogin: () => void;
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
        currentAction: { text: '等待中', source: null },
        browserLoginRequest: null,
        requestBrowserLogin: (platform, loginUrl) => set({ browserLoginRequest: { platform, loginUrl } }),
        clearBrowserLogin: () => set({ browserLoginRequest: null }),
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
        setCurrentAction: (source, text) =>
          set((state) => {
            const cur = state.currentAction.source;
            const curPri = cur ? ACTION_SOURCE_PRIORITY[cur] ?? 0 : 0;
            const newPri = ACTION_SOURCE_PRIORITY[source] ?? 0;
            // 低优先级源不覆盖正在展示的高优先级源
            if (cur && curPri > newPri) return state;
            return { currentAction: { text, source } };
          }),
        clearCurrentAction: (source) =>
          set((state) =>
            state.currentAction.source === source
              ? { currentAction: { text: '等待中', source: null } }
              : state
          ),
      };
    },
    {
      name: 'bossclaw-app',
      // P30：安全持久化（防 localStorage 写失败异常冒泡到渲染调用链）
      storage: createSafePersistStorage(),
      // bridgeStatus / bossLoggedIn / currentAction 是运行时探测结果，不能持久化：
      // 否则上次「已连接 / 正在投递」会被带到下次启动，导致未运行时仍显示旧状态
      partialize: (s) => {
        const { bridgeStatus: _bridge, bossLoggedIn: _login, currentAction: _action, browserLoginRequest: _blr, ...rest } = s;
        return rest;
      },
    }
  )
);
