import { useMemo, useState } from 'react';
import {
  Alert, Button, Card, Divider, Input, List, Progress, Select, Space, Tag, Typography, message,
} from 'antd';
import {
  RobotOutlined, FileTextOutlined, CopyOutlined, SendOutlined, LoadingOutlined, ImportOutlined,
  DeleteOutlined, ArrowRightOutlined, HistoryOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { tailorForJob, type TailorResult } from '@/lib/bossclaw/jobAssistant';
import { computeMatchScore, extractJdKeywords } from '@/lib/bossclaw/resumeMatch';
import { stableProfileView } from '@/lib/bossclaw/matching';
import { cleanJobDescription, jdLooksNoisy } from '@/lib/bossclaw/jdCleaner';
import { getErrorMessage } from '@/lib/bossclaw/helpers';

const { Text, Paragraph } = Typography;

// ===== 历史定制记录（本地持久化，最近 20 条） =====
const HISTORY_KEY = 'bossclaw-tailor-history-v1';
const HISTORY_MAX = 20;

interface TailorHistoryItem {
  id: string;
  jobTitle: string;
  jobDesc: string;
  createdAt: number;
  result: TailorResult;
}

function loadHistory(): TailorHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as TailorHistoryItem[];
    }
  } catch {
    /* 数据损坏则重建 */
  }
  return [];
}

function saveHistory(list: TailorHistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* 存储不可用时静默降级 */
  }
}

const scoreColor = (s: number) => (s >= 80 ? 'green' : s >= 60 ? 'orange' : 'red');

