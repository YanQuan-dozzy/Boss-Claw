// 公共 UI：空状态 / 加载态 / 错误态 / 顶部横幅 / 错误边界
// 设计原则：
//   1. 不依赖业务，可被任意页面复用
//   2. 暗色 / 浅色跟随全局主题（用 antd ConfigProvider 自动适配）
//   3. 文案短促、提供行动指引（不要写「暂无数据」这种没用的提示）
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Empty, Result, Skeleton, Spin } from 'antd';
import {
  ExclamationCircleFilled,
  InboxOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';

// ===== 空状态 =====
interface EmptyStateProps {
  title?: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  size?: 'default' | 'large';
}
export function EmptyState({ title = '暂无内容', description, icon, action, size = 'default' }: EmptyStateProps) {
  return (
    <Empty
      image={icon ?? <InboxOutlined style={{ fontSize: size === 'large' ? 72 : 48 }} />}
      imageStyle={size === 'large' ? { height: 96 } : undefined}
      description={
        <div className="empty-state-text">
          <div className="empty-state-title">{title}</div>
          {description ? <div className="empty-state-desc">{description}</div> : null}
        </div>
      }
    >
      {action}
    </Empty>
  );
}

// ===== 加载态 =====
interface LoadingStateProps {
  tip?: string;
  size?: 'small' | 'default' | 'large';
  inline?: boolean;
}
export function LoadingState({ tip = '加载中…', size = 'default', inline = false }: LoadingStateProps) {
  if (inline) {
    return (
      <span className="loading-state-inline">
        <Spin size="small" indicator={<LoadingOutlined spin />} />
        <span className="loading-state-text">{tip}</span>
      </span>
    );
  }
  return (
    <div className="loading-state">
      <Spin size={size} indicator={<LoadingOutlined spin />} tip={tip} />
    </div>
  );
}

// ===== 骨架屏（卡片场景）=====
interface SkeletonCardProps {
  rows?: number;
  height?: number;
}
export function SkeletonCard({ rows = 3, height = 96 }: SkeletonCardProps) {
  return (
    <div className="skeleton-card" style={{ minHeight: height }}>
      <Skeleton active paragraph={{ rows }} />
    </div>
  );
}

// ===== 顶部横幅（自动消失 / 可关闭 / 多种语义）=====
type BannerKind = 'info' | 'success' | 'warning' | 'error';
interface StatusBannerProps {
  kind?: BannerKind;
  message: ReactNode;
  description?: ReactNode;
  closable?: boolean;
  onClose?: () => void;
  action?: ReactNode;
}
export function StatusBanner({ kind = 'info', message, description, closable, onClose, action }: StatusBannerProps) {
  return (
    <Alert
      type={kind}
      showIcon
      closable={closable}
      onClose={onClose}
      message={message}
      description={description}
      action={action}
      className={`status-banner status-banner--${kind}`}
    />
  );
}

// ===== 错误页面（独立 page 级别）=====
interface ErrorPanelProps {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  extra?: ReactNode;
}
export function ErrorPanel({
  title = '出了点问题',
  description = '页面渲染时发生错误。',
  onRetry,
  extra,
}: ErrorPanelProps) {
  return (
    <Result
      status="error"
      icon={<ExclamationCircleFilled style={{ color: 'var(--color-error, #ff4d4f)' }} />}
      title={title}
      subTitle={description}
      extra={
        <>
          {onRetry ? (
            <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
              重试
            </Button>
          ) : null}
          {extra}
        </>
      }
    />
  );
}

// ===== 错误边界（class 组件，因为 React 错误边界必须是 class）=====
interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义 fallback（不传则用内置 ErrorPanel） */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  /** 出错时上报回调（可接 Sentry / 自家日志） */
  onError?: (err: Error, info: ErrorInfo) => void;
  /** 出错后右上角显示的标识，便于调试 */
  label?: string;
}
interface ErrorBoundaryState {
  err: Error | null;
}
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { err: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // 静默打印到 console（生产可替换为 Sentry 上报）
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, err, info);
    this.props.onError?.(err, info);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.err, this.reset);
    return (
      <div className="error-boundary-fallback">
        <ErrorPanel
          title="页面渲染异常"
          description={
            <span>
              {String(this.state.err?.message || this.state.err)}
              <br />
              <small style={{ opacity: 0.6 }}>已隔离错误，页面其他部分仍可继续使用。</small>
            </span>
          }
          onRetry={this.reset}
        />
      </div>
    );
  }
}

// 默认导出：批量使用最频繁的几个
export default {
  EmptyState,
  LoadingState,
  SkeletonCard,
  StatusBanner,
  ErrorPanel,
  ErrorBoundary,
};