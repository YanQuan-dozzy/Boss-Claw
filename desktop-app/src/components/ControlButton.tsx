import React from 'react';
import { CaretRightOutlined, PauseOutlined, StopOutlined } from '@ant-design/icons';

export type TaskEngineState = 'idle' | 'running' | 'paused' | 'error';

interface ControlButtonProps {
  state: TaskEngineState;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  disabled?: boolean;
  className?: string;
}

export const ControlButton: React.FC<ControlButtonProps> = ({
  state,
  onStart,
  onPause,
  onStop,
  disabled = false,
  className = '',
}) => {
  const isRunning = state === 'running';
  const isPaused = state === 'paused';

  return (
    <div className={`control-bar-group ${className}`}>
      {/* 状态指示器 */}
      <div className={`status-indicator status-indicator--${state}`}>
        <span className="status-indicator__dot" />
        <span className="status-indicator__text">
          {state === 'idle' && '空闲中'}
          {state === 'running' && '自动投递运行中'}
          {state === 'paused' && '已暂停'}
          {state === 'error' && '运行异常'}
        </span>
      </div>

      <div className="control-btn-group">
        {!isRunning ? (
          <button
            type="button"
            className="ctrl-btn ctrl-btn--start"
            onClick={onStart}
            disabled={disabled}
            title="启动自动投递"
          >
            <CaretRightOutlined />
            <span>{isPaused ? '继续投递' : '启动投递'}</span>
          </button>
        ) : (
          <button
            type="button"
            className="ctrl-btn ctrl-btn--pause"
            onClick={onPause}
            disabled={disabled}
            title="暂停投递"
          >
            <PauseOutlined />
            <span>暂停</span>
          </button>
        )}

        {(isRunning || isPaused) && (
          <button
            type="button"
            className="ctrl-btn ctrl-btn--stop"
            onClick={onStop}
            disabled={disabled}
            title="停止自动投递"
          >
            <StopOutlined />
            <span>停止</span>
          </button>
        )}
      </div>
    </div>
  );
};
