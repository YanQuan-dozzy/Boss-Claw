import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { cssVars } from './theme';
import { useTheme } from './context/ThemeContext';
import { bridgeStatus } from './lib/bridgeClient';
import { checkBossLogin } from './lib/bossLogin';
import { clearAllData } from './lib/storage';
import { ensureSkillsLoaded } from './lib/bossclaw/skills';
import { useInterval } from './lib/hooks';
import { startScheduler } from './lib/scheduler';
import { useScheduleStore } from './store/useScheduleStore';
import { consumeLegacyBatchDelivery } from './store/useSettingsStore';
import { restoreFromLocalBackup, startLocalBackup } from './lib/localBackup';
import { syncTargetLocationsOnStart } from './lib/bossclaw/targetLocationSync';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';
import { ErrorBoundary, SkeletonCard } from './components/feedback';
import { useAutoChatStore } from './store/useAutoChatStore';

// 数据版本号：与主进程 main.cjs 的 DATA_VERSION 对齐，v3 重建后首次启动清空旧数据
const DATA_VERSION = 'v3-rebuild-20260815';

// 路由级代码分割：8 个功能页按需加载，显著减小首屏 JS 体积。
const Home = lazy(() => import('./pages/Home'));
const Workbench = lazy(() => import('./pages/Workbench'));
const Resume = lazy(() => import('./pages/Resume'));
const Directions = lazy(() => import('./pages/Directions'));
const Tasks = lazy(() => import('./pages/Tasks'));
const ScheduleTasks = lazy(() => import('./pages/ScheduleTasks'));
const Stats = lazy(() => import('./pages/Stats'));
const OpenClaw = lazy(() => import('./pages/OpenClaw'));
const AutoChat = lazy(() => import('./pages/AutoChat'));
const JobAssistant = lazy(() => import('./pages/JobAssistant'));
const Settings = lazy(() => import('./pages/Settings'));

// 非工作台功能页的路由 key（顺序即侧栏展示顺序；工作台单独常驻处理）。
// 用于「首进常驻」：切到已访问页面不重挂载，仅切换显隐，消除来回切换的挂载卡顿。
const NAV_PAGES: Array<'home' | 'resume' | 'directions' | 'tasks' | 'schedule' | 'stats' | 'openclaw' | 'autochat' | 'assistant' | 'settings'> = [
  'home', 'resume', 'directions', 'tasks',
  'schedule', 'stats', 'openclaw', 'autochat', 'assistant', 'settings',
];

// 页面分块预加载：空闲期预取全部功能页 chunk，使首次切换无需等待懒加载请求/编译，
// 进一步压减切换延迟。模块已在顶部 lazy 具名引用，此处 import() 命中同一分块，无损复用。
const PRELOAD_PAGES: Array<() => Promise<unknown>> = [
  () => import('./pages/Home'),
  () => import('./pages/Workbench'),
  () => import('./pages/Resume'),
  () => import('./pages/Directions'),
  () => import('./pages/Tasks'),
  () => import('./pages/ScheduleTasks'),
  () => import('./pages/Stats'),
  () => import('./pages/OpenClaw'),
  () => import('./pages/AutoChat'),
  () => import('./pages/JobAssistant'),
  () => import('./pages/Settings'),
];

