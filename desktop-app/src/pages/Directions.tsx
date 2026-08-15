import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  AimOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { buildDirectionPlan, normalizeDirectionPlan, selectedDirectionItems } from '@/lib/bossclaw/directions';
import { normalizeStringList } from '@/lib/bossclaw/helpers';
import type { DirectionItem } from '@/lib/bossclaw/types';

const { Paragraph, Text } = Typography;

export default function Directions() {
  const profile = useDataStore((s) => s.profile);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const setDirectionPlan = useDataStore((s) => s.setDirectionPlan);
  const [items, setItems] = useState<DirectionItem[]>(directionPlan?.items || []);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');

  useEffect(() => {
    setItems(directionPlan?.items || []);
  }, [directionPlan]);

  const ensurePlan = () => {
    if (!profile) {
      message.warning('请先在「简历中心」生成职业画像');
      return null;
    }
    if (!directionPlan) {
      const plan = buildDirectionPlan(profile, null, { confirmed: false });
      setDirectionPlan(plan);
      return plan;
    }
    return directionPlan;
  };

  const onGenerate = () => {
    const plan = ensurePlan();
    if (!plan) return;
    // 保留勾选/名称/自定义方向，但强制按画像重算搜索词，修复历史错误的「实习生」等关键词
    const fresh = buildDirectionPlan(profile, plan, {
      preserveEdits: true,
      preserveSelections: true,
      preserveCustom: true,
      preserveKeywords: false,
      confirmed: false,
    });
    setDirectionPlan(fresh);
    message.success('已根据画像更新方向计划');
  };

  const update = (next: DirectionItem[]) => {
    const plan = ensurePlan();
    if (!plan) return;
    const np = normalizeDirectionPlan({ ...plan, items: next, confirmed: false }, profile, {
      confirmed: false,
    });
    setDirectionPlan(np);
    setItems(np.items);
  };

  const toggle = (id: string, enabled: boolean) =>
    update(items.map((it) => (it.id === id ? { ...it, enabled } : it)));

  const onPriority = (id: string, delta: number) => {
    const sorted = [...items].sort((a, b) => a.priority - b.priority);
    const idx = sorted.findIndex((it) => it.id === id);
    const swap = idx + delta;
    if (idx < 0 || swap < 0 || swap >= sorted.length) return;
    [sorted[idx].priority, sorted[swap].priority] = [sorted[swap].priority, sorted[idx].priority];
    update(sorted);
  };

  const onKeywords = (id: string, v: string[]) =>
    update(items.map((it) => (it.id === id ? { ...it, keywords: normalizeStringList(v, 12) } : it)));

  const onDelete = (id: string) => {
    const it = items.find((i) => i.id === id);
    update(items.filter((i) => i.id !== id));
    message.success(it ? `已删除方向：${it.name}` : '已删除方向');
  };

  const onAddCustom = () => {
    setCustomName('');
    setCustomOpen(true);
  };

  const handleCustomOk = () => {
    const name = customName.trim();
    if (!name) {
      message.warning('请输入方向名称');
      return;
    }
    const custom: DirectionItem = {
      id: `direction_custom_${Date.now().toString(36)}`,
      source: 'custom',
      custom: true,
      sourceName: name,
      name,
      enabled: true,
      priority: items.length + 1,
      score: 70,
      reason: '用户自定义岗位方向。',
      matchedSkills: [],
      gaps: [],
      keywords: normalizeStringList([name]),
      updatedAt: Date.now(),
    };
    update([...items, custom]);
    setCustomOpen(false);
    setCustomName('');
    message.success(`已添加自定义方向：${name}`);
  };

  const onConfirm = () => {
    const plan = ensurePlan();
    if (!plan) return;
    const selected = selectedDirectionItems({ ...plan, items });
    if (!selected.length) {
      message.warning('请至少勾选一个投递方向');
      return;
    }
    const np = normalizeDirectionPlan({ ...plan, items, confirmed: true }, profile, { confirmed: true });
    setDirectionPlan(np);
    message.success(`已确认 ${selected.length} 个投递方向`);
  };

  if (!profile) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">
              <AimOutlined className="page-title-icon" />
              投递方向
            </h1>
          </div>
        </div>
        <Card>
          <Empty description="请先在「简历中心」生成职业画像，再生成投递方向" />
        </Card>
      </div>
    );
  }

  const selectedCount = items.filter((i) => i.enabled).length;
  const sortedItems = [...items].sort((a, b) => a.priority - b.priority);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <AimOutlined className="page-title-icon" />
            投递方向
          </h1>
          <p className="page-sub">
            系统只为你<Text strong>明确勾选并保存</Text>的方向建立任务。可修改搜索词、调整优先级、删除或新增自定义方向。
          </p>
        </div>
        <div className="page-head-extra">
          <Button icon={<ReloadOutlined />} onClick={onGenerate}>
            根据画像更新
          </Button>
          <Button icon={<PlusOutlined />} onClick={onAddCustom}>
            新增自定义方向
          </Button>
          <Button type="primary" icon={<CheckCircleOutlined />} onClick={onConfirm}>
            确认方向（{selectedCount}）
          </Button>
          {directionPlan?.confirmed && <Tag color="green">已确认</Tag>}
        </div>
      </div>

      {sortedItems.length === 0 ? (
        <Card>
          <Empty description="暂无投递方向，点击「根据画像更新」生成" />
        </Card>
      ) : (
        <div className="directions-grid">
          {sortedItems.map((it) => (
            <Card
              key={it.id}
              size="small"
              className={`direction-card ${!it.enabled ? 'is-disabled' : ''}`}
              title={
                <div className="direction-card__head">
                  <div className="direction-card__title">
                    <Switch
                      size="small"
                      checked={it.enabled}
                      onChange={(v) => toggle(it.id, v)}
                    />
                    <span className="direction-card__name" title={it.name}>
                      {it.name}
                    </span>
                    {it.custom ? (
                      <Tag color="blue" className="direction-card__source">
                        自定义
                      </Tag>
                    ) : (
                      <Tag className="direction-card__source">画像</Tag>
                    )}
                  </div>
                  <div className="direction-card__meta">
                    <span className="direction-card__priority">优先级 {it.priority}</span>
                    <Popconfirm
                      title="删除投递方向"
                      description={`确定要删除「${it.name}」吗？删除后可在「根据画像更新」中重新生成画像方向。`}
                      onConfirm={() => onDelete(it.id)}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="删除方向"
                        className="direction-card__delete"
                      />
                    </Popconfirm>
                  </div>
                </div>
              }
            >
              <Paragraph type="secondary" className="direction-card__reason">
                {it.reason}
              </Paragraph>

              <div className="direction-card__field">
                <Text type="secondary" className="direction-card__label">
                  搜索词
                </Text>
                <Select
                  mode="tags"
                  size="small"
                  className="direction-card__select"
                  value={it.keywords}
                  onChange={(v) => onKeywords(it.id, v)}
                  placeholder="输入后回车添加搜索关键词"
                  maxTagCount="responsive"
                />
              </div>

              {it.matchedSkills.length > 0 && (
                <div className="direction-card__tags">
                  <Text type="secondary" className="direction-card__label">
                    匹配技能
                  </Text>
                  <div className="direction-card__tag-list">
                    {it.matchedSkills.map((s) => (
                      <Tag key={s} color="green" className="direction-card__tag">
                        {s}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {it.gaps.length > 0 && (
                <div className="direction-card__tags">
                  <Text type="secondary" className="direction-card__label">
                    能力缺口
                  </Text>
                  <div className="direction-card__tag-list">
                    {it.gaps.map((s) => (
                      <Tag key={s} className="direction-card__tag">
                        {s}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              <div className="direction-card__foot">
                <Space size={2}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    onClick={() => onPriority(it.id, -1)}
                    disabled={it.priority <= 1}
                    aria-label="提升优先级"
                    title="提升优先级"
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    onClick={() => onPriority(it.id, 1)}
                    disabled={it.priority >= sortedItems.length}
                    aria-label="降低优先级"
                    title="降低优先级"
                  />
                </Space>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        title="新增自定义方向"
        open={customOpen}
        onOk={handleCustomOk}
        onCancel={() => setCustomOpen(false)}
        okText="添加"
        cancelText="取消"
      >
        <Input
          placeholder="如：游戏前端开发"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onPressEnter={handleCustomOk}
          autoFocus
        />
      </Modal>
    </div>
  );
}
