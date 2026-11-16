// 模拟面试「从投递岗位导入」选择器
//
// 数据源 = 工作台采集队列（useDataStore.pending：待确认 / 待投递 / 已投递 / 失败 等全状态），
// 与「定制简历」页的岗位下拉同源同口径（listTailorJobs + buildTailorJobInput），
// 保证同一个岗位在两个页面看到的是同一份 JD，不会出现「这边有正文、那边只有标题」。
//
// 为什么用弹窗而不是下拉：模拟面试对 JD 有硬门槛（≥ 30 字，见 useMockInterviewStore.startInterview），
// 列表里必须能一眼看出「这个岗位到底采到 JD 没有」——选错了，整场练习都是白练。
import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Modal, Tag, Typography } from 'antd';
import { ImportOutlined, SearchOutlined } from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '@/store/useDataStore';
import { useAppStore } from '@/store/useAppStore';
import { buildTailorJobInput, listTailorJobs, pendingStatusLabel, tailorJobTitle } from '@/lib/bossclaw/tailorJob';
import type { PendingItem } from '@/lib/bossclaw/types';
import { MOCK_MIN_JD_CHARS } from '@/lib/bossclaw/mockInterviewTypes';
import PlatformChip from '@/components/PlatformChip';

const { Text } = Typography;

/** 导入结果：页面拿到后一次性写进当前会话的 job 快照 */
export interface MockJobPick {
  jobId: string | null;
  jobTitle: string;
  company: string;
  jdText: string;
  /** JD 字数（用于导入后的提示口径） */
  chars: number;
  /** 采集到的 JD 质量：只采到元信息时，页面要明确提示「这不是 JD」 */
  jdQuality: JdQuality;
}

interface MockJobPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (pick: MockJobPick) => void;
  /** 当前会话已绑定的岗位 id，列表里打「当前」标记 */
  activeJobId?: string | null;
}

type JdQuality = 'full' | 'card' | 'none';

const JD_QUALITY_META: Record<JdQuality, { label: string; color?: string; tip: string }> = {
  full: { label: 'JD 完整', color: 'green', tip: '采到了岗位详情正文，可直接出题' },
  card: { label: '仅摘要', color: 'orange', tip: '只有列表卡片摘要，JD 可能不足 30 字，导入后需补全' },
  none: { label: '无 JD', color: 'red', tip: '只采到岗位基本信息，导入后需要自己粘贴 JD 原文' },
};

/** 采集时留下的 JD 质量：正文 > 卡片摘要 > 只有元信息 */
function jdQualityOf(p: PendingItem): JdQuality {
  if (String(p.job?.description || '').trim()) return 'full';
  if (String(p.job?.cardText || '').trim()) return 'card';
  return 'none';
}

/** 排序：已投递优先（正在投的岗位最值得练），其次待投递/待确认，最后失败等；同档按时间倒序 */
function statusRank(p: PendingItem): number {
  if (p.status === 'sent') return 0;
  if (p.status === 'approved_queue' || p.status === 'approved' || p.status === 'pending') return 1;
  return 2;
}

function jobTime(p: PendingItem): number {
  return (p.status === 'sent' ? p.sentAt : p.approvedAt) || p.createdAt || 0;
}

