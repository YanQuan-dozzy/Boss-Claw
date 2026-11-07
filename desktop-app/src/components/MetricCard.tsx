import React, { useEffect, useRef, useState } from 'react';

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
  // 动画起点必须读「最新值」，但不能靠把 displayValue 放进依赖 —— 那样每帧 setState 都会重建
  // effect、动画被反复重置（表现为数字卡在 0 或只跳一格）。用 ref 承载最新值：
  // effect 只在 targetValue / duration 变化时重建，起点仍是本次动画开始时的真实值。
  const displayRef = useRef(0);

  useEffect(() => {
    let startTimestamp: number | null = null;
    const startValue = displayRef.current;
    const diff = targetValue - startValue;

    if (diff === 0) return;

    let animationFrameId: number;

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      // easeOutExpo
      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const next = Math.round(startValue + diff * easeProgress);
      displayRef.current = next;
      setDisplayValue(next);

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
