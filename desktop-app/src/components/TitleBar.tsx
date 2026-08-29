import type { ReactElement } from 'react';
import { SunOutlined, MoonOutlined, MonitorOutlined } from '@ant-design/icons';
import { useAppStore, type EngineStatus, type ThemeMode } from '../store/useAppStore';
import electronApi from '../lib/electronApi';
import bossclawIcon from '../assets/bossclaw-icon.png';
import { WindowControls } from './WindowControls';
import { Tooltip } from './Tooltip';

const STATUS_META: Record<EngineStatus, { text: string; color: string }> = {
  running: { text: '投递引擎 · 运行中', color: 'var(--status-success)' },
  stopped: { text: '投递引擎 · 已停止', color: 'var(--fg-subtle)' },
  disconnected: { text: '投递引擎 · 未连接', color: 'var(--status-warning)' },
};

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactElement }[] = [
  { value: 'light', label: '浅色', icon: <SunOutlined /> },
  { value: 'dark', label: '深色', icon: <MoonOutlined /> },
  { value: 'system', label: '跟随系统', icon: <MonitorOutlined /> },
];

export default function TitleBar() {
  const engineStatus = useAppStore((s) => s.engineStatus);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const meta = STATUS_META[engineStatus];

  const toggleMaximize = () => electronApi.win.maximize();

  return (
    <header className="title-bar">
      {/* 左侧拖拽区（双击最大化/还原） */}
      <div className="title-bar-drag" onDoubleClick={toggleMaximize}>
        <img className="title-bar-icon" src={bossclawIcon} alt="BossClaw" />
        <span className="title-bar-name">BossClaw</span>
        <span className="title-bar-sep">·</span>
        <span className="title-bar-status">
          <span className="status-led" style={{ background: meta.color }} />
          {meta.text}
        </span>
      </div>

      {/* 右侧交互区：外观胶囊切换 + 窗口控制按钮 */}
      <div className="title-bar-actions">
        <div className="theme-seg" role="group" aria-label="外观主题">
          {THEME_OPTIONS.map((opt) => (
            <Tooltip key={opt.value} title={opt.label} delayMs={400}>
              <button
                type="button"
                className={`theme-seg-item${theme === opt.value ? ' is-active' : ''}`}
                onClick={() => setTheme(opt.value)}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </button>
            </Tooltip>
          ))}
        </div>

        <WindowControls />
      </div>
    </header>
  );
}
