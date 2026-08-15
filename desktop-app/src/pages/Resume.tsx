import { useRef, useState, useEffect } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  UploadOutlined,
  ThunderboltOutlined,
  SaveOutlined,
  FileTextOutlined,
  CopyOutlined,
  InboxOutlined,
  CommentOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { isReadableResumeText } from '@/lib/bossclaw/pdfExtractor';
import { parseResumeFile, resumeFileKind } from '@/lib/bossclaw/resumeParser';
import { buildProfile, profileFromDraft, profileToDraft, profileHasCore } from '@/lib/bossclaw/profile';
import { generateGreetings, DEFAULT_GREETING_PROMPT, resolveGreetingPrompt } from '@/lib/bossclaw/greetings';
import { normalizeStringList } from '@/lib/bossclaw/helpers';
import { bridgeParseResume } from '@/lib/bridgeClient';
import type { ProfileDraft } from '@/lib/bossclaw/types';

const { TextArea } = Input;
const { Text } = Typography;

// DOCX / PDF 本地解析失败时的桥接兜底（mammoth / pdftotext / OCR）
const bridgeFallback = async (file: File, name: string) => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  const r = await bridgeParseResume(dataUrl, name);
  if (!r.ok || !r.text) throw new Error(r.error || '桥接解析失败');
  return { text: r.text, method: r.method || 'bridge' };
};

