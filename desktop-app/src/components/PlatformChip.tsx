// 岗位卡片平台来源 chip —— 统一展示「来自哪个招聘平台」。
// 风格对齐 score-chip / dim-chip / score-rank：等高 monospace、4px 圆角、12% 透明背景 + 深色文本。
// 所有平台都展示（不再仅非 BOSS 显示），让用户一眼看清岗位来源。
import { memo } from 'react';
import type { JobPlatform } from '@/lib/bossclaw/platforms';
import { PLATFORM_META, PLATFORM_CHIP_PALETTE, platformLabel } from '@/lib/bossclaw/platforms';

interface PlatformChipProps {
  /** 平台 id；缺省视为 boss */
  platform?: JobPlatform | string | null;
  /** 是否使用紧凑模式（仅显示 2 字符缩写，用于卡片宽度受限场景） */
  compact?: boolean;
  className?: string;
}

/** 平台 chip 显示文案：紧凑模式取前 2 个中文字符，全名模式用 PLATFORM_META.label */
function chipText(label: string, compact?: boolean): string {
  if (!compact) return label;
  // 取前 2 个中文字符 / 首字母缩写
  const m = label.match(/[\u4e00-\u9fa5]/g);
  if (m && m.length >= 2) return m.slice(0, 2).join('');
  return label.slice(0, 2);
}

// P5-11：入参为原始字符串/布尔，memo 零成本——岗位列表每卡渲染 2 次（Workbench / AutoChat），
// 采集/投递期状态高频变化时避免整卡重复计算 chip
const PlatformChip = memo(function PlatformChip({ platform, compact, className }: PlatformChipProps) {
  const pf = (platform && PLATFORM_META[platform as JobPlatform] ? platform : 'boss') as JobPlatform;
  const meta = PLATFORM_META[pf];
  const palette = PLATFORM_CHIP_PALETTE[meta.chipKey];
  const cls = ['platform-chip', compact ? 'platform-chip--compact' : '', className || '']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      style={{ background: palette.bg, color: palette.fg }}
      title={`来源平台：${platformLabel(pf)}`}
    >
      {chipText(meta.label, compact)}
    </span>
  );
});

export default PlatformChip;