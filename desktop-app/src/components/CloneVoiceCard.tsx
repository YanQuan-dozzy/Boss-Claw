// 设置页「克隆我的声音」（P4-B）
//
// 三段式：装模型（ZipVoice ~163MB 下载）→ 录 3–10 秒参考音频 → 命名保存。
// 三条约束直接写在界面上（方案 6.5.3）：
//   · 必须勾选授权声明，否则不能保存；
//   · 克隆只用于题干预生成，追问固定回落到内置音色（RTF≈1.0，现场等不起）；
//   · 不承诺「和真人一模一样」，不满意就重录。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Progress, Space, Tag, Tooltip, message } from 'antd';
import {
  AudioOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  SoundOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  CLONE_REFERENCE_TEXT,
  formatSpeechBytes,
  type ClonedVoice,
  type SpeechProgress,
  type SpeechStatus,
} from '@/lib/bossclaw/mockInterviewVoice';
import {
  cancelSpeechInstall,
  createClonedVoice,
  installSpeechPack,
  listClonedVoices,
  playWavBase64,
  previewVoice,
  removeClonedVoice,
  renameClonedVoice,
  stopSpeaking,
} from '@/lib/bossclaw/mockInterviewTts';
import { VoiceRecorder } from '@/lib/bossclaw/mockInterviewRecorder';

const PHASE_LABEL: Record<string, string> = {
  prepare: '准备中…',
  download: '正在下载',
  verify: '校验文件…',
  extract: '正在解压（约 1–2 分钟）…',
  done: '安装完成',
};

/** 录音时长窗口：与主进程校验口径一致 */
const MIN_SEC = 3;
const MAX_SEC = 10;