export default function Resume() {
  const resumeText = useDataStore((s) => s.resumeText);
  const resumeFileName = useDataStore((s) => s.resumeFileName);
  const profile = useDataStore((s) => s.profile);
  const profileDraft = useDataStore((s) => s.profileDraft);
  const setResumeText = useDataStore((s) => s.setResumeText);
  const setProfile = useDataStore((s) => s.setProfile);
  const setProfileDraft = useDataStore((s) => s.setProfileDraft);
  const storeGreetings = useDataStore((s) => s.greetings);
  const storeGreetingPrompt = useDataStore((s) => s.greetingPrompt);
  const setGreetingPromptStore = useDataStore((s) => s.setGreetingPrompt);
  const config = useSettingsStore((s) => s.config);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState('');
  const [text, setText] = useState(resumeText);
  const [draft, setDraft] = useState<ProfileDraft | null>(profileDraft);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [method, setMethod] = useState('');
  const [greetings, setGreetings] = useState<string[]>([]);
  const [greetingsMeta, setGreetingsMeta] = useState<{ method: string; warning?: string } | null>(null);
  const [greetingBusy, setGreetingBusy] = useState(false);
  const [customPrompt, setCustomPrompt] = useState(storeGreetingPrompt || DEFAULT_GREETING_PROMPT);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 页面加载时回填全局 store 中已生成的打招呼语和自定义提示词（刷新后仍可见，无需重新生成）
  useEffect(() => {
    if (storeGreetings.length) {
      setGreetings(storeGreetings);
      setGreetingsMeta({ method: 'ai', warning: undefined });
    }
    if (storeGreetingPrompt) {
      setCustomPrompt(storeGreetingPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = async (file: File) => {
    const kind = resumeFileKind(file.name);
    if (kind === 'unsupported') {
      message.error('仅支持 PDF / DOCX / TXT 文件（旧版 .doc 请先转档为 DOCX/TXT）');
      return;
    }
    try {
      setBusy(true);
      setBusyMsg(`正在解析 ${file.name} …`);
      setWarnings([]);
      const result = await parseResumeFile(file, bridgeFallback);
      setText(result.text);
      setResumeText(result.text, file.name);
      setMethod(result.method);
      setWarnings(result.warnings || []);
      if (!isReadableResumeText(result.text)) {
        message.warning(`已解析（${result.method}），但文本可读度偏低，建议改用 DOCX/TXT 或粘贴正文。`);
      } else {
        message.success(`已解析简历文本（${result.method}），可点击「生成职业画像」。`);
      }
      // 新简历导入后清空旧打招呼语
      setGreetings([]);
      setGreetingsMeta(null);
    } catch (err: any) {
      setWarnings((w) => [...w, err?.message || '解析失败']);
      message.error(err?.message || '解析失败');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const onGenerate = async () => {
    if (!text.trim()) {
      message.warning('请先导入或粘贴简历文本');
      return;
    }
    try {
      setBusy(true);
      setBusyMsg('AI 正在生成职业画像（失败将自动回退本地规则）…');
      const p = await buildProfile(text, config.model);
      setProfile(p);
      const d = profileToDraft(p);
      setDraft(d);
      setProfileDraft(d);
      const mode = p.generation?.label || (p.generation?.aiStatus === 'success' ? 'AI' : '本地规则');
      message.success(`职业画像已生成（${mode}）。请检查并编辑后保存。`);
    } catch (err: any) {
      message.error(err?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const onGenerateGreetings = async () => {
    if (!text.trim()) {
      message.warning('请先导入或粘贴简历文本');
      return;
    }
    setGreetingBusy(true);
    try {
      const p = useDataStore.getState().profile;
      // 保存用户编辑的提示词到 store（供工作台岗位分析使用）
      const promptToUse = resolveGreetingPrompt(customPrompt);
      setGreetingPromptStore(promptToUse === DEFAULT_GREETING_PROMPT ? '' : customPrompt);
      const result = await generateGreetings(text, p, config.model, customPrompt);
      setGreetings(result.greetings);
      setGreetingsMeta({ method: result.method, warning: result.warning });
      // 写入全局 store：工作台岗位沟通可选用这些 AI 打招呼语
      useDataStore.getState().setGreetings(result.greetings);
      message.success(result.method === 'ai' ? `已基于自定义提示词生成 4 条 AI 个性化打招呼语（已供工作台选用）` : '已生成 4 条打招呼语（本地规则）');
    } catch (err: any) {
      message.error(err?.message || '生成失败');
    } finally {
      setGreetingBusy(false);
    }
  };

  const onCopyGreeting = (g: string) => {
    navigator.clipboard?.writeText(g).then(
      () => message.success('已复制打招呼语'),
      () => message.warning('复制失败，请手动选择复制')
    );
  };

  const onSavePrompt = () => {
    const resolved = resolveGreetingPrompt(customPrompt);
    setGreetingPromptStore(resolved === DEFAULT_GREETING_PROMPT ? '' : customPrompt);
    message.success('打招呼语提示词已保存（将用于工作台岗位分析的招呼语生成）');
  };

  const onResetPrompt = () => {
    setCustomPrompt(DEFAULT_GREETING_PROMPT);
    setGreetingPromptStore('');
    message.info('已恢复为系统默认提示词');
  };

  const onSave = () => {
    if (!draft || !profileHasCore(draft)) {
      message.warning('画像至少需要一个主方向和至少一个搜索词');
      return;
    }
    const p = profileFromDraft(draft, useDataStore.getState().profile);
    setProfile(p);
    setProfileDraft(draft);
    message.success('职业画像已保存');
  };

  const patch = (k: keyof ProfileDraft, v: any) => setDraft((d) => (d ? { ...d, [k]: v, updatedAt: Date.now() } : d));

  const methodLabel: Record<string, string> = {
    'text': 'TXT/MD 直接读取',
    'pdf-unicode-map': 'PDF 文本层（含字体映射）',
    'pdf-content-stream': 'PDF 内容流',
    'docx-local': 'DOCX 本地解析',
    'mammoth': 'DOCX（桥接 mammoth）',
    'pdftotext': 'PDF（桥接 pdftotext）',
    'none': '未知',
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <FileTextOutlined className="page-title-icon" />简历中心
          </h1>
          <p className="page-sub">
            导入 PDF / DOCX / TXT，本地解析提取文本（无需联网）；AI 生成可编辑的职业画像与打招呼语提示词（未配置或失败时自动回退本地规则）。
          </p>
        </div>
      </div>

      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          className="mb-12"
          message="解析提示"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          }
        />
      )}

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card size="small" className="mb-12"
            title={
              <Space>
                <span>简历原文</span>
                {method && <Tag color="blue">{methodLabel[method] || method}</Tag>}
                {resumeFileName && <Tag>{resumeFileName}</Tag>}
              </Space>
            }
            extra={
              <Space>
                <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>导入文件</Button>
                <Button onClick={() => { setResumeText(text, resumeFileName); message.success('原文已保存'); }}>保存原文</Button>
                <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.text" hidden onChange={onPick} />
              </Space>
            }
          >
            <div
              className={'resume-dropzone' + (dragging ? ' is-dragging' : '')}
              role="button"
              tabIndex={0}
              aria-label="点击或拖拽导入简历文件"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileRef.current?.click();
                }
              }}
            >
              <InboxOutlined className="dz-icon" />
              <div className="dz-title">点击或拖拽文件到此处</div>
              <div className="dz-sub">支持 PDF / DOCX / TXT · 单个文件 ≤ 10MB · 本地解析</div>
            </div>
            <TextArea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              className="mt-12"
              placeholder="在此粘贴简历正文，或点击上方/虚线区域导入 PDF / DOCX / TXT"
            />
          </Card>

          <Card size="small" title={<Space><CommentOutlined /> AI 打招呼语提示词</Space>}
            extra={
              <Space>
                <Button icon={<ThunderboltOutlined />} loading={greetingBusy} onClick={onGenerateGreetings}>生成预览</Button>
                <Button icon={<SaveOutlined />} size="small" onClick={onSavePrompt}>保存提示词</Button>
                <Button size="small" onClick={onResetPrompt} disabled={customPrompt === DEFAULT_GREETING_PROMPT}>恢复默认</Button>
                {greetings.length > 0 && (
                  <Button size="small" onClick={() => { setGreetings([]); setGreetingsMeta(null); }}>清空预览</Button>
                )}
              </Space>
            }>
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                自定义 AI 生成打招呼语的提示词。修改后点击「保存提示词」，工作台分析岗位时将使用你的提示词生成个性化招呼语。留空或恢复默认则使用系统内置提示词。
              </Text>
            </div>
            <TextArea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={8}
              placeholder="在此编辑 AI 打招呼语提示词，控制生成口吻、角度、长度等..."
              style={{ fontSize: 12, lineHeight: 1.7, fontFamily: 'monospace' }}
            />
            {greetings.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={8}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text strong style={{ fontSize: 13 }}>预览结果（基于当前提示词生成）</Text>
                  {greetingsMeta?.method === 'local' && greetingsMeta.warning && (
                    <Tag color="orange">{greetingsMeta.warning}</Tag>
                  )}
                  {greetingsMeta?.method === 'ai' && <Tag color="green">AI 生成</Tag>}
                </div>
                {greetings.map((g, i) => (
                  <div key={i} className="greeting-item">
                    <span className="greeting-index">{i + 1}</span>
                    <Text style={{ flex: 1, minWidth: 0 }}>{g}</Text>
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopyGreeting(g)}>复制</Button>
                  </div>
                ))}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  预览供参考；实际投递时，工作台会根据每个岗位单独生成针对性招呼语。请勿替用户承诺薪资、到岗或面试时间。
                </Text>
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
                <span>导入简历后编辑提示词，点击「生成预览」查看效果<br/><small style={{ color: '#999' }}>提示词将用于工作台每个岗位的打招呼语生成</small></span>
              } style={{ marginTop: 16 }} />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title="职业画像（可编辑草稿）"
            size="small"
            className="mb-12"
            extra={
              <Space>
                <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={onGenerate}>
                  生成职业画像
                </Button>
                <Button icon={<SaveOutlined />} onClick={onSave}>保存</Button>
              </Space>
            }
          >
            {!draft ? (
              <Empty description="尚未生成职业画像" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <span className="field-label">个人定位摘要</span>
                  <TextArea rows={3} value={draft.summary} onChange={(e) => patch('summary', e.target.value)} />
                </div>
                <div>
                  <span className="field-label">主方向（最多 3）</span>
                  <Select
                    mode="tags"
                    style={{ width: '100%' }}
                    value={draft.primaryDirections}
                    onChange={(v) => patch('primaryDirections', normalizeStringList(v, 3))}
                    placeholder="如：前端开发工程师"
                  />
                </div>
                <div>
                  <span className="field-label">搜索关键词（真实岗位名）</span>
                  <Select
                    mode="tags"
                    style={{ width: '100%' }}
                    value={draft.searchKeywords}
                    onChange={(v) => patch('searchKeywords', normalizeStringList(v, 12))}
                    placeholder="如：前端开发、React 开发"
                  />
                </div>
                <Row gutter={8}>
                  <Col span={12}>
                    <span className="field-label">技能</span>
                    <Select mode="tags" style={{ width: '100%' }} value={draft.skills} onChange={(v) => patch('skills', normalizeStringList(v, 40))} />
                  </Col>
                  <Col span={12}>
                    <span className="field-label">城市</span>
                    <Select mode="tags" style={{ width: '100%' }} value={draft.locations} onChange={(v) => patch('locations', normalizeStringList(v, 20))} />
                  </Col>
                </Row>
                <Row gutter={8}>
                  <Col span={12}>
                    <span className="field-label">求职类型</span>
                    <Select mode="tags" style={{ width: '100%' }} value={draft.employmentTypes} onChange={(v) => patch('employmentTypes', normalizeStringList(v, 10))} />
                  </Col>
                  <Col span={12}>
                    <span className="field-label">学历</span>
                    <Input value={draft.degree} onChange={(e) => patch('degree', e.target.value)} />
                  </Col>
                </Row>
                <Row gutter={8}>
                  <Col span={12}>
                    <span className="field-label">经验</span>
                    <Input value={draft.experience} onChange={(e) => patch('experience', e.target.value)} />
                  </Col>
                  <Col span={12}>
                    <span className="field-label">薪资</span>
                    <Input value={draft.salary} onChange={(e) => patch('salary', e.target.value)} />
                  </Col>
                </Row>
                <div>
                  <span className="field-label">排除方向</span>
                  <Select mode="tags" style={{ width: '100%' }} value={draft.excludeDirections} onChange={(v) => patch('excludeDirections', normalizeStringList(v, 20))} />
                </div>
                {profile?.generation && (
                  <Tag color={profile.generation.aiStatus === 'success' || profile.generation.aiStatus === 'success-after-retry' ? 'green' : 'orange'}>
                    {profile.generation.label}
                  </Tag>
                )}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Spin spinning={busy} tip={busyMsg}>
        <div style={{ height: 1 }} />
      </Spin>
    </div>
  );
}
