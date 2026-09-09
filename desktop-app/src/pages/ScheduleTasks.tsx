import { useState } from 'react';
import {
  Button, Card, Input, InputNumber, Modal, Select, Space, Switch, Tag, TimePicker, Typography, message,
} from 'antd';
import {
  ClockCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  RocketOutlined,
  SearchOutlined,
  SaveOutlined,
  ScheduleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useScheduleStore, type ScheduleAction, type ScheduleEntry } from '@/store/useScheduleStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { PLATFORM_IDS, platformEnabled, platformLabel, type JobPlatform } from '@/lib/bossclaw/platforms';
import { EmptyState } from '@/components/feedback';
import dayjs from 'dayjs';

const { Text, Paragraph } = Typography;

const ACTION_META: Record<ScheduleAction, { label: string; color: string; icon: React.ReactNode; desc: string }> = {
  deliver: {
    label: '定时投递',
    color: 'green',
    icon: <RocketOutlined />,
    desc: '到点启动一次批量自动投递，可限定平台与单轮上限（受冷却/每日上限/首条验收等安全规则约束）。',
  },
  collect: { label: '定时采集', color: 'blue', icon: <SearchOutlined />, desc: '到点自动执行搜索采集并入库岗位（需工作台引擎可用）。' },
  backup: { label: '定时备份', color: 'orange', icon: <SaveOutlined />, desc: '到点把 localStorage（岗位/简历/日志）备份到所选备份目录；内容不变不重写。' },
};

/** 「一键生成」分批模板：早 / 午 / 晚 三条限量投递任务 */
const BATCH_TEMPLATES: { name: string; time: string }[] = [
  { name: '早间限量投递', time: '09:00' },
  { name: '午间限量投递', time: '13:00' },
  { name: '晚间限量投递', time: '18:00' },
];
const BATCH_TEMPLATE_LIMIT = 40;

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
  platforms: JobPlatform[];
  limitPerRun: number;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftTask = {
  name: '',
  action: 'deliver',
  time: '09:00',
  daysOfWeek: [],
  platforms: [],
  limitPerRun: 0,
  enabled: true,
};

