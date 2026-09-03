import { lazy, Suspense, useCallback, useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { cssVars } from './theme';
import { useTheme } from './context/ThemeContext';
import { bridgeStatus } from './lib/bridgeClient';
import { checkBossLogin } from './lib/bossLogin';
import { clearAllData } from './lib/storage';
import { ensureSkillsLoaded } from './lib/bossclaw/skills';
import { useInterval } from './lib/hooks';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';
import { ErrorBoundary, SkeletonCard } from './components/feedback';

// 数据版本号：与主进程 main.cjs 的 DATA_VERSION 对齐，v3 重建后首次启动清空旧数据
const DATA_VERSION = 'v3-rebuild-20260815';

// 路由级代码分割：8 个功能页按需加载，显著减小首屏 JS 体积。
const Home = lazy(() => import('./pages/Home'));
const Workbench = lazy(() => import('./pages/Workbench'));
const Resume = lazy(() => import('./pages/Resume'));
const Directions = lazy(() => import('./pages/Directions'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Stats = lazy(() => import('./pages/Stats'));
const OpenClaw = lazy(() => import('./pages/OpenClaw'));
const AutoChat = lazy(() => import('./pages/AutoChat'));
const JobAssistant = lazy(() => import('./pages/JobAssistant'));
const Settings = lazy(() => import('./pages/Settings'));

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

  const isWorkbench = activeRoute === 'workbench';

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
            /* Suspense + ErrorBoundary：路由懒加载与页面级崩溃隔离。
               单页崩溃不影响侧栏 / 标题栏 / 状态栏，其它页可正常切换。 */
            <ErrorBoundary label={activeRoute} key={activeRoute}>
              <Suspense fallback={<div className="route-loading" style={{ padding: 24 }}><SkeletonCard rows={4} /></div>}>
                {activeRoute === 'home' && <Home />}
                {activeRoute === 'resume' && <Resume />}
                {activeRoute === 'directions' && <Directions />}
                {activeRoute === 'tasks' && <Tasks />}
                {activeRoute === 'stats' && <Stats />}
                {activeRoute === 'openclaw' && <OpenClaw />}
                {activeRoute === 'autochat' && <AutoChat />}
                {activeRoute === 'assistant' && <JobAssistant />}
                {activeRoute === 'settings' && <Settings />}
              </Suspense>
            </ErrorBoundary>
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