const formatTime = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function JobAssistant() {
  const pending = useDataStore(useShallow((s) => s.pending));
  // 导入入口只展示用户已批准通过的岗位（approved=待投递 / approved_queue=投递中）
  const approvedJobs = useMemo(
    () => pending.filter((p) => p.status === 'approved' || p.status === 'approved_queue'),
    [pending]
  );
  const profile = useDataStore((s) => s.profile);
  const resumeText = useDataStore((s) => s.resumeText);
  const setGreetings = useDataStore((s) => s.setGreetings);
  const config = useSettingsStore(useShallow((s) => s.config));

  const [jobTitle, setJobTitle] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  const [importId, setImportId] = useState<string | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [tailor, setTailor] = useState<TailorResult | null>(null);
  const [history, setHistory] = useState<TailorHistoryItem[]>(() => loadHistory());

  const hasResume = Boolean(resumeText && resumeText.trim().length > 0);
  const canGenerate = Boolean(jobTitle.trim() && jobDesc.trim() && hasResume);

  // 实时匹配度预览：本地确定性计算（不调用 AI），JD / 简历 / 画像变化即时刷新
  const liveMatch = useMemo(() => {
    if (!jobDesc.trim() || !hasResume) return null;
    const { keywords, weights } = extractJdKeywords(jobDesc, profile);
    const profileBlob = profile ? JSON.stringify(stableProfileView(profile)) : '';
    return computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}`);
  }, [jobDesc, resumeText, hasResume, profile]);

  // 从任务记录导入岗位 JD（便利入口，非耦合依赖）
  // 注意：历史任务可能是清洗修复前采集的，description 里混有「去App/热门职位」等页面噪声，
  // 导入时统一 cleanJobDescription 清洗；公司/薪资/地点前缀仅当描述里没有对应标签行时才拼接，避免重复。
  const onImport = (id: string | undefined) => {
    setImportId(id);
    if (!id) return;
    const p = approvedJobs.find((x) => x.id === id);
    if (!p) return;
    const j = p.job || {};
    const desc = cleanJobDescription(j.description || '');
    const parts: string[] = [];
    if (j.company && !/(^|\n)\s*公司[:：]/.test(desc)) parts.push(`公司：${j.company}`);
    if (j.salary && !/(^|\n)\s*薪资[:：]/.test(desc)) parts.push(`薪资：${j.salary}`);
    if (j.location && !/(^|\n)\s*地点[:：]/.test(desc)) parts.push(`地点：${j.location}`);
    if (desc) parts.push(desc);
    setJobTitle(String(j.title || '').replace(/\s*\d+-\d+K.*$/, '').trim());
    setJobDesc(parts.filter(Boolean).join('\n'));
    message.success('已导入岗位信息（已自动清理页面噪声），可修改后生成');
  };

  const onGenerate = async () => {
    if (!canGenerate) {
      if (!hasResume) return message.warning('请先在「简历中心」上传/粘贴简历并生成职业画像');
      return message.warning('请填写岗位名称与岗位 JD');
    }
    setGenerating(true);
    try {
      const job = { title: jobTitle.trim(), company: '', description: jobDesc.trim() };
      const r = await tailorForJob(job, resumeText, profile, config.model);
      setTailor(r);
      // 保存历史记录（同岗位重复定制保留最新一条）
      const item: TailorHistoryItem = {
        id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        jobTitle: jobTitle.trim(),
        jobDesc: jobDesc.trim(),
        createdAt: Date.now(),
        result: r,
      };
      const next = [item, ...history.filter((h) => h.jobTitle !== item.jobTitle)].slice(0, HISTORY_MAX);
      setHistory(next);
      saveHistory(next);
      if (r.method === 'local' && r.warning) message.info(r.warning);
    } catch (e: any) {
      message.error('定制失败：' + getErrorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const onLoadHistory = (h: TailorHistoryItem) => {
    setJobTitle(h.jobTitle);
    setJobDesc(h.jobDesc);
    setTailor(h.result);
    message.success('已载入历史定制结果');
  };

  const onRemoveHistory = (id: string) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    saveHistory(next);
  };

  const onSaveCoverLetter = () => {
    if (!tailor?.coverLetter) return;
    setGreetings([tailor.coverLetter, ...(useDataStore.getState().greetings || [])]);
    message.success('已存入打招呼语列表（可在「自动沟通」中选用）');
  };

  const match = tailor?.match;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <RobotOutlined className="page-title-icon" />定制简历
          </h1>
          <p className="page-sub">
            输入目标岗位 JD，AI 基于简历与职业画像生成岗位定制内容：匹配评分、关键词覆盖分析、
            量化经历、求职打招呼语与优化建议。只引用简历真实事实，不编造任何能力与数据。
          </p>
        </div>
      </div>

      <Card size="small" className="mb-16" title={<Space><FileTextOutlined style={{ color: 'var(--brand)' }} />岗位信息</Space>}>
        <Space size={12} style={{ marginBottom: 12 }}>
          <Select
            placeholder={approvedJobs.length ? '（可选）从已批准岗位导入' : '暂无已批准岗位，请先在工作台批准'}
            style={{ width: 300 }}
            value={importId}
            onChange={onImport}
            allowClear
            showSearch
            optionFilterProp="label"
            notFoundContent="暂无已批准通过的岗位"
            options={approvedJobs.map((p) => ({
              value: p.id,
              label: `${String(p.job?.title || '').replace(/\s*\d+-\d+K.*$/, '')} · ${p.job?.company || '未知公司'}`,
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}><ImportOutlined /> 仅展示你已批准通过的岗位（工作台「批准」后即在此可见），导入后自动填充岗位名称与 JD，可直接修改</Text>
        </Space>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>岗位名称 <Text type="danger">*</Text></Text>
            <Input
              placeholder="如：前端开发工程师（实习）"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              maxLength={60}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>岗位 JD <Text type="danger">*</Text></Text>
            <Input.TextArea
              placeholder="粘贴岗位职责与任职要求全文，内容越完整，定制越精准…"
              value={jobDesc}
              onChange={(e) => setJobDesc(e.target.value)}
              rows={7}
              maxLength={6000}
              showCount
            />
            {jdLooksNoisy(jobDesc) && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag color="orange" icon={<ExclamationCircleOutlined />}>检测到页面噪声</Tag>
                <Button size="small" icon={<DeleteOutlined />} onClick={() => setJobDesc(cleanJobDescription(jobDesc))}>
                  一键清理噪声
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  去除「去App 与BOSS随时沟通 / 求职工具 升级VIP / 热门职位推荐区」等页面内容
                </Text>
              </div>
            )}
          </div>
        </Space>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <Space size={12}>
            <Button
              type="primary"
              className="btn-uniform"
              icon={generating ? <LoadingOutlined /> : <RobotOutlined />}
              onClick={onGenerate}
              loading={generating}
              disabled={!canGenerate}
            >
              AI 生成定制简历
            </Button>
            {!hasResume && (
              <Text type="warning" style={{ fontSize: 12 }}>未解析简历：请先到「简历中心」上传并生成职业画像</Text>
            )}
          </Space>
          {!config.model?.apiKey && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未配置 AI 模型时将回退本地规则（摘要 + 兜底招呼语），建议在「设置 → AI·LLM」填写 API Key。
            </Text>
          )}
        </div>

        {/* 实时匹配度预览（本地确定性计算） */}
        {liveMatch && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13 }}>当前简历匹配度：</Text>
            <Tag color={scoreColor(liveMatch.score)} style={{ fontSize: 13, padding: '1px 10px' }}>
              {liveMatch.score} 分
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              JD 关键词命中 {liveMatch.coverage}/{liveMatch.total}（覆盖率 {liveMatch.coverageRatio}%）· 生成后对比提升
            </Text>
          </div>
        )}
      </Card>

      {tailor && (
        <Card
          size="small"
          className="mb-16"
          title={
            <Space>
              <RobotOutlined style={{ color: 'var(--brand)' }} />
              <span>定制结果</span>
              {tailor.method === 'ai' ? <Tag color="green">AI 生成</Tag> : <Tag>本地规则兜底</Tag>}
            </Space>
          }
        >
          {tailor.warning && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={tailor.warning} />}

          {/* 匹配度对比：定制前 → 定制后 */}
          {match && (
            <>
              <Divider orientation="left" plain style={{ margin: '8px 0 12px' }}>
                <Space size={6}><ArrowRightOutlined />匹配度（定制前 → 定制后）</Space>
              </Divider>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>定制前（简历原文）</Text>
                  <Progress
                    percent={match.before.coverageRatio}
                    strokeColor={scoreColor(match.before.score)}
                    format={() => `${match.before.score} 分`}
                    style={{ marginBottom: 0 }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>命中 {match.before.coverage}/{match.before.total} 个关键词</Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <ArrowRightOutlined style={{ fontSize: 16, color: 'var(--text-2, #86909c)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>定制后（原简历 + 定制内容）</Text>
                  <Progress
                    percent={match.after.coverageRatio}
                    strokeColor={scoreColor(match.after.score)}
                    format={() => `${match.after.score} 分`}
                    style={{ marginBottom: 0 }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>命中 {match.after.coverage}/{match.after.total} 个关键词</Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {(() => {
                    const delta = match.after.score - match.before.score;
                    if (delta >= 5) return <Tag color="green">提升 +{delta}</Tag>;
                    if (delta <= -5) return <Tag color="red">下降 {delta}</Tag>;
                    return <Tag>基本持平</Tag>;
                  })()}
                </div>
              </div>
            </>
          )}

          {/* 关键词覆盖三层分析 */}
          {match && (
            <>
              <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>岗位关键词覆盖分析</Divider>
              <Space size={[4, 8]} wrap style={{ marginBottom: 4 }}>
                {match.keywords.coveredInResume.length ? (
                  match.keywords.coveredInResume.map((k) => <Tag key={k} color="green"><CheckCircleOutlined /> {k}</Tag>)
                ) : (
                  <Text type="secondary">（无已覆盖关键词）</Text>
                )}
              </Space>
              <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
                绿色 = 岗位要求且简历已体现
              </Text>
              {match.keywords.missingInResumeButInProfile.length > 0 && (
                <>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                    <ExclamationCircleOutlined style={{ color: '#faad14' }} /> 画像具备但简历未体现（建议把真实经历/技能补写进简历）：
                  </Text>
                  <Space size={[4, 8]} wrap style={{ marginBottom: 8 }}>
                    {match.keywords.missingInResumeButInProfile.map((k) => <Tag key={k} color="gold">{k}</Tag>)}
                  </Space>
                </>
              )}
              {match.keywords.completelyMissing.length > 0 && (
                <>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                    <ExclamationCircleOutlined style={{ color: '#f5222d' }} /> 简历与画像均缺失（真实缺口，如实评估是否可补）：
                  </Text>
                  <Space size={[4, 8]} wrap>
                    {match.keywords.completelyMissing.map((k) => <Tag key={k} color="red">{k}</Tag>)}
                  </Space>
                </>
              )}
              {!match.keywords.missingInResumeButInProfile.length && !match.keywords.completelyMissing.length && (
                <Text type="secondary" style={{ fontSize: 12 }}>岗位关键词在简历中均有体现，覆盖良好。</Text>
              )}
            </>
          )}

          {/* 优化建议 */}
          {tailor.suggestions.length > 0 && (
            <>
              <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>优化建议（可执行）</Divider>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {tailor.suggestions.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
              </ul>
            </>
          )}

          <Divider orientation="left" plain style={{ margin: '16px 0 12px' }}>岗位匹配技能</Divider>
          <Space size={[4, 8]} wrap style={{ marginBottom: 4 }}>
            {tailor.highlightedSkills.length ? (
              tailor.highlightedSkills.map((s) => <Tag key={s} color="green">{s}</Tag>)
            ) : (
              <Text type="secondary">（暂无）</Text>
            )}
          </Space>

          {tailor.skillGaps.length > 0 && (
            <>
              <Divider orientation="left" plain style={{ margin: '12px 0' }}>岗位要求但简历缺失（如实提示，不补写）</Divider>
              <Space size={[4, 8]} wrap>
                {tailor.skillGaps.map((g) => <Tag key={g} color="orange">{g}</Tag>)}
              </Space>
            </>
          )}

          <Divider orientation="left" plain style={{ margin: '12px 0' }}>定制个人摘要</Divider>
          <Paragraph style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>{tailor.tailoredSummary}</Paragraph>
          <Button
            size="small"
            icon={<CopyOutlined />}
            style={{ marginTop: 4 }}
            onClick={() => { navigator.clipboard?.writeText(tailor.tailoredSummary); message.success('已复制摘要'); }}
          >
            复制摘要
          </Button>

          <Divider orientation="left" plain style={{ margin: '12px 0' }}>重点经历（按岗位相关性重排 · 量化改写）</Divider>
          {tailor.tailoredExperiences.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {tailor.tailoredExperiences.map((e, i) => <li key={i} style={{ marginBottom: 4 }}>{e}</li>)}
            </ul>
          ) : <Text type="secondary">（暂无）</Text>}
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
            仅提炼简历中已有的数字（规模/时长/效率），简历无数字则保持事实描述，不编造数据。
          </Text>

          <Divider orientation="left" plain style={{ margin: '12px 0' }}>定制求职信（打招呼语）</Divider>
          <div style={{ background: 'var(--bg-soft, #f8fafc)', borderRadius: 8, padding: '10px 14px' }}>
            <Paragraph style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{tailor.coverLetter}</Paragraph>
            <Space>
              <Button size="small" icon={<SendOutlined />} onClick={onSaveCoverLetter}>存入打招呼语</Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard?.writeText(tailor.coverLetter); message.success('已复制求职信'); }}
              >
                复制求职信
              </Button>
            </Space>
          </div>
        </Card>
      )}

      {/* 历史定制记录 */}
      <Card
        size="small"
        title={<Space><HistoryOutlined style={{ color: 'var(--brand)' }} />历史定制记录</Space>}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>本地保存最近 {HISTORY_MAX} 条</Text>}
      >
        {history.length === 0 ? (
          <Text type="secondary">暂无记录，生成定制结果后自动保存。</Text>
        ) : (
          <List
            size="small"
            dataSource={history}
            renderItem={(h) => (
              <List.Item
                actions={[
                  <Button key="view" size="small" onClick={() => onLoadHistory(h)}>查看</Button>,
                  <Button key="del" size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onRemoveHistory(h.id)} />,
                ]}
              >
                <List.Item.Meta
                  title={<Space size={8}>{h.jobTitle}{h.result.method === 'ai' ? <Tag color="green" style={{ fontSize: 11 }}>AI</Tag> : <Tag style={{ fontSize: 11 }}>本地</Tag>}</Space>}
                  description={`${formatTime(h.createdAt)} · 匹配 ${h.result.match?.after?.score ?? '-'} 分（定制前 ${h.result.match?.before?.score ?? '-'} 分）`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
