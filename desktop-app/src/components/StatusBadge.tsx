import React from 'react';

export type StatusBadgeType =
  | 'pending'
  | 'approved'
  | 'approved_queue'
  | 'opened'
  | 'sent'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'ignored'
  | 'filtered';

interface StatusBadgeProps {
  status: StatusBadgeType | string;
  label?: string;
  className?: string;
}

const BADGE_MAP: Record<string, { label: string; cls: string; icon?: string }> = {
  pending: { label: '待确认', cls: 'badge-pending' },
  approved: { label: '待投递', cls: 'badge-approved' },
  approved_queue: { label: '投递中', cls: 'badge-queue' },
  opened: { label: '已开窗', cls: 'badge-opened' },
  sent: { label: '投递成功', cls: 'badge-success', icon: '✓' },
  success: { label: '成功', cls: 'badge-success', icon: '✓' },
  failed: { label: '失败', cls: 'badge-failed', icon: '✕' },
  skipped: { label: '已跳过', cls: 'badge-skipped' },
  ignored: { label: '已忽略', cls: 'badge-ignored' },
  filtered: { label: '已过滤', cls: 'badge-filtered' },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, className = '' }) => {
  const meta = BADGE_MAP[status] || { label: label || status, cls: 'badge-default' };
  const displayLabel = label || meta.label;

  return (
    <span className={`status-badge ${meta.cls} ${className}`}>
      {meta.icon && <span className="status-badge__icon">{meta.icon}</span>}
      <span className="status-badge__text">{displayLabel}</span>
    </span>
  );
};
