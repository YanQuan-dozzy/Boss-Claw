import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Input,
  Modal,
  Progress,
  Space,
  Tag,
  Typography,
  message,
  notification,
  Tooltip,
} from 'antd';
import {
  RobotOutlined,
  DownloadOutlined,
  CopyOutlined,
  SendOutlined,
  CheckOutlined,
  ArrowRightOutlined,
  RiseOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CloseCircleOutlined,
  UnorderedListOutlined,
  EditOutlined,
  DiffOutlined,
  UploadOutlined,
  EyeOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import type { JdPointLayer, JdPointVerdict, TailorJdPoint, TailorPointDraft, TailorResult } from '@/lib/bossclaw/jobAssistant';
import { JD_LAYER_LABEL } from '@/lib/bossclaw/jobAssistant';
import { STATUS_COLORS } from '@/theme';

const { Text, Paragraph } = Typography;

interface TailorResultViewProps {
  tailor: TailorResult;
  jobTitle: string;
  onExportPdf: () => void;
  onSaveCoverLetter: () => void;
  /** 打开「经历信息导入」（用于补齐简历未体现的经历） */
  onImportMaterials?: () => void;
  supplementText?: string;
  onSupplementChange?: (text: string) => void;
  onRegenerate?: () => void;
  onHelpWritePoint?: (point: TailorJdPoint, text: string) => Promise<TailorPointDraft>;
  onSupplementPoint?: (point: TailorJdPoint, text: string) => Promise<boolean>;
  regenerating?: boolean;
  regenerateDisabled?: boolean;
}

const scoreColor = (s: number) => (s >= 80 ? STATUS_COLORS.success : s >= 60 ? STATUS_COLORS.warning : STATUS_COLORS.danger);

/** JD 要点层级展示顺序（硬门槛 → 优先条件 → 职责信号 → 团队信号） */
const LAYER_ORDER: JdPointLayer[] = ['must', 'prefer', 'duty', 'team'];
const VERDICT_META: Record<JdPointVerdict, { label: string; color: string; icon: React.ReactNode }> = {
  covered: { label: '已体现', color: 'green', icon: <CheckCircleOutlined style={{ color: STATUS_COLORS.success }} /> },
  addable: { label: '可补充', color: 'gold', icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} /> },
  missing: { label: '不具备', color: 'red', icon: <CloseCircleOutlined style={{ color: '#f5222d' }} /> },
};
/** 判定标签：statusVerified === false 才显示「待复核」（本次正文已改但复核未返回）；
 *  旧历史无该字段（undefined）沿用原有三档结论，避免存量记录整片变成待复核。 */
const pointMeta = (p: TailorJdPoint) => p.statusVerified === false
  ? { label: '待复核', color: 'default', icon: <ExclamationCircleOutlined /> }
  : VERDICT_META[p.verdict];

