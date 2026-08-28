import React, { useEffect, useState } from 'react';
import { MinusOutlined, BorderOutlined, SwitcherOutlined, CloseOutlined } from '@ant-design/icons';
import electronApi from '../lib/electronApi';

interface WindowControlsProps {
  platform?: 'win32' | 'darwin' | string;
  className?: string;
}

export const WindowControls: React.FC<WindowControlsProps> = ({
  platform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 'darwin' : 'win32',
  className = '',
}) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    electronApi.win
      .isMaximized()
      .then((m: boolean) => {
        if (alive) setMaximized(m);
      })
      .catch(() => {});

    const unsub = electronApi.win.onMaximizedChanged((m: boolean) => {
      if (alive) setMaximized(m);
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const toggleMaximize = () => electronApi.win.maximize();

  if (platform === 'darwin') {
    return (
      <div className={`mac-window-controls ${className}`}>
        <button
          type="button"
          className="mac-wc-btn mac-wc-close"
          onClick={() => electronApi.win.close()}
          title="关闭"
          aria-label="关闭"
        />
        <button
          type="button"
          className="mac-wc-btn mac-wc-min"
          onClick={() => electronApi.win.minimize()}
          title="最小化"
          aria-label="最小化"
        />
        <button
          type="button"
          className="mac-wc-btn mac-wc-max"
          onClick={toggleMaximize}
          title={maximized ? '还原' : '全屏'}
          aria-label={maximized ? '还原' : '全屏'}
        />
      </div>
    );
  }

  return (
    <div className={`window-controls ${className}`}>
      <button
        type="button"
        className="wc-btn wc-btn--min"
        onClick={() => electronApi.win.minimize()}
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
        onClick={() => electronApi.win.close()}
        title="关闭"
        aria-label="关闭"
      >
        <CloseOutlined />
      </button>
    </div>
  );
};
