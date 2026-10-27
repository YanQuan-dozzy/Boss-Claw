// 「本地存储用量」卡片（issue #10）
// ---------------------------------------------------------
// 背景：业务数据大部分在 localStorage（岗位队列自 issue #10 起已迁到主进程文件）。
// 配额写满后 persistSafe 会静默丢弃写入
// （为了不把异常冒泡进引擎），界面上却毫无痕迹——用户看到队列一直在推进，重启后
// 整段进度回退到配额耗尽那一刻，连「基础求职条件」也跟着倒退（bossclaw-settings-v2
// 同样写不进）。
// 这张卡片把「谁吃掉了配额」摊开给用户看，让清理有据可依；写失败时置顶红色提示，
// 并给出可执行的处置路径（导出备份 → 检查磁盘/权限 → 清空运行日志）。
// 口径（实测，见 lib/storage.ts 注释）：Chromium 按「键名 + 值的 UTF-16 码元」计费，
// 单源上限 52,428,800 码元 = 50 MB（1 码元按 1 字节折算展示，与内核的「50MB 额度」表述一致）。
import { useCallback, useEffect, useState } from 'react';
import { Button, Progress, Tag, Typography } from 'antd';
import { DatabaseOutlined, SyncOutlined } from '@ant-design/icons';
import {
  measureStorageUsage,
  formatStorageSize,
  type StorageUsage,
} from '@/lib/storage';
import { usePersistFailures } from '@/lib/hooks';
import { electronApi } from '@/lib/electronApi';
import { isQueueFileMode } from '@/lib/bossclaw/queueMode';

const { Paragraph, Text } = Typography;

/** 存储键的人类可读名（未登记的键直接显示原名） */
const KEY_LABELS: Record<string, string> = {
  'bossclaw-data': '简历 / 画像 / 达标岗位缓存（队列已移出）',
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
  // 队列已迁到 <userData>/queue/（issue #10）：它不占上文的 50MB localStorage 额度，
  // 因此单独一行展示磁盘占用，避免用户误把「额度快满了」与「队列很大」画等号。
  const [queueBytes, setQueueBytes] = useState<number | null>(null);
  const refreshQueue = useCallback(async () => {
    if (!isQueueFileMode()) {
      setQueueBytes(null);
      return;
    }
    const r = await electronApi.queue.usage();
    if (r.ok) setQueueBytes(r.totalBytes ?? 0);
  }, []);
  const refresh = useCallback(() => {
    setUsage(measureStorageUsage());
    void refreshQueue();
  }, [refreshQueue]);
  // 写失败状态变化时刷新：这一时刻占用通常刚跨过阈值，用户最需要看到数字
  useEffect(() => {
    refresh();
  }, [failures, refresh]);
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const failing = failures.length > 0;
  const nearLimit = !failing && usage.ratio >= 0.8;
  const percent = Math.round(usage.ratio * 1000) / 10;
  const rows = usage.rows.filter((r) => r.units > 0);

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
          最后一次成功写入的状态。请先点上方「导出 JSON 备份」。岗位队列已迁到主进程文件、
          不再占用该额度；若仍写入失败，请检查磁盘空间与安全软件拦截，并到日志面板清空运行日志后重试。
        </Paragraph>
      )}

      <Progress
        percent={percent}
        status={failing ? 'exception' : nearLimit ? 'normal' : 'success'}
        strokeColor={nearLimit ? 'var(--status-warning)' : undefined}
        format={() => `${formatStorageSize(usage.totalUnits)} / ${formatStorageSize(usage.quotaUnits)}`}
        style={{ marginTop: 6, marginBottom: 10 }}
      />

      <div className="storage-usage-list">
        {rows.length === 0 && queueBytes == null ? (
          <Text type="secondary" style={{ fontSize: 13 }}>当前没有已持久化的数据。</Text>
        ) : (
          rows.map((r) => (
            <div className="storage-usage-row" key={r.key}>
              <span className="storage-usage-row__name" title={`${r.key}${KEY_LABELS[r.key] ? `（${KEY_LABELS[r.key]}）` : ''}`}>
                {KEY_LABELS[r.key] || r.key}
              </span>
              <span className="storage-usage-row__key">{r.key}</span>
              <span className="storage-usage-row__size">{formatStorageSize(r.units)}</span>
            </div>
          ))
        )}
        {queueBytes != null && (
          <div className="storage-usage-row" key="queue-file">
            <span className="storage-usage-row__name" title="岗位队列（含达标岗位缓存），存于主进程文件，不占 localStorage 额度">
              岗位队列（文件）
            </span>
            <span className="storage-usage-row__key">&lt;userData&gt;/queue/</span>
            <span className="storage-usage-row__size">{formatStorageSize(queueBytes)}</span>
          </div>
        )}
      </div>

      <div className="setting-actions" style={{ marginTop: 12 }}>
        <Button size="middle" className="btn-uniform" icon={<SyncOutlined />} onClick={refresh}>
          刷新用量
        </Button>
      </div>

      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
        上限 <strong>50 MB</strong>（Chromium 对同源所有键合计计算，按字符计费：52,428,800 个字符），
        写满后所有键（含「基础求职条件」）都会写不进去。
        自 issue #10 修复起，<strong>岗位队列已迁到主进程文件</strong>（&lt;userData&gt;/queue/，不占上述额度），
        localStorage 里只剩简历、画像与设置等小数据；若上方仍提示写入失败，请先导出备份再检查磁盘权限。
      </Paragraph>
    </div>
  );
}
