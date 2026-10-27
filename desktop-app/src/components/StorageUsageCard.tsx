// 「本地存储用量」卡片（issue #10）
// ---------------------------------------------------------
// 背景：所有业务数据都存在 localStorage（Chromium 同源配额 5MB）。配额写满后
// persistSafe 会静默丢弃写入（为了不把异常冒泡进引擎），界面上却毫无痕迹——
// 用户看到队列一直在推进，重启后整段进度回退到配额耗尽那一刻，连「基础求职条件」
// 也跟着倒退（bossclaw-settings-v2 同样写不进）。
// 这张卡片把「谁吃掉了配额」摊开给用户看，让清理有据可依；写失败时置顶红色提示，
// 并给出可执行的处置路径（导出备份 → 清理队列 → 恢复）。
import { useCallback, useEffect, useState } from 'react';
import { Button, Progress, Tag, Typography } from 'antd';
import { DatabaseOutlined, SyncOutlined } from '@ant-design/icons';
import {
  measureStorageUsage,
  formatStorageBytes,
  type StorageUsage,
} from '@/lib/storage';
import { usePersistFailures } from '@/lib/hooks';

const { Paragraph, Text } = Typography;

/** 存储键的人类可读名（未登记的键直接显示原名） */
const KEY_LABELS: Record<string, string> = {
  'bossclaw-data': '岗位队列 / 简历 / 画像 / 达标岗位缓存',
  'bossclaw-settings-v2': '基础求职条件与模型配置',
  'bossclaw-app': '界面偏好（主题、侧栏、路由）',
  'bossclaw-schedule': '定时采集 / 投递任务',
  'bossclaw-runtime-logs': '运行日志（重启即清空，可丢弃）',
  'bossclaw-tailor-history-v1': '定制简历历史',
  'bossclaw-skills-v1': '技能启用态',
  'bossclaw-city-codes': '城市码缓存（可重建）',
  'bossclaw-ai-cache-v1': 'AI 结果缓存（可重建）',
  'bossclaw-ai-cache-stats': 'AI 缓存统计',
  'bossclaw-resume-module-order-v1': '简历模块排序',
  'bossclaw-resume-template-v1': '简历模板',
  'bossclaw-resume-photo-v1': '简历照片',
  'bossclaw-data-version': '数据版本号',
};

export default function StorageUsageCard() {
  const failures = usePersistFailures();
  const [usage, setUsage] = useState<StorageUsage>(() => measureStorageUsage());
  const refresh = useCallback(() => setUsage(measureStorageUsage()), []);
  // 写失败状态变化时刷新：这一时刻占用通常刚跨过阈值，用户最需要看到数字
  useEffect(() => {
    refresh();
  }, [failures, refresh]);

  const failing = failures.length > 0;
  const nearLimit = !failing && usage.ratio >= 0.8;
  const percent = Math.round(usage.ratio * 1000) / 10;
  const rows = usage.rows.filter((r) => r.bytes > 0);

  return (
    <div className="settings-section-card">
      <div className="settings-section-header">
        <div className="settings-section-header__title">
          <div className="section-icon-box">
            <DatabaseOutlined />
          </div>
          本地存储用量
        </div>
        {failing ? (
          <Tag color="red">写入失败</Tag>
        ) : nearLimit ? (
          <Tag color="orange">接近上限</Tag>
        ) : (
          <Tag color="green">正常</Tag>
        )}
      </div>

      {failing && (
        <Paragraph style={{ marginTop: 4, marginBottom: 12, color: 'var(--status-danger-strong)', fontSize: 13 }}>
          <strong>最新进度没有写进本地存储。</strong>
          存储空间已满（或写入被系统拦截）后，所有写入都会被丢弃——界面照常显示，重启后会回退到
          最后一次成功写入的状态。请先点上方「导出 JSON 备份」，再清理岗位队列（工作台 → 批量删除已处理记录），
          给存储腾出空间后写入会自动恢复。
        </Paragraph>
      )}

      <Progress
        percent={percent}
        status={failing ? 'exception' : nearLimit ? 'normal' : 'success'}
        strokeColor={nearLimit ? 'var(--status-warning)' : undefined}
        format={() => `${formatStorageBytes(usage.totalBytes)} / ${formatStorageBytes(usage.quotaBytes)}`}
        style={{ marginTop: 6, marginBottom: 10 }}
      />

      <div className="storage-usage-list">
        {rows.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 13 }}>当前没有已持久化的数据。</Text>
        ) : (
          rows.map((r) => (
            <div className="storage-usage-row" key={r.key}>
              <span className="storage-usage-row__name" title={`${r.key}${KEY_LABELS[r.key] ? `（${KEY_LABELS[r.key]}）` : ''}`}>
                {KEY_LABELS[r.key] || r.key}
              </span>
              <span className="storage-usage-row__key">{r.key}</span>
              <span className="storage-usage-row__size">{formatStorageBytes(r.bytes)}</span>
            </div>
          ))
        )}
      </div>

      <div className="setting-actions" style={{ marginTop: 12 }}>
        <Button size="middle" className="btn-uniform" icon={<SyncOutlined />} onClick={refresh}>
          刷新用量
        </Button>
      </div>

      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
        配额按浏览器同源计算，约 <strong>5 MB</strong>；写满后所有键（含「基础求职条件」）都会写不进去。
        占用主要由<strong>岗位队列的完整 JD 与分析结果</strong>和<strong>达标岗位缓存</strong>构成——
        定期清理已处理岗位、缩短达标岗位保留天数即可长期保持充足余量。
      </Paragraph>
    </div>
  );
}
