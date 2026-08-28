import { memo } from 'react';

export interface LogEntry {
  id?: string;
  time: string;
  level: 'info' | 'success' | 'warn' | 'error' | string;
  msg: string;
}

interface LogItemProps {
  log: LogEntry;
}

export const LogItem = memo<LogItemProps>(function LogItem({ log }) {
  const levelUpper = (log.level || 'info').toUpperCase();

  return (
    <div className={`log-item log-item--${log.level}`}>
      <span className="log-item__time">{log.time}</span>
      <span className={`log-item__tag log-item__tag--${log.level}`}>[{levelUpper}]</span>
      <span className="log-item__msg">{log.msg}</span>
    </div>
  );
});
