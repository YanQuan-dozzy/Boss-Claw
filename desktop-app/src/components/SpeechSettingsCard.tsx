// 设置页「语音」分区：本地语音包安装状态、下载进度、8 个精选音色试听、缓存清理。
//
// 这一块刻意独立成组件：设置页已经有 6 个分区、体量很大，语音只依赖 3 个 IPC，
// 单独放可以让「是否安装 / 装到哪 / 占了多大」这三件事在一屏内说清楚。
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Popconfirm, Progress, Space, Switch, Tag, message } from 'antd';
import { AudioOutlined, CloudDownloadOutlined, DeleteOutlined, SoundOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  MOCK_SPEECH_RATES,
  MOCK_VOICES,
  formatSpeechBytes,
  type SpeechProgress,
  type SpeechStatus,
} from '@/lib/bossclaw/mockInterviewVoice';
import {
  cancelSpeechInstall,
  clearSpeechCache,
  getSpeechStatus,
  installSpeechPack,
  previewVoice,
  removeSpeechPack,
  setOnlineEngine,
  stopSpeaking,
} from '@/lib/bossclaw/mockInterviewTts';
import CloneVoiceCard from './CloneVoiceCard';
import VoicePackCard from './VoicePackCard';

const PHASE_LABEL: Record<string, string> = {
  prepare: '准备中…',
  download: '正在下载语音包',
  verify: '校验文件…',
  extract: '正在解压（约 1–2 分钟）…',
  done: '安装完成',
};

