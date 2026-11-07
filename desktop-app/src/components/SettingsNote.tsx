// 设置页「说明条」：常驻只留一句结论，完整解释收进悬停提示。
//
// 为什么要有这个组件：语音 / 面试相关分区原先用大块 Alert 常驻 2–4 行技术说明
// （运行时是 sherpa-onnx…、解压后多少 MB…、为什么这样设计…），一屏灰字，
// 真正需要用户看见的东西（数据会发到哪、删了会怎样）反而被稀释掉了。
// 判定口径（改文案时按这条走，别把该留的也收起来）：
//   · 常驻：数据外发 / 隐私承诺 / 不可逆后果 / 会让用户判断错的操作前提；
//   · 收起：实现细节、体积字节数、设计取舍的来龙去脉。
import type { CSSProperties, ReactNode } from 'react';
import { Tooltip } from 'antd';
import { InfoCircleOutlined, QuestionCircleOutlined, WarningOutlined } from '@ant-design/icons';

export default function SettingsNote({
  tone = 'info',
  text,
  detail,
  style,
}: {
  /** info = 中性说明；warning = 需要用户留意的风险（外发 / 不可逆） */
  tone?: 'info' | 'warning';
  text: ReactNode;
  detail?: ReactNode;
  style?: CSSProperties;
}) {
  const Icon = tone === 'warning' ? WarningOutlined : InfoCircleOutlined;
  return (
    <div className={`settings-note settings-note--${tone}`} style={style}>
      <Icon className="settings-note__icon" />
      <div className="settings-note__text">
        {text}
        {detail ? (
          <Tooltip
            title={detail}
            styles={{ body: { maxWidth: 360, fontSize: 12.5, lineHeight: 1.7 } }}
          >
            <span className="settings-note__hint" tabIndex={0} role="button" aria-label="查看说明">
              <QuestionCircleOutlined />
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
