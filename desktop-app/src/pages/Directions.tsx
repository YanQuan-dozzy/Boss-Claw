/**
 * 【主模块：投递方向】导航 key = 'directions'
 * 子模块：
 * - 页头操作区（根据画像更新 / 新增自定义方向 / 确认方向（N）+ 已确认徽标）
 * - 方向卡片网格（directions-grid：方向开关/名称/来源(画像|自定义)/优先级，编辑、删除、按需补充建议）
 * - 空态引导（无画像或无方向时的 Empty 提示）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import type { InputRef } from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  RobotOutlined,
  AimOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  buildDirectionPlan,
  directionPreset,
  filterGapsCoveredByProfile,
  normalizeDirectionPlan,
  selectedDirectionItems,
} from '@/lib/bossclaw/directions';
import { generateDirectionKeywords } from '@/lib/bossclaw/directionKeywordsAI';
import { refineDirectionCapabilities, applyDirectionDetails } from '@/lib/bossclaw/directionDetailAI';
import { normalizeStringList } from '@/lib/bossclaw/helpers';
import type { DirectionItem } from '@/lib/bossclaw/types';

const { Paragraph, Text } = Typography;

/** 第一行关键词折叠时默认显示的数量；因为该行恒定单行不换行，这里取小值保证不挤 */
const KEYWORD_COLLAPSE_COUNT = 2;
/** 单个方向最多保留的搜索词数量（与 normalizeDirectionItem 的 12 上限一致） */
const KEYWORD_LIMIT = 12;

