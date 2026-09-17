import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
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

function Root() {
  const theme = useAppStore((s) => s.theme);
  const effective = useEffectiveTheme(theme);

  return (
    <ThemeProvider effective={effective}>
      <ConfigProvider locale={zhCN} theme={getTheme(effective)}>
        <AntApp>
          <App />
        </AntApp>
      </ConfigProvider>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
