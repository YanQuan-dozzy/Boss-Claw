// 题库工作区（P3）：栏 ② 的题库列表 + 栏 ③ 的题目表格 / 新增 / 编辑 / 导入向导
//
// 边界（方案 §4.6）：
//   · 内置库只读：可停用、可查看、可「恢复默认」，但不能改题（output 是模型生成的，改了也没有依据）；
//   · 有进行中的会话时，编辑/删除/导入整页置灰——会话里存的是题目快照，中途改会让「这题要点是哪版」无法追溯；
//   · 导入不允许直接吞进去：解析 → 字段映射 → 校验报告 → 目标库 → 写入，五步都要用户看见。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useBankStore, BANK_DIRECTION_OPTIONS } from '@/store/useBankStore';
import {
  BANK_CATEGORY_LABELS,
  BANK_DIFFICULTY_LABELS,
  BANK_DIRECTION_LABELS,
  BANK_TYPE_LABELS,
  type BankDirection,
  type BankQuestion,
} from '@/lib/bossclaw/mockInterviewBank';
import {
  FIELD_LABELS,
  IMPORT_FORMAT_LABELS,
  MAX_IMPORT_QUESTIONS,
  applyFieldMap,
  autoMap,
  csvToRecords,
  detectFormat,
  emptyBankQuestion,
  parseCsv,
  parseDocxRecords,
  parseJsonRecords,
  parseMarkdownRecords,
  prepareImport,
  type FieldKey,
  type FieldMap,
  type ImportFormat,
  type MappedQuestion,
  type RawRecord,
  type ValidationReport,
} from '@/lib/bossclaw/mockInterviewImport';
import type { MockDifficulty, MockQuestionCategory } from '@/lib/bossclaw/mockInterviewTypes';
import { formatBytes } from '@/lib/bossclaw/mockInterviewRepo';

const FIELD_ORDER: FieldKey[] = ['text', 'answer', 'focus', 'keyPoints', 'directions', 'difficulty', 'category', 'tags'];

