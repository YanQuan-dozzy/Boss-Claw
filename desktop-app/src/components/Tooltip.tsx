import React, { useState, useRef } from 'react';

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

  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      setVisible(true);
    }, delayMs);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  };

  if (!title) return children;

  return (
    <div
      className="custom-tooltip-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && (
        <div className={`custom-tooltip custom-tooltip--${placement} ${className}`} role="tooltip">
          <div className="custom-tooltip__content">{title}</div>
        </div>
      )}
    </div>
  );
};
