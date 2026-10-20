// 设置页「导入音色包」（P2 剩余）
//
// 四步（方案 6.5.2）：探测模型族 → 完整性校验 → 试听验证 → 复制落盘。
// 关键取舍：**先试听再复制**。社区音色包质量参差，有的 ONNX 与运行时版本不兼容，
// 加载会直接崩；在 utilityProcess 里崩只影响这次试听，用户目录也不会被复制出半份。
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, InputNumber, Modal, Popconfirm, Space, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, EditOutlined, ImportOutlined, SoundOutlined } from '@ant-design/icons';
import {
  formatSpeechBytes,
  isClonedVoiceId,
  type CustomVoice,
  type ImportedVoice,
  type VoicePackProbe,
} from '@/lib/bossclaw/mockInterviewVoice';
import {
  importVoicePack,
  listCustomVoices,
  pickVoicePack,
  previewVoice,
  previewVoicePack,
  removeClonedVoice,
  renameClonedVoice,
  stopSpeaking,
} from '@/lib/bossclaw/mockInterviewTts';

export default function VoicePackCard({ active }: { active: boolean }) {
  const [voices, setVoices] = useState<ImportedVoice[]>([]);
  const [pack, setPack] = useState<{ dir: string; probe: VoicePackProbe } | null>(null);
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [sid, setSid] = useState(0);
  const [previewed, setPreviewed] = useState(false);
  const [busy, setBusy] = useState<'' | 'pick' | 'preview' | 'import'>('');
  const [previewing, setPreviewing] = useState('');
  const [renaming, setRenaming] = useState('');
  const [renameValue, setRenameValue] = useState('');

  const refresh = useCallback(async () => {
    const r = await listCustomVoices();
    setVoices((r.voices || []).filter((v): v is ImportedVoice => v.kind === 'imported'));
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const onPick = async () => {
    setBusy('pick');
    try {
      const r = await pickVoicePack();
      if (r.canceled) return;
      if (!r.probe) { message.error(r.error || '无法读取这个目录'); return; }
      setPack({ dir: r.dir || '', probe: r.probe });
      setName(r.probe.ok ? (r.dir || '').split(/[\\/]/).filter(Boolean).pop() || '导入音色' : '');
      setLicense('');
      setSid(0);
      setPreviewed(false);
      // 不支持的族不弹试听：直接把原因摆在弹窗里
      if (!r.probe.ok) message.warning(r.probe.reason || '这个目录不能导入');
    } finally {
      setBusy('');
    }
  };

  const onPreview = async () => {
    if (!pack) return;
    setBusy('preview');
    try {
      const r = await previewVoicePack(pack.dir, sid);
      if (!r.ok) {
        message.error(r.error || '试听失败');
        setPreviewed(false);
        return;
      }
      setPreviewed(true);
      message.success(`试听通过${r.ms ? `（合成 ${(r.ms / 1000).toFixed(1)}s）` : ''}，可以保存了`);
      // 社区 vits 包常不发 13MB 音素数据，我们借了内置包那份；不说明的话用户会以为包里有
      if (r.borrowedDataDir) {
        message.info('这个包没带音素数据（espeak-ng-data），已借用内置语音包的那份，导入后照常可用');
      }
    } finally {
      setBusy('');
    }
  };

  const onImport = async () => {
    if (!pack) return;
    if (!previewed) { message.warning('先试听一次，确认能出声再保存'); return; }
    setBusy('import');
    try {
      const r = await importVoicePack(pack.dir, { name: name.trim() || '导入音色', license: license.trim(), sid });
      if (!r.ok) { message.error(r.error || '导入失败'); return; }
      message.success('音色已导入，可在面试配置里选择');
      setPack(null);
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const onPreviewSaved = async (id: string) => {
    setPreviewing(id);
    try {
      const r = await previewVoice(id, 1);
      if (!r.ok) message.warning(r.error || '试听失败');
    } finally {
      setPreviewing('');
    }
  };

  const onDelete = async (id: string) => {
    stopSpeaking();
    const r = await removeClonedVoice(id);
    if (!r.ok) { message.error(r.error || '删除失败'); return; }
    message.success('音色已删除');
    await refresh();
  };

  const onRename = async (id: string) => {
    const next = renameValue.trim();
    if (!next) { message.warning('名称不能为空'); return; }
    const r = await renameClonedVoice(id, next);
    if (!r.ok) { message.error(r.error || '重命名失败'); return; }
    setRenaming('');
    await refresh();
  };

  const probe = pack?.probe;

  return (
    <div className="settings-section-card">
      <div className="settings-section-header">
        <div className="settings-section-header__title">
          <div className="section-icon-box">
            <ImportOutlined />
          </div>
          导入音色包
        </div>
        <Tag>{voices.length} 个已导入</Tag>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ borderRadius: 8, marginBottom: 12 }}
        message="支持 Piper / VITS、Kokoro 布局；Matcha / Kitten / Pocket 本版不导入"
        description="选一个目录（不是单个文件）。会先探测模型族并试听，通过后才复制到本机音色库。音色包版权由你自行确认，BossClaw 不分发、不推荐下载源。"
      />

      <div className="setting-actions" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Button
            type="primary"
            icon={<ImportOutlined />}
            loading={busy === 'pick'}
            disabled={busy !== ''}
            onClick={() => void onPick()}
          >
            选择音色包目录…
          </Button>
          <span className="field-label" style={{ opacity: 0.7 }}>
            单个音色包通常 60–120MB（Kokoro 多语言包约 407MB），上限 600MB；一次只导一个，避免把磁盘塞满。
          </span>
        </Space>
      </div>

      <div className="mi-clone-list">
        <div className="mi-rail-label">已导入的音色（{voices.length}）</div>
        {voices.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有导入音色包" />
        ) : (
          voices.map((v) => (
            <div className="mi-clone-item" key={v.id}>
              <div className="mi-clone-item__main">
                {renaming === v.id ? (
                  <Space size={6}>
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onPressEnter={() => void onRename(v.id)}
                    />
                    <Button size="small" type="primary" onClick={() => void onRename(v.id)}>保存</Button>
                    <Button size="small" type="text" onClick={() => setRenaming('')}>取消</Button>
                  </Space>
                ) : (
                  <>
                    <div className="mi-clone-item__name">
                      {v.name}
                      <Tag bordered={false} style={{ marginLeft: 6, fontSize: 11 }}>
                        {v.engine === 'vits' ? 'Piper' : v.engine === 'kokoro' ? 'Kokoro' : 'ZipVoice'}
                      </Tag>
                    </div>
                    <div className="mi-clone-item__meta">
                      {formatSpeechBytes(v.bytes || 0)}
                      {v.numSpeakers > 1 ? ` · ${v.numSpeakers} 个说话人（用 #${v.sid}）` : ''}
                      {v.license ? ` · ${v.license}` : ''}
                    </div>
                  </>
                )}
              </div>
              <Space size={4}>
                <Tooltip title="用这个音色试听一句">
                  <Button
                    size="small"
                    icon={<SoundOutlined />}
                    loading={previewing === v.id}
                    onClick={() => void onPreviewSaved(v.id)}
                  >
                    试听
                  </Button>
                </Tooltip>
                <Tooltip title="重命名">
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => { setRenaming(v.id); setRenameValue(v.name); }}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除这个音色？"
                  description="复制的模型文件会一起删除，无法恢复（原目录不受影响）。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void onDelete(v.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>
          ))
        )}
      </div>

      <Modal
        open={Boolean(pack)}
        title={probe?.ok ? '确认导入音色包' : '这个目录不能导入'}
        onCancel={() => setPack(null)}
        footer={
          probe?.ok
            ? [
                <Button key="cancel" onClick={() => setPack(null)}>取消</Button>,
                <Button key="preview" icon={<SoundOutlined />} loading={busy === 'preview'} onClick={() => void onPreview()}>
                  {previewed ? '再听一次' : '试听'}
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={busy === 'import'}
                  disabled={!previewed}
                  onClick={() => void onImport()}
                >
                  保存到音色库
                </Button>,
              ]
            : [<Button key="close" onClick={() => setPack(null)}>知道了</Button>]
        }
        width={560}
      >
        <div className="mi-import-body">
          <div className="mi-caption" style={{ wordBreak: 'break-all' }}>{pack?.dir}</div>

          {probe?.ok ? (
            <>
              <div className="mi-bank-stats">
                <span>模型族 <b>{probe.familyLabel || probe.family}</b></span>
                <span>文件 <b>{probe.fileCount}</b> 个</span>
                <span>体积 <b>{formatSpeechBytes(probe.bytes)}</b></span>
                {probe.numSpeakers > 1 ? <span>说话人 <b>{probe.numSpeakers}</b></span> : null}
                {probe.needsEspeak ? <span>音素数据 <b>借用内置包</b></span> : null}
              </div>

              <div className="mi-import-target">
                <label>名称</label>
                <Input
                  size="small"
                  style={{ width: 220 }}
                  maxLength={24}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="音色名称"
                />
                {probe.numSpeakers > 1 ? (
                  <>
                    <label>说话人编号</label>
                    <InputNumber
                      size="small"
                      min={0}
                      max={probe.numSpeakers - 1}
                      value={sid}
                      onChange={(v) => { setSid(Number(v) || 0); setPreviewed(false); }}
                    />
                  </>
                ) : null}
              </div>

              <div className="mi-import-target">
                <label>许可证</label>
                <Input
                  size="small"
                  style={{ width: 280 }}
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  placeholder="可选，例如 CC-BY-4.0 / 仅个人使用"
                />
              </div>

              <Alert
                type={previewed ? 'success' : 'warning'}
                showIcon
                message={previewed ? '试听已通过，可以保存' : '还没试听：先确认这个包能出声，再保存'}
                description="试听是直接加载你这个目录合成的，不会先复制文件；失败不会留下半份音色。"
              />
            </>
          ) : (
            <>
              <Alert type="error" showIcon message={probe?.reason || '无法识别'} />
              {probe?.missing?.length ? (
                <div className="mi-caption">缺少：{probe.missing.join('、')}</div>
              ) : null}
              {probe?.required?.length ? (
                <div className="mi-caption">该布局需要：{probe.required.join('、')}</div>
              ) : null}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

/** 供页面/设置判断「这个 id 是不是导入音色」 */
export function isImportedVoice(v: CustomVoice): v is ImportedVoice {
  return v.kind === 'imported' && !isClonedVoiceId(v.id);
}
