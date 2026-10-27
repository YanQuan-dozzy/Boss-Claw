import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getTheme } from './theme';
import { useAppStore } from './store/useAppStore';
import { useRuntimeLogsStore } from './store/useRuntimeLogsStore';
import { useEffectiveTheme } from './lib/useEffectiveTheme';
import './index.css';
// P5-06：UI 精修层独立文件，必须在此处（index.css 之后）引入，保证「文件靠后覆盖」语义
import './index.polish.css';
// antd v5 基础样式重置（确保 Segmented/Button 等组件有正确的胶囊/边框样式）
import 'antd/dist/reset.css';

import { ThemeProvider } from './context/ThemeContext';
// 渲染层控制运行时：为「本地控制桥」(BOSSCLAW_CONTROL=1) 提供状态快照与白名单动作。
// 未开启控制桥时它只是挂一个 window.__bossclawControl，不产生任何副作用。
import { installControlRuntime } from './lib/controlRuntime';

type AppComponent = React.ComponentType;

// P30：渲染进程全局兜底——网络卡顿/异步异常导致的未捕获错误与 rejection 不应静默吞掉，
// 统一记录到日志面板（addLog 低频、日志已拆独立小键防抖持久化，不会放大卡顿），便于定位「无故卡死」根因。
function installGlobalErrorCatch(): void {
  const report = (kind: string, detail: unknown): void => {
    try {
      const msg = String(
        detail instanceof Error ? `${detail.name}: ${detail.message}` : typeof detail === 'object' ? JSON.stringify(detail) : String(detail)
      ).slice(0, 400);
      console.error(`[global:${kind}]`, detail);
      // 运行日志 store 已被多处静态引用、必然在同一主包内，直接同步写入错误日志
      useRuntimeLogsStore.getState().addLog('error', `全局${kind}：${msg}`);
    } catch {
      /* 兜底失败不再抛 */
    }
  };
  // 仅记录运行时异常（window.onerror）；资源加载失败等无 error 对象的事件跳过（避免噪音刷屏）
  window.addEventListener('error', (e) => {
    if (e?.error) report('错误', e.error);
  });
  window.addEventListener('unhandledrejection', (e) => report('未处理异常', e?.reason));
}
installGlobalErrorCatch();
installControlRuntime();

const root = document.getElementById('root')!;

// 首帧骨架：队列水合是一次 IPC 往返（读 <userData>/queue/queue-store.json，含 .bak 回退），
// 期间不能先渲染一遍「空队列」再跳成真实数据（会闪一下 0 条，issue #10 的观感问题之一）。
if (root) {
  root.innerHTML =
    '<div class="boot-splash"><div class="boot-splash__spinner"></div><div class="boot-splash__text">正在载入本地数据…</div></div>';
}

function Root({ AppComponent }: { AppComponent: AppComponent }) {
  const theme = useAppStore((s) => s.theme);
  const effective = useEffectiveTheme(theme);

  return (
    <ThemeProvider effective={effective}>
      <ConfigProvider locale={zhCN} theme={getTheme(effective)}>
        <AntApp>
          <AppComponent />
        </AntApp>
      </ConfigProvider>
    </ThemeProvider>
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/**
 * 启动顺序（issue #10 / docs/存储迁移方案.md §3）：
 *   1) 一次性迁移：localStorage 里的 pending/qualifiedExports → <userData>/queue/queue-store.json
 *      （先写文件、读回校验，成功后才剥离 localStorage；任何一步失败自动退回旧路径）
 *   2) 水合队列文件；文件为空时尝试从本地备份回签
 *   3) 订阅防抖写盘
 *   4) 动态载入 App 并渲染（App 模块静态引用 useDataStore，必须在第 2 步之后才执行，
 *      否则首帧会用 localStorage 的旧队列画出 0 条、再跳变）
 */
async function boot(): Promise<void> {
  let migrationError: string | undefined;
  try {
    const { migrateQueueFromLocalStorageIfNeeded } = await import('./lib/bossclaw/queueMigrate');
    const r = await migrateQueueFromLocalStorageIfNeeded();
    migrationError = r.error;
  } catch (e) {
    migrationError = String((e as Error)?.message || e);
    console.error('[boot] 队列迁移异常', e);
  }

  const [queueRepo, { queueFileAvailable, isQueueFileMode }, { useDataStore }] = await Promise.all([
    import('./lib/bossclaw/queueRepo'),
    import('./lib/bossclaw/queueMode'),
    import('./store/useDataStore'),
  ]);

  // 迁移失败时文件内容不可信（可能只写了一半），本会话必须以 localStorage 副本为准
  const mayReadFile = !migrationError && queueFileAvailable();
  let hydrated = mayReadFile
    ? await withTimeout(
        queueRepo.hydrateQueue(),
        3000,
        { ok: false, hasData: false, pending: [], qualifiedExports: {}, error: '读取本地队列超时' }
      )
    : { ok: true, hasData: false, pending: [], qualifiedExports: {} as Record<string, never[]> };
  if (!hydrated.ok) {
    useRuntimeLogsStore.getState().addLog('error', `本地队列读取失败：${hydrated.error || '未知错误'}`);
  }
  if (hydrated.ok && hydrated.hasData) {
    useDataStore.getState().hydrateFromFile(hydrated.pending, hydrated.qualifiedExports);
  } else if (mayReadFile) {
    // 对应旧行为「无 localStorage 数据时从本地备份回签」：队列文件被删/损坏时兜底
    const restored = await queueRepo.restoreQueueFromBackupIfEmpty();
    if (restored) {
      const again = await queueRepo.hydrateQueue();
      useDataStore.getState().hydrateFromFile(again.pending, again.qualifiedExports);
      useRuntimeLogsStore.getState().addLog('info', '已从本地备份恢复岗位队列');
    } else if (hydrated.ok && isQueueFileMode()) {
      // 文件模式下「文件里就是没有队列」也要灌一次空值：让 stats 与 queue 对齐，
      // 否则手工删掉队列文件后会看到「待投递 800」但列表为空。
      useDataStore.getState().hydrateFromFile([], {});
    }
  }
  queueRepo.startQueueAutoSave();

  const { default: App } = await import('./App');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Root AppComponent={App} />
    </React.StrictMode>
  );
}

void boot().catch((e) => {
  console.error('[boot] 启动失败', e);
  // 极端兜底：水合链路整体异常时仍渲染主界面（App 内部有自己的空态与本地备份提示）
  void import('./App')
    .then(({ default: App }) => {
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <Root AppComponent={App} />
        </React.StrictMode>
      );
    })
    .catch(() => {
      if (root) {
        root.innerHTML =
          '<div class="boot-splash"><div class="boot-splash__text">界面加载失败，请重启应用</div></div>';
      }
    });
});
