import React, { useEffect, useId, useRef, useState } from 'react';

interface CustomTooltipProps {
  title: React.ReactNode;
  children: React.ReactElement;
  delayMs?: number;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export const Tooltip: React.FC<CustomTooltipProps> = ({
  title,
  children,
  delayMs = 400,
  placement = 'top',
  className = '',
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // 审查 #89：延迟定时器必须随卸载清理 —— 否则在 delayMs 窗口内卸载时，
  // 定时器仍会在卸载后触发 setVisible（对已卸载组件写状态）。
  useEffect(() => clearTimer, []);

  const show = () => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(true);
    }, delayMs);
  };

  const hide = () => {
    clearTimer();
    setVisible(false);
  };

  if (!title) return children;

  // 键盘可达（审查 #89）：React 的 onFocus/onBlur 映射到可冒泡的 focusin/focusout，
  // 因此内部可聚焦元素（按钮/链接）获得焦点时同样展示提示；并用 aria-describedby 把提示
  // 与控件关联（role="tooltip" 已有，此处补上被描述对象的引用）。
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-describedby': visible ? tooltipId : undefined,
      })
    : children;

  return (
    <div
      className="custom-tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {child}
      {visible && (
        <div id={tooltipId} className={`custom-tooltip custom-tooltip--${placement} ${className}`} role="tooltip">
          <div className="custom-tooltip__content">{title}</div>
        </div>
      )}
    </div>
  );
};
