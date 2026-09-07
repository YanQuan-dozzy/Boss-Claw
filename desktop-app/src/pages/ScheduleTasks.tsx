import { useState } from 'react';
import { Button, Card, Input, Modal, Select, Space, Switch, Tag, TimePicker, Typography, message } from 'antd';
import {
  ClockCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  RocketOutlined,
  SearchOutlined,
  SaveOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { useScheduleStore, type ScheduleAction } from '@/store/useScheduleStore';
import { EmptyState } from '@/components/feedback';
import dayjs from 'dayjs';

const { Text, Paragraph } = Typography;

const ACTION_META: Record<ScheduleAction, { label: string; color: string; icon: React.ReactNode; desc: string }> = {
  deliver: { label: '定时投递', color: 'green', icon: <RocketOutlined />, desc: '到点启动批量自动投递（已批准岗位），受冷却/每日上限等安全规则约束。' },
  collect: { label: '定时采集', color: 'blue', icon: <SearchOutlined />, desc: '到点自动执行搜索采集并入库岗位（需工作台引擎可用）。' },
  backup: { label: '定时备份', color: 'orange', icon: <SaveOutlined />, desc: '到点把 localStorage（岗位/简历/日志）备份到所选备份目录；内容不变不重写。' },
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ label, value }));

function formatLastRun(stamp: number): string {
  if (!stamp) return '未触发';
  return dayjs(stamp).format('MM-DD HH:mm');
}

function weekdayText(days: number[]): string {
  if (!days || days.length === 0) return '每天';
  return days.sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join('/');
}

interface DraftTask {
  name: string;
  action: ScheduleAction;
  time: string;
  daysOfWeek: number[];
  enabled: boolean;
}

export default function ScheduleTasks() {
  const entries = useScheduleStore((s) => s.entries);
  const addEntry = useScheduleStore((s) => s.addEntry);
  const removeEntry = useScheduleStore((s) => s.removeEntry);
  const toggleEntry = useScheduleStore((s) => s.toggleEntry);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftTask>({
    name: '',
    action: 'deliver',
    time: '09:00',
    daysOfWeek: [],
    enabled: true,
  });
  const patchDraft = (p: Partial<DraftTask>) => setDraft((d) => ({ ...d, ...p }));

  // 页头「新建定时任务」打开时重置草稿
  const onOpenNew = () => {
    setDraft({ name: '', action: 'deliver', time: '09:00', daysOfWeek: [], enabled: true });
    setOpen(true);
  };

  const onSave = () => {
    const name = draft.name.trim();
    if (!name) { message.warning('请填写任务名称'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(draft.time) || !dayjs(draft.time, 'HH:mm').isValid()) {
      message.warning('请选择有效的触发时刻'); return;
    }
    addEntry({
      name,
      action: draft.action,
      time: draft.time,
      daysOfWeek: draft.daysOfWeek,
      enabled: draft.enabled,
    });
    message.success(`已创建定时任务「${name}」`);
    setOpen(false);
  };

  const onDelete = (e: { id: string; name: string }) => {
    Modal.confirm({
      title: `删除定时任务「${e.name}」？`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        removeEntry(e.id);
        message.success('已删除');
      },
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <ScheduleOutlined className="page-title-icon" />定时任务
          </h1>
          <p className="page-sub">按设定的时刻自动触发「投递 / 采集 / 备份」，需保持应用运行（最小化也生效）。</p>
        </div>
        <div className="page-head-extra">
          <Button type="primary" className="btn-uniform" icon={<PlusOutlined />} onClick={onOpenNew}>
            新建定时任务
          </Button>
        </div>
      </div>

      <Card
        size="small"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClockCircleOutlined style={{ color: 'var(--brand)' }} />
            <span>定时任务列表</span>
          </div>
        }
        className="mb-16"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{entries.length} 项</Text>}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="尚未创建定时任务"
            description="点击右上角「新建定时任务」，按需设定投递 / 采集 / 备份的触发时刻与频率"
            action={<Button type="primary" icon={<PlusOutlined />} onClick={onOpenNew}>新建定时任务</Button>}
          />
        ) : (
          <div>
            {entries.map((e) => {
              const meta = ACTION_META[e.action];
              return (
                <div key={e.id} className="task-row">
                  <div style={{ minWidth: 200 }}>
                    <Space size={8} wrap>
                      <Text strong style={{ fontSize: 14 }}>{e.name}</Text>
                      <Tag color={meta.color} icon={meta.icon} style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>{meta.label}</Tag>
                    </Space>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                      {e.time} · {weekdayText(e.daysOfWeek)}
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-muted)' }}>
                    {meta.desc}
                    <div style={{ marginTop: 4 }}>
                      上次触发：{formatLastRun(e.lastRunStamp)}
                    </div>
                  </div>
                  <Space size={8}>
                    <Switch
                      checked={e.enabled}
                      onChange={(v) => { toggleEntry(e.id, v); message.success(v ? '已启用' : '已停用'); }}
                    />
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onDelete({ id: e.id, name: e.name })} />
                  </Space>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card size="small">
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          说明：定时任务依赖应用保持运行（最小化仍触发，窗口关闭则不执行）；「定时投递」会复用现有自动投递引擎的全部安全规则（冷却、每日上限、分批、首条验收、风控交人工），「定时备份」会写入你设置的本地备份目录（内容未变化不重写文件）。
        </Paragraph>
      </Card>

      <Modal
        title="新建定时任务"
        open={open}
        onOk={onSave}
        onCancel={() => setOpen(false)}
        okText="创建任务"
        cancelText="取消"
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
          <div>
            <span className="field-label">任务名称</span>
            <Input
              style={{ width: '100%' }}
              placeholder="如：每日早晨投递"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </div>
          <div>
            <span className="field-label">动作类型</span>
            <Select
              style={{ width: '100%' }}
              value={draft.action}
              onChange={(v) => patchDraft({ action: v as ScheduleAction })}
              options={(Object.keys(ACTION_META) as ScheduleAction[]).map((a) => ({
                label: `${ACTION_META[a].label} - ${ACTION_META[a].desc}`,
                value: a,
              }))}
            />
          </div>
          <div>
            <span className="field-label">触发时刻</span>
            <TimePicker
              format="HH:mm"
              style={{ width: '100%' }}
              minuteStep={5}
              value={dayjs(draft.time, 'HH:mm')}
              onChange={(t) => patchDraft({ time: t ? t.format('HH:mm') : '09:00' })}
            />
          </div>
          <div>
            <span className="field-label">执行星期（默认每天）</span>
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="留空 = 每天"
              value={draft.daysOfWeek}
              onChange={(v) => patchDraft({ daysOfWeek: v })}
              options={WEEKDAY_OPTIONS}
              maxTagCount="responsive"
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="field-label" style={{ marginBottom: 0 }}>创建后启用</span>
            <Switch checked={draft.enabled} onChange={(v) => patchDraft({ enabled: v })} />
          </div>
          <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            到点自动执行一次所述动作；触发与频控由全局调度器每分钟校验并去重。
          </Paragraph>
        </div>
      </Modal>
    </div>
  );
}