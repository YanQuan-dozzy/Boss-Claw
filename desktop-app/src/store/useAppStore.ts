import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { ThemeMode } from '../theme';
import type { JobPlatform } from '@/lib/bossclaw/platforms';
import { PLATFORM_IDS } from '@/lib/bossclaw/platforms';
import type { PlatformLogins } from '@/lib/bossLogin';

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

/**
 * 侧边栏导航（11 模块）唯一权威定义：key = 路由标识，label = 中文展示名。
 * 维护定位：渲染在 components/Sidebar.tsx（图标见其 NAV_ICONS）；
 * 各模块 key(中文) → 页面组件 → 页面文件（App.tsx 中按 key 渲染）：
 *   home(首页)        → Home          → src/pages/Home.tsx
 *   workbench(工作台) → Workbench     → src/pages/Workbench.tsx（常驻宿主，App.tsx 单独挂载）
 *   resume(简历中心)  → Resume        → src/pages/Resume.tsx
 *   directions(投递方向) → Directions → src/pages/Directions.tsx
 *   tasks(任务进度)   → Tasks         → src/pages/Tasks.tsx
 *   schedule(定时任务) → ScheduleTasks → src/pages/ScheduleTasks.tsx
 *   stats(数据统计)   → Stats         → src/pages/Stats.tsx
 *   assistant(定制简历) → JobAssistant → src/pages/JobAssistant.tsx
 *   openclaw(OpenClaw) → OpenClaw     → src/pages/OpenClaw.tsx
 *   autochat(自动沟通) → AutoChat     → src/pages/AutoChat.tsx
 *   settings(设置)    → Settings      → src/pages/Settings.tsx
 * ⚠️ 顺序即展示顺序；新增模块需同步：RouteKey 类型 + NAV_ITEMS + 图标 + App.tsx 渲染分支。
 */
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

/** 设置页分区 key（与 Settings.tsx 的 Tabs items 一一对应，唯一权威） */
export type SettingsTabKey = 'appearance' | 'platforms' | 'criteria' | 'llm' | 'engine' | 'data';

interface AppState {
  theme: ThemeMode;
  activeRoute: RouteKey;
  /**
   * 设置页当前分区。Settings 的 Tabs 以此**受控**，
   * 使「首页 → 配置 AI 模型」等跳转能直达指定分区（此前 Tabs 非受控，跳过去只能落在默认分区）。
   */
  settingsTab: SettingsTabKey;
  autoAssist: boolean;
  bridgeStatus: 'connected' | 'disconnected';
  bossLoggedIn: boolean | null;
  /** 各平台登录态（boss/猎聘/智联/51job），运行时探测结果，不持久化；null = 检测中 */
  platformLogins: PlatformLogins;
  sidebarCollapsed: boolean;
  /** 侧边栏底部动态动作状态（与 StatusBar 的 OpenClaw 状态区分开） */
  currentAction: { text: string; source: string | null };
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setRoute: (r: RouteKey) => void;
  /** 切换设置页分区（不会自动跳转设置页；调用方按需再 setRoute('settings')） */
  setSettingsTab: (t: SettingsTabKey) => void;
  /** 一步到位：定位到设置页某分区（首页步骤卡 / 通知点击用） */
  openSettings: (t: SettingsTabKey) => void;
  setAutoAssist: (v: boolean) => void;
  setBridgeStatus: (s: 'connected' | 'disconnected') => void;
  setBossLoggedIn: (v: boolean | null) => void;
  setPlatformLogins: (m: PlatformLogins) => void;
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
        settingsTab: 'appearance',
        autoAssist: false,
        bridgeStatus: 'disconnected',
        bossLoggedIn: null,
        platformLogins: Object.fromEntries(PLATFORM_IDS.map((p) => [p, null])) as PlatformLogins,
        sidebarCollapsed: false,
        engineStatus: 'stopped',
        currentAction: { text: '等待中', source: null },
        browserLoginRequest: null,
        requestBrowserLogin: (platform, loginUrl) => set({ browserLoginRequest: { platform, loginUrl } }),
        clearBrowserLogin: () => set({ browserLoginRequest: null }),
        setTheme: (t) => set({ theme: t }),
        toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
        setRoute: (r) => set({ activeRoute: r }),
        setSettingsTab: (t) => set({ settingsTab: t }),
        openSettings: (t) => set({ settingsTab: t, activeRoute: 'settings' }),
        setAutoAssist: (v) => set({ autoAssist: v, engineStatus: deriveEngineStatus(v) }),
        setBridgeStatus: (s) =>
          set((state) => ({
            bridgeStatus: s,
            // engineStatus 不再依赖 bridgeStatus，但仍触发 selector 刷新避免遗漏订阅者
            engineStatus: deriveEngineStatus(state.autoAssist),
          })),
        setBossLoggedIn: (v) => set({ bossLoggedIn: v }),
        setPlatformLogins: (m) => set({ platformLogins: m }),
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
      // bridgeStatus / bossLoggedIn / platformLogins / currentAction 是运行时探测结果，不能持久化：
      // 否则上次「已连接 / 正在投递」会被带到下次启动，导致未运行时仍显示旧状态
      partialize: (s) => {
        const { bridgeStatus: _bridge, bossLoggedIn: _login, platformLogins: _pl, currentAction: _action, browserLoginRequest: _blr, ...rest } = s;
        return rest;
      },
    }
  )
);