export default function CloneVoiceCard({
  active,
  status,
  onStatusChange,
}: {
  active: boolean;
  status: SpeechStatus | null;
  onStatusChange: () => void | Promise<void>;
}) {
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<SpeechProgress | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [hasClip, setHasClip] = useState(false);
  const [name, setName] = useState('我的声音');
  const [licenseAck, setLicenseAck] = useState(false);
  const [busy, setBusy] = useState<'' | 'create' | 'preview'>('');
  const [previewing, setPreviewing] = useState('');
  const [renaming, setRenaming] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const clipRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null);
  const timerRef = useRef(0);

  const clone = status?.clone;
  const installed = Boolean(clone?.installed);

  const refreshVoices = useCallback(async () => {
    const r = await listClonedVoices();
    setVoices(r.voices || []);
  }, []);

  useEffect(() => {
    if (active) void refreshVoices();
  }, [active, refreshVoices]);

  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = 0;
  };

  // 切走设置页 / 卸载：麦克风必须关
  useEffect(() => () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopTimer();
  }, []);

  const onInstall = async () => {
    setInstalling(true);
    setProgress({ phase: 'prepare', percent: 0, pack: 'clone' });
    try {
      const r = await installSpeechPack('clone', (p) => setProgress(p));
      if (!r.ok) {
        if (/取消/.test(r.error || '')) message.info('已取消安装');
        else message.error(r.error || '安装失败');
      } else {
        message.success('克隆音色包已安装，现在可以录 3–10 秒创建自己的音色');
      }
    } finally {
      setInstalling(false);
      setProgress(null);
      await onStatusChange();
    }
  };

  const finishRecording = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    stopTimer();
    setRecording(false);
    setLevel(0);
    try {
      const r = await rec.stop();
      clipRef.current = { samples: r.samples, sampleRate: r.sampleRate };
      setHasClip(true);
      const sec = r.samples.length / r.sampleRate;
      if (sec < MIN_SEC) {
        message.warning(`只录到 ${sec.toFixed(1)} 秒，至少需要 ${MIN_SEC} 秒。可以再录一次。`);
      }
    } catch (e) {
      message.error(`录音处理失败：${(e as Error).message}`);
    }
  };

  const startRecording = async () => {
    stopSpeaking();
    try {
      const rec = new VoiceRecorder();
      await rec.start({
        maxSec: MAX_SEC,
        onLevel: setLevel,
        onAutoStop: () => { void finishRecording(); },
      });
      recorderRef.current = rec;
      clipRef.current = null;
      setHasClip(false);
      setRecSec(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => setRecSec(Math.round(rec.elapsedSec)), 200);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const onCancelRecording = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopTimer();
    setRecording(false);
    setLevel(0);
    setRecSec(0);
  };

  const onCreate = async () => {
    const clip = clipRef.current;
    if (!clip) { message.warning('请先录一段 3–10 秒的参考音频'); return; }
    if (!licenseAck) { message.warning('请先确认「这是本人声音，或我已获得授权」'); return; }
    setBusy('create');
    try {
      const b64 = (() => {
        const bytes = new Uint8Array(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength);
        let bin = '';
        const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) {
          bin += String.fromCharCode(...bytes.subarray(i, i + step));
        }
        return btoa(bin);
      })();
      const r = await createClonedVoice({
        name: name.trim() || '我的声音',
        samplesBase64: b64,
        sampleRate: clip.sampleRate,
        refText: CLONE_REFERENCE_TEXT,
        licenseAck,
      });
      if (!r.ok) { message.error(r.error || '创建失败'); return; }
      setHasClip(false);
      clipRef.current = null;
      await refreshVoices();
      if (r.previewOk && r.previewWavBase64) {
        message.success('音色已创建，正在播放试听…');
        await playWavBase64(r.previewWavBase64);
      } else {
        message.warning(`音色已保存，但试听合成失败：${r.previewError || '未知原因'}。可以删掉重录。`);
      }
    } finally {
      setBusy('');
    }
  };

  const onPreview = async (id: string) => {
    setPreviewing(id);
    setBusy('preview');
    try {
      const r = await previewVoice(id, 1);
      if (!r.ok) message.warning(r.error || '试听失败');
    } finally {
      setPreviewing('');
      setBusy('');
    }
  };

  const onDelete = async (id: string) => {
    stopSpeaking();
    const r = await removeClonedVoice(id);
    if (!r.ok) { message.error(r.error || '删除失败'); return; }
    message.success('音色已删除');
    await refreshVoices();
  };

  const onRename = async (id: string) => {
    const next = renameValue.trim();
    if (!next) { message.warning('名称不能为空'); return; }
    const r = await renameClonedVoice(id, next);
    if (!r.ok) { message.error(r.error || '重命名失败'); return; }
    setRenaming('');
    await refreshVoices();
  };

  return (
    <div className="settings-section-card">
      <div className="settings-section-header">
        <div className="settings-section-header__title">
          <div className="section-icon-box">
            <SoundOutlined />
          </div>
          克隆我的声音
        </div>
        {installed ? <Tag color="green">模型已安装</Tag> : <Tag>未安装</Tag>}
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ borderRadius: 8, marginBottom: 12 }}
        message="仅用于本人声音或已获授权的声音；禁止用于冒充他人"
        description="参考音频只存在本机（userData/speech/voices/），不上传、不建声纹库、不分享。克隆音色只用于题干预生成——追问仍用内置音色，否则每句要多等 3–5 秒。克隆与朗读两族模型会同时驻留内存（约 500MB），低配机器可随时删掉克隆包。"
      />

      {!installed && (
        <div className="setting-actions" style={{ marginBottom: 12 }}>
          <Space wrap>
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              loading={installing}
              disabled={installing}
              onClick={() => void onInstall()}
            >
              下载克隆音色包（约 {formatSpeechBytes(clone?.archiveBytes || 163 * 1024 * 1024)}）
            </Button>
            <span className="field-label" style={{ opacity: 0.7 }}>
              解压后约 197MB；不装也能用内置的 8 个音色。
            </span>
            {installing && (
              <Button size="small" icon={<StopOutlined />} onClick={() => void cancelSpeechInstall()}>
                取消
              </Button>
            )}
          </Space>
          {installing && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                {PHASE_LABEL[progress?.phase || 'prepare'] || '安装中…'}
                {progress?.phase === 'download' && progress.total
                  ? `（${formatSpeechBytes(progress.received || 0)} / ${formatSpeechBytes(progress.total)}）`
                  : ''}
                {progress?.file ? ` · ${progress.file}` : ''}
              </div>
              <Progress
                percent={progress?.percent || 0}
                showInfo={false}
                status="active"
                strokeColor="var(--brand)"
              />
            </div>
          )}
        </div>
      )}

      {installed && (
        <div className="mi-clone-box">
          <div className="mi-clone-steps">
            <div className="mi-clone-step">
              <span className="mi-clone-step__no">1</span>
              照着下面这段话读，安静环境下录 {MIN_SEC}–{MAX_SEC} 秒
            </div>
            <div className="mi-clone-ref">{CLONE_REFERENCE_TEXT}</div>
            <div className="mi-clone-record">
              {recording ? (
                <>
                  <Button danger size="small" icon={<StopOutlined />} onClick={() => void finishRecording()}>
                    停止录音（{recSec}s）
                  </Button>
                  <div className="mi-level" aria-hidden>
                    <span style={{ width: `${Math.round(level * 100)}%` }} />
                  </div>
                  <span className="mi-caption">
                    {recSec < MIN_SEC ? `还需至少 ${MIN_SEC - recSec} 秒` : '已够长，可以停止'}
                  </span>
                  <Button size="small" type="link" onClick={onCancelRecording}>取消</Button>
                </>
              ) : (
                <>
                  <Button
                    type={hasClip ? 'default' : 'primary'}
                    size="small"
                    icon={<AudioOutlined />}
                    disabled={busy === 'create'}
                    onClick={() => void startRecording()}
                  >
                    {hasClip ? `重新录制（已录 ${clipRef.current ? (clipRef.current.samples.length / clipRef.current.sampleRate).toFixed(1) : 0}s）` : '开始录音'}
                  </Button>
                  {hasClip ? <Tag color="green">已录制</Tag> : null}
                  <span className="mi-caption">录音只在本机处理，创建后参考片段保存在本机</span>
                </>
              )}
            </div>
          </div>

          <div className="mi-clone-steps">
            <div className="mi-clone-step">
              <span className="mi-clone-step__no">2</span>
              命名并确认授权
            </div>
            <Space wrap style={{ marginTop: 6 }}>
              <Input
                size="small"
                style={{ width: 180 }}
                value={name}
                maxLength={24}
                onChange={(e) => setName(e.target.value)}
                placeholder="音色名称"
              />
              <Checkbox checked={licenseAck} onChange={(e) => setLicenseAck(e.target.checked)}>
                这是本人声音，或我已获得授权
              </Checkbox>
              <Button
                type="primary"
                size="small"
                loading={busy === 'create'}
                disabled={!hasClip || !licenseAck || recording}
                onClick={() => void onCreate()}
              >
                创建并试听
              </Button>
            </Space>
            <div className="mi-caption" style={{ marginTop: 6 }}>
              创建后会立刻用克隆声合成一句试听；如果声音不像或没声音，删掉重录即可（不承诺与真人完全一致）。
            </div>
          </div>

          <div className="mi-clone-list">
            <div className="mi-rail-label">我的克隆音色（{voices.length}）</div>
            {voices.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有克隆音色" />
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
                        <div className="mi-clone-item__name">{v.name}</div>
                        <div className="mi-clone-item__meta">
                          {v.durationSec?.toFixed(1)}s · {formatSpeechBytes(v.bytes || 0)} ·{' '}
                          {new Date(v.createdAt).toLocaleDateString()}
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
                        onClick={() => void onPreview(v.id)}
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
                      description="参考音频会一起删除，无法恢复。"
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
        </div>
      )}
    </div>
  );
}
