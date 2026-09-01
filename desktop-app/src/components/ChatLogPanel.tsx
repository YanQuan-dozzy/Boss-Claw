import { memo, useState, useRef, useEffect, useMemo } from 'react';
import { Button, Input, Segmented, Tag, Tooltip } from 'antd';
import {
  MessageOutlined,
  DeleteOutlined,
  DownOutlined,
  SearchOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  UnorderedListOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { ChatLogItem } from './ChatLogItem';
import type { ChatLogEntry } from '@/store/useDataStore';

interface ChatLogPanelProps {
  logs: ChatLogEntry[];
  onClear: () => void;
  isRunning?: boolean;
  maxHeight?: number | string;
  className?: string;
}

export const ChatLogPanel = memo<ChatLogPanelProps>(function ChatLogPanel({
  logs,
  onClear,
  isRunning = false,
  maxHeight = 320,
  className = '',
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [searchKw, setSearchKw] = useState<string>('');
  const [userScrolled, setUserScrolled] = useState<boolean>(false);

  // 检查是否在底部
  const checkIfAtBottom = () => {
    const el = streamRef.current;
    if (!el) return true;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceToBottom <= 20;
  };

  const handleScroll = () => {
    setUserScrolled(!checkIfAtBottom());
  };

  const scrollToBottom = () => {
    const el = streamRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setUserScrolled(false);
    }
  };

  useEffect(() => {
    if (!userScrolled) {
      scrollToBottom();
    }
  }, [logs.length, userScrolled]);

  const filteredLogs = useMemo(() => {
    return logs.filter((item) => {
      // 1. 类型/阶段过滤
      if (filterType === 'greeting' && item.stage !== 'greeting') return false;
      if (filterType === 'success' && item.level !== 'success') return false;
      if (filterType === 'risk' && item.stage !== 'risk' && item.level !== 'warn') return false;
      if (filterType === 'error' && item.level !== 'error') return false;

      // 2. 搜索关键词过滤
      if (searchKw.trim()) {
        const kw = searchKw.trim().toLowerCase();
        const inMsg = (item.msg || '').toLowerCase().includes(kw);
        const inJob = (item.jobTitle || '').toLowerCase().includes(kw);
        const inComp = (item.company || '').toLowerCase().includes(kw);
        const inGreet = (item.greetingPreview || '').toLowerCase().includes(kw);
        if (!inMsg && !inJob && !inComp && !inGreet) return false;
      }

      return true;
    });
  }, [logs, filterType, searchKw]);

  return (
    <div className={`chat-log-panel ${className}`}>
      {/* 顶部 Action 工具栏 */}
      <div className="chat-log-panel__header">
        <div className="chat-log-panel__title-row">
          <MessageOutlined className="chat-log-panel__icon" />
          <span className="chat-log-panel__title">实时沟通专属终端日志</span>
          {isRunning && (
            <Tag color="processing" icon={<SyncOutlined spin />} style={{ marginLeft: 8, borderRadius: 10 }}>
              实时监控中
            </Tag>
          )}
          <span className="chat-log-panel__count">{filteredLogs.length} / {logs.length} 条</span>
        </div>

        <div className="chat-log-panel__actions">
          <Input
            size="small"
            placeholder="搜索岗位/公司/消息"
            prefix={<SearchOutlined style={{ color: 'var(--fg-muted)' }} />}
            allowClear
            value={searchKw}
            onChange={(e) => setSearchKw(e.target.value)}
            style={{ width: 150, fontSize: 12 }}
          />

          <Segmented
            size="small"
            value={filterType}
            onChange={(v) => setFilterType(String(v))}
            options={[
              {
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <UnorderedListOutlined style={{ fontSize: 11 }} />
                    全部
                  </span>
                ),
                value: 'all',
              },
              {
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <MessageOutlined style={{ color: '#1677ff', fontSize: 11 }} />
                    招呼
                  </span>
                ),
                value: 'greeting',
              },
              {
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 11 }} />
                    成功
                  </span>
                ),
                value: 'success',
              },
              {
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <WarningOutlined style={{ color: '#fa8c16', fontSize: 11 }} />
                    风控
                  </span>
                ),
                value: 'risk',
              },
              {
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 11 }} />
                    失败
                  </span>
                ),
                value: 'error',
              },
            ]}
          />

          <Tooltip title="清空沟通日志">
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={onClear}
              disabled={logs.length === 0}
            >
              清空
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* 日志流容器 */}
      <div
        ref={streamRef}
        className="chat-log-panel__body"
        style={{ maxHeight }}
        onScroll={handleScroll}
      >
        {filteredLogs.length === 0 ? (
          <div className="chat-log-panel__empty">
            <InboxOutlined style={{ fontSize: 32, marginBottom: 8, opacity: 0.45 }} />
            <div>{searchKw ? '未匹配到相关沟通日志' : '暂无专属沟通日志记录'}</div>
          </div>
        ) : (
          filteredLogs.map((item) => (
            <ChatLogItem key={item.id} log={item} />
          ))
        )}
      </div>

      {/* 滚动到底部悬浮按钮 */}
      {userScrolled && (
        <button
          type="button"
          className="chat-log-panel__scroll-btn"
          onClick={scrollToBottom}
        >
          <DownOutlined />
          <span>最新日志</span>
        </button>
      )}
    </div>
  );
});