// ===== 栏 ②：题库列表 =====
export function MockBankRail({ active }: { active: boolean }) {
  const banks = useBankStore((s) => s.banks);
  const activeBankId = useBankStore((s) => s.activeBankId);
  const toggleBank = useBankStore((s) => s.toggleBank);
  const refreshBanks = useBankStore((s) => s.refreshBanks);
  const selectBank = useBankStore((s) => s.selectBank);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const createBank = useBankStore((s) => s.createBank);

  useEffect(() => {
    if (active) void refreshBanks();
  }, [active, refreshBanks]);

  return (
    <>
      <div className="mi-rail-label">题库（启用的参与召回）</div>
      <div className="mi-history">
        {banks.length === 0 ? (
          <div className="mi-history-empty">还没有题库</div>
        ) : (
          banks.map((b) => (
            <div
              key={b.id}
              role="button"
              tabIndex={0}
              className={'mi-history-item' + (activeBankId === b.id ? ' is-active' : '')}
              onClick={() => void selectBank(b.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') void selectBank(b.id); }}
            >
              <div className="mi-history-top">
                <span className="mi-history-job">{b.name}</span>
                <Checkbox
                  checked={b.enabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void toggleBank(b.id, e.target.checked)}
                />
              </div>
              <div className="mi-history-meta">
                {BANK_TYPE_LABELS[b.type]} · {b.count} 题 · {formatBytes(b.bytes)}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mi-rail-foot">
        <div className="mi-foot-actions">
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建题库</Button>
        </div>
      </div>

      <Modal
        title="新建题库"
        open={creating}
        okText="创建"
        cancelText="取消"
        onCancel={() => setCreating(false)}
        onOk={async () => {
          const b = await createBank(name);
          if (b) {
            setCreating(false);
            setName('');
          }
        }}
      >
        <Input
          placeholder="例如：我司面经 / 算法专项"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void createBank(name).then((b) => { if (b) { setCreating(false); setName(''); } })}
        />
        <div className="mi-caption" style={{ marginTop: 8 }}>建好之后可以在右侧「导入文件」或「新增题目」往里加题。</div>
      </Modal>
    </>
  );
}

// ===== 栏 ③：题库主工作区 =====
export default function MockBankPanel({ sessionActive }: { sessionActive: boolean }) {
  const banks = useBankStore((s) => s.banks);
  const activeBankId = useBankStore((s) => s.activeBankId);
  const questions = useBankStore((s) => (s.activeBankId ? s.questions[s.activeBankId] : undefined));
  const indexInfo = useBankStore((s) => s.indexInfo);
  const busy = useBankStore((s) => s.busy);
  const error = useBankStore((s) => s.error);
  const notice = useBankStore((s) => s.notice);
  const refreshBanks = useBankStore((s) => s.refreshBanks);
  const clearCache = useBankStore((s) => s.clearCache);
  const deleteBank = useBankStore((s) => s.deleteBank);
  const restoreBuiltin = useBankStore((s) => s.restoreBuiltin);
  const deleteQuestion = useBankStore((s) => s.deleteQuestion);

  const [keyword, setKeyword] = useState('');
  const [dirFilter, setDirFilter] = useState<BankDirection[]>([]);
  const [diffFilter, setDiffFilter] = useState<MockDifficulty[]>([]);
  const [editing, setEditing] = useState<Partial<BankQuestion> | null>(null);
  const [viewing, setViewing] = useState<BankQuestion | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    void refreshBanks();
  }, [refreshBanks]);

  const bank = useMemo(() => banks.find((b) => b.id === activeBankId) || null, [banks, activeBankId]);
  const editable = Boolean(bank && bank.type !== 'builtin');
  const lockEdit = sessionActive;

  const filtered = useMemo(() => {
    const list = questions || [];
    const kw = keyword.trim().toLowerCase();
    return list.filter((q) => {
      if (kw && !q.text.toLowerCase().includes(kw)) return false;
      if (dirFilter.length && !q.directions.some((d) => dirFilter.includes(d))) return false;
      if (diffFilter.length && !diffFilter.includes(q.difficulty)) return false;
      return true;
    });
  }, [questions, keyword, dirFilter, diffFilter]);

  const onRebuild = useCallback(async () => {
    await clearCache();
    message.success('索引已重建');
  }, [clearCache]);

  const openAdd = () => setEditing(emptyBankQuestion());
  const openEdit = (q: BankQuestion) => setEditing({ ...q });

  const totalEnabled = banks.filter((b) => b.enabled).length;

  if (!bank) {
    return (
      <div className="mi-center">
        <Empty description="还没有可用的题库" />
        <Button type="primary" icon={<ReloadOutlined />} onClick={() => void refreshBanks()}>刷新</Button>
      </div>
    );
  }

  return (
    <div className="mi-scroll mi-bank">
      <div className="mi-head">
        <div>
          <h1 className="page-title">{bank.name}</h1>
          <Typography.Text type="secondary">
            {BANK_TYPE_LABELS[bank.type]} · {bank.count} 题 · {formatBytes(bank.bytes)}
            {bank.license ? ` · 许可 ${bank.license}` : ''}
            {bank.source ? ` · 来源 ${bank.source}` : ''}
          </Typography.Text>
        </div>
        <Space wrap>
          {bank.type === 'builtin' ? (
            <Button size="small" icon={<SyncOutlined />} onClick={() => void restoreBuiltin()}>恢复默认</Button>
          ) : (
            <Popconfirm
              title="删除这个题库？"
              description="题库文件会被删除，不可恢复。已生成的面试报告不受影响。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={lockEdit}
              onConfirm={() => void deleteBank(bank.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={lockEdit}>删除题库</Button>
            </Popconfirm>
          )}
        </Space>
      </div>

      <div className="mi-bank-stats">
        <span>参与召回：<b>{totalEnabled}</b> / {banks.length} 个题库</span>
        <span>
          索引：<b>{indexInfo.count}</b> 题
          {indexInfo.source === 'cache' ? '（读缓存）' : indexInfo.source === 'built' ? `（重建 ${indexInfo.buildMs}ms）` : ''}
        </span>
        <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => void onRebuild()} loading={busy === 'build-index'}>
          重建索引
        </Button>
      </div>

      {error ? <Alert type="error" showIcon closable message={error} /> : null}
      {notice ? <Alert type="success" showIcon closable message={notice} /> : null}
      {lockEdit ? (
        <Alert
          type="warning"
          showIcon
          message="本场面试进行中，题库暂不可编辑"
          description="会话里存的是题目快照；现在改题会让「这道题的要点是哪一版」无法追溯。本场结束后即可编辑。"
        />
      ) : null}
      {indexInfo.count === 0 && banks.some((b) => b.enabled) ? (
        <Alert
          type="info"
          showIcon
          message="索引尚未构建"
          description="发起面试或点上方「重建索引」即可构建（内置题库约 1.4 万题，首次约 1–3 秒）。"
        />
      ) : null}

      <div className="mi-bank-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索题干"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ width: 220 }}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount={1}
          placeholder="方向"
          style={{ minWidth: 120 }}
          value={dirFilter}
          onChange={setDirFilter}
          options={BANK_DIRECTION_OPTIONS}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount={1}
          placeholder="难度"
          style={{ minWidth: 110 }}
          value={diffFilter}
          onChange={setDiffFilter}
          options={(Object.keys(BANK_DIFFICULTY_LABELS) as MockDifficulty[]).map((k) => ({
            value: k,
            label: BANK_DIFFICULTY_LABELS[k],
          }))}
        />
        <span className="mi-caption">筛选后 {filtered.length} 题</span>
        <div style={{ flex: 1 }} />
        <Tooltip title={editable ? '' : '内置题库只读，请新建题库后再加题'}>
          <Button size="small" icon={<PlusOutlined />} disabled={!editable || lockEdit} onClick={openAdd}>新增题目</Button>
        </Tooltip>
        <Tooltip title={lockEdit ? '本场结束后可导入' : ''}>
          <Button size="small" icon={<ImportOutlined />} disabled={lockEdit} onClick={() => setImportOpen(true)}>导入文件</Button>
        </Tooltip>
        <Button
          size="small"
          icon={<ExportOutlined />}
          disabled={!filtered.length}
          onClick={() => exportBankJson(bank.name, filtered)}
        >
          导出
        </Button>
      </div>

      <Table<BankQuestion>
        size="small"
        rowKey="id"
        className="mi-bank-table"
        dataSource={filtered}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 题` }}
        columns={[
          {
            title: '题干',
            dataIndex: 'text',
            render: (text: string, q) => (
              <button type="button" className="mi-bank-q" onClick={() => setViewing(q)}>
                {text}
              </button>
            ),
          },
          {
            title: '方向',
            dataIndex: 'directions',
            width: 130,
            render: (dirs: BankDirection[]) => (
              <Space size={2} wrap>
                {dirs.slice(0, 2).map((d) => (
                  <Tag key={d} bordered={false}>{BANK_DIRECTION_LABELS[d]}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: '难度',
            dataIndex: 'difficulty',
            width: 70,
            render: (d: MockDifficulty) => BANK_DIFFICULTY_LABELS[d],
          },
          {
            title: '要点',
            dataIndex: 'keyPoints',
            width: 60,
            render: (kp?: string[]) => (kp && kp.length ? `${kp.length} 条` : '—'),
          },
          {
            title: '',
            width: 90,
            render: (_: unknown, q) =>
              editable ? (
                <Space size={0}>
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    disabled={lockEdit}
                    onClick={() => openEdit(q)}
                  />
                  <Popconfirm
                    title="删除这道题？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    disabled={lockEdit}
                    onConfirm={() => void deleteQuestion(bank.id, q.id)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={lockEdit} />
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />

      <QuestionDrawer question={viewing} onClose={() => setViewing(null)} onEdit={editable && !lockEdit ? (q) => { setViewing(null); openEdit(q); } : undefined} />

      <QuestionEditor
        open={Boolean(editing)}
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
        bankId={bank.id}
        isBuiltin={!editable}
      />

      <ImportWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        banks={banks.filter((b) => b.type !== 'builtin')}
        defaultBankId={editable ? bank.id : null}
        existing={editable ? questions || [] : []}
      />
    </div>
  );
}

// ===== 题目详情（内置题的 output 折叠在「参考资料」里，默认不展示） =====
function QuestionDrawer({
  question,
  onClose,
  onEdit,
}: {
  question: BankQuestion | null;
  onClose: () => void;
  onEdit?: (q: BankQuestion) => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  useEffect(() => setShowAnswer(false), [question?.id]);
  return (
    <Drawer
      open={Boolean(question)}
      onClose={onClose}
      width={520}
      title="题目详情"
      extra={onEdit && question ? <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(question)}>编辑</Button> : null}
    >
      {question ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph style={{ fontSize: 15, fontWeight: 600, marginBottom: 0 }}>
            {question.text}
          </Typography.Paragraph>
          <Space size={4} wrap>
            {question.directions.map((d) => <Tag key={d} bordered={false}>{BANK_DIRECTION_LABELS[d]}</Tag>)}
            <Tag bordered={false}>{BANK_DIFFICULTY_LABELS[question.difficulty]}</Tag>
            <Tag bordered={false}>{BANK_CATEGORY_LABELS[question.category]}</Tag>
            {question.tags.map((t) => <Tag key={t}>{t}</Tag>)}
          </Space>
          {question.focus?.length ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="考察点">
                {question.focus.join('；')}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
          {question.keyPoints?.length ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="评分要点（判漏答依据）">
                <ul className="mi-gap-list">{question.keyPoints.map((k) => <li key={k}>{k}</li>)}</ul>
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Alert
              type="info"
              showIcon
              message="这道题没有评分要点"
              description="没有要点时，报告里不会出现「题库要点」标记，AI 也不会凭空编造判分依据。"
            />
          )}
          {question.answer ? (
            <div>
              <Button size="small" type="link" onClick={() => setShowAnswer((v) => !v)} style={{ paddingLeft: 0 }}>
                {showAnswer ? '收起参考资料' : '参考资料（AI 生成，未校验）'}
              </Button>
              {showAnswer ? (
                <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                  {question.answer}
                </Typography.Paragraph>
              ) : null}
            </div>
          ) : null}
        </Space>
      ) : null}
    </Drawer>
  );
}

// ===== 新增 / 编辑 =====
function QuestionEditor({
  open,
  value,
  onClose,
  onSaved,
  bankId,
  isBuiltin,
}: {
  open: boolean;
  value: Partial<BankQuestion> | null;
  onClose: () => void;
  onSaved: () => void;
  bankId: string;
  isBuiltin: boolean;
}) {
  const [form] = Form.useForm<Partial<BankQuestion>>();
  const addQuestion = useBankStore((s) => s.addQuestion);
  const updateQuestion = useBankStore((s) => s.updateQuestion);
  const busy = useBankStore((s) => s.busy);

  useEffect(() => {
    if (open && value) form.setFieldsValue(value);
  }, [open, value, form]);

  const onOk = async () => {
    if (isBuiltin) return;
    const v = await form.validateFields();
    const ok = value?.id
      ? await updateQuestion(bankId, value.id, v)
      : await addQuestion(bankId, v);
    if (ok) onSaved();
  };

  return (
    <Modal
      open={open}
      title={value?.id ? '编辑题目' : '新增题目'}
      width={640}
      okText="保存"
      cancelText="取消"
      confirmLoading={busy === 'add-question' || busy === 'update-question'}
      onCancel={onClose}
      onOk={() => void onOk()}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item
          name="text"
          label="题干（必填，6–200 字）"
          rules={[{ required: true, message: '请填写题干' }, { min: 6, message: '太短了，写清楚要问什么' }]}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={200} showCount />
        </Form.Item>
        <Space size={12} wrap>
          <Form.Item name="directions" label="岗位方向（可多选）" rules={[{ required: true }]}>
            <Select mode="multiple" style={{ width: 220 }} options={BANK_DIRECTION_OPTIONS} maxTagCount={2} />
          </Form.Item>
          <Form.Item name="difficulty" label="难度" rules={[{ required: true }]}>
            <Select
              style={{ width: 120 }}
              options={(Object.keys(BANK_DIFFICULTY_LABELS) as MockDifficulty[]).map((k) => ({
                value: k,
                label: BANK_DIFFICULTY_LABELS[k],
              }))}
            />
          </Form.Item>
          <Form.Item name="category" label="题型" rules={[{ required: true }]}>
            <Select
              style={{ width: 140 }}
              options={(Object.keys(BANK_CATEGORY_LABELS) as MockQuestionCategory[]).map((k) => ({
                value: k,
                label: BANK_CATEGORY_LABELS[k],
              }))}
            />
          </Form.Item>
        </Space>
        <Form.Item
          name="focus"
          label="考察点（每行一条，2–4 条）"
          extra="报告里「命中/漏答」会对着它逐条比"
          getValueProps={(v) => ({ value: Array.isArray(v) ? v.join('\n') : v || '' })}
          normalize={(v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean)}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder={'例如：\n是否讲清指标口径\n是否有具体数据'} />
        </Form.Item>
        <Form.Item
          name="keyPoints"
          label="评分要点（每行一条，2–5 条）"
          extra="填了才会在报告里标「题库要点」；留空则该题不产生要点，报告标「无要点依据」"
          getValueProps={(v) => ({ value: Array.isArray(v) ? v.join('\n') : v || '' })}
          normalize={(v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean)}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
        </Form.Item>
        <Form.Item name="tags" label="标签">
          <Select mode="tags" placeholder="例如：Redis、缓存、高并发" tokenSeparators={[',', '，']} />
        </Form.Item>
        <Form.Item name="answer" label="参考答案（仅本地参考，不会喂给 AI）">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ===== 导入向导 =====
interface ImportDraft {
  format: ImportFormat | null;
  fileName: string;
  records: RawRecord[];
  headers: string[];
  map: FieldMap;
  mapped: MappedQuestion[];
  report: ValidationReport | null;
  questions: BankQuestion[];
}

const EMPTY_DRAFT: ImportDraft = {
  format: null,
  fileName: '',
  records: [],
  headers: [],
  map: autoMap([]),
  mapped: [],
  report: null,
  questions: [],
};

function ImportWizard({
  open,
  onClose,
  banks,
  defaultBankId,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  banks: Array<{ id: string; name: string; type: string }>;
  defaultBankId: string | null;
  existing: BankQuestion[];
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ImportDraft>(EMPTY_DRAFT);
  const [parsing, setParsing] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(defaultBankId);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [newBankName, setNewBankName] = useState('');
  const [writing, setWriting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const createBank = useBankStore((s) => s.createBank);
  const writeImport = useBankStore((s) => s.writeImport);

  useEffect(() => {
    if (open) {
      setStep(0);
      setDraft(EMPTY_DRAFT);
      setTargetId(defaultBankId);
      setMode('append');
      setNewBankName('');
    }
  }, [open, defaultBankId]);

  const onPickFile = async (file: File) => {
    const format = detectFormat(file.name);
    if (!format) {
      message.error('只支持 JSON / CSV / Markdown / .docx');
      return;
    }
    // 158K 条的大库约 90MB：先按体积拦住，避免在渲染进程里 JSON.parse 到界面假死
    if (file.size > 40 * 1024 * 1024) {
      message.error(
        `文件 ${(file.size / 1024 / 1024).toFixed(0)}MB 过大。请按方向或年份拆成多个小于 30MB 的文件分批导入（单次上限 ${MAX_IMPORT_QUESTIONS} 条）。`,
      );
      return;
    }
    setParsing(true);
    try {
      let result;
      if (format === 'docx') {
        result = await parseDocxRecords(file);
      } else {
        const text = await file.text();
        if (format === 'json') {
          result = parseJsonRecords(text);
        } else if (format === 'csv') {
          const table = parseCsv(text);
          result = { records: csvToRecords(table), headers: table.headers };
        } else {
          result = parseMarkdownRecords(text);
        }
      }
      if (result.error) {
        message.error(result.error);
        setDraft({ ...EMPTY_DRAFT, fileName: file.name, format });
        return;
      }
      if (result.records.length > MAX_IMPORT_QUESTIONS) {
        message.error(
          `这个文件有 ${result.records.length} 条，超过单次上限 ${MAX_IMPORT_QUESTIONS} 条。请按方向或年份拆成多个文件分批导入。`,
        );
      }
      const map = autoMap(result.headers);
      const mapped = applyFieldMap(result.records, map);
      setDraft({
        format,
        fileName: file.name,
        records: result.records,
        headers: result.headers,
        map,
        mapped,
        report: null,
        questions: [],
      });
      setStep(1);
    } finally {
      setParsing(false);
    }
  };

  const remap = (map: FieldMap) => {
    const mapped = applyFieldMap(draft.records, map);
    setDraft({ ...draft, map, mapped, report: null, questions: [] });
  };

  const runValidation = async () => {
    if (!draft.map.text) {
      message.error('请先指定「题干」对应的字段');
      return;
    }
    const prepared = prepareImport(draft.mapped, existing);
    setDraft({ ...draft, report: prepared.report, questions: prepared.questions });
    setStep(2);
  };

  const doWrite = async () => {
    let bankId = targetId;
    if (!bankId) {
      const name = newBankName.trim();
      if (!name) {
        message.error('请选择目标题库，或填一个新题库名称');
        return;
      }
      const b = await createBank(name);
      if (!b) return;
      bankId = b.id;
    }
    if (!draft.questions.length) return;
    setWriting(true);
    try {
      const ok = await writeImport(bankId, draft.questions, mode);
      if (ok) onClose();
    } finally {
      setWriting(false);
    }
  };

  const r = draft.report;

  return (
    <Modal
      open={open}
      title="导入题库"
      width={880}
      footer={null}
      onCancel={onClose}
      destroyOnClose
    >
      <Steps
        size="small"
        current={step}
        items={[
          { title: '选文件' },
          { title: '字段映射' },
          { title: '校验' },
          { title: '写入' },
        ]}
      />
      <div className="mi-import-body">
        {step === 0 ? (
          <div className="mi-import-drop">
            <ImportOutlined style={{ fontSize: 28, opacity: 0.5 }} />
            <div>支持 JSON / CSV / Markdown / Word(.docx)</div>
            <div className="mi-caption">
              JSON 支持数组或 {'{ questions: [...] }'}；CSV 会处理 BOM 与跨行单元格；Markdown 按标题一题一块。
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv,.tsv,.txt,.md,.markdown,.docx"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickFile(f);
                e.target.value = '';
              }}
            />
            <Button type="primary" icon={<ImportOutlined />} loading={parsing} onClick={() => fileRef.current?.click()}>
              选择文件
            </Button>
          </div>
        ) : null}

        {step === 1 ? (
          <div>
            <Alert
              type="info"
              showIcon
              message={`已解析 ${draft.records.length} 条 · ${draft.format ? IMPORT_FORMAT_LABELS[draft.format] : ''} · ${draft.fileName}`}
              description="确认每一列对应的字段。识别不出的留空即可——题干必须指定，其余留空会按关键词自动分类。"
            />
            <div className="mi-import-map">
              {FIELD_ORDER.map((k) => (
                <div className="mi-import-map-row" key={k}>
                  <label>{FIELD_LABELS[k]}</label>
                  <Select
                    allowClear
                    size="small"
                    placeholder="（不导入）"
                    value={draft.map[k] || undefined}
                    style={{ width: 220 }}
                    onChange={(v) => remap({ ...draft.map, [k]: v || null })}
                    options={draft.headers.map((h) => ({ value: h, label: h }))}
                  />
                </div>
              ))}
            </div>
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={draft.mapped.slice(0, 5)}
              columns={[
                { title: '题干', dataIndex: 'text', ellipsis: true },
                { title: '答案', dataIndex: 'answer', ellipsis: true, width: 160 },
                {
                  title: '方向',
                  dataIndex: 'directions',
                  width: 110,
                  render: (dirs: BankDirection[]) => dirs.map((d) => BANK_DIRECTION_LABELS[d]).join('/'),
                },
                { title: '难度', dataIndex: 'difficulty', width: 70, render: (d: MockDifficulty) => BANK_DIFFICULTY_LABELS[d] },
              ]}
            />
            <div className="mi-import-foot">
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" onClick={() => void runValidation()}>校验</Button>
            </div>
          </div>
        ) : null}

        {step === 2 && r ? (
          <div>
            {r.overflow ? <Alert type="error" showIcon message="超过单次导入上限" description={r.overflow.message} /> : null}
            <div className="mi-import-report">
              <div><span>总条数</span><b>{r.total}</b></div>
              <div><span>可写入</span><b>{r.valid}</b></div>
              <div><span>缺题干</span><b>{r.noText}</b></div>
              <div><span>题干过短</span><b>{r.tooShort}</b></div>
              <div><span>题干过长</span><b>{r.tooLong}</b></div>
              <div><span>无答案</span><b>{r.noAnswer}</b></div>
              <div><span>完全重复（跳过）</span><b>{r.exactDuplicates}</b></div>
              <div><span>疑似重复（保留）</span><b>{r.nearDuplicates.length}</b></div>
            </div>
            {r.nearDuplicates.length ? (
              <Alert
                type="warning"
                showIcon
                message={`有 ${r.nearDuplicates.length} 条与已有/本批题目高度相似（Jaccard > 0.85）`}
                description={
                  <div className="mi-import-near">
                    {r.nearDuplicates.slice(0, 5).map((n) => (
                      <div key={`${n.row}-${n.similarity}`}>
                        第 {n.row} 行「{n.text.slice(0, 30)}」≈ {n.similarTo}（{n.similarity}）
                      </div>
                    ))}
                    <div className="mi-caption">只提示，不自动删——自动去掉可能把「同一问法的不同岗位版」误删。</div>
                  </div>
                }
              />
            ) : null}
            <div className="mi-import-foot">
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" disabled={!r.valid || Boolean(r.overflow)} onClick={() => setStep(3)}>
                下一步（写入 {r.valid} 条）
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <div className="mi-import-target">
              <label>目标题库</label>
              <Select
                allowClear
                placeholder="新建题库…"
                style={{ width: 260 }}
                value={targetId || undefined}
                onChange={(v) => setTargetId(v || null)}
                options={banks.map((b) => ({ value: b.id, label: b.name }))}
              />
              {!targetId ? (
                <Input
                  placeholder="新题库名称"
                  style={{ width: 200 }}
                  value={newBankName}
                  onChange={(e) => setNewBankName(e.target.value)}
                />
              ) : null}
              <Select
                style={{ width: 160 }}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'append', label: '追加到现有题目' },
                  { value: 'replace', label: '覆盖（先清空该库）' },
                ]}
              />
            </div>
            {mode === 'replace' && targetId ? (
              <Alert type="warning" showIcon message="覆盖模式会先清空目标题库里的全部题目（不可撤销）" />
            ) : null}
            {writing ? <Progress percent={100} status="active" showInfo={false} /> : null}
            <div className="mi-import-foot">
              <Button onClick={() => setStep(2)} disabled={writing}>上一步</Button>
              <Button type="primary" loading={writing} onClick={() => void doWrite()}>
                写入 {draft.questions.length} 条
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** 导出当前筛选结果为 JSON（与导入格式对称） */
function exportBankJson(name: string, questions: BankQuestion[]) {
  const payload = {
    name,
    exportedAt: new Date().toISOString(),
    questions: questions.map((q) => ({
      question: q.text,
      answer: q.answer || '',
      directions: q.directions,
      difficulty: q.difficulty,
      category: q.category,
      tags: q.tags,
      focus: q.focus || [],
      keyPoints: q.keyPoints || [],
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name || '题库'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