export default function Directions() {
  const profile = useDataStore((s) => s.profile);
  const resumeText = useDataStore((s) => s.resumeText);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const setDirectionPlan = useDataStore((s) => s.setDirectionPlan);
  const [items, setItems] = useState<DirectionItem[]>(directionPlan?.items || []);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  // 每个方向卡片的「待添加」输入草稿（受控，便于「＋」按钮一键添加并清空输入）
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 第一行关键词是否展开（默认折叠，只显示前 KEYWORD_COLLAPSE_COUNT 个）
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  // 当前展开候选面板的方向 id（同一时刻只开一个）
  const [openSuggest, setOpenSuggest] = useState<string | null>(null);
  // 正在调用 AI 生成搜索词的方向 id
  const [aiBusyId, setAiBusyId] = useState<string | null>(null);
  // 正在经 AI 复核细化匹配技能/能力缺口（「根据画像更新」内的自动步骤，无独立按钮）
  const [aiDetailBusy, setAiDetailBusy] = useState(false);
  const inputRefs = useRef<Record<string, InputRef | null>>({});
  const config = useSettingsStore((s) => s.config);

  useEffect(() => {
    setItems(directionPlan?.items || []);
  }, [directionPlan]);

  // 点击候选面板与输入行之外的任意位置（或按 Esc）关闭面板
  useEffect(() => {
    if (!openSuggest) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.direction-add') || target?.closest?.('.direction-suggest')) return;
      setOpenSuggest(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenSuggest(null);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openSuggest]);

  // 每张卡片的候选搜索词：只放「本方向」自己的词（方向名 + 该方向目录关键词）。
  // 刻意不混入画像搜索词——那里包含其他方向的岗位名（如「全栈开发工程师」「后端开发工程师」），
  // 混进来会让本方向的下拉里出现跨方向关键词，用户会被误导。
  const suggestionMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const it of items) {
      const preset = directionPreset(it.name);
      map.set(it.id, normalizeStringList([it.name, ...(preset?.keywords || [])], 18));
    }
    return map;
  }, [items]);

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

  const onGenerate = async () => {
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
    // 「只调用 AI 时一起做好」：若已配 AI Key 且画像/简历可用，自动对每个方向做一次细粒度
    // 能力复核（细化匹配技能、剔除误报缺口，如简历已熟 PostgreSQL/MySQL 时不再把「数据库」列为缺口）。
    // 无需新增按钮；AI 未配置或失败时静默保留本地结果。
    // 无论本地还是 AI 的缺口，写入前都统一剔除「画像已具备」项，防止已具备技能误报为缺口。
    const guardGaps = (list: DirectionItem[]) => list.map((it) => ({ ...it, gaps: filterGapsCoveredByProfile(it.gaps, profile) }));
    const sanitized = guardGaps(fresh.items);
    if (fresh.items.length && config.model?.apiKey) {
      setAiDetailBusy(true);
      try {
        const details = await refineDirectionCapabilities(
          { items: fresh.items, profile: profile || undefined, resumeText },
          config.model
        );
        const refined = guardGaps(applyDirectionDetails(fresh.items, details));
        setDirectionPlan(normalizeDirectionPlan({ ...fresh, items: refined }, profile, { confirmed: false }));
        message.success('已根据画像更新方向计划（AI 已细化匹配与缺口）');
        return;
      } catch (error: any) {
        message.warning(`已按画像更新方向计划；AI 缺口细化未完成：${error?.message || '请稍后重试'}`);
      } finally {
        setAiDetailBusy(false);
      }
    }
    setDirectionPlan(normalizeDirectionPlan({ ...fresh, items: sanitized }, profile, { confirmed: false }));
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

  const onKeywordDraft = (id: string, v: string) =>
    setDrafts((prev) => (prev[id] === v ? prev : { ...prev, [id]: v }));

  const toggleExpanded = (id: string) =>
    setExpandedKeys((prev) => ({ ...prev, [id]: !prev[id] }));

  // 增删搜索词统一入口：去重 + 12 条上限告警
  const applyKeywords = (id: string, next: string[]) => {
    const merged = normalizeStringList(next, KEYWORD_LIMIT);
    if (merged.length < normalizeStringList(next, 99).length) {
      message.warning(`每个方向最多 ${KEYWORD_LIMIT} 个搜索词，超出的已忽略`);
    }
    onKeywords(id, merged);
  };

  const removeKeyword = (id: string, keyword: string) => {
    const target = items.find((it) => it.id === id);
    if (!target) return;
    applyKeywords(id, target.keywords.filter((k) => k !== keyword));
  };

  // 候选词行点击：已加入则删除，未加入则添加
  const toggleKeyword = (id: string, keyword: string) => {
    const target = items.find((it) => it.id === id);
    if (!target) return;
    if (target.keywords.includes(keyword)) {
      applyKeywords(id, target.keywords.filter((k) => k !== keyword));
      return;
    }
    applyKeywords(id, [...target.keywords, keyword]);
    onKeywordDraft(id, '');
  };

  // 第二行输入「回车 / 点＋」：有草稿则添加为搜索词并清空输入，无草稿则聚焦展开候选
  const commitKeywordDraft = (id: string) => {
    const draft = (drafts[id] || '').trim();
    const target = items.find((it) => it.id === id);
    if (!target) return;
    if (!draft) {
      inputRefs.current[id]?.focus();
      setOpenSuggest(id);
      return;
    }
    if (!target.keywords.includes(draft)) {
      applyKeywords(id, [...target.keywords, draft]);
      message.success(`已添加搜索词：${draft}`);
    }
    onKeywordDraft(id, '');
  };

  // 候选词面板：本方向目录词 + 输入中的新词，右侧「＋ 添加 / × 删除」，底部 AI 生成
  const renderSuggestPanel = (it: DirectionItem) => {
    const draft = (drafts[it.id] || '').trim();
    const preset = suggestionMap.get(it.id) || [];
    const query = draft.toLowerCase();
    const candidates = query
      ? preset.filter((k) => k !== draft && k.toLowerCase().includes(query))
      : preset;
    const draftIsNew = Boolean(draft) && !preset.includes(draft);
    return (
      <div className="direction-suggest">
        <div className="direction-suggest__list">
          {draftIsNew && (
            <button
              type="button"
              className="direction-suggest__row is-draft"
              onClick={() => commitKeywordDraft(it.id)}
            >
              <span className="direction-suggest__label">新增「{draft}」</span>
              <span className="direction-option__act direction-option__add">
                <PlusOutlined />
              </span>
            </button>
          )}
          {candidates.map((keyword) => {
            const added = it.keywords.includes(keyword);
            return (
              <button
                type="button"
                key={keyword}
                className={`direction-suggest__row ${added ? 'is-added' : ''}`}
                onClick={() => toggleKeyword(it.id, keyword)}
              >
                <span className="direction-suggest__label">{keyword}</span>
                {added ? (
                  <span
                    className="direction-option__act direction-option__remove"
                    title="点击删除该搜索词"
                  >
                    <CloseOutlined />
                  </span>
                ) : (
                  <span
                    className="direction-option__act direction-option__add"
                    title="点击添加为该方向的搜索词"
                  >
                    <PlusOutlined />
                  </span>
                )}
              </button>
            );
          })}
          {!candidates.length && !draftIsNew && (
            <div className="direction-suggest__empty">没有匹配的候选词，直接输入后回车即可新增</div>
          )}
        </div>
        <div className="direction-suggest__foot">
          <Button
            size="small"
            type="text"
            className="direction-ai-btn"
            icon={<RobotOutlined />}
            loading={aiBusyId === it.id}
            disabled={Boolean(aiBusyId) && aiBusyId !== it.id}
            title="调用 AI 为该方向生成 3 条新的搜索关键词"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void onGenerateKeywords(it.id)}
          >
            AI 生成 3 条新搜索词
          </Button>
        </div>
      </div>
    );
  };

  // 下拉底部「AI 生成 3 条新搜索词」：只针对当前方向生成，去重后直接追加为该方向搜索词
  const onGenerateKeywords = async (id: string) => {
    const target = items.find((it) => it.id === id);
    if (!target || aiBusyId) return;
    if (!config.model?.apiKey) {
      message.warning('请先在「设置」页填写 AI API Key 后使用 AI 生成搜索词');
      return;
    }
    setAiBusyId(id);
    try {
      const fresh = await generateDirectionKeywords({ item: target, profile }, config.model);
      if (!fresh.length) {
        message.info('AI 没有生成新的关键词，当前方向的关键词已较完整');
        return;
      }
      applyKeywords(id, [...target.keywords, ...fresh]);
      onKeywordDraft(id, '');
      message.success(`已为「${target.name}」新增 ${fresh.length} 条搜索词：${fresh.join('、')}`);
    } catch (e: any) {
      message.warning(`AI 生成搜索词失败：${e?.message || String(e)}`);
    } finally {
      setAiBusyId(null);
    }
  };

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
          <Space wrap size={10}>
            <Button size="middle" className="btn-uniform" icon={<ReloadOutlined />} onClick={() => void onGenerate()} loading={aiDetailBusy}>
              根据画像更新
            </Button>
            <Button size="middle" className="btn-uniform" icon={<PlusOutlined />} onClick={onAddCustom}>
              新增自定义方向
            </Button>
            <Button size="middle" type="primary" className="btn-uniform" icon={<CheckCircleOutlined />} onClick={onConfirm}>
              确认方向（{selectedCount}）
            </Button>
            {directionPlan?.confirmed && (
              <span className="direction-confirmed-badge">
                <span className="direction-confirmed-dot" />
                已确认
              </span>
            )}
          </Space>
        </div>
      </div>

      {sortedItems.length === 0 ? (
        <Card>
          <Empty description="暂无投递方向，点击「根据画像更新」生成" />
        </Card>
      ) : (
        // 子模块：方向卡片网格（开关/名称/来源/优先级，编辑与删除）
        <div className="directions-grid">
          {sortedItems.map((it) => (
            <Card
              key={it.id}
              size="small"
              className={`direction-card ${it.enabled ? 'is-enabled' : 'is-disabled'} ${
                openSuggest === it.id ? 'is-suggesting' : ''
              }`}
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
                      <span className="direction-card__source is-custom">
                        自定义
                      </span>
                    ) : (
                      <span className="direction-card__source">画像</span>
                    )}
                  </div>
                  <div className="direction-card__meta">
                    <span className="direction-rank-badge" title="方向优先级排名">#{it.priority}</span>
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
                <div className="direction-card__label-wrap">
                  <span className="direction-card__label">
                    搜索词
                  </span>
                  <span className="direction-card__count">{it.keywords.length}</span>
                </div>

                {/* 第一行：已有关键词，恒定单行不换行；超出用「+N / 收起」展开 */}
                <div className={`direction-keys ${expandedKeys[it.id] ? 'is-expanded' : ''}`}>
                  {(expandedKeys[it.id] ? it.keywords : it.keywords.slice(0, KEYWORD_COLLAPSE_COUNT)).map(
                    (keyword) => (
                      <span key={keyword} className="direction-tag" title={keyword}>
                        <span className="direction-tag__text">{keyword}</span>
                        <span
                          className="direction-tag__close"
                          role="button"
                          aria-label={`删除搜索词 ${keyword}`}
                          title="删除该搜索词"
                          onClick={() => removeKeyword(it.id, keyword)}
                        >
                          <CloseOutlined />
                        </span>
                      </span>
                    )
                  )}
                  {it.keywords.length > KEYWORD_COLLAPSE_COUNT && (
                    <button
                      type="button"
                      className="direction-tag direction-tag--more"
                      title={expandedKeys[it.id] ? '收起关键词' : '展开全部关键词'}
                      onClick={() => toggleExpanded(it.id)}
                    >
                      {expandedKeys[it.id] ? '收起' : `+${it.keywords.length - KEYWORD_COLLAPSE_COUNT}`}
                    </button>
                  )}
                  {!it.keywords.length && (
                    <span className="direction-keys__empty">暂无搜索词，在下方输入框添加</span>
                  )}
                </div>

                {/* 第二行：输入新增（回车或点「＋」添加，聚焦展开候选词面板） */}
                <div className="direction-add">
                  <Input
                    ref={(node) => {
                      inputRefs.current[it.id] = node;
                    }}
                    size="small"
                    className="direction-card__input"
                    value={drafts[it.id] || ''}
                    onChange={(e) => onKeywordDraft(it.id, e.target.value)}
                    onPressEnter={() => commitKeywordDraft(it.id)}
                    onFocus={() => setOpenSuggest(it.id)}
                    onClick={() => setOpenSuggest(it.id)}
                    placeholder="输入关键字，回车或点「＋」添加"
                    suffix={
                      <span
                        className="direction-add__btn"
                        role="button"
                        aria-label="添加搜索词"
                        title={drafts[it.id] ? '添加当前关键字' : '展开候选搜索词'}
                        onClick={() => commitKeywordDraft(it.id)}
                      >
                        <PlusOutlined />
                      </span>
                    }
                  />
                  {openSuggest === it.id && renderSuggestPanel(it)}
                </div>
              </div>

              {it.matchedSkills.length > 0 && (
                <div className="direction-card__tags">
                  <div className="direction-card__label-wrap">
                    <span className="direction-card__label">
                      匹配技能
                    </span>
                    <span className="direction-card__count">{it.matchedSkills.length}</span>
                  </div>
                  <div className="direction-card__tag-list">
                    {it.matchedSkills.map((s) => (
                      <span key={s} className="direction-card__tag skill-chip-matched">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {it.gaps.length > 0 && (
                <div className="direction-card__tags">
                  <div className="direction-card__label-wrap">
                    <span className="direction-card__label">
                      能力缺口
                    </span>
                    <span className="direction-card__count is-gap">{it.gaps.length}</span>
                  </div>
                  <div className="direction-card__tag-list">
                    {it.gaps.map((s) => (
                      <span key={s} className="direction-card__tag skill-chip-gap">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="direction-card__foot">
                <Space size={4}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    onClick={() => onPriority(it.id, -1)}
                    disabled={it.priority <= 1}
                    aria-label="提升优先级"
                    title="提升优先级"
                    className="direction-card__prio-btn"
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    onClick={() => onPriority(it.id, 1)}
                    disabled={it.priority >= sortedItems.length}
                    aria-label="降低优先级"
                    title="降低优先级"
                    className="direction-card__prio-btn"
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
