import { memo } from 'react';
import {
  HomeOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  AimOutlined,
  ProfileOutlined,
  BarChartOutlined,
  ApiOutlined,
  MessageOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { NAV_ITEMS, useAppStore, RouteKey } from '../store/useAppStore';

const NAV_ICONS: Record<RouteKey, React.ReactNode> = {
  home: <HomeOutlined />,
  workbench: <ThunderboltOutlined />,
  resume: <FileTextOutlined />,
  directions: <AimOutlined />,
  tasks: <ProfileOutlined />,
  stats: <BarChartOutlined />,
  openclaw: <ApiOutlined />,
  autochat: <MessageOutlined />,
  settings: <SettingOutlined />,
};

export default memo(function Sidebar() {
  const active = useAppStore((s) => s.activeRoute);
  const setRoute = useAppStore((s) => s.setRoute);
  const bridge = useAppStore((s) => s.bridgeStatus);

  return (
    <nav className="side-rail">
      <div className="rail-label">导航</div>
      {NAV_ITEMS.map((it) => (
        <button
          key={it.key}
          className={'nav-btn' + (active === it.key ? ' is-active' : '')}
          onClick={() => setRoute(it.key)}
        >
          <span className="nav-icon">{NAV_ICONS[it.key]}</span>
          {it.label}
        </button>
      ))}
      <div className="rail-spacer" />
      <span className={'bridge-status' + (bridge === 'connected' ? ' online' : '')}>
        <i className="dot" />
        OpenClaw{bridge === 'connected' ? '已连接' : '未连接'}
      </span>
    </nav>
  );
});
