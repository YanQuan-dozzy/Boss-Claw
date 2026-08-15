import { useEffect, useState, type ReactElement } from 'react';
import {
  SunOutlined,
  MoonOutlined,
  MonitorOutlined,
  MinusOutlined,
  BorderOutlined,
  SwitcherOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useAppStore, type EngineStatus, type ThemeMode } from '../store/useAppStore';
import bossclawIcon from '../assets/bossclaw-icon.png';

const STATUS_META: Record<EngineStatus, { text: string; color: string }> = {
  running: { text: '投递引擎 · 运行中', color: '#52c41a' },
  stopped: { text: '投递引擎 · 已停止', color: '#bfbfbf' },
  disconnected: { text: '投递引擎 · 未连接', color: '#fa8c16' },
};

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactElement }[] = [
  { value: 'light', label: '浅色', icon: <SunOutlined /> },
  { value: 'dark', label: '深色', icon: <MoonOutlined /> },
  { value: 'system', label: '跟随', icon: <MonitorOutlined /> },
];

export default function TitleBar() {
  const engineStatus = useAppStore((s) => s.engineStatus);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const meta = STATUS_META[engineStatus];

  // 窗口最大化状态（控制「最大化□ / 还原❐」图标切换）
  const [maximized, setMaximized] = useState(false);

  // preload 通过 contextBridge 暴露的窗口控制 API（普通 onClick 直接调用，避免任何拖拽区/ref 拦截）
  const win = (window as any).electron;

  // 初始化最大化状态 + 订阅主进程的 maximize/unmaximize 事件（含双击标题栏、Win 键方向键等外部触发）
  useEffect(() => {
    let alive = true;
    win?.winIsMaximized?.().then((m: boolean) => { if (alive) setMaximized(Boolean(m)); }).catch(() => {});
    const unsub = win?.onWindowMaximized?.((m: boolean) => setMaximized(Boolean(m)));
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const toggleMaximize = () => win?.winMaximize?.();

  return (
    <div className="title-bar">
      {/* 左侧拖拽区（双击最大化/还原） */}
      <div className="title-bar-drag" onDoubleClick={toggleMaximize}>
        <img className="title-bar-icon" src={bossclawIcon} alt="BossClaw" />
        <span className="title-bar-name">BossClaw 桌面版</span>
        <span className="title-bar-sep">·</span>
        <span className="title-bar-status">
          <span className="status-led" style={{ background: meta.color }} />
          {meta.text}
        </span>
      </div>

      {/* 右侧交互区：外观胶囊切换 + 窗口控制按钮（均无 drag，普通点击即可触发） */}
      <div className="title-bar-actions">
        <div className="theme-seg" role="group" aria-label="外观主题">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-seg-item${theme === opt.value ? ' is-active' : ''}`}
              onClick={() => setTheme(opt.value)}
              title={opt.label}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="window-controls">
          <button
            type="button"
            className="wc-btn wc-btn--min"
            onClick={() => win?.winMinimize?.()}
            title="最小化"
            aria-label="最小化"
          >
            <MinusOutlined />
          </button>
          <button
            type="button"
            className="wc-btn wc-btn--max"
            onClick={toggleMaximize}
            title={maximized ? '向下还原' : '最大化'}
            aria-label={maximized ? '还原' : '最大化'}
          >
            {maximized ? <SwitcherOutlined /> : <BorderOutlined />}
          </button>
          <button
            type="button"
            className="wc-btn wc-btn--close"
            onClick={() => win?.winClose?.()}
            title="关闭"
            aria-label="关闭"
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
    </div>
  );
}