export default function MockJobPicker({ open, onClose, onPick, activeJobId }: MockJobPickerProps) {
  const pending = useDataStore(useShallow((s) => s.pending));
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 每次打开都重置：上一次的搜索词/选中项不该带进下一场面试
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    setSelectedId(null);
  }, [open]);

  // 搜索索引与排序都在 pending 变化时算一次：输入关键词时只做 includes，不再对每条 JD 跑清洗/解码
  const entries = useMemo(() => {
    // 损坏/历史数据里的空项直接跳过，避免一条脏数据把整页渲染打崩
    const safe = pending.filter((p) => Boolean(p && p.job));
    return listTailorJobs(safe)
      .slice()
      .sort((a, b) => statusRank(a) - statusRank(b) || jobTime(b) - jobTime(a))
      .map((p) => ({
        p,
        hay: [p.job?.title, p.job?.company, p.job?.description, p.job?.location]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      }));
  }, [pending]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return entries;
    return entries.filter((e) => e.hay.includes(kw));
  }, [entries, keyword]);

  const selected = useMemo(() => entries.find((e) => e.p.id === selectedId)?.p || null, [entries, selectedId]);

  // 只在选中时才算完整 JD（清洗 + 拼元信息），避免几百条岗位每次输入都跑一遍正则
  const picked = useMemo<MockJobPick | null>(() => {
    if (!selected) return null;
    const input = buildTailorJobInput(selected.job);
    return {
      jobId: String(selected.job?.jobId || '').trim() || null,
      jobTitle: input.jobTitle,
      company: String(selected.job?.company || '').trim(),
      jdText: input.jobDesc,
      chars: input.jobDesc.trim().length,
      jdQuality: jdQualityOf(selected),
    };
  }, [selected]);

  const goWorkbench = () => {
    onClose();
    useAppStore.getState().setRoute('workbench');
  };

  const renderRow = (p: PendingItem) => {
    const quality = jdQualityOf(p);
    const meta = JD_QUALITY_META[quality];
    const isActive = p.id === selectedId;
    const isCurrent = Boolean(activeJobId) && String(p.job?.jobId || '') === String(activeJobId);
    return (
      <div
        key={p.id}
        role="option"
        tabIndex={0}
        aria-selected={isActive}
        className={'mi-pick-item' + (isActive ? ' is-active' : '')}
        onClick={() => setSelectedId(p.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelectedId(p.id);
          }
        }}
      >
        <div className="mi-pick-top">
          <span className="mi-pick-title">{tailorJobTitle(p.job) || '未命名岗位'}</span>
          <PlatformChip platform={p.job?.platform} compact />
          <Tag bordered={false} color={meta.color} title={meta.tip}>
            {meta.label}
          </Tag>
          {isCurrent ? <Tag bordered={false} color="blue">当前岗位</Tag> : null}
        </div>
        <div className="mi-pick-sub">
          {[String(p.job?.company || '').trim() || '未知公司', pendingStatusLabel(p.status), p.job?.location]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnClose
      title={<span><ImportOutlined style={{ marginRight: 8, color: 'var(--brand)' }} />从投递岗位导入</span>}
      okText="导入这个岗位"
      cancelText="取消"
      okButtonProps={{ disabled: !picked }}
      onOk={() => { if (picked) onPick(picked); }}
    >
      <div className="mi-pick">
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: 'var(--fg-subtle)' }} />}
          placeholder="搜岗位名称 / 公司 / JD 关键词"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="mi-pick-hint">
          {entries.length
            ? `${filtered.length}/${entries.length} 个已采集岗位（含待确认、待投递、已投递）。导入会把 JD 原文快照进本场面试，之后工作台清缓存也不影响。`
            : '工作台还没有采集到岗位。'}
        </div>

        {filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={entries.length ? '没有匹配的岗位' : '先到工作台采集岗位，或在右侧直接手填'}
            style={{ padding: '24px 0' }}
          >
            {!entries.length ? <Button size="small" onClick={goWorkbench}>去工作台</Button> : null}
          </Empty>
        ) : (
          <div className="mi-pick-list" role="listbox" aria-label="已采集岗位">
            {filtered.map((e) => renderRow(e.p))}
          </div>
        )}

        {picked ? (
          <div className="mi-pick-preview">
            <div className="mi-pick-preview-head">
              <span>JD 预览</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {picked.jdQuality === 'none'
                  ? '没有采到正文'
                  : `${picked.chars} 字${picked.chars < MOCK_MIN_JD_CHARS ? `（少于 ${MOCK_MIN_JD_CHARS} 字，导入后要自己补全才能出题）` : ''}`}
              </Text>
            </div>
            <div className="mi-pick-preview-body">
              {picked.jdQuality === 'none'
                ? '这个岗位只采到标题、公司等基本信息，导入后需要手动粘贴岗位描述。'
                : picked.jdText}
            </div>
          </div>
        ) : (
          <div className="mi-pick-hint mi-pick-hint--foot">选中一个岗位后，这里会显示将要带入的 JD 原文。</div>
        )}
      </div>
    </Modal>
  );
}
