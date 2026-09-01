import React, { useState } from 'react';
import {
  Alert,
  Button,
  Card,
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
} from '@ant-design/icons';
import type { TailorResult } from '@/lib/bossclaw/jobAssistant';

const { Text, Paragraph } = Typography;

interface TailorResultViewProps {
  tailor: TailorResult;
  jobTitle: string;
  onExportPdf: () => void;
  onSaveCoverLetter: () => void;
}

const scoreColor = (s: number) => (s >= 80 ? '#10b981' : s >= 60 ? '#f59e0b' : '#ef4444');

export const TailorResultView: React.FC<TailorResultViewProps> = ({
  tailor,
  jobTitle,
  onExportPdf,
  onSaveCoverLetter,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
      `> 匹配度评分：定制前 ${tailor.match?.before?.score ?? '-'} 分 -> 定制后 ${tailor.match?.after?.score ?? '-'} 分`,
      '',
      '## 定制个人摘要',
      tailor.tailoredSummary || '（暂无）',
      '',
      '## 与岗位匹配的技能',
      tailor.highlightedSkills.length ? tailor.highlightedSkills.join('、') : '（暂无）',
      '',
      '## 重点经历（按岗位相关度排序）',
      ...tailor.tailoredExperiences.map((e, idx) => `${idx + 1}. ${e}`),
      '',
      '## 定制求职信（打招呼语）',
      tailor.coverLetter || '（暂无）',
    ];

    if (tailor.suggestions.length) {
      lines.push('', '## 优化建议', ...tailor.suggestions.map((s, idx) => `${idx + 1}. ${s}`));
    }

    copyToClipboard(lines.join('\n'), '全部定制内容', 'all');
  };

  const match = tailor.match;
  const delta = match ? match.after.score - match.before.score : 0;

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
              {tailor.method === 'ai' ? (
                <Tag color="green">AI 生成</Tag>
              ) : (
                <Tag>本地规则兜底</Tag>
              )}
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
            <Button
              type="primary"
              size="small"
              icon={<DownloadOutlined />}
              onClick={onExportPdf}
            >
              导出定制简历 PDF
            </Button>
          </Space>
        }
      >
        {tailor.warning && (
          <Alert
            className="tailor-alert"
            type="info"
            showIcon
            message={tailor.warning}
          />
        )}

        {/* 1. 匹配度对比（定制前 -> 定制后） */}
        {match && (
          <div className="tailor-block tailor-benchmark-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <RiseOutlined />
                <span className="tailor-block-title">匹配度（定制前 → 定制后）</span>
              </Space>
            </div>

            <div className="tailor-score-compare">
              {/* 定制前 */}
              <div className="tailor-score-pane tailor-score-pane--before">
                <div className="tailor-score-label">定制前（简历原文）</div>
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
                  命中 {match.before.coverage}/{match.before.total} 项岗位要点（{match.before.coverageRatio}%）
                </div>
              </div>

              {/* 中间转换 */}
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

              {/* 定制后 */}
              <div className="tailor-score-pane tailor-score-pane--after">
                <div className="tailor-score-label">定制后（原简历 + 定制内容）</div>
                <div className="tailor-score-value-row">
                  <span className="tailor-score-num" style={{ color: scoreColor(match.after.score) }}>
                    {match.after.score}
                  </span>
                  <span className="tailor-score-unit">分</span>
                </div>
                <Progress
                  percent={match.after.coverageRatio}
                  strokeColor={scoreColor(match.after.score)}
                  size={['100%', 6]}
                  showInfo={false}
                />
                <div className="tailor-score-sub">
                  命中 {match.after.coverage}/{match.after.total} 项岗位要点（{match.after.coverageRatio}%）
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 二轮回审修订（Reviewer 对草稿的片段对比与优化说明） */}
        {tailor.review && (tailor.review.diffs.length > 0 || tailor.review.note) && (
          <div className="tailor-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <EditOutlined />
                <span className="tailor-block-title">二轮回审修订（AI 优化）</span>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                只显示有改动的片段
              </Text>
            </div>

            {tailor.review.note && (
              <Alert
                className="tailor-react-alert"
                type="success"
                showIcon
                message={tailor.review.note}
                style={{ marginTop: 4 }}
              />
            )}

            {tailor.review.diffs.length > 0 && (
              <div className="tailor-diff-list">
                {tailor.review.diffs.map((d, i) => (
                  <div key={i} className="tailor-diff-row">
                    <div className="tailor-diff-label">{d.label}</div>
                    <div className="tailor-diff-cols">
                      <div className="tailor-diff-pane tailor-diff-pane--before">
                        <div className="tailor-diff-caption">修订前</div>
                        <div className="tailor-diff-text">{d.before || '（原为空）'}</div>
                      </div>
                      <span className="tailor-diff-arrow">
                        <ArrowRightOutlined />
                      </span>
                      <div className="tailor-diff-pane tailor-diff-pane--after">
                        <div className="tailor-diff-caption">修订后</div>
                        <div className="tailor-diff-text">{d.after || '（已移除）'}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 2. 岗位关键词覆盖与缺口分析 */}
        {match && (
          <div className="tailor-block">
            <div className="tailor-block-head">
              <Space size={6}>
                <CheckCircleOutlined />
                <span className="tailor-block-title">岗位要点对照</span>
              </Space>
              <Space size={6} className="tailor-stat-tags">
                <Tag color="green">已体现 {match.keywords.coveredInResume.length}</Tag>
                {match.keywords.missingInResumeButInProfile.length > 0 && (
                  <Tag color="gold">建议补充 {match.keywords.missingInResumeButInProfile.length}</Tag>
                )}
                {match.keywords.completelyMissing.length > 0 && (
                  <Tag color="red">尚不具备 {match.keywords.completelyMissing.length}</Tag>
                )}
              </Space>
            </div>

            <div className="tailor-diagnostic-list">
              {/* 已在简历体现 */}
              <div className="tailor-diag-item">
                <div className="tailor-diag-item-head">
                  <CheckCircleOutlined style={{ color: '#10b981' }} />
                  <span className="tailor-diag-title">岗位要求且简历已体现：</span>
                </div>
                <div className="tailor-diag-tags">
                  {match.keywords.coveredInResume.length ? (
                    match.keywords.coveredInResume.map((k) => (
                      <Tag key={k} color="green" className="tailor-tag-item">
                        {k}
                      </Tag>
                    ))
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>（暂无直接匹配项）</Text>
                  )}
                </div>
              </div>

              {/* 画像具备但简历未体现 */}
              {match.keywords.missingInResumeButInProfile.length > 0 && (
                <div className="tailor-diag-item">
                  <div className="tailor-diag-item-head">
                    <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                    <span className="tailor-diag-title">经验已具备、简历未体现（建议补充真实经历）：</span>
                  </div>
                  <div className="tailor-diag-tags">
                    {match.keywords.missingInResumeButInProfile.map((k) => (
                      <Tag key={k} color="gold" className="tailor-tag-item">
                        {k}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* 简历与画像均缺失 */}
              {match.keywords.completelyMissing.length > 0 && (
                <div className="tailor-diag-item">
                  <div className="tailor-diag-item-head">
                    <CloseCircleOutlined style={{ color: '#f5222d' }} />
                    <span className="tailor-diag-title">简历与画像均未体现（如实评估可否补充）：</span>
                  </div>
                  <div className="tailor-diag-tags">
                    {match.keywords.completelyMissing.map((k) => (
                      <Tag key={k} color="red" className="tailor-tag-item">
                        {k}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. 优化建议 */}
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

        {/* 4. 岗位匹配技能 */}
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
                onClick={() =>
                  copyToClipboard(tailor.highlightedSkills.join('、'), '技能列表', 'skills')
                }
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

        {/* 5. 定制个人摘要 */}
        <div className="tailor-block">
          <div className="tailor-block-head">
            <Space size={6}>
              <EditOutlined />
              <span className="tailor-block-title">定制个人摘要</span>
            </Space>
            <Button
              size="small"
              icon={copiedKey === 'summary' ? <CheckOutlined /> : <CopyOutlined />}
              onClick={() => copyToClipboard(tailor.tailoredSummary, '个人摘要', 'summary')}
            >
              {copiedKey === 'summary' ? '已复制' : '复制摘要'}
            </Button>
          </div>
          <div className="tailor-box tailor-summary-box">
            <Paragraph className="tailor-box-content">
              {tailor.tailoredSummary || '（暂无摘要）'}
            </Paragraph>
          </div>
        </div>

        {/* 6. 重点经历 */}
        <div className="tailor-block">
          <div className="tailor-block-head">
            <Space size={6}>
              <FileTextOutlined />
              <span className="tailor-block-title">重点经历（按岗位相关度排序）</span>
            </Space>
            {tailor.tailoredExperiences.length > 0 && (
              <Button
                size="small"
                icon={copiedKey === 'exp' ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() =>
                  copyToClipboard(
                    tailor.tailoredExperiences.map((e, i) => `${i + 1}. ${e}`).join('\n'),
                    '全部重点经历',
                    'exp'
                  )
                }
              >
                {copiedKey === 'exp' ? '已复制' : '复制全部'}
              </Button>
            )}
          </div>
          {tailor.tailoredExperiences.length ? (
            <div className="tailor-exp-list">
              {tailor.tailoredExperiences.map((e, i) => (
                <div key={i} className="tailor-exp-row">
                  <span className="tailor-exp-idx">{i + 1}</span>
                  <span className="tailor-exp-text">{e}</span>
                  <Tooltip title="复制该条">
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      className="tailor-exp-copy"
                      onClick={() => copyToClipboard(e, `第 ${i + 1} 条经历`, `exp_${i}`)}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>（暂无）</Text>
          )}
          <Text type="secondary" className="tailor-exp-footnote">
            仅提炼简历中已有的真实数据（如规模、时长、效率）；简历无数据则保持事实描述，不作编造。
          </Text>
        </div>

        {/* 7. 定制求职信（打招呼语） */}
        <div className="tailor-block" style={{ marginBottom: 0 }}>
          <div className="tailor-block-head">
            <Space size={6}>
              <SendOutlined />
              <span className="tailor-block-title">定制求职信（打招呼语）</span>
            </Space>
            <Space size={8}>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={onSaveCoverLetter}
              >
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
            <Paragraph className="tailor-box-content">
              {tailor.coverLetter || '（暂无打招呼语）'}
            </Paragraph>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default TailorResultView;
