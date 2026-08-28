import React, { useEffect, useRef, useState, useMemo, memo } from 'react';
import { DownOutlined, ClearOutlined } from '@ant-design/icons';
import { Tooltip, Button } from 'antd';
import { LogItem, type LogEntry } from './LogItem';
import { useDataStore } from '@/store/useDataStore';

interface LogConsoleProps {
  logs: LogEntry[];
  title?: string;
  maxHeight?: number | string;
  className?: string;
  extraActions?: React.ReactNode;
}

type FilterLevel = 'all' | 'info' | 'success' | 'warn' | 'error';

export const LogConsole = memo<LogConsoleProps>(function LogConsole({
  logs,
  title = '执行日志',
  maxHeight = 220,
  className = '',
  extraActions,
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterLevel>('all');
  const clearLogs = useDataStore((s) => s.clearLogs);

  // 按日志级别过滤
  const filteredLogs = useMemo(() => {
    if (activeFilter === 'all') return logs;
    return logs.filter((l) => (l.level || 'info').toLowerCase() === activeFilter);
  }, [logs, activeFilter]);

  // 检查是否滚动到底部
  const checkIfAtBottom = () => {
    const el = streamRef.current;
    if (!el) return true;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceToBottom <= 15;
  };

  const handleScroll = () => {
    const atBottom = checkIfAtBottom();
    setUserScrolled(!atBottom);
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
  }, [filteredLogs, userScrolled]);

  return (
    <div className={`log-console ${className}`}>
      <div className="log-console__head">
        <div className="log-console__title-wrap">
          <span className="log-console__terminal-dot" />
          <span className="log-console__title">{title}</span>
        </div>

        <div className="log-console__filters">
          {(['all', 'info', 'success', 'warn', 'error'] as FilterLevel[]).map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`log-console__filter-btn${activeFilter === lvl ? ' is-active' : ''} is-${lvl}`}
              onClick={() => setActiveFilter(lvl)}
            >
              {lvl.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="log-console__actions">
          {extraActions}
          <span className="log-console__count">{filteredLogs.length} 条</span>
          <Tooltip title="清空日志">
            <Button
              size="small"
              type="text"
              icon={<ClearOutlined />}
              onClick={clearLogs}
              className="log-console__clear-btn"
            />
          </Tooltip>
        </div>
      </div>

      <div
        ref={streamRef}
        className="log-console__body"
        style={{ maxHeight }}
        onScroll={handleScroll}
      >
        {filteredLogs.length === 0 ? (
          <div className="log-console__empty">
            {logs.length === 0 ? '暂无日志记录' : `无 [${activeFilter.toUpperCase()}] 级别日志`}
          </div>
        ) : (
          filteredLogs.map((item, idx) => (
            <LogItem key={item.id || `${item.time}-${idx}`} log={item} />
          ))
        )}
      </div>

      {userScrolled && (
        <button
          type="button"
          className="log-console__scroll-btn"
          onClick={scrollToBottom}
        >
          <DownOutlined />
          <span>回到最新</span>
        </button>
      )}
    </div>
  );
});