export default function SpeechSettingsCard({ active }: { active: boolean }) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<'' | 'tts' | 'asr'>('');
  const [progress, setProgress] = useState<SpeechProgress | null>(null);
  const [previewing, setPreviewing] = useState<string>('');
  const [error, setError] = useState('');
  const [rate, setRate] = useState(1);
  const [onlineSaving, setOnlineSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSpeechStatus();
      setStatus(r);
      if (!r.ok && r.error) setError(r.error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const onInstall = async (pack: 'tts' | 'asr') => {
    setInstalling(pack);
    setError('');
    setProgress({ phase: 'prepare', percent: 0, pack });
    try {
      const r = await installSpeechPack(pack, (p) => setProgress(p));
      if (!r.ok) {
        // 取消不是错误：不往页面顶部挂红色告警
        if (/取消/.test(r.error || '')) {
          message.info('已取消安装');
        } else {
          setError(r.error || '安装失败');
          message.error(r.error || '安装失败');
        }
      } else {
        message.success(pack === 'asr' ? '语音识别包已安装，可以语音作答了' : '语音包已安装，可以朗读题干与追问了');
      }
    } finally {
      setInstalling('');
      setProgress(null);
      await refresh();
    }
  };

  const onCancel = async () => {
    await cancelSpeechInstall();
    message.info('已取消安装');
  };

  const onRemove = async (pack: 'tts' | 'asr') => {
    stopSpeaking();
    const r = await removeSpeechPack(pack);
    if (!r.ok) { message.error(r.error || '删除失败'); return; }
    message.success(pack === 'asr' ? '语音识别包已删除（语音作答会重新引导安装）' : '语音包已删除（下次朗读会重新引导安装）');
    await refresh();
  };

  const onClearCache = async () => {
    const r = await clearSpeechCache();
    if (!r.ok) { message.error(r.error || '清理失败'); return; }
    message.success(`已清理朗读缓存${r.freedBytes ? `（${formatSpeechBytes(r.freedBytes)}）` : ''}`);
    await refresh();
  };

  const applyOnline = async (on: boolean) => {
    setOnlineSaving(true);
    try {
      const r = await setOnlineEngine(on);
      if (!r.ok) { message.error(r.error || '设置失败'); return; }
      message.success(on ? '已开启在线高音质（失败会自动回落本地）' : '已切回本地语音');
      await refresh();
    } finally {
      setOnlineSaving(false);
    }
  };

  // 开启前必须显式告知"文本会发到微软"：这是本地优先定位下唯一允许的联网例外（方案 6.6）
  const onToggleOnline = (next: boolean) => {
    if (!next) { void applyOnline(false); return; }
    Modal.confirm({
      title: '开启在线高音质？',
      okText: '开启',
      cancelText: '取消',
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <p style={{ marginTop: 0 }}>
            朗读文本（<b>含岗位名、公司名与题干内容</b>）会发送到微软的神经语音接口合成。这是本功能唯一一次联网。
          </p>
          <p style={{ marginBottom: 0 }}>
            关闭后立即回到本地合成；接口失效或断网时会自动回落本地，不打断面试。
          </p>
        </div>
      ),
      onOk: () => applyOnline(true),
    });
  };

  const onPreview = async (voiceId: string) => {
    setPreviewing(voiceId);
    try {
      // 试听与正式朗读走同一个引擎：开着在线档却试听到本地音，会让人以为切换没生效
      const r = await previewVoice(voiceId, rate, status?.onlineEngine === true);
      if (!r.ok) message.warning(r.error || '试听失败');
    } finally {
      setPreviewing('');
    }
  };

  const tts = status?.tts;
  const asr = status?.asr;
  const online = status?.onlineEngine === true;
  const installed = Boolean(tts?.installed);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="settings-section-card">
        <div className="settings-section-header">
          <div className="settings-section-header__title">
            <div className="section-icon-box">
              <AudioOutlined />
            </div>
            本地语音（朗读题干与追问）
          </div>
          {installed ? <Tag color="green">已安装</Tag> : <Tag>未安装</Tag>}
        </div>

        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 8, marginBottom: 12 }}
          message="语音完全在本机合成，不上传题干或公司信息"
          description="运行时是 sherpa-onnx + Kokoro 多语言模型。语音包不进安装包，首次使用时下载；报告不朗读，只朗读开场、题干、追问与收尾。"
        />

        {!installed && !installing && (
          <div className="setting-actions">
            <Space wrap>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={loading}
                disabled={installing !== ''}
                onClick={() => void onInstall('tts')}
              >
                下载语音包（约 {formatSpeechBytes(tts?.archiveBytes || 348 * 1024 * 1024)}）
              </Button>
              <span className="field-label" style={{ opacity: 0.7 }}>
                解压后约 430MB；国内网络较慢时可先跳过，面试仍可用纯文字。
              </span>
            </Space>
          </div>
        )}

        {installing === 'tts' && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>
                {PHASE_LABEL[progress?.phase || 'prepare'] || '安装中…'}
                {progress?.phase === 'download' && progress.total
                  ? `（${formatSpeechBytes(progress.received || 0)} / ${formatSpeechBytes(progress.total)}）`
                  : ''}
              </span>
              <Space size={8}>
                {progress?.phase === 'download' && <span style={{ fontSize: 12 }}>{progress.percent}%</span>}
                <Button size="small" icon={<StopOutlined />} onClick={() => void onCancel()}>取消</Button>
              </Space>
            </div>
            <Progress
              percent={progress?.phase === 'download' ? progress.percent : 100}
              status={progress?.phase === 'download' ? 'active' : 'normal'}
              showInfo={false}
              strokeColor="var(--brand)"
            />
          </div>
        )}

        {installed && tts && (
          <>
            <div className="settings-grid" style={{ marginBottom: 12 }}>
              <div className="sg-item">
                <span className="field-label">语音包</span>
                <div style={{ fontSize: 13 }}>{tts.name}</div>
              </div>
              <div className="sg-item">
                <span className="field-label">占用</span>
                <div style={{ fontSize: 13 }}>{formatSpeechBytes(tts.bytes)}（缓存 {formatSpeechBytes(tts.cacheBytes)}）</div>
              </div>
              <div className="sg-item">
                <span className="field-label">安装位置</span>
                <div style={{ fontSize: 12, wordBreak: 'break-all', opacity: 0.8 }}>{tts.dir}</div>
              </div>
            </div>
            <div className="setting-actions">
              <Space wrap>
                <Button icon={<AudioOutlined />} onClick={() => void onPreview('zf_001')}>试听默认音色</Button>
                <Button onClick={() => void onClearCache()}>清理朗读缓存</Button>
                <Popconfirm
                  title="删除语音包？"
                  description="题干朗读会不可用，需要重新下载（约 348MB）。面试记录与题库不受影响。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void onRemove('tts')}
                >
                  <Button danger icon={<DeleteOutlined />}>删除语音包</Button>
                </Popconfirm>
              </Space>
            </div>
          </>
        )}

        {error ? (
          <Alert type="error" showIcon style={{ marginTop: 12, borderRadius: 8 }} message={error} />
        ) : null}
      </div>

      <div className="settings-section-card">
        <div className="settings-section-header">
          <div className="settings-section-header__title">
            <div className="section-icon-box">
              <ThunderboltOutlined />
            </div>
            在线高音质（实验）
          </div>
          <Space size={8}>
            <Tag color={online ? 'gold' : undefined}>{online ? '已开启' : '默认关闭'}</Tag>
            <Switch size="small" checked={online} loading={onlineSaving} onChange={onToggleOnline} />
          </Space>
        </div>

        <Alert
          type="warning"
          showIcon
          style={{ borderRadius: 8, marginBottom: 12 }}
          message="开启后朗读文本会发送到微软的语音接口"
          description="这是本项目「本地优先」定位下唯一允许的联网例外，且必须由你主动开启。它不是官方接口，鉴权或返回结构随时可能变；任何失败都会静默回落本地 Kokoro，只影响这一句，不影响面试本身。"
        />

        <div style={{ fontSize: 12, opacity: 0.65 }}>
          在线档只服务内置的 8 个精选音色；克隆与导入的音色仍走本地模型。音色与语速沿用上面的设置，缓存与播放队列共用。
        </div>
      </div>

      <div className="settings-section-card">
        <div className="settings-section-header">
          <div className="settings-section-header__title">
            <div className="section-icon-box">
              <AudioOutlined />
            </div>
            语音识别（语音作答）
          </div>
          {asr?.installed ? <Tag color="green">已安装</Tag> : <Tag>未安装</Tag>}
        </div>

        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 8, marginBottom: 12 }}
          message="录音只在本机转写，不上传音频"
          description="运行时是 sherpa-onnx + SenseVoice（中/英/日/韩/粤，自带标点）。转写结果会填进作答框，可修改后再提交；语速 / 长停顿 / 口头禅由本地 VAD 与文本计算，不参与内容分。"
        />

        {!asr?.installed && installing !== 'asr' && (
          <div className="setting-actions">
            <Space wrap>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={loading}
                disabled={installing !== ''}
                onClick={() => void onInstall('asr')}
              >
                下载识别包（约 {formatSpeechBytes(asr?.archiveBytes || 228 * 1024 * 1024)}）
              </Button>
              <span className="field-label" style={{ opacity: 0.7 }}>
                解压后约 229MB；不装也能用文字作答。
              </span>
            </Space>
          </div>
        )}

        {installing === 'asr' && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>
                {PHASE_LABEL[progress?.phase || 'prepare'] || '安装中…'}
                {progress?.phase === 'download' && progress.total
                  ? `（${formatSpeechBytes(progress.received || 0)} / ${formatSpeechBytes(progress.total)}）`
                  : ''}
                {progress?.file ? ` · ${progress.file}` : ''}
              </span>
              <Space size={8}>
                {progress?.phase === 'download' && <span style={{ fontSize: 12 }}>{progress.percent}%</span>}
                <Button size="small" icon={<StopOutlined />} onClick={() => void onCancel()}>取消</Button>
              </Space>
            </div>
            <Progress
              percent={progress?.phase === 'download' ? progress.percent : 100}
              status={progress?.phase === 'download' ? 'active' : 'normal'}
              showInfo={false}
              strokeColor="var(--brand)"
            />
          </div>
        )}

        {asr?.installed && (
          <>
            <div className="settings-grid" style={{ marginBottom: 12 }}>
              <div className="sg-item">
                <span className="field-label">识别包</span>
                <div style={{ fontSize: 13 }}>{asr.name}</div>
              </div>
              <div className="sg-item">
                <span className="field-label">占用</span>
                <div style={{ fontSize: 13 }}>{formatSpeechBytes(asr.bytes)}</div>
              </div>
              <div className="sg-item">
                <span className="field-label">安装位置</span>
                <div style={{ fontSize: 12, wordBreak: 'break-all', opacity: 0.8 }}>{asr.dir}</div>
              </div>
            </div>
            <div className="setting-actions">
              <Popconfirm
                title="删除语音识别包？"
                description="语音作答会不可用（文字作答不受影响），需要重新下载约 228MB。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void onRemove('asr')}
              >
                <Button danger icon={<DeleteOutlined />}>删除识别包</Button>
              </Popconfirm>
            </div>
          </>
        )}
      </div>

      <CloneVoiceCard active={active} status={status} onStatusChange={refresh} />

      <VoicePackCard active={active} />

      <div className="settings-section-card">
        <div className="settings-section-header">
          <div className="settings-section-header__title">
            <div className="section-icon-box">
              <SoundOutlined />
            </div>
            面试官音色（8 个精选）
          </div>
          <Space size={6}>
            {MOCK_SPEECH_RATES.map((r) => (
              <Tag
                key={r}
                color={rate === r ? 'blue' : undefined}
                style={{ cursor: 'pointer', margin: 0 }}
                onClick={() => setRate(r)}
              >
                {r.toFixed(1)}×
              </Tag>
            ))}
          </Space>
        </div>
        <div className="mi-voice-grid">
          {MOCK_VOICES.map((v) => (
            <div className="mi-voice-item" key={v.id}>
              <div>
                <div className="mi-voice-name">{v.name}</div>
                <div className="mi-voice-meta">{v.gender === 'female' ? '女声' : '男声'} · {v.style} · {v.id}</div>
              </div>
              <Button
                size="small"
                type="text"
                loading={previewing === v.id}
                disabled={!installed}
                onClick={() => void onPreview(v.id)}
              >
                试听
              </Button>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
          音色全局生效，<b>会话内不可切换</b>（下一场生效）：一场面试的面试官不该中途换嗓子，锁定音色也能让题干预渲染全部命中缓存。
        </div>
      </div>
    </div>
  );
}
