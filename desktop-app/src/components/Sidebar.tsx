import { memo, useState, useEffect } from 'react';
import {
  HomeOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  AimOutlined,
  ProfileOutlined,
  BarChartOutlined,
  ApiOutlined,
  MessageOutlined,
  RobotOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
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
  assistant: <RobotOutlined />,
  settings: <SettingOutlined />,
};

export default memo(function Sidebar() {
  const active = useAppStore((s) => s.activeRoute);
  const setRoute = useAppStore((s) => s.setRoute);
  const bridge = useAppStore((s) => s.bridgeStatus);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleSidebarCollapsed);

  const [collapseTooltipOpen, setCollapseTooltipOpen] = useState(false);

  // 侧边栏展开/收起状态改变时，强制关闭提示标签，防止位置变动导致 Tooltip 卡在页面上
  useEffect(() => {
    setCollapseTooltipOpen(false);
  }, [collapsed]);

  const handleToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    setCollapseTooltipOpen(false);
    e.currentTarget.blur();
    toggleCollapsed();
  };

  return (
    <nav className={'side-rail' + (collapsed ? ' is-collapsed' : '')}>
      <div className="rail-header">
        {!collapsed && <span className="rail-label">导航</span>}
        <Tooltip
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          placement="right"
          open={collapseTooltipOpen}
          onOpenChange={setCollapseTooltipOpen}
          destroyTooltipOnHide
        >
          <button
            className="rail-collapse-btn"
            onClick={handleToggle}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </Tooltip>
      </div>

      {NAV_ITEMS.map((it) => {
        const btn = (
          <button
            key={it.key}
            className={'nav-btn' + (active === it.key ? ' is-active' : '')}
            onClick={(e) => {
              e.currentTarget.blur();
              setRoute(it.key);
            }}
          >
            <span className="nav-icon">{NAV_ICONS[it.key]}</span>
            {!collapsed && <span className="nav-label">{it.label}</span>}
          </button>
        );

        return collapsed ? (
          <Tooltip key={it.key} title={it.label} placement="right" destroyTooltipOnHide>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}

      <div className="rail-spacer" />

      {collapsed ? (
        <Tooltip
          title={`OpenClaw ${bridge === 'connected' ? '已连接' : '未连接'}`}
          placement="right"
          destroyTooltipOnHide
        >
          <div className={'bridge-status' + (bridge === 'connected' ? ' online' : '') + ' is-collapsed'}>
            <i className="dot" />
          </div>
        </Tooltip>
      ) : (
        <div className={'bridge-status' + (bridge === 'connected' ? ' online' : '')}>
          <i className="dot" />
          <span>OpenClaw{bridge === 'connected' ? '已连接' : '未连接'}</span>
        </div>
      )}
    </nav>
  );
});
