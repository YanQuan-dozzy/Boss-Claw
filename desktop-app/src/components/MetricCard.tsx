import React, { useEffect, useState } from 'react';

interface MetricCardProps {
  title: string;
  value: number;
  suffix?: string;
  type?: 'default' | 'success-rate' | 'pending' | 'remaining';
  icon?: React.ReactNode;
  subText?: string;
}

// 数字递增动画 Hook
function useAnimatedCount(targetValue: number, duration: number = 600) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let startTimestamp: number | null = null;
    const startValue = displayValue;
    const diff = targetValue - startValue;

    if (diff === 0) return;

    let animationFrameId: number;

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      // easeOutExpo
      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplayValue(Math.round(startValue + diff * easeProgress));

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(step);
      }
    };

    animationFrameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationFrameId);
  }, [targetValue, duration]);

  return displayValue;
}



export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  suffix = '',
  type = 'default',
  icon,
  subText,
}) => {
  const count = useAnimatedCount(value);
  const displaySuffix = suffix || (type === 'success-rate' ? '%' : '');

  return (
    <div className={`metric-card metric-card--${type}`}>
      <div className="metric-card__header">
        <span className="metric-card__title">{title}</span>
        {icon && <span className="metric-card__icon">{icon}</span>}
      </div>

      <div className="metric-card__body">
        <div className="metric-card__value-wrap">
          <span className="metric-card__value">{count}</span>
          {displaySuffix && <span className="metric-card__suffix">{displaySuffix}</span>}
        </div>
      </div>

      {subText && <div className="metric-card__sub">{subText}</div>}
    </div>
  );
};