export default function ScheduleTasks() {
  const entries = useScheduleStore((s) => s.entries);
  const addEntry = useScheduleStore((s) => s.addEntry);
  const updateEntry = useScheduleStore((s) => s.updateEntry);
  const removeEntry = useScheduleStore((s) => s.removeEntry);
  const toggleEntry = useScheduleStore((s) => s.toggleEntry);
  const config = useSettingsStore((s) => s.config);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftTask>(EMPTY_DRAFT);
  const patchDraft = (p: Partial<DraftTask>) => setDraft((d) => ({ ...d, ...p }));

  const showPlatformScope = draft.action === 'deliver' || draft.action === 'collect';

  // 页头「新建定时任务」打开时重置草稿
  const onOpenNew = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const onOpenEdit = (e: ScheduleEntry) => {
    setEditingId(e.id);
    setDraft({
      name: e.name,
      action: e.action,
      time: e.time || '09:00',
      daysOfWeek: e.daysOfWeek || [],
      platforms: e.platforms || [],
      limitPerRun: Math.max(0, Number(e.limitPerRun) || 0),
      enabled: e.enabled,
    });
    setOpen(true);
  };

  const onSave = () => {
    const name = draft.name.trim();
    if (!name) { message.warning('请填写任务名称'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(draft.time) || !dayjs(draft.time, 'HH:mm').isValid()) {
      message.warning('请选择有效的触发时刻'); return;
    }
    const body = {
      name,
      action: draft.action,
      time: draft.time,
      daysOfWeek: draft.daysOfWeek,
      platforms: showPlatformScope ? draft.platforms : [],
      limitPerRun: draft.action === 'deliver' ? draft.limitPerRun : 0,
      enabled: draft.enabled,
    };
    if (editingId) {
      updateEntry(editingId, body);
      message.success(`已保存定时任务「${name}」`);
    } else {
      addEntry(body);
      message.success(`已创建定时任务「${name}」`);
    }
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

  /** 一键生成早/午/晚三条限量投递任务（已存在同名任务时先确认） */
  const onGenerateBatch = () => {
    const existing = entries.filter(
      (e) => e.action === 'deliver' && BATCH_TEMPLATES.some((t) => t.name === e.name)
    );
    const create = () => {
      BATCH_TEMPLATES.forEach((t) => {
        addEntry({
          name: t.name,
          action: 'deliver',
          time: t.time,
          daysOfWeek: [],
          enabled: true,
          platforms: [],
          limitPerRun: BATCH_TEMPLATE_LIMIT,
        });
      });
      message.success('已创建 早/午/晚 三条限量投递任务，可在列表中调整时刻与上限');
    };
    if (existing.length > 0) {
      Modal.confirm({
        title: '分批投递模板任务已存在',
        content: `列表已有 ${existing.length} 条同名模板任务（如「早间限量投递」）。仍要再创建一份吗？可在列表中先删除旧任务。`,
        okText: '再创建一份',
        cancelText: '取消',
        onOk: create,
      });
      return;
    }
    create();
  };

  // 平台范围文本（空 = 全部已启用平台）
  const scopeText = (e: ScheduleEntry) => {
    if (e.action === 'backup') return '备份本地数据目录';
    const pf = e.platforms?.length ? e.platforms.map((p) => platformLabel(p)).join('、') : '全部启用平台';
    if (e.action === 'deliver') {
      const limit = Math.max(0, Number(e.limitPerRun) || 0);
      return `${pf} · ${limit > 0 ? `单轮上限 ${limit} 条` : '不限量'}`;
    }
    return pf;
  };

  const platformOptions = PLATFORM_IDS.map((id) => ({
    value: id,
    label: platformEnabled(config, id) ? platformLabel(id) : `${platformLabel(id)}（未启用）`,
  }));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <ScheduleOutlined className="page-title-icon" />定时任务
          </h1>
          <p className="page-sub">按设定的时刻自动触发「投递 / 采集 / 备份」，需保持应用运行（最小化也生效）。早中晚分批现由多条「限量定时投递」表达。</p>
        </div>
        <div className="page-head-extra">
          <Button type="primary" className="btn-uniform" icon={<PlusOutlined />} onClick={onOpenNew}>
            新建定时任务
          </Button>
        </div>
      </div>

      <Card
        size="small"
        className="mb-16"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ThunderboltOutlined style={{ color: 'var(--brand)' }} />
            <span>分批投递模板</span>
          </div>
        }
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <Paragraph type="secondary" style={{ margin: 0, maxWidth: 620, fontSize: 13 }}>
            分批投递 = 把一天的投递量分散到多个时刻，各自触发一轮<b>限量</b>投递，避免单次批量触发平台风控。
            点击右侧按钮一键创建「早间 09:00 / 午间 13:00 / 晚间 18:00」三条任务（默认每轮 40 条、全部启用平台），
            随后可在列表中按需编辑时刻、每轮上限与目标平台；执行仍受每日上限、冷却与首条验收等安全规则约束。
          </Paragraph>
          <Button className="btn-uniform" icon={<RocketOutlined />} onClick={onGenerateBatch}>
            一键创建 早/午/晚 三条投递任务
          </Button>
        </div>
      </Card>

      <Card
        size="small"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClockCircleOutlined style={{ color: 'var(--brand)' }} />
            <span>定时任务列表</span>
          </div>
        }
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{entries.length} 项</Text>}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="尚未创建定时任务"
            description="点击右上角「新建定时任务」，设定投递 / 采集 / 备份的触发时刻、目标平台与频率"
            action={<Button type="primary" icon={<PlusOutlined />} onClick={onOpenNew}>新建定时任务</Button>}
          />
        ) : (
          <div>
            {entries.map((e) => {
              const meta = ACTION_META[e.action];
              return (
                <div key={e.id} className="task-row">
                  <div style={{ minWidth: 220 }}>
                    <Space size={6} wrap>
                      <Text strong style={{ fontSize: 14 }}>{e.name}</Text>
                      <Tag color={meta.color} icon={meta.icon} style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>{meta.label}</Tag>
                      {(e.action === 'deliver' || e.action === 'collect') && (
                        <Tag color={e.platforms?.length ? 'cyan' : 'default'} style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>
                          {e.platforms?.length ? e.platforms.map((p) => platformLabel(p)).join('/') : '全部平台'}
                        </Tag>
                      )}
                      {e.action === 'deliver' && (Number(e.limitPerRun) || 0) > 0 && (
                        <Tag color="purple" style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>
                          ≤{Number(e.limitPerRun)}/轮
                        </Tag>
                      )}
                    </Space>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {e.time} · {weekdayText(e.daysOfWeek)}
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-muted)' }}>
                    {scopeText(e)}
                    <div style={{ marginTop: 4 }}>
                      上次触发：{formatLastRun(e.lastRunStamp)}
                    </div>
                  </div>
                  <Space size={4}>
                    <Button size="small" type="text" icon={<EditOutlined />} title="编辑" onClick={() => onOpenEdit(e)} />
                    <Switch
                      size="small"
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
          说明：定时任务依赖应用保持运行（最小化仍触发，窗口关闭则不执行）。「定时投递」复用现有自动投递引擎的全部安全规则
          （冷却、每日上限、首条验收、风控交人工），任务可圈定目标平台并设「单轮上限」——达到上限即结束本轮，等下一个触发时刻再启动，
          由此实现分时分批投递；「定时采集」按任务平台逐个执行（需对应平台已登录）；「定时备份」写入你设置的本地备份目录（内容未变化不重写文件）。
        </Paragraph>
      </Card>

      <Modal
        title={editingId ? '编辑定时任务' : '新建定时任务'}
        open={open}
        onOk={onSave}
        onCancel={() => setOpen(false)}
        okText={editingId ? '保存修改' : '创建任务'}
        cancelText="取消"
        width={540}
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
          {showPlatformScope && (
            <div>
              <span className="field-label">目标平台</span>
              <Select
                mode="multiple"
                allowClear
                style={{ width: '100%' }}
                placeholder="留空 = 全部已启用平台（也可预设未启用平台，启用后自动生效）"
                value={draft.platforms}
                onChange={(v) => patchDraft({ platforms: v as JobPlatform[] })}
                options={platformOptions}
                maxTagCount="responsive"
              />
            </div>
          )}
          {draft.action === 'deliver' && (
            <div>
              <span className="field-label">本次投递上限（单轮）</span>
              <InputNumber
                min={0}
                style={{ width: '100%' }}
                placeholder="0 = 不限"
                addonAfter="条 / 轮"
                value={draft.limitPerRun}
                onChange={(v) => patchDraft({ limitPerRun: Math.max(0, Number(v) || 0) })}
              />
              <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
                &gt;0 时，到点触发后成功沟通满该条数即自动结束本轮，等待下一次触发时刻；0 表示不限（跑完队列或触达每日上限等安全规则为止）。配合多个时刻即构成「分批投递」。
              </Paragraph>
            </div>
          )}
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
            <span className="field-label" style={{ marginBottom: 0 }}>{editingId ? '启用该任务' : '创建后启用'}</span>
            <Switch checked={draft.enabled} onChange={(v) => patchDraft({ enabled: v })} />
          </div>
          <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            到点自动执行一次所述动作；触发与频控由全局调度器每分钟校验并去重（同一时刻同一任务不会重复触发）。
          </Paragraph>
        </div>
      </Modal>
    </div>
  );
}