export default function App() {
  const activeRoute = useAppStore((s) => s.activeRoute);
  // P28：从 ThemeProvider 上下文复用 Root 算好的 effective，避免 App 再各自持有一份 matchMedia 监听
  const { effective } = useTheme();

  useEffect(() => {
    const vars = cssVars(effective);
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute('data-theme', effective);
  }, [effective]);

  // 侧边栏按窗口宽度自适应：窗口窄于断点（主窗口 minWidth 960）自动收起为图标栏，
  // 恢复宽度自动展开。跨断点翻转时才改状态，避免覆盖用户在同一侧的手动切换。
  // 页面缩放依赖原生窗口拖拽调整大小（BrowserWindow 默认可拖拽边缘）。
  const SIDEBAR_BREAKPOINT = 1100;
  const lastAutoCollapsedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const applyByWidth = () => {
      const shouldCollapse = window.innerWidth < SIDEBAR_BREAKPOINT;
      if (lastAutoCollapsedRef.current !== shouldCollapse) {
        lastAutoCollapsedRef.current = shouldCollapse;
        useAppStore.getState().setSidebarCollapsed(shouldCollapse);
      }
    };
    applyByWidth();
    window.addEventListener('resize', applyByWidth);
    return () => window.removeEventListener('resize', applyByWidth);
  }, []);

  // 失焦时暂停非必要微动效，节省系统 CPU/GPU 资源
  useEffect(() => {
    const handleBlur = () => document.documentElement.classList.add('is-blurred');
    const handleFocus = () => document.documentElement.classList.remove('is-blurred');
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // 数据版本检测：v3 重建后首次启动清空旧 localStorage 数据（任务/岗位/会话/设置），
  // 与主进程 resetDataForVersion（清 BOSS 登录态）配套，实现「数据也重置」。
  useEffect(() => {
    try {
      const cur = localStorage.getItem('bossclaw-data-version');
      if (cur !== DATA_VERSION) {
        clearAllData();
        localStorage.setItem('bossclaw-data-version', DATA_VERSION);
        window.location.reload();
      }
    } catch (e) {
      console.warn('[App] 数据版本重置失败（可能导致旧数据残留）: ' + String((e && (e as Error).message) || e));
    }
  }, []);

  // 启动即实时探测本地桥接状态（不依赖持久化、不依赖进入 OpenClaw 页），
  // 之后每 15 秒心跳一次，确保「未连接」时不会误显示「已连接」
  const checkBridge = useCallback(async () => {
    try {
      const s = await bridgeStatus();
      useAppStore.getState().setBridgeStatus(s.ok ? 'connected' : 'disconnected');
    } catch {
      useAppStore.getState().setBridgeStatus('disconnected');
    }
  }, []);
  useInterval(checkBridge, 15000, { immediate: true });

  // 启动即探测 BOSS 直聘登录态（cookie 判定），之后每 10 秒心跳一次；
  // 未登录时工作台/首页的自动辅助、搜索采集将被拦截。
  const checkBoss = useCallback(async () => {
    const ok = await checkBossLogin();
    useAppStore.getState().setBossLoggedIn(ok);
  }, []);
  useInterval(checkBoss, 10000, { immediate: true });

  // 启动即预热 AI Skills 层：从 skills/*/SKILL.md 加载技能定义（调用 AI 时按作用域启用注入）
  useEffect(() => {
    ensureSkillsLoaded().catch(() => {});
  }, []);

  // 目标城市同源（设置页「基础求职条件」⇄ 职业画像）：启动时对存量数据做一次并集补齐。
  // 两处一致（正常使用下的恒等状态）时不写任何东西；用户后续在任一处的删除都会同步写两处，
  // 因此不会被这里的补齐「复活」。
  useEffect(() => {
    syncTargetLocationsOnStart();
  }, []);

  // 无 localStorage 数据时从本地备份回签（主存储缺失才恢复，避免覆盖现有数据）
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let hasData = false;
      try {
        hasData = localStorage.getItem('bossclaw-data') != null;
      } catch {
        /* ignore */
      }
      if (hasData) return; // 主存储健在，以 localStorage 为准
      const r = await restoreFromLocalBackup();
      // 刷新守卫：只有恢复后主数据键 bossclaw-data 确实存在才整页刷新。
      // 若备份中该项为 null（坏备份/全空备份），恢复后主数据仍缺失——
      // 此时 reload 只会让启动路径再次进入恢复分支，造成无限整页刷新、界面假死。
      if (!cancelled && r.restored && localStorage.getItem('bossclaw-data') != null) {
        window.location.reload();
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动 5 分钟本地备份心跳（脏检查写盘）
  useEffect(() => {
    const stopBackup = startLocalBackup();
    return () => stopBackup();
  }, []);

  // 启动全局定时任务调度器（应用运行期间按设定时刻触发投递/采集/备份）
  useEffect(() => {
    startScheduler();
  }, []);

  // 一次性迁移（2026-09-09）：老用户 config.batchDelivery（早中晚分批）已退役，
  // 若曾开启，则按其时刻与配额生成 3 条「限量定时投递」任务；幂等：仅当不存在同名任务时生成。
  useEffect(() => {
    const legacy = consumeLegacyBatchDelivery();
    if (!legacy || legacy.enabled !== true) return;
    const sched = useScheduleStore.getState();
    const templateNames = ['早间限量投递', '午间限量投递', '晚间限量投递'];
    if (sched.entries.some((e) => e.action === 'deliver' && templateNames.includes(e.name))) return;
    const count = (slot: 'morning' | 'noon' | 'evening') => Math.max(0, Number(legacy.counts?.[slot]) || 0);
    const mk = (name: string, time: string, slot: 'morning' | 'noon' | 'evening') => {
      sched.addEntry({
        name,
        action: 'deliver',
        time,
        daysOfWeek: [],
        enabled: true,
        platforms: [],
        limitPerRun: count(slot),
      });
    };
    mk('早间限量投递', legacy.morningTime || '09:00', 'morning');
    mk('午间限量投递', legacy.noonTime || '13:00', 'noon');
    mk('晚间限量投递', legacy.eveningTime || '18:00', 'evening');
  }, []);

  const isWorkbench = activeRoute === 'workbench';

  // 「首进常驻」：记录已访问过的非工作台页面（初始为 home），
  // 已访问页面保持挂载、用 CSS 显隐切换，避免每次切回都整体重挂载导致卡顿。
  const [visited, setVisited] = useState<Record<string, boolean>>({ home: true });
  useEffect(() => {
    setVisited((v) => (v[activeRoute] ? v : { ...v, [activeRoute]: true }));
  }, [activeRoute]);
  // 当前路由恒渲染（即使首次进入也只是显示 Suspense 骨架，不产生白屏闪烁）；
  // 渲染集合 = 已访问 ∪ 当前路由，保证切换瞬间新页立即可见。
  const visibleSet = visited[activeRoute] ? visited : { ...visited, [activeRoute]: true };

  // 空闲期预取全部功能页 chunk（延迟数百毫秒，避免与首屏关键资源竞争）
  useEffect(() => {
    const t = window.setTimeout(() => {
      PRELOAD_PAGES.forEach((load) => load().catch(() => {}));
    }, 900);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="workspace">
        <Sidebar />
        <main className={'main-stage' + (isWorkbench ? ' main-stage--full' : '')}>
          {/* 工作台常驻宿主：active 时全屏显示；切换其它模块时隐藏但保持挂载，
              使「搜索采集 / 自动投递 / 内置浏览器」在后台继续运行（webview 不被销毁）。
              因此工作台使用稳定 key 的独立 ErrorBoundary，不随路由切换而卸载。 */}
          <div className={'workbench-host' + (isWorkbench ? ' is-active' : ' is-background')}>
            <ErrorBoundary label="workbench">
              <Suspense fallback={<div className="route-loading" style={{ padding: 24 }}><SkeletonCard rows={4} /></div>}>
                <Workbench />
              </Suspense>
            </ErrorBoundary>
          </div>
          {!isWorkbench && (
            /* 非工作台页「首进常驻」：已访问页保持挂载，仅切换 .is-show 显隐（display 控制），
               避免来回切换时整页卸载/重挂载的卡顿；未访问页展示 Suspense 骨架（lazy 分块已预取）。
               每个页面使用稳定 key（路由名），ErrorBoundary/key 不再随 activeRoute 变化，
               保证已挂载的页面 DOM 不被重建。页面内自行管理的数据（投递/采集/沟通后台）照常存活。 */
            NAV_PAGES.map((key) => {
              if (!visibleSet[key]) return null;
              return (
                <div key={key} className={'page page-route' + (activeRoute === key ? ' is-show' : '')}>
                  <ErrorBoundary label={key}>
                    <Suspense fallback={<div className="route-loading" style={{ padding: 24 }}><SkeletonCard rows={4} /></div>}>
                      {/* 侧边栏各导航模块 → 页面组件映射（key 定义见 store/useAppStore.ts 的 NAV_ITEMS）：
                          home(首页)→Home / resume(简历中心)→Resume /
                          directions(投递方向)→Directions / tasks(任务进度)→Tasks /
                          schedule(定时任务)→ScheduleTasks / stats(数据统计)→Stats /
                          openclaw(OpenClaw)→OpenClaw / autochat(自动沟通)→AutoChat /
                          assistant(定制简历)→JobAssistant / settings(设置)→Settings；
                          workbench(工作台) 在「工作台常驻宿主」处单独挂载。新增模块需同步此处分支。 */}
                      {key === 'home' && <Home />}
                      {key === 'resume' && <Resume />}
                      {key === 'directions' && <Directions />}
                      {key === 'tasks' && <Tasks />}
                      {key === 'schedule' && <ScheduleTasks />}
                      {key === 'stats' && <Stats />}
                      {key === 'openclaw' && <OpenClaw />}
                      {key === 'autochat' && <AutoChat />}
                      {key === 'assistant' && <JobAssistant />}
                      {key === 'settings' && <Settings isVisible={activeRoute === 'settings'} />}
                    </Suspense>
                  </ErrorBoundary>
                </div>
              );
            })
          )}
        </main>
      </div>
      <StatusBar />
      {/* 侧边栏「当前动作」协调器：自动沟通后台常驻运行（AutoChat 页切走会卸载），
          由本组件统一上报「正在自动沟通」，优先级高于工作台投递/采集源 */}
      <ActionReporter />
    </div>
  );
}

/** 常驻协调侧边栏底部「当前动作」：后台自动沟通运行时上报，停止时清除。
 * 订阅 autoAssist 作为重跑触发器——工作台停止后若自动沟通仍在跑则恢复其文本。 */
function ActionReporter() {
  const chatRunning = useAutoChatStore((s) => s.chatRunning);
  const autoAssist = useAppStore((s) => s.autoAssist);
  const setCurrentAction = useAppStore((s) => s.setCurrentAction);
  const clearCurrentAction = useAppStore((s) => s.clearCurrentAction);
  useEffect(() => {
    if (chatRunning) setCurrentAction('autochat', '正在自动沟通');
    else clearCurrentAction('autochat');
  }, [chatRunning, autoAssist, setCurrentAction, clearCurrentAction]);
  return null;
}
