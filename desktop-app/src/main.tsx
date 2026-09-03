import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { getTheme } from './theme';
import { useAppStore } from './store/useAppStore';
import { useEffectiveTheme } from './lib/useEffectiveTheme';
import './index.css';
// antd v5 基础样式重置（确保 Segmented/Button 等组件有正确的胶囊/边框样式）
import 'antd/dist/reset.css';

import { ThemeProvider } from './context/ThemeContext';

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
