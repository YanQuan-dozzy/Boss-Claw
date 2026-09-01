import { memo } from 'react';
import { Tag, Typography } from 'antd';
import {
  CompassOutlined,
  MessageOutlined,
  CheckCircleOutlined,
  PaperClipOutlined,
  RobotOutlined,
  WarningOutlined,
  SettingOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import type { ChatLogEntry, ChatLogStage } from '@/store/useDataStore';

const { Text } = Typography;

interface ChatLogItemProps {
  log: ChatLogEntry;
}

const STAGE_META: Record<
  ChatLogStage,
  { icon: React.ReactNode; label: string; color: string }
> = {
  open_chat: { icon: <CompassOutlined />, label: '唤起窗口', color: 'cyan' },
  greeting: { icon: <MessageOutlined />, label: '打招呼', color: 'blue' },
  confirm: { icon: <CheckCircleOutlined />, label: '气泡确认', color: 'purple' },
  resume: { icon: <PaperClipOutlined />, label: '简历附件', color: 'geekblue' },
  ai_reply: { icon: <RobotOutlined />, label: 'AI跟聊', color: 'teal' },
  risk: { icon: <WarningOutlined />, label: '风控/暂停', color: 'volcano' },
  verify_chat_target: { icon: <ExclamationCircleOutlined />, label: '目标核验', color: 'volcano' },
  skip: { icon: <WarningOutlined />, label: '跳过', color: 'gold' },
  system: { icon: <SettingOutlined />, label: '系统调度', color: 'default' },
};

const LEVEL_COLOR: Record<string, string> = {
  info: 'blue',
  success: 'green',
  warn: 'gold',
  error: 'red',
  stage: 'cyan',
};

export const ChatLogItem = memo<ChatLogItemProps>(function ChatLogItem({ log }) {
  const stageInfo = log.stage ? STAGE_META[log.stage] || STAGE_META.system : STAGE_META.system;
  const levelColor = LEVEL_COLOR[log.level] || 'default';
  const formattedTime = new Date(log.time).toLocaleTimeString();

  return (
    <div className={`chat-log-item chat-log-item--${log.level}`}>
      <div className="chat-log-item__header">
        <span className="chat-log-item__time">{formattedTime}</span>

        <Tag color={stageInfo.color} icon={stageInfo.icon} className="chat-log-item__stage-tag">
          {stageInfo.label}
        </Tag>

        {log.level !== 'info' && log.level !== 'stage' && (
          <Tag color={levelColor} className="chat-log-item__level-tag">
            {log.level.toUpperCase()}
          </Tag>
        )}

        {(log.jobTitle || log.company) && (
          <div className="chat-log-item__job-chip">
            {log.jobTitle && <span className="chat-log-item__job-title">{log.jobTitle}</span>}
            {log.company && <span className="chat-log-item__company">@{log.company}</span>}
          </div>
        )}
      </div>

      <div className="chat-log-item__body">
        <div className="chat-log-item__msg">{log.msg}</div>

        {/* 打招呼语引述对话框 */}
        {log.greetingPreview && (
          <div className="chat-log-item__bubble">
            <div className="chat-log-item__bubble-author">
              <MessageOutlined style={{ marginRight: 6, color: 'var(--brand)' }} />
              拟发送给 HR 的求职招呼语：
            </div>
            <div className="chat-log-item__bubble-text">{log.greetingPreview}</div>
          </div>
        )}

        {/* 错误与风控 Alert 盒子 */}
        {log.errorDetail && (
          <div className="chat-log-item__error-callout">
            <ExclamationCircleOutlined style={{ marginRight: 6 }} />
            <Text type="danger" style={{ fontSize: 12 }}>{log.errorDetail}</Text>
          </div>
        )}
      </div>
    </div>
  );
});
