import { useMemo, useState } from 'react';
import {
  Alert, Avatar, Button, Card, Checkbox, Divider, Form, Input, List, Modal, Radio, Select, Space, Tag, Typography, Upload, message,
} from 'antd';
import {
  RobotOutlined, FileTextOutlined, LoadingOutlined, ImportOutlined,
  DeleteOutlined, HistoryOutlined, ExclamationCircleOutlined,
  DownloadOutlined, CameraOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { tailorForJob, type TailorResult } from '@/lib/bossclaw/jobAssistant';
import { computeMatchScore, extractJdKeywords } from '@/lib/bossclaw/resumeMatch';
import { stableProfileView } from '@/lib/bossclaw/matching';
import { cleanJobDescription, jdLooksNoisy } from '@/lib/bossclaw/jdCleaner';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import { buildResumeHtml, defaultPdfFileName, RESUME_TEMPLATES, isKnownTemplate } from '@/lib/bossclaw/resumePdf';
import { buildResumeDocData, extractContactInfo, RESUME_SECTION_META } from '@/lib/bossclaw/resumeContact';
import { TailorResultView } from '@/components/TailorResultView';

const { Text } = Typography;

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
  // 从工作台导入的岗位分析分（AI 优先），用于匹配分数展示；AI 未配置时回退本地计算
  const [importedScore, setImportedScore] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [tailor, setTailor] = useState<TailorResult | null>(null);
  const [history, setHistory] = useState<TailorHistoryItem[]>(() => loadHistory());

  // ===== 导出定制简历 PDF =====
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportTailor, setExportTailor] = useState<TailorResult | null>(null);
  const [exportSections, setExportSections] = useState<string[]>(RESUME_SECTION_META.filter((m) => m.default).map((m) => m.id));
  const [exportForm] = Form.useForm();

  // 模板选择（持久化到 localStorage，下次打开沿用）
  const TEMPLATE_KEY = 'bossclaw-resume-template-v1';
  const [templateId, setTemplateId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TEMPLATE_KEY);
      if (saved && isKnownTemplate(saved)) return saved;
    } catch { /* 忽略存储异常 */ }
    return 'classic';
  });
  const setTemplate = (id: string) => {
    setTemplateId(id);
    try { localStorage.setItem(TEMPLATE_KEY, id); } catch { /* 忽略 */ }
  };

  // ===== 个人照片（选填，压缩后持久化；未上传时模板渲染虚线占位框） =====
  const PHOTO_KEY = 'bossclaw-resume-photo-v1';
  const [photo, setPhoto] = useState<string>(() => {
    try { return localStorage.getItem(PHOTO_KEY) || ''; } catch { return ''; }
  });
  const setPhotoPersist = (dataUrl: string) => {
    setPhoto(dataUrl);
    try {
      if (dataUrl) localStorage.setItem(PHOTO_KEY, dataUrl);
      else localStorage.removeItem(PHOTO_KEY);
    } catch { /* localStorage 满则忽略（本次仍生效） */ }
  };

  /** 照片压缩：等比缩到最长边 360px，JPEG 0.85，控制体积（证件照足够清晰） */
  const compressPhoto = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 360;
          let { width, height } = img;
          if (width > max || height > max) {
            const scale = max / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('Canvas 不可用')); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = String(reader.result);
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

  /** 打开导出对话框：以提取的联系信息为初值（须用户确认），章节默认勾选 */
  const openExport = (result: TailorResult, title: string) => {
    setExportTailor(result);
    const c = extractContactInfo(resumeText, title);
    exportForm.setFieldsValue({
      name: c.name,
      phone: c.phone,
      email: c.email,
      targetTitle: c.targetTitle || title,
    });
    setExportSections(RESUME_SECTION_META.filter((m) => m.default).map((m) => m.id));
    setExportOpen(true);
  };

  /** 渲染 A4 HTML → 经主进程 printToPDF 保存（无 Electron 时降级下载 HTML 自行打印） */
  const onExportPdf = async () => {
    if (!exportTailor) return;
    let values: { name: string; phone: string; email: string; targetTitle: string };
    try {
      values = await exportForm.validateFields();
    } catch {
      return; // 校验失败（必填缺失），antd 已展示错误
    }
    setExporting(true);
    try {
      const data = buildResumeDocData(resumeText, profile, exportTailor, values, exportSections);
      if (!data.sections.length) {
        message.warning('请至少勾选一个内容分节');
        return;
      }
      if (photo) data.photo = photo;
      const html = buildResumeHtml(data, templateId);
      const fileName = defaultPdfFileName(data.contact);
      const api = (window as any).electron as any;
      if (api?.savePdf) {
        const r = await api.savePdf(fileName, html);
        if (r?.canceled) return;
        if (r?.ok) message.success(`已保存：${r.filePath}`);
        else message.error(`保存失败：${r?.error || '未知原因'}`);
      } else {
        // 浏览器降级：下载 HTML，提示用浏览器「打印 → 另存为 PDF」
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName.replace(/\.pdf$/i, '.html');
        a.click();
        URL.revokeObjectURL(url);
        message.info(`已生成 ${fileName.replace(/\.pdf$/i, '.html')}，请用浏览器打开后「打印 → 另存为 PDF」`);
      }
    } catch (e: any) {
      message.error('导出失败：' + getErrorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const hasResume = Boolean(resumeText && resumeText.trim().length > 0);
  const canGenerate = Boolean(jobTitle.trim() && jobDesc.trim() && hasResume);

  // 实时匹配度预览：优先 AI（工作台导入分）；AI 未配置时回退本地确定性计算（不调用 AI）
  const aiConfigured = Boolean(config.model?.apiKey);
  const liveMatch = useMemo(() => {
    if (!jobDesc.trim() || !hasResume) return null;
    const { keywords, weights } = extractJdKeywords(jobDesc, profile);
    const profileBlob = profile ? JSON.stringify(stableProfileView(profile)) : '';
    return computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}`);
  }, [jobDesc, resumeText, hasResume, profile]);
  // 匹配分数取值：AI 已配置且有工作台导入分 → 用 AI 分；否则用本地计算分兜底
  const currentMatchScore = useMemo(() => {
    if (aiConfigured && importedScore != null) return importedScore;
    return liveMatch ? liveMatch.score : null;
  }, [aiConfigured, importedScore, liveMatch]);
  const scoreSource: 'ai' | 'local' = aiConfigured && importedScore != null ? 'ai' : 'local';

  // 从任务记录导入岗位 JD（便利入口，非耦合依赖）
  // 注意：历史任务可能是清洗修复前采集的，description 里混有「去App/热门职位」等页面噪声，
  // 导入时统一 cleanJobDescription 清洗；公司/薪资/地点前缀仅当描述里没有对应标签行时才拼接，避免重复。
  const onImport = (id: string | undefined) => {
    setImportId(id);
    if (!id) {
      setImportedScore(null);
      return;
    }
    const p = approvedJobs.find((x) => x.id === id);
    if (!p) return;
    // 工作台分析分（AI 优先）：导入时记录，AI 已配置则作为匹配分数主来源
    setImportedScore(p.analysis?.score ?? null);
    const j = p.job || {};
    const desc = cleanJobDescription(j.description || '');
    const parts: string[] = [];
    if (j.company && !/(^|\n)\s*公司[:：]/.test(desc)) parts.push(`公司：${j.company}`);
    if (j.salary && !/(^|\n)\s*薪资[:：]/.test(desc)) parts.push(`薪资：${j.salary}`);
    if (j.location && !/(^|\n)\s*地点[:：]/.test(desc)) parts.push(`地点：${j.location}`);
    if (desc) parts.push(desc);
    setJobTitle(String(j.title || '').replace(/\s*\d+-\d+K.*$/, '').trim());
    setJobDesc(parts.filter(Boolean).join('\n'));
    message.success('已导入岗位信息（已自动清理无关内容），可修改后生成');
  };

  const onGenerate = async () => {
    if (!canGenerate) {
      if (!hasResume) return message.warning('请先在「简历中心」上传/粘贴简历并生成职业画像');
      return message.warning('请填写岗位名称与岗位要求');
    }
    setGenerating(true);
    try {
      const job = { title: jobTitle.trim(), company: '', description: jobDesc.trim() };
      const r = await tailorForJob(job, resumeText, profile, config.model, useDataStore.getState().greetingPrompt || undefined);
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <RobotOutlined className="page-title-icon" />定制简历
          </h1>
          <p className="page-sub">
            输入目标岗位描述，AI 基于简历生成定制内容：匹配评分、要点对照、重点经历、
            求职打招呼语与优化建议，并可一键导出适配的简历 PDF。
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
          <Text type="secondary" style={{ fontSize: 12 }}><ImportOutlined /> 仅展示你已批准通过的岗位（工作台「批准」后即在此可见），导入后自动填充岗位名称与岗位要求，可直接修改</Text>
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
            <Text strong style={{ display: 'block', marginBottom: 6 }}>岗位要求 <Text type="danger">*</Text></Text>
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
                <Tag color="orange" icon={<ExclamationCircleOutlined />}>检测到无关内容</Tag>
                <Button size="small" icon={<DeleteOutlined />} onClick={() => setJobDesc(cleanJobDescription(jobDesc))}>
                  一键清理
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  去除「去App 与BOSS随时沟通 / 热门职位推荐区」等无关内容
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
              未配置 AI 时将按本地模板生成（摘要 + 打招呼语占位），建议在「设置 → AI」中填写密钥。
            </Text>
          )}
        </div>

        {/* 实时匹配度预览（AI 优先：工作台导入分；AI 未配置时本地确定性计算） */}
        {liveMatch && currentMatchScore != null && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13 }}>当前简历匹配度：</Text>
            <Tag color={scoreColor(currentMatchScore)} style={{ fontSize: 13, padding: '1px 10px' }}>
              {currentMatchScore} 分
            </Tag>
            {scoreSource === 'ai' ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <Tag color="green" style={{ fontSize: 11, marginRight: 6 }}>AI 分</Tag>
                工作台分析导入（{importedScore} 分）· 生成定制后按需对比提升
              </Text>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {!aiConfigured && <Tag style={{ fontSize: 11, marginRight: 6 }}>本地分</Tag>}
                简历覆盖岗位要点 {liveMatch.coverage}/{liveMatch.total}（{liveMatch.coverageRatio}%）· 生成后对比提升
              </Text>
            )}
          </div>
        )}
      </Card>

      {tailor && (
        <TailorResultView
          tailor={tailor}
          jobTitle={jobTitle.trim() || '定制简历'}
          onExportPdf={() => openExport(tailor, jobTitle.trim() || '定制简历')}
          onSaveCoverLetter={onSaveCoverLetter}
        />
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
                  <Button key="export" size="small" icon={<DownloadOutlined />} onClick={() => openExport(h.result, h.jobTitle)}>
                    导出 PDF
                  </Button>,
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

      {/* 导出定制简历 PDF：联系信息人工确认 + 分节勾选 */}
      <Modal
        title={<Space><DownloadOutlined style={{ color: 'var(--brand)' }} />导出定制简历 PDF</Space>}
        open={exportOpen}
        onCancel={() => { if (!exporting) setExportOpen(false); }}
        width={560}
        okText="生成并保存"
        cancelText="取消"
        confirmLoading={exporting}
        onOk={onExportPdf}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="所有内容均来自你的简历与定制结果，不会编造任何能力与数据。"
          description="请核对下方联系信息（已从简历自动提取，可修改）；选择模板后生成 A4 PDF，可直接投递。"
        />

        {/* 模板选择（多套美观模板，选择持久化） */}
        <div style={{ margin: '4px 0 12px' }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>简历模板</Text>
          <Radio.Group
            value={templateId}
            onChange={(e) => setTemplate(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space wrap size={8} style={{ width: '100%' }}>
              {RESUME_TEMPLATES.map((t) => (
                <Radio.Button
                  key={t.id}
                  value={t.id}
                  style={{
                    width: 'calc(50% - 4px)',
                    height: 'auto',
                    padding: '8px 10px',
                    whiteSpace: 'normal',
                    textAlign: 'left',
                    lineHeight: '1.5',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background: t.color,
                      marginTop: 3,
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{t.name}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t.desc}</Text>
                  </span>
                </Radio.Button>
              ))}
            </Space>
          </Radio.Group>
        </div>

        {/* 个人照片（选填，未上传则模板显示占位框） */}
        <div style={{ margin: '4px 0 12px' }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>个人照片 <Text type="secondary" style={{ fontWeight: 400 }}>（选填 · 所有模板均保留照片框，上传后自动嵌入）</Text></Text>
          <Upload
            accept="image/*"
            showUploadList={false}
            beforeUpload={(file) => {
              compressPhoto(file)
                .then((dataUrl) => { setPhotoPersist(dataUrl); message.success('照片已添加'); })
                .catch((e) => message.error('照片处理失败：' + getErrorMessage(e)));
              return false; // 阻止 antd 自动上传
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar
                size={56}
                shape="square"
                src={photo || undefined}
                icon={!photo ? <CameraOutlined /> : undefined}
                style={{ background: photo ? 'transparent' : '#eef1f5', border: '1px dashed #c3ccd6', color: '#8a94a6' }}
              />
              <Space size={6} wrap>
                <Button size="small" icon={<CameraOutlined />}>上传照片</Button>
                {photo && (
                  <Button size="small" type="text" danger onClick={() => { setPhotoPersist(''); message.info('已移除照片'); }}>
                    移除
                  </Button>
                )}
                <Text type="secondary" style={{ fontSize: 12, display: 'block', width: 200 }}>
                  支持 JPG/PNG，自动压缩后本地保存
                </Text>
              </Space>
            </div>
          </Upload>
        </div>

        <Form form={exportForm} layout="vertical" size="small" style={{ marginTop: 8 }}>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item
              label="姓名"
              name="name"
              rules={[{ required: true, message: '请填写姓名' }]}
              style={{ flex: 1, minWidth: 120 }}
            >
              <Input placeholder="用于简历头部展示" maxLength={20} />
            </Form.Item>
            <Form.Item
              label="电话"
              name="phone"
              rules={[{ pattern: /^1[3-9]\d{9}$/, message: '请填写 11 位手机号' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="选填，建议填写" maxLength={11} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item
              label="邮箱"
              name="email"
              rules={[{ type: 'email', message: '邮箱格式不正确' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="选填" maxLength={60} />
            </Form.Item>
            <Form.Item
              label="求职意向岗位"
              name="targetTitle"
              rules={[{ required: true, message: '请填写求职意向岗位' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="如：前端开发工程师" maxLength={30} />
            </Form.Item>
          </Space>
        </Form>

        <Divider orientation="left" plain style={{ margin: '4px 0 10px' }}>内容分节（按需勾选）</Divider>
        <Checkbox.Group
          value={exportSections}
          onChange={(vals) => setExportSections(vals.map(String))}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {RESUME_SECTION_META.map((m) => (
              <Checkbox key={m.id} value={m.id}>
                <Space size={4}>
                  <span>{m.title}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>{m.hint}</Text>
                </Space>
              </Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
        {exportTailor && exportTailor.skillGaps.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Text type="warning" style={{ fontSize: 12 }}>
              提示：岗位要求但简历未体现的技能未写入（{exportTailor.skillGaps.join('、')}）。若确实具备，可补齐真实经历后再导出。
            </Text>
          </div>
        )}
      </Modal>
    </div>
  );
}