export const TailorResultView: React.FC<TailorResultViewProps> = ({
  tailor,
  jobTitle,
  onExportPdf,
  onSaveCoverLetter,
  onImportMaterials,
  supplementText = '',
  onSupplementChange,
  onRegenerate,
  onHelpWritePoint,
  onSupplementPoint,
  regenerating = false,
  regenerateDisabled = false,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** 「已复制」提示的复位定时器（单一实例，卸载时清理） */
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);
  /** 岗位要点详情弹窗当前查看的要点（null = 关闭） */
  const [selectedPoint, setDetailPoint] = useState<Pick<TailorJdPoint, 'point' | 'layer'> | null>(null);
  const detailPoint = selectedPoint
    ? tailor.jdPoints.find((p) => p.point === selectedPoint.point && p.layer === selectedPoint.layer) || null : null;
  const [pointDrafts, setPointDrafts] = useState<Record<string, TailorPointDraft>>({});
  const [pointBusy, setPointBusy] = useState<'write' | 'submit' | null>(null);
  const pointLock = useRef(false);
  const pointKey = detailPoint ? `${detailPoint.layer}:${detailPoint.point}` : '';
  const pointDraft = pointDrafts[pointKey] || { text: '', missingDetails: [] };
  const pointDisabled = !!pointBusy || regenerating || regenerateDisabled;
  const helpWritePoint = async () => {
    if (!detailPoint || !pointDraft.text.trim() || pointLock.current || pointDisabled || !onHelpWritePoint) return;
    const key = pointKey;
    pointLock.current = true;
    setPointBusy('write');
    try {
      const draft = await onHelpWritePoint(detailPoint, pointDraft.text);
      setPointDrafts((prev) => ({ ...prev, [key]: draft }));
      message.success('已整理草稿，请核对后提交');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AI 整理失败，原输入已保留');
    } finally { pointLock.current = false; setPointBusy(null); }
  };
  const submitPoint = async () => {
    if (!detailPoint || !pointDraft.text.trim() || pointLock.current || pointDisabled || !onSupplementPoint) return;
    const key = pointKey;
    pointLock.current = true;
    setPointBusy('submit');
    try {
      if (await onSupplementPoint(detailPoint, pointDraft.text)) {
        setPointDrafts((prev) => ({ ...prev, [key]: { text: '', missingDetails: [] } }));
        setDetailPoint(null);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重新生成失败，原输入已保留');
    } finally { pointLock.current = false; setPointBusy(null); }
  };

  const copyToClipboard = async (text: string, label: string, key: string) => {
    if (!text) return;
    // M-42：原实现不 await/不 catch 即提示「已复制」——剪贴板被拒绝时误报成功。
    try {
      await navigator.clipboard?.writeText(text);
    } catch (e: any) {
      message.error(`复制${label}失败：${e?.message || '剪贴板不可用'}`);
      return;
    }
    setCopiedKey(key);
    message.success(`已复制${label}`);
    // 复用单一 timer 并在卸载时清理：原实现每次复制都新排一个 2s 定时器、卸载不取消，
    // 连续复制会叠加多个定时器，且组件卸载后仍会 setState（见审查 #95）。
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  const handleCopyAll = () => {
    const lines: string[] = [
      `# 岗位定制简历 —— ${jobTitle || '目标岗位'}`,
      tailor.aiMatch
        ? `> 匹配度：定制前 ${tailor.aiMatch.before} 分 -> 定制后 ${tailor.aiMatch.after} 分（AI 同口径判定）`
        : `> 匹配度：本地估算 ${tailor.match?.before?.score ?? '-'} 分（未取得有效 AI 评分，未做前后对比）`,
      '',
      '## 定制个人摘要',
      tailor.tailoredSummary || '（暂无）',
      '',
      '## 与岗位匹配的技能',
      tailor.highlightedSkills.length ? tailor.highlightedSkills.join('、') : '（暂无）',
      '',
      '## 定制求职信（打招呼语）',
      tailor.coverLetter || '（暂无）',
    ];

    if (tailor.jdPoints?.length) {
      lines.push('', '## 岗位要点对照');
      for (const p of tailor.jdPoints) {
        lines.push(`- [${JD_LAYER_LABEL[p.layer]}/${pointMeta(p).label}] ${p.point}${p.evidence ? ` —— ${p.evidence}` : ''}`);
      }
    }

    if (tailor.suggestions.length) {
      lines.push('', '## 优化建议', ...tailor.suggestions.map((s, idx) => `${idx + 1}. ${s}`));
    }

    copyToClipboard(lines.join('\n'), '全部定制内容', 'all');
  };

  const match = tailor.match;
  const aiMatch = tailor.aiMatch;
  const delta = aiMatch ? aiMatch.after - aiMatch.before : 0;
  const rewrites = (tailor.rewrites || []).filter((r) => r.before);
  const unmatched = (tailor.rewrites || []).filter((r) => !r.before);
  const points = tailor.jdPoints || [];
  const verdictCount: Record<JdPointVerdict, number> = {
    covered: points.filter((p) => p.statusVerified !== false && p.verdict === 'covered').length,
    addable: points.filter((p) => p.statusVerified !== false && p.verdict === 'addable').length,
    missing: points.filter((p) => p.statusVerified !== false && p.verdict === 'missing').length,
  };
  const pendingPointCount = points.filter((p) => p.statusVerified === false).length;

  // 说明类文案不常驻页面：仅在出现「待复核」时用顶部 notification 提示一次（同一结果不重复弹）。
  const pendingNoticeRef = useRef('');
  useEffect(() => {
    if (!pendingPointCount) { pendingNoticeRef.current = ''; return; }
    const signature = `${jobTitle}|${pendingPointCount}|${tailor.aiMatch?.after ?? '-'}`;
    if (pendingNoticeRef.current === signature) return;
    pendingNoticeRef.current = signature;
    notification.info({
      message: '部分岗位要点未完成复核',
      description: `${pendingPointCount} 条要点在正文修改后未获得有效复核，判定暂不可用。点「补充并重新生成」可更新判定，原补充内容会保留。`,
      placement: 'top',
      duration: 9,
      showProgress: true,
    });
  }, [pendingPointCount, jobTitle, tailor.aiMatch?.after]);

  return (
    <div className="tailor-view">
      <Card
        size="small"
        className="tailor-main-card"
        title={
          <div className="tailor-main-header">
            <Space size={8}>
              <RobotOutlined style={{ color: 'var(--brand)' }} />
              <span className="tailor-header-title">定制结果</span>
              {tailor.method === 'ai' ? <Tag color="green">AI 生成</Tag> : <Tag>本地规则兜底</Tag>}
            </Space>
          </div>
        }
        extra={
          <Space size={8}>
            <Button
              size="small"
              icon={copiedKey === 'all' ? <CheckOutlined /> : <CopyOutlined />}
              onClick={handleCopyAll}
            >
              {copiedKey === 'all' ? '已复制全部' : '复制全部内容'}
            </Button>
            <Button type="primary" size="small" icon={<DownloadOutlined />} onClick={onExportPdf}>
              导出定制简历 PDF
            </Button>
          </Space>
        }
      >
        {tailor.warning && (
          <Alert className="tailor-alert" type="info" showIcon message={tailor.warning} />
        )}

        {/* 1. 匹配度对比（定制前 → 定制后，AI 同口径判定） */}
        {aiMatch ? (
          <div className="tailor-block tailor-benchmark-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <RiseOutlined />
                <span className="tailor-block-title">匹配度（定制前 → 定制后）</span>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                AI 同口径判定 · 同一份岗位要点清单
              </Text>
            </div>

            <div className="tailor-score-compare">
              <div className="tailor-score-pane tailor-score-pane--before">
                <div className="tailor-score-label">定制前（原简历 + 补充材料 + 画像）</div>
                <div className="tailor-score-value-row">
                  <span className="tailor-score-num" style={{ color: scoreColor(aiMatch.before) }}>
                    {aiMatch.before}
                  </span>
                  <span className="tailor-score-unit">分</span>
                </div>
                <Progress percent={aiMatch.before} strokeColor={scoreColor(aiMatch.before)} size={['100%', 6]} showInfo={false} />
              </div>

              <div className="tailor-score-arrow">
                <ArrowRightOutlined />
                <div className="tailor-score-tag-wrap">
                  {delta > 0 ? (
                    <Tag color="green">提升 +{delta}</Tag>
                  ) : delta < 0 ? (
                    <Tag color="red">下降 {delta}</Tag>
                  ) : (
                    <Tag>基本持平</Tag>
                  )}
                </div>
              </div>

              <div className="tailor-score-pane tailor-score-pane--after">
                <div className="tailor-score-label">定制后（定制简历文档）</div>
                <div className="tailor-score-value-row">
                  <span className="tailor-score-num" style={{ color: scoreColor(aiMatch.after) }}>
                    {aiMatch.after}
                  </span>
                  <span className="tailor-score-unit">分</span>
                </div>
                <Progress percent={aiMatch.after} strokeColor={scoreColor(aiMatch.after)} size={['100%', 6]} showInfo={false} />
              </div>
            </div>
          </div>
        ) : (
          match && (
            <div className="tailor-block tailor-benchmark-block">
              <div className="tailor-block-head">
                <Space size={6}>
                  <RiseOutlined />
                  <span className="tailor-block-title">匹配度（本地估算）</span>
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  未取得有效 AI 评分 · 不做前后对比
                </Text>
              </div>
              <div className="tailor-score-compare tailor-score-compare--single">
                <div className="tailor-score-pane">
                  <div className="tailor-score-label">原简历 + 画像（未评估补充内容）</div>
                  <div className="tailor-score-value-row">
                    <span className="tailor-score-num" style={{ color: scoreColor(match.before.score) }}>
                      {match.before.score}
                    </span>
                    <span className="tailor-score-unit">分</span>
                  </div>
                  <Progress
                    percent={match.before.coverageRatio}
                    strokeColor={scoreColor(match.before.score)}
                    size={['100%', 6]}
                    showInfo={false}
                  />
                  <div className="tailor-score-sub">
                    本地关键词命中 {match.before.coverage}/{match.before.total} 项（{match.before.coverageRatio}%）
                  </div>
                </div>
              </div>
            </div>
          )
        )}

        {onRegenerate && (
          <div className="tailor-block" data-testid="tailor-supplement">
            <div className="tailor-block-head">
              <Space size={6}>
                <EditOutlined />
                <span className="tailor-block-title">补充内容，继续优化</span>
                <Tooltip title="根据下方岗位要点与优化建议，补充漏写的项目细节、职责、成果，或说明要修改的表达。每轮补充都会保留并用于下一次生成；匹配分按实际经历评估，仍有缺口时如实显示。">
                  <QuestionCircleOutlined style={{ fontSize: 13, opacity: 0.65 }} />
                </Tooltip>
              </Space>
              {Boolean(tailor.supplements?.length) && <Tag>已补充 {tailor.supplements!.length} 轮</Tag>}
            </div>
            {tailor.previousScore != null && aiMatch && (
              <div style={{ marginBottom: 8 }} data-testid="tailor-iteration-score">
                上一版 {tailor.previousScore} 分 → 本轮 {aiMatch.after} 分
                <Tag style={{ marginLeft: 8 }} color={aiMatch.after > tailor.previousScore ? 'green' : aiMatch.after < tailor.previousScore ? 'red' : undefined}>
                  {aiMatch.after > tailor.previousScore ? `提升 +${aiMatch.after - tailor.previousScore}` : aiMatch.after < tailor.previousScore ? `下降 ${aiMatch.after - tailor.previousScore}` : '持平'}
                </Tag>
              </div>
            )}
            <Input.TextArea
              id="tailor-supplement-text"
              aria-label="补充内容"
              value={supplementText}
              onChange={(e) => onSupplementChange?.(e.target.value)}
              disabled={regenerating || regenerateDisabled}
              autoSize={{ minRows: 4, maxRows: 12 }}
              placeholder="例如：我在知识库项目中还负责文档切分和检索效果评估，测试使用了30条问题；请把这项职责写入项目经历。"
              style={{ fontSize: 15 }}
            />
            <Space wrap style={{ marginTop: 10 }}>
              <Tooltip title="生成失败时会保留上一版结果和本轮输入，可直接重试">
                <Button type="primary" onClick={onRegenerate} loading={regenerating} disabled={regenerating || regenerateDisabled || !supplementText.trim()}>
                  补充并重新生成
                </Button>
              </Tooltip>
            </Space>
            {Boolean(tailor.supplements?.length) && <Collapse size="small" style={{ marginTop: 12 }} items={[{
              key: 'supplements', label: `查看已采用的 ${tailor.supplements!.length} 轮补充`,
              children: tailor.supplements!.map((s, i) => <div key={`${s.createdAt}-${i}`} style={{ marginBottom: 12 }}>
                <Text strong>第 {i + 1} 轮</Text><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s.text}</div>
              </div>),
            }]} />}
          </div>
        )}

        {/* 2. 改写对照（原文摘录 → 定制后条目） */}
        {(rewrites.length > 0 || unmatched.length > 0 || tailor.review) && (
          <div className="tailor-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <DiffOutlined />
                <span className="tailor-block-title">改写对照（原简历内容 → 定制后内容）</span>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                逐条对应 · 只列实际改写的条目（{rewrites.length} 条）
              </Text>
            </div>

            {tailor.review?.note && (
              <Alert
                className="tailor-react-alert"
                type="success"
                showIcon
                message={`二轮复检：${tailor.review.note}`}
                style={{ marginTop: 4 }}
              />
            )}

            {/* 描述语保真兜底：提示词挡不住时，把「精通/熟悉等被抹平」的条目标出来 */}
            {(tailor.qualifierLoss?.length ?? 0) > 0 && (
              <Alert
                className="tailor-react-alert"
                type="warning"
                showIcon
                style={{ marginTop: 6 }}
                message={`检测到 ${tailor.qualifierLoss.length} 条改写把能力描述语抹平或降级了（精通 / 熟练 / 熟悉 / 沉淀 等）——导出前建议把描述语补回，否则会抹平你的真实水平。`}
                description={
                  <ul className="tailor-qualifier-list">
                    {tailor.qualifierLoss.map((q) => (
                      // 审查 §四表 24：用「模块 + 丢失词 + 改写后」组合作 key（内容即身份），
                      // 不用下标 —— 列表按不同筛选/材料重算时下标会串位。
                      <li key={`${q.module}|${q.words.join(',')}|${q.after}`}>
                        <span className="tailor-unmatched-module">{q.module}</span>
                        丢失「<b>{q.words.join('、')}</b>」→ {q.after}
                        <div className="tailor-qualifier-before">原文：{q.before}</div>
                      </li>
                    ))}
                  </ul>
                }
              />
            )}

            {rewrites.length > 0 && (
              <div className="tailor-diff-list">
                {rewrites.map((d) => (
                  // 审查 §四表 24：改写条目用「模块 + 原文」组合作 key
                  <div key={`${d.module}|${d.before}`} className="tailor-diff-row">
                    <div className="tailor-diff-label">
                      {d.module}
                      {d.from === 'extra' && (
                        <Tag color="blue" style={{ marginLeft: 6 }}>
                          补充材料
                        </Tag>
                      )}
                    </div>
                    <div className="tailor-diff-cols">
                      <div className="tailor-diff-pane tailor-diff-pane--before">
                        <div className="tailor-diff-caption">原简历内容</div>
                        <div className="tailor-diff-text">{d.before}</div>
                      </div>
                      <span className="tailor-diff-arrow">
                        <ArrowRightOutlined />
                      </span>
                      <div className="tailor-diff-pane tailor-diff-pane--after">
                        <div className="tailor-diff-caption">定制后内容</div>
                        <div className="tailor-diff-text">{d.after}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {unmatched.length > 0 && (
              <div className="tailor-unmatched">
                <div className="tailor-diag-item-head" style={{ marginBottom: 6 }}>
                  <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                  <span className="tailor-diag-title">
                    以下定制内容在简历原文与补充材料中未找到对应表述，请人工核对后再使用（{unmatched.length} 条）：
                  </span>
                </div>
                <ul className="tailor-unmatched-list">
                  {unmatched.map((u) => (
                    // 审查 §四表 24：未匹配条目用「模块 + 改写后」组合作 key
                    <li key={`${u.module}|${u.after}`}>
                      <span className="tailor-unmatched-module">{u.module}</span>
                      {u.after}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* 3. 岗位要点对照（AI 分层拆解 + 三层判定；两列并排、点击查看单条详情） */}
        {points.length > 0 && (
          <div className="tailor-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <CheckCircleOutlined />
                <span className="tailor-block-title">岗位要点对照</span>
              </Space>
              <Space size={6} className="tailor-stat-tags">
                <Tag color="green">已体现 {verdictCount.covered}</Tag>
                {verdictCount.addable > 0 && <Tag color="gold">可补充 {verdictCount.addable}</Tag>}
                {verdictCount.missing > 0 && <Tag color="red">不具备 {verdictCount.missing}</Tag>}
                {pendingPointCount > 0 && (
                  <Tooltip title="这些要点在正文修改后未获得有效复核，判定暂不可用；重新生成可更新判定，原补充内容保留">
                    <Tag>待复核 {pendingPointCount}</Tag>
                  </Tooltip>
                )}
                {onImportMaterials && (
                  <Tooltip title="导入简历里没写的真实经历素材（实习/项目/获奖等），AI 会据此补齐简历">
                    <Button size="small" icon={<UploadOutlined />} onClick={onImportMaterials}>
                      经历信息导入
                    </Button>
                  </Tooltip>
                )}
              </Space>
            </div>

            <div className="tailor-point-layers">
              {LAYER_ORDER.map((layer) => {
                const items = points.filter((p) => p.layer === layer);
                if (!items.length) return null;
                return (
                  <div className="tailor-point-layer" key={layer}>
                    <div className="tailor-point-layer-head">
                      <span className="tailor-point-layer-title">{JD_LAYER_LABEL[layer]}</span>
                      <span className="tailor-point-layer-count">{items.length} 项</span>
                    </div>
                    <div className="tailor-point-list">
                      {items.map((p, i) => (
                        <button
                          type="button"
                          className={`tailor-point-row tailor-point-row--${p.statusVerified === false ? 'pending' : p.verdict}`}
                          key={`${layer}_${i}`}
                          onClick={() => setDetailPoint(p)}
                          title="点击查看该条要点的完整判定依据"
                        >
                          <span className="tailor-point-name">{p.point}</span>
                          <Tag color={pointMeta(p).color} className="tailor-point-verdict">
                            {pointMeta(p).label}
                          </Tag>
                          <EyeOutlined className="tailor-point-more" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 4. 优化建议 */}
        {tailor.suggestions.length > 0 && (
          <div className="tailor-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <UnorderedListOutlined />
                <span className="tailor-block-title">优化建议</span>
              </Space>
              <Button
                type="link"
                size="small"
                icon={copiedKey === 'sug' ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() =>
                  copyToClipboard(
                    tailor.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n'),
                    '优化建议',
                    'sug'
                  )
                }
              >
                复制建议
              </Button>
            </div>
            <div className="tailor-sug-list">
              {tailor.suggestions.map((s, i) => (
                // 审查 §四表 24：建议是纯文本、内容即身份 → key 用文本（下标仍用于序号展示）
                <div key={s} className="tailor-sug-row">
                  <span className="tailor-sug-idx">{i + 1}</span>
                  <span className="tailor-sug-txt">{s}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 5. 岗位匹配技能 */}
        <div className="tailor-block">
          <div className="tailor-block-head">
            <Space size={6}>
              <FileTextOutlined />
              <span className="tailor-block-title">与岗位匹配的技能</span>
            </Space>
            {tailor.highlightedSkills.length > 0 && (
              <Button
                type="link"
                size="small"
                icon={copiedKey === 'skills' ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => copyToClipboard(tailor.highlightedSkills.join('、'), '技能列表', 'skills')}
              >
                复制技能
              </Button>
            )}
          </div>
          <div className="tailor-diag-tags">
            {tailor.highlightedSkills.length ? (
              tailor.highlightedSkills.map((s) => (
                <Tag key={s} color="green" className="tailor-tag-item">
                  {s}
                </Tag>
              ))
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>（暂无）</Text>
            )}
          </div>

          {tailor.skillGaps.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="tailor-diag-item-head" style={{ marginBottom: 6 }}>
                <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                <span className="tailor-diag-title">岗位要求但简历未体现（如实列出）：</span>
              </div>
              <div className="tailor-diag-tags">
                {tailor.skillGaps.map((g) => (
                  <Tag key={g} color="orange" className="tailor-tag-item">
                    {g}
                  </Tag>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 6. 定制个人摘要（不上 PDF，供复制到其他场合使用） */}
        <div className="tailor-block">
          <div className="tailor-block-head">
            <Space size={6}>
              <EditOutlined />
              <span className="tailor-block-title">定制个人摘要</span>
            </Space>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                不进入 PDF，供打招呼/其他场合使用
              </Text>
              <Button
                size="small"
                icon={copiedKey === 'summary' ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => copyToClipboard(tailor.tailoredSummary, '个人摘要', 'summary')}
              >
                {copiedKey === 'summary' ? '已复制' : '复制摘要'}
              </Button>
            </Space>
          </div>
          <div className="tailor-box tailor-summary-box">
            <Paragraph className="tailor-box-content">{tailor.tailoredSummary || '（暂无摘要）'}</Paragraph>
          </div>
        </div>

        {/* 定制求职信（打招呼语） */}
        <div className="tailor-block" style={{ marginBottom: 0 }}>
          <div className="tailor-block-head">
            <Space size={6}>
              <SendOutlined />
              <span className="tailor-block-title">定制求职信（打招呼语）</span>
            </Space>
            <Space size={8}>
              <Button type="primary" size="small" icon={<SendOutlined />} onClick={onSaveCoverLetter}>
                存入打招呼语
              </Button>
              <Button
                size="small"
                icon={copiedKey === 'letter' ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => copyToClipboard(tailor.coverLetter, '求职信', 'letter')}
              >
                {copiedKey === 'letter' ? '已复制' : '复制求职信'}
              </Button>
            </Space>
          </div>
          <div className="tailor-box tailor-cover-letter-box">
            <Paragraph className="tailor-box-content">{tailor.coverLetter || '（暂无打招呼语）'}</Paragraph>
          </div>
        </div>
      </Card>

      {/* 要点详情弹窗：点要点行查看单条全部信息（列表里只留要点与判定，保证页面更短） */}
      <Modal
        open={!!detailPoint}
        onCancel={() => { if (!pointLock.current) setDetailPoint(null); }}
        closable={!pointBusy}
        maskClosable={!pointBusy}
        keyboard={!pointBusy}
        footer={null}
        width={620}
        centered
        title="岗位要点详情"
        className="tailor-point-detail-modal"
      >
        {detailPoint && (
          <div className="tailor-point-detail">
            <div className="tailor-point-detail-head">
              <span className="tailor-point-detail-name">{detailPoint.point}</span>
              <Tag color={pointMeta(detailPoint).color}>{pointMeta(detailPoint).label}</Tag>
            </div>
            <div className="tailor-point-detail-row">
              <span className="tailor-point-detail-label">JD 层级</span>
              <span>{JD_LAYER_LABEL[detailPoint.layer]}</span>
            </div>
            <div className="tailor-point-detail-row">
              <span className="tailor-point-detail-label">判定依据</span>
              <span>{detailPoint.statusVerified === false ? '本条在正文修改后未获得有效复核，请重新生成更新判定。' : detailPoint.evidence || '（AI 未给出依据，请人工核对）'}</span>
            </div>
            {onSupplementPoint && (
              <div style={{ marginTop: 20 }} data-testid="tailor-point-editor">
                <Text strong>补充这项技能或经历</Text>
                <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 10 }}>
                  填写你实际掌握的技能或做过的工作。AI 可帮你整理和续写，核对后再用于简历。
                </Paragraph>
                <Input.TextArea
                  id="tailor-point-supplement-text"
                  value={pointDraft.text}
                  disabled={pointDisabled}
                  autoSize={{ minRows: 4, maxRows: 10 }}
                  style={{ fontSize: 15 }}
                  placeholder="例如：我做过 Web 接口模块，使用 Python；没有做过插件开发。请帮我整理这部分经历。"
                  onChange={(e) => setPointDrafts((prev) => ({ ...prev, [pointKey]: { text: e.target.value, missingDetails: [] } }))}
                />
                {pointDraft.missingDetails.length > 0 && <Alert
                  type="info" style={{ marginTop: 10 }} message="还可以补充以下细节"
                  description={<ul style={{ marginBottom: 0, paddingLeft: 20 }}>{[...new Set(pointDraft.missingDetails)].map((q) => <li key={q}>{q}</li>)}</ul>}
                />}
                <Space wrap style={{ marginTop: 12 }}>
                  {onHelpWritePoint && <Button icon={<RobotOutlined />} onClick={() => void helpWritePoint()}
                    loading={pointBusy === 'write'} disabled={pointDisabled || !pointDraft.text.trim()}>AI 帮我整理／续写</Button>}
                  <Button type="primary" onClick={() => void submitPoint()} loading={pointBusy === 'submit'}
                    disabled={pointDisabled || !pointDraft.text.trim()}>补充这一项并重新生成</Button>
                </Space>
              </div>
            )}
            {detailPoint.statusVerified && detailPoint.verdict === 'addable' && onImportMaterials && (
              <div className="tailor-point-detail-tip">
                <span>本人资料中已有依据，但最终简历尚未写明。可补充说明要写入的技能或经历，也可导入素材。</span>
                <Button
                  size="small"
                  type="primary"
                  icon={<UploadOutlined />}
                  disabled={pointDisabled}
                  onClick={() => {
                    setDetailPoint(null);
                    onImportMaterials();
                  }}
                >
                  经历信息导入
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default TailorResultView;
