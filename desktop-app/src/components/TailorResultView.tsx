import React, { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Modal,
  Progress,
  Space,
  Tag,
  Typography,
  message,
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
} from '@ant-design/icons';
import type { JdPointLayer, JdPointVerdict, TailorJdPoint, TailorResult } from '@/lib/bossclaw/jobAssistant';
import { JD_LAYER_LABEL } from '@/lib/bossclaw/jobAssistant';

const { Text, Paragraph } = Typography;

interface TailorResultViewProps {
  tailor: TailorResult;
  jobTitle: string;
  onExportPdf: () => void;
  onSaveCoverLetter: () => void;
  /** 打开「经历信息导入」（用于补齐简历未体现的经历） */
  onImportMaterials?: () => void;
}

const scoreColor = (s: number) => (s >= 80 ? '#10b981' : s >= 60 ? '#f59e0b' : '#ef4444');

/** JD 要点层级展示顺序（硬门槛 → 优先条件 → 职责信号 → 团队信号） */
const LAYER_ORDER: JdPointLayer[] = ['must', 'prefer', 'duty', 'team'];
const VERDICT_META: Record<JdPointVerdict, { label: string; color: string; icon: React.ReactNode }> = {
  covered: { label: '已体现', color: 'green', icon: <CheckCircleOutlined style={{ color: '#10b981' }} /> },
  addable: { label: '可补充', color: 'gold', icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} /> },
  missing: { label: '不具备', color: 'red', icon: <CloseCircleOutlined style={{ color: '#f5222d' }} /> },
};

export const TailorResultView: React.FC<TailorResultViewProps> = ({
  tailor,
  jobTitle,
  onExportPdf,
  onSaveCoverLetter,
  onImportMaterials,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** 岗位要点详情弹窗当前查看的要点（null = 关闭） */
  const [detailPoint, setDetailPoint] = useState<TailorJdPoint | null>(null);

  const copyToClipboard = (text: string, label: string, key: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    message.success(`已复制${label}`);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  const handleCopyAll = () => {
    const lines: string[] = [
      `# 岗位定制简历 —— ${jobTitle || '目标岗位'}`,
      tailor.aiMatch
        ? `> 匹配度：定制前 ${tailor.aiMatch.before} 分 -> 定制后 ${tailor.aiMatch.after} 分（AI 同口径判定）`
        : `> 匹配度：本地估算 ${tailor.match?.before?.score ?? '-'} 分（AI 不可用，未做前后对比）`,
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
        lines.push(`- [${JD_LAYER_LABEL[p.layer]}/${VERDICT_META[p.verdict].label}] ${p.point}${p.evidence ? ` —— ${p.evidence}` : ''}`);
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
    covered: points.filter((p) => p.verdict === 'covered').length,
    addable: points.filter((p) => p.verdict === 'addable').length,
    missing: points.filter((p) => p.verdict === 'missing').length,
  };

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
                  AI 不可用 · 不做前后对比
                </Text>
              </div>
              <div className="tailor-score-compare tailor-score-compare--single">
                <div className="tailor-score-pane">
                  <div className="tailor-score-label">原简历（含补充材料与画像）</div>
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
                    {tailor.qualifierLoss.map((q, i) => (
                      <li key={i}>
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
                {rewrites.map((d, i) => (
                  <div key={i} className="tailor-diff-row">
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
                  {unmatched.map((u, i) => (
                    <li key={i}>
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
                          className={`tailor-point-row tailor-point-row--${p.verdict}`}
                          key={`${layer}_${i}`}
                          onClick={() => setDetailPoint(p)}
                          title="点击查看该条要点的完整判定依据"
                        >
                          <span className="tailor-point-name">{p.point}</span>
                          <Tag color={VERDICT_META[p.verdict].color} className="tailor-point-verdict">
                            {VERDICT_META[p.verdict].label}
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
                <div key={i} className="tailor-sug-row">
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
        onCancel={() => setDetailPoint(null)}
        footer={null}
        width={520}
        centered
        title="岗位要点详情"
        className="tailor-point-detail-modal"
      >
        {detailPoint && (
          <div className="tailor-point-detail">
            <div className="tailor-point-detail-head">
              <span className="tailor-point-detail-name">{detailPoint.point}</span>
              <Tag color={VERDICT_META[detailPoint.verdict].color}>{VERDICT_META[detailPoint.verdict].label}</Tag>
            </div>
            <div className="tailor-point-detail-row">
              <span className="tailor-point-detail-label">JD 层级</span>
              <span>{JD_LAYER_LABEL[detailPoint.layer]}</span>
            </div>
            <div className="tailor-point-detail-row">
              <span className="tailor-point-detail-label">判定依据</span>
              <span>{detailPoint.evidence || '（AI 未给出依据，请人工核对）'}</span>
            </div>
            {detailPoint.verdict === 'addable' && onImportMaterials && (
              <div className="tailor-point-detail-tip">
                <span>该要点你已具备、但简历未体现，可导入对应经历素材补齐。</span>
                <Button
                  size="small"
                  type="primary"
                  icon={<UploadOutlined />}
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
