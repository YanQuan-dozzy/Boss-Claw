import React from 'react';

export interface ChevronDownProps extends React.SVGProps<SVGSVGElement> {
  /** 尺寸（默认 12px） */
  size?: number | string;
  /** 是否处于展开/打开状态（为 true 时平滑旋转 180°） */
  open?: boolean;
  /** 自定义旋转角度（度） */
  rotate?: number;
  /** 线条宽度（默认 2.2） */
  strokeWidth?: number;
}

/**
 * 现代高质感 ChevronDown 下拉符号
 * - 采用微圆角几何设计（strokeLinecap: round, strokeLinejoin: round）
 * - 展开角度平缓舒展（~90°），告别 Ant Design 原版生硬尖锐的 V 形数学符号
 * - 使用 currentColor 自动随上下文文本或按钮自适应色彩
 * - 内置 0.24s cubic-bezier 展开平滑旋转过渡
 */
export const ChevronDown: React.FC<ChevronDownProps> = ({
  size = 12,
  open = false,
  rotate,
  strokeWidth = 2.2,
  className = '',
  style,
  ...rest
}) => {
  const transform = open
    ? 'rotate(180deg)'
    : typeof rotate === 'number'
    ? `rotate(${rotate}deg)`
    : undefined;

  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`chevron-down ${open ? 'chevron-down--open' : ''} ${className}`.trim()}
      style={{
        display: 'inline-block',
        verticalAlign: '-0.125em',
        transition: 'transform 0.24s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
        transform,
        transformOrigin: '50% 50%',
        flexShrink: 0,
        ...style,
      }}
      aria-hidden="true"
      {...rest}
    >
      <path d="M4.5 7.5L10 13L15.5 7.5" />
    </svg>
  );
};

export default ChevronDown;
