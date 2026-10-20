// 模拟面试页（P1 文字骨架）
//
// 页面结构 = 三栏：
//   ① 全局模块切换栏 —— App.tsx 的 <Sidebar/>（不归本页管）
//   ② 面试功能栏（272px）—— Tab[面试/题库] + 新建 + 历史会话 + 目录占用 + 导出
//   ③ 主工作区（flex:1）—— 配置 / 进行 / 反问 / 报告 / 题库 五态
// 根节点 absolute inset:0 铺满 .main-stage（跳过其 24px padding）；两栏各自 overflow-y:auto。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BulbOutlined,
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SoundOutlined,
  AudioOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useMockInterviewStore, type MockInterviewTab } from '@/store/useMockInterviewStore';
import type {
  MockDimensionResult,
  MockInterviewRole,
  MockDifficulty,
  MockQuestion,
  MockSession,
} from '@/lib/bossclaw/mockInterviewTypes';
import {
  MOCK_CATEGORY_LABELS,
  MOCK_DIFFICULTY_LABELS,
  MOCK_EVIDENCE_LABELS,
  MOCK_ROLE_LABELS,
  MOCK_STATUS_LABELS,
} from '@/lib/bossclaw/mockInterviewTypes';
import {
  dimensionTone,
  latestAttempt,
  probeCount,
  questionProgress,
} from '@/lib/bossclaw/mockInterviewEngine';
import {
  MOCK_SPEECH_RATES,
  MOCK_VOICES,
  findVoice,
  isClonedVoiceId,
  isCustomVoiceId,
  type CustomVoice,
  type SpeechStatus,
} from '@/lib/bossclaw/mockInterviewVoice';
import {
  getSpeechStatus,
  isSpeaking,
  listCustomVoices,
  prefetchTts,
  previewVoice,
  speak,
  stopSpeaking,
} from '@/lib/bossclaw/mockInterviewTts';
import { VoiceRecorder } from '@/lib/bossclaw/mockInterviewRecorder';
import { transcribeRecording, warmupAsr } from '@/lib/bossclaw/mockInterviewAsr';
import { paceLabel, type DeliveryMetrics } from '@/lib/bossclaw/mockInterviewDelivery';
import MockBankPanel, { MockBankRail } from '@/components/MockBankPanel';
import { useBankStore } from '@/store/useBankStore';
import { formatBytes } from '@/lib/bossclaw/mockInterviewRepo';

const { Text } = Typography;

function fmtDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toneColor(score: number | null): string {
  const tone = dimensionTone(score);
  if (tone === 'ok') return 'var(--status-success)';
  if (tone === 'warn') return 'var(--status-warning)';
  if (tone === 'bad') return 'var(--status-danger)';
  return 'var(--fg-subtle)';
}

function bandColor(key: string | null | undefined): string {
  if (key === 'strong') return 'green';
  if (key === 'effective') return 'blue';
  if (key === 'improve') return 'orange';
  return 'default';
}

export default function MockInterview({ isVisible = false }: { isVisible?: boolean }) {
  const session = useMockInterviewStore((s) => s.session);
  const list = useMockInterviewStore((s) => s.list);
  const usage = useMockInterviewStore((s) => s.usage);
  const tab = useMockInterviewStore((s) => s.tab);
  const busy = useMockInterviewStore((s) => s.busy);
  const error = useMockInterviewStore((s) => s.error);
  const notice = useMockInterviewStore((s) => s.notice);
  const rewrites = useMockInterviewStore((s) => s.rewrites);

  const setTab = useMockInterviewStore((s) => s.setTab);
  const clearError = useMockInterviewStore((s) => s.clearError);
  const clearNotice = useMockInterviewStore((s) => s.clearNotice);
  const refreshList = useMockInterviewStore((s) => s.refreshList);
  const refreshUsage = useMockInterviewStore((s) => s.refreshUsage);
  const newDraft = useMockInterviewStore((s) => s.newDraft);
  const openSession = useMockInterviewStore((s) => s.openSession);
  const removeSession = useMockInterviewStore((s) => s.removeSession);
  const exportAll = useMockInterviewStore((s) => s.exportAll);
  const clearAllSessions = useMockInterviewStore((s) => s.clearAllSessions);

  const updateJob = useMockInterviewStore((s) => s.updateJob);
  const updateConfig = useMockInterviewStore((s) => s.updateConfig);
  const startInterview = useMockInterviewStore((s) => s.startInterview);
  const beginAnswering = useMockInterviewStore((s) => s.beginAnswering);
  const goReverse = useMockInterviewStore((s) => s.goReverse);
  const submitAnswer = useMockInterviewStore((s) => s.submitAnswer);
  const skipQuestion = useMockInterviewStore((s) => s.skipQuestion);
  const submitReverse = useMockInterviewStore((s) => s.submitReverse);
  const finishInterview = useMockInterviewStore((s) => s.finishInterview);
  const retryQuestion = useMockInterviewStore((s) => s.retryQuestion);
  const rewriteCurrent = useMockInterviewStore((s) => s.rewriteCurrent);

  const pending = useAppStore((s) => s.pendingMockInterview);
  const clearMockInterview = useAppStore((s) => s.clearMockInterview);
  const openSettings = useAppStore((s) => s.openSettings);
  const resumeText = useDataStore((s) => s.resumeText);
  const apiKey = useSettingsStore((s) => s.config.model.apiKey);

  // 题库摘要：配置页要能一眼看出「这场有没有题库参与、有多少题可用」
  const bankList = useBankStore((s) => s.banks);
  const bankIndex = useBankStore((s) => s.indexInfo);
  const bankSummary = useMemo(() => {
    const enabled = bankList.filter((b) => b.enabled);
    const total = enabled.reduce((n, b) => n + Number(b.count || 0), 0);
    if (!enabled.length) return '没有启用的题库';
    return `${enabled.length} 个题库 · ${total} 题${bankIndex.count ? `（索引 ${bankIndex.count}）` : '（发起时建索引）'}`;
  }, [bankList, bankIndex.count]);

  // ===== 本地交互态 =====
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [jdDraft, setJdDraft] = useState('');
  const [answer, setAnswer] = useState('');
  const [reverseInput, setReverseInput] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [customVoices, setCustomVoices] = useState<CustomVoice[]>([]);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recLevel, setRecLevel] = useState(0);
  const [recSec, setRecSec] = useState(0);
  const [voiceMetrics, setVoiceMetrics] = useState<DeliveryMetrics | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recTimerRef = useRef<number>(0);
  const prefetchedRef = useRef<Set<string>>(new Set());
  const startRef = useRef<number>(Date.now());

  const hasKey = Boolean(String(apiKey || '').trim());
  const speechReady = Boolean(speech?.tts?.installed);
  const cloneReady = Boolean(speech?.clone?.installed);
  const asrReady = Boolean(speech?.asr?.installed);
  // 在线高音质档（设置 → 语音）：只对内置音色生效，自定义音色由 speech 模块自动留在本地
  const onlineSpeech = speech?.onlineEngine === true;
  const voiceMode = session?.config.answerMode === 'voice';
  const activeQuestionId = session?.retry?.questionId || session?.currentQuestionId || null;
  const currentQuestion = useMemo(
    () => (session && activeQuestionId ? session.questions.find((q) => q.id === activeQuestionId) || null : null),
    [session, activeQuestionId],
  );

  // ===== 提示 / 报错 =====
  useEffect(() => {
    if (error) { message.error({ content: error, key: 'mi-error' }); clearError(); }
  }, [error, clearError]);
  useEffect(() => {
    if (notice) { message.success({ content: notice, key: 'mi-notice' }); clearNotice(); }
  }, [notice, clearNotice]);

  // ===== 首次进入：加载列表；没有当前会话时落在最近一场（优先未完成） =====
  useEffect(() => {
    if (!isVisible) return;
    void (async () => {
      await refreshList();
      await refreshUsage();
      if (!useMockInterviewStore.getState().session) {
        const items = useMockInterviewStore.getState().list;
        const unfinished = items.find((x) => x.status === 'running' || x.status === 'planning' || x.status === 'ready' || x.status === 'reverse');
        const target = unfinished || items[0];
        if (target) await openSession(target.id);
      }
    })();
  }, [isVisible, refreshList, refreshUsage, openSession]);

  // 题库注册表：配置页要显示「多少个题库可用」，不能等用户点开题库 Tab 才加载
  useEffect(() => {
    if (!isVisible) return;
    void useBankStore.getState().refreshBanks();
  }, [isVisible]);

  // 语音包状态：只在页面可见时探测（安装发生在设置页，切回来要刷新）
  useEffect(() => {
    if (!isVisible) return;
    void getSpeechStatus().then((r) => setSpeech(r));
    void listCustomVoices().then((r) => setCustomVoices(r.voices || []));
  }, [isVisible]);

  // 进入语音作答且识别包已装：后台预热模型（首次加载约 1.3s，不该让用户等）
  useEffect(() => {
    if (!isVisible || !asrReady || !voiceMode) return;
    void warmupAsr();
  }, [isVisible, asrReady, voiceMode]);

  // 切题 / 切追问时：正在录的音作废（不能把上一题的录音提交到这一题）
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      if (recTimerRef.current) window.clearInterval(recTimerRef.current);
      recTimerRef.current = 0;
    };
  }, [activeQuestionId, session?.pendingProbe?.askedAt]);

  // 切到别的页面也要停：页面只是切路由，组件并没有卸载
  useEffect(() => {
    if (isVisible || !recorderRef.current) return;
    recorderRef.current.cancel();
    recorderRef.current = null;
    setRecording(false);
    setRecLevel(0);
    stopRecTimer();
  }, [isVisible]);

  // 离开进行态（结束/生成报告）或组件卸载：录音必须停，否则麦克风一直开着
  useEffect(() => {
    if (!session || session.status === 'running') return;
    if (recorderRef.current) {
      recorderRef.current.cancel();
      recorderRef.current = null;
      setRecording(false);
      setRecLevel(0);
      stopRecTimer();
    }
  }, [session?.status]);

  useEffect(() => () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
  }, []);

  useEffect(() => {
    setVoiceMetrics(null);
    setRecSec(0);
    if (session?.config.answerMode !== 'voice') {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
    }
  }, [activeQuestionId, session?.config.answerMode]);

  const probeAskedAt = session?.pendingProbe?.askedAt || 0;

  // 会话里锁定的克隆音色被删掉时，静默回落到默认内置音色。
  // 不回落的话，这道题会一直合成失败，用户只看到「朗读没声音」。
  useEffect(() => {
    const id = session?.config.voiceId;
    if (!session || !isCustomVoiceId(id) || !customVoices.length) return;
    if (customVoices.some((v) => v.id === id)) return;
    updateConfig({ voiceId: MOCK_VOICES[0].id });
    message.info('这场面试用的克隆音色已被删除，已回落到默认内置音色');
  }, [session?.config.voiceId, customVoices, updateConfig]);

  /**
   * 追问音色：克隆音色 RTF≈1.0，一句 20 字要等 3–5s，追问现场等不起。
   * 所以克隆只用于题干（预生成），追问固定回落到默认内置音色——这是方案 6.5.3 的取舍，
   * UI 上要明确说明，否则用户会以为「怎么声音变了」。
   */
  const voiceFor = (isProbe: boolean) => {
    const id = session?.config.voiceId;
    if (!isClonedVoiceId(id)) return id;
    return isProbe ? MOCK_VOICES[0].id : id;
  };

  // 题干预渲染：计划生成后把还没合成过的题干逐条合成进主进程缓存（不播放）。
  // 首次朗读要 3–5s，用户点「下一题」时命中缓存则为 0 耗时。
  useEffect(() => {
    if (!speechReady || !session) return;
    if (session.status !== 'ready' && session.status !== 'running') return;
    const voiceId = session.config.voiceId;
    const speed = session.config.speechRate;
    // 键带 voiceId 与引擎：换音色/切在线档后旧缓存命不中，必须重新预渲染（否则新音色永远没人合成）
    const engineKey = onlineSpeech ? 'on' : 'off';
    const mark = (qid: string) => `${qid}|${voiceId}|${engineKey}`;
    const todo = session.questions.filter((q) => !prefetchedRef.current.has(mark(q.id)));
    if (!todo.length) return;
    let cancelled = false;
    void (async () => {
      for (const q of todo) {
        if (cancelled) return;
        prefetchedRef.current.add(mark(q.id));
        await prefetchTts(q.text, { voiceId, speed, online: onlineSpeech });
      }
    })();
    return () => { cancelled = true; };
  }, [speechReady, onlineSpeech, session?.status, session?.questions.length, session?.config.voiceId, session?.config.speechRate]);

  // 自动朗读：进入一道新题 / 追问时朗读；离开进行态立即停（朗读与作答硬互斥）
  useEffect(() => {
    if (!isVisible || !speechReady || !session) return;
    if (session.status === 'running') {
      const isProbe = Boolean(session.pendingProbe?.question);
      const text = session.pendingProbe?.question || currentQuestion?.text;
      if (text) {
        setTtsBusy(true);
        void speak(text, { voiceId: voiceFor(isProbe), speed: session.config.speechRate, online: onlineSpeech })
          .then((r) => {
            // 克隆合成失败（参考音频过短/静音）要能看见原因，而不是静默无声
            if (!r.ok && isClonedVoiceId(session.config.voiceId) && !isProbe) {
              message.warning(r.error || '克隆音色合成失败，可在设置 → 语音重新录制');
            }
          })
          .finally(() => setTtsBusy(false));
      }
      return () => stopSpeaking();
    }
    if (session.status === 'reverse' && !session.reverse) {
      setTtsBusy(true);
      void speak('我的问题问完了，你有什么想问我的吗？', {
        voiceId: session.config.voiceId,
        speed: session.config.speechRate,
        online: onlineSpeech,
      }).finally(() => setTtsBusy(false));
      return () => stopSpeaking();
    }
    return undefined;
  }, [isVisible, speechReady, session?.status, activeQuestionId, probeAskedAt, onlineSpeech]);

  // ===== 工作台「面试」入口：带入岗位并新建草稿（旧会话仍在历史里，不删除） =====
  useEffect(() => {
    if (!isVisible || !pending) return;
    newDraft({
      jobId: pending.jobId,
      jobTitle: pending.jobTitle,
      company: pending.company,
      jdText: pending.jdText,
    });
    setTab('interview');
    clearMockInterview();
  }, [isVisible, pending, newDraft, setTab, clearMockInterview]);

  // 配置态输入框与会话同步（只在会话切换/外部带入时重置，不干扰输入）
  useEffect(() => {
    setJobTitle(session?.job.jobTitle || '');
    setCompany(session?.job.company || '');
    setJdDraft(session?.job.jdText || '');
  }, [session?.id, session?.job.jobTitle, session?.job.company, session?.job.jdText]);

  // 切题 / 切到追问时重置草稿与计时
  useEffect(() => {
    setAnswer('');
    startRef.current = Date.now();
    setElapsed(0);
  }, [activeQuestionId, probeAskedAt]);

  useEffect(() => {
    if (!session || (session.status !== 'running' && session.status !== 'ready')) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [session, activeQuestionId, probeAskedAt]);

  const readCurrent = useCallback(() => {
    if (!session || !currentQuestion) return;
    const isProbe = Boolean(session.pendingProbe?.question);
    const text = session.pendingProbe?.question || currentQuestion.text;
    setTtsBusy(true);
    void speak(text, {
      voiceId: isClonedVoiceId(session.config.voiceId) && isProbe
        ? MOCK_VOICES[0].id
        : session.config.voiceId,
      speed: session.config.speechRate,
      online: onlineSpeech,
    })
      .then((r) => { if (!r.ok && r.error) message.warning(r.error); })
      .finally(() => setTtsBusy(false));
  }, [session, currentQuestion, onlineSpeech]);

  const onCreate = useCallback(() => {
    newDraft({ jobTitle: '', company: '', jdText: '' });
  }, [newDraft]);

  const onSubmit = async () => {
    if (recording) { message.warning('还在录音，先「停止并转写」再提交'); return; }
    if (!answer.trim()) { message.warning('先写点什么，或点「跳过这题」'); return; }
    stopSpeaking();
    const text = answer;
    const metrics = voiceMetrics || undefined;
    setAnswer('');
    setVoiceMetrics(null);
    await submitAnswer(text, Date.now() - startRef.current, metrics);
  };

  // ===== 语音作答（P4）=====
  const stopRecTimer = () => {
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
    recTimerRef.current = 0;
  };

  const finishRecording = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    // 先摘掉引用，避免 autoStop 与手点重复进入
    recorderRef.current = null;
    stopRecTimer();
    setRecording(false);
    setRecLevel(0);
    setTranscribing(true);
    try {
      const result = await rec.stop();
      const r = await transcribeRecording(result);
      if (!r.ok) {
        message.warning(r.error || '转写失败');
        return;
      }
      setAnswer((prev) => (prev.trim() ? `${prev.trim()}\n${r.text}` : r.text));
      setVoiceMetrics(r.metrics);
      message.success(`转写完成（${((r.ms || 0) / 1000).toFixed(1)}s）：可直接修改后提交`);
    } catch (e) {
      message.error(`录音处理失败：${(e as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!asrReady) {
      message.warning('语音作答需要先安装「语音识别包」（设置 → 语音）');
      return;
    }
    if (!voiceMode) return;
    // 硬互斥：录音前必须停掉面试官的朗读，否则转写里会混进扬声器回声
    stopSpeaking();
    try {
      const rec = new VoiceRecorder();
      await rec.start({
        maxSec: 180,
        onLevel: setRecLevel,
        onAutoStop: () => { void finishRecording(); },
      });
      recorderRef.current = rec;
      setVoiceMetrics(null);
      setRecSec(0);
      setRecording(true);
      recTimerRef.current = window.setInterval(() => setRecSec(Math.round(rec.elapsedSec)), 500);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const toggleRecording = () => {
    if (recording) void finishRecording();
    else void startRecording();
  };

  // ===== 栏 ② =====
  const renderRail = () => {
    const running = session && (session.status === 'running' || session.status === 'ready' || session.status === 'planning');
    const prog = session ? questionProgress(session) : { answered: 0, total: 0, index: -1 };
    return (
      <aside className="mi-rail">
        <div className="mi-rail-head">
          <Segmented
            block
            size="small"
            value={tab}
            onChange={(v) => setTab(v as MockInterviewTab)}
            options={[{ label: '面试', value: 'interview' }, { label: '题库', value: 'bank' }]}
          />
          <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate}>新建面试</Button>
        </div>

        {running && session && (
          <div className="mi-progress-block">
            <div className="mi-progress-title">
              <span>本场进度</span>
              <Text type="secondary" style={{ fontSize: 12 }}>{prog.answered}/{prog.total}</Text>
            </div>
            <div className="mi-dots">
              {session.questions.map((q, i) => {
                const att = latestAttempt(session, q.id);
                const state = att ? (att.skipped ? 'skip' : 'done') : q.id === session.currentQuestionId ? 'current' : 'todo';
                return (
                  <Tooltip key={q.id} title={`第 ${i + 1} 题${q.kind === 'injected' ? '（临时追加）' : ''}`}>
                    <span className={`mi-dot mi-dot--${state}`} />
                  </Tooltip>
                );
              })}
            </div>
            <Button size="small" block onClick={() => { stopSpeaking(); void goReverse(); }}>结束面试</Button>
          </div>
        )}

        {tab === 'bank' ? <MockBankRail active={isVisible && tab === 'bank'} /> : (
          <>
        <div className="mi-rail-label">历史会话</div>
        <div className="mi-history">
          {list.length === 0 ? (
            <div className="mi-history-empty">还没有面试记录</div>
          ) : (
            list.map((it) => (
              <div
                key={it.id}
                role="button"
                tabIndex={0}
                className={'mi-history-item' + (session?.id === it.id ? ' is-active' : '')}
                onClick={() => void openSession(it.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') void openSession(it.id); }}
              >
                <div className="mi-history-top">
                  <span className="mi-history-job">{it.jobTitle || '未命名岗位'}</span>
                  {it.score != null ? (
                    <span className="mi-history-score" style={{ color: toneColor(it.score) }}>{it.score}</span>
                  ) : (
                    <span className="mi-history-score mi-history-score--none">—</span>
                  )}
                </div>
                <div className="mi-history-meta">
                  {[it.company, fmtDate(it.startedAt || it.updatedAt), MOCK_STATUS_LABELS[it.status]].filter(Boolean).join(' · ')}
                </div>
                <Popconfirm
                  title="删除这场面试记录？"
                  description="会话文件将被删除，不可恢复。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removeSession(it.id)}
                >
                  <Button
                    size="small"
                    type="text"
                    className="mi-history-del"
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            ))
          )}
        </div>

        <div className="mi-rail-foot">
          <div className="mi-usage">目录占用：{usage.count} 场 · {formatBytes(usage.bytes)}</div>
          <div className="mi-foot-actions">
            <Button size="small" icon={<ExportOutlined />} onClick={() => void exportAll()}>导出记录</Button>
            <Popconfirm
              title="清空全部面试记录？"
              description={`将删除 ${usage.count} 场面试记录。题库与音色不受影响。`}
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void clearAllSessions()}
            >
              <Button size="small" danger>清空</Button>
            </Popconfirm>
          </div>
        </div>
          </>
        )}
      </aside>
    );
  };

  // ===== 配置态 =====
  const renderConfig = (s: MockSession) => {
    const ready = s.status === 'ready' && s.questions.length > 0;
    return (
      <div className="mi-scroll">
        <div className="mi-head">
          <div>
            <h1 className="page-title">模拟面试</h1>
            <Text type="secondary">
              用你正在投的岗位 JD 和自己的简历练一场，结束后拿到逐题评分与可执行的改进建议。
            </Text>
          </div>
        </div>

        {!hasKey && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="模拟面试需要 AI 出题与评分"
            description="本功能不接 agent 代答（一场 11–17 次调用，代答等待不可用）。请先在设置页填写你自己的 API Key。"
            action={<Button size="small" onClick={() => openSettings('llm')}>去设置</Button>}
          />
        )}
        {!resumeText.trim() && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="还没有导入简历"
            description="阶段二深挖题与「证据具体性」评分会参考简历原文。可先去「简历中心」导入，再回来练。"
            action={<Button size="small" onClick={() => useAppStore.getState().setRoute('resume')}>去导入</Button>}
          />
        )}

        <Card size="small" title="岗位与 JD" className="mi-card">
          <div className="mi-form-row">
            <label>岗位名称</label>
            <Input
              value={jobTitle}
              placeholder="如：数据分析师"
              onChange={(e) => setJobTitle(e.target.value)}
              onBlur={() => updateJob({ jobTitle: jobTitle.trim() })}
            />
          </div>
          <div className="mi-form-row">
            <label>公司</label>
            <Input
              value={company}
              placeholder="选填"
              onChange={(e) => setCompany(e.target.value)}
              onBlur={() => updateJob({ company: company.trim() })}
            />
          </div>
          <div className="mi-form-row mi-form-row--top">
            <label>JD 原文</label>
            <Input.TextArea
              value={jdDraft}
              autoSize={{ minRows: 6, maxRows: 14 }}
              placeholder="把岗位描述整段粘贴进来。JD 是出题与「哪条要求没答到」的依据，越完整越好。"
              onChange={(e) => setJdDraft(e.target.value)}
              onBlur={() => updateJob({ jdText: jdDraft })}
            />
          </div>
          <div className="mi-form-hint">
            {jdDraft.trim().length} 字{jdDraft.trim().length > 0 && jdDraft.trim().length < 30 ? '（少于 30 字，无法出针对性题目）' : ''}
          </div>
        </Card>

        <Card size="small" title="本场设置" className="mi-card">
          <div className="mi-form-row">
            <label>面试官</label>
            <Radio.Group
              value={s.config.role}
              onChange={(e) => updateConfig({ role: e.target.value as MockInterviewRole })}
              optionType="button"
              buttonStyle="solid"
              options={(Object.keys(MOCK_ROLE_LABELS) as MockInterviewRole[]).map((k) => ({ label: MOCK_ROLE_LABELS[k], value: k }))}
            />
          </div>
          <div className="mi-form-row">
            <label>难度</label>
            <Radio.Group
              value={s.config.difficulty}
              onChange={(e) => updateConfig({ difficulty: e.target.value as MockDifficulty })}
              optionType="button"
              options={(Object.keys(MOCK_DIFFICULTY_LABELS) as MockDifficulty[]).map((k) => ({ label: MOCK_DIFFICULTY_LABELS[k], value: k }))}
            />
          </div>
          <div className="mi-form-row">
            <label>题量</label>
            <Space>
              <span className="mi-inline-label">阶段一</span>
              <Select
                size="small"
                style={{ width: 96 }}
                value={s.config.phase1Count}
                onChange={(v) => updateConfig({ phase1Count: v })}
                options={[4, 5, 6].map((n) => ({ value: n, label: `${n} 题` }))}
              />
              <span className="mi-inline-label">阶段二</span>
              <Select
                size="small"
                style={{ width: 96 }}
                value={s.config.phase2Count}
                onChange={(v) => updateConfig({ phase2Count: v })}
                options={[3, 4].map((n) => ({ value: n, label: `${n} 题` }))}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>合计 {s.config.phase1Count + s.config.phase2Count} 题（另有最多 2 道临时插题）</Text>
            </Space>
          </div>
          <div className="mi-form-row">
            <label>作答方式</label>
            <Space wrap>
              <Radio.Group
                size="small"
                optionType="button"
                value={s.config.answerMode}
                onChange={(e) => updateConfig({ answerMode: e.target.value })}
                options={[{ label: '文字', value: 'text' }, { label: '语音', value: 'voice' }]}
              />
              {s.config.answerMode === 'voice' ? (
                asrReady ? (
                  <span className="mi-inline-label">说 → 本机转写成文字 → 可修改后提交；录音不上传</span>
                ) : (
                  <Button size="small" type="link" onClick={() => openSettings('speech')}>
                    安装语音识别包（约 228MB）
                  </Button>
                )
              ) : null}
            </Space>
          </div>
          <div className="mi-form-row">
            <label>朗读题干</label>
            <Space wrap>
              <Radio.Group
                size="small"
                value={s.config.readAloud ? 'auto' : 'manual'}
                onChange={(e) => updateConfig({ readAloud: e.target.value === 'auto' })}
                options={[{ label: '自动', value: 'auto' }, { label: '仅手动', value: 'manual' }]}
                optionType="button"
              />
              <Select
                size="small"
                style={{ width: 168 }}
                value={isCustomVoiceId(s.config.voiceId) ? s.config.voiceId : findVoice(s.config.voiceId).id}
                disabled={!speechReady}
                onChange={(v) => updateConfig({ voiceId: v })}
                options={[
                  {
                    label: '内置音色',
                    options: MOCK_VOICES.map((v) => ({ value: v.id, label: `${v.name}（${v.style}）` })),
                  },
                  ...(customVoices.some((v) => v.kind === 'cloned')
                    ? [{
                        label: cloneReady ? '我的克隆音色' : '我的克隆音色（缺模型包）',
                        options: customVoices
                          .filter((v) => v.kind === 'cloned')
                          .map((v) => ({ value: v.id, label: `${v.name}（克隆）`, disabled: !cloneReady })),
                      }]
                    : []),
                  ...(customVoices.some((v) => v.kind === 'imported')
                    ? [{
                        label: '导入的音色',
                        options: customVoices
                          .filter((v) => v.kind === 'imported')
                          .map((v) => ({ value: v.id, label: `${v.name}（导入）` })),
                      }]
                    : []),
                ]}
              />
              <Select
                size="small"
                style={{ width: 88 }}
                value={s.config.speechRate}
                disabled={!speechReady}
                onChange={(v) => updateConfig({ speechRate: v })}
                options={MOCK_SPEECH_RATES.map((r) => ({ value: r, label: `${r.toFixed(1)}×` }))}
              />
              <Button
                size="small"
                icon={<SoundOutlined />}
                disabled={!speechReady}
                onClick={() => void previewVoice(s.config.voiceId, s.config.speechRate, onlineSpeech)}
              >
                试听
              </Button>
              {!speechReady ? (
                <Button size="small" type="link" onClick={() => openSettings('speech')}>
                  安装语音包（约 348MB）
                </Button>
              ) : null}
              {isClonedVoiceId(s.config.voiceId) && !cloneReady ? (
                <Button size="small" type="link" onClick={() => openSettings('speech')}>
                  安装克隆音色包（约 163MB）
                </Button>
              ) : null}
              {isClonedVoiceId(s.config.voiceId) && cloneReady ? (
                <span className="mi-inline-label">
                  克隆声只读题干（后台预生成）；追问自动用内置音色，避免每题多等 3–5 秒
                </span>
              ) : null}
            </Space>
          </div>
          <div className="mi-form-row">
            <label>题库参与</label>
            <Space wrap>
              <Switch
                size="small"
                checked={s.config.bankEnabled}
                onChange={(v) => updateConfig({ bankEnabled: v })}
              />
              <Select
                size="small"
                style={{ width: 96 }}
                disabled={!s.config.bankEnabled}
                value={s.config.recallTopK}
                onChange={(v) => updateConfig({ recallTopK: v })}
                options={[10, 20, 30].map((n) => ({ value: n, label: `召回 ${n} 条` }))}
              />
              {bankSummary ? (
                <span className="mi-inline-label">{bankSummary}</span>
              ) : (
                <span className="mi-inline-label">题库状态读取中…</span>
              )}
              {!s.config.bankEnabled ? (
                <span className="mi-inline-label">已关闭：本场为纯 AI 出题</span>
              ) : null}
            </Space>
          </div>
        </Card>

        {ready ? (
          <Card
            size="small"
            title={`题目已就绪（${s.questions.length} 题）`}
            className="mi-card"
            extra={
              <Space>
                <Button size="small" icon={<ReloadOutlined />} loading={busy === 'phase1' || busy === 'recall'} onClick={() => void startInterview()}>
                  重新出题
                </Button>
                <Button size="small" type="primary" icon={<RocketOutlined />} onClick={beginAnswering}>开始面试</Button>
              </Space>
            }
          >
            <div className="mi-question-preview">
              {s.questions.map((q, i) => (
                <div key={q.id} className="mi-question-preview-item">
                  <span className="mi-q-index">{i + 1}</span>
                  <div>
                    <div>{q.text}</div>
                    {q.jdRef ? <div className="mi-q-jd">对应 JD：{q.jdRef}</div> : null}
                  </div>
                </div>
              ))}
            </div>
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message="答题过程中不显示分数"
              description="每答完一题只记录、不评分；全部结束后一次性给出报告。答完阶段一后会有一段「面试官正在整理你的回答…」的等待，用于生成针对你的深挖题。"
            />
          </Card>
        ) : (
          <div className="mi-actions">
            <Button
              type="primary"
              size="large"
              icon={<RocketOutlined />}
              loading={busy === 'phase1' || busy === 'recall'}
              disabled={!hasKey}
              onClick={() => void startInterview()}
            >
              生成题目
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {busy === 'recall' ? '正在从本地题库召回候选…' : '将调用 AI 1 次生成阶段一题目（约 2–4K token）'}
            </Text>
          </div>
        )}
      </div>
    );
  };

  // ===== 进行态 =====
  const renderAnswer = (s: MockSession, q: MockQuestion) => {
    const idx = s.questions.findIndex((x) => x.id === q.id);
    const att = latestAttempt(s, q.id);
    const probes = probeCount(att);
    const inProbe = Boolean(s.pendingProbe);
    const retrying = Boolean(s.retry);
    return (
      <div className="mi-scroll">
        <div className="mi-running-head">
          <Space size={8} wrap>
            <Tag color={q.phase === 1 ? 'blue' : 'purple'}>阶段{q.phase === 1 ? '一' : '二'}</Tag>
            <Tag>{MOCK_CATEGORY_LABELS[q.category]}</Tag>
            {q.kind === 'injected' ? <Tag color="gold">临时追加</Tag> : null}
            <Text type="secondary" style={{ fontSize: 12 }}>
              第 {idx + 1} / {s.questions.length} 题 · 已用 {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              {ttsBusy ? ' · 面试官正在朗读…' : ''}
            </Text>
          </Space>
          <Space>
            <Tooltip title={speechReady ? '重播这道题' : '语音包未安装，可在设置 → 语音中安装'}>
              <Button size="small" icon={<SoundOutlined />} disabled={!speechReady || recording || transcribing} onClick={readCurrent}>
                朗读
              </Button>
            </Tooltip>
            {speechReady && isSpeaking() ? (
              <Button size="small" onClick={() => stopSpeaking()}>停止</Button>
            ) : null}
            {!retrying && <Button size="small" onClick={() => { stopSpeaking(); void goReverse(); }}>结束面试</Button>}
          </Space>
        </div>

        {retrying ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="重答此题"
            description="提交后只重算这一题的分数，其他题保持不变；旧的一次作答会保留在记录里用于对比。"
          />
        ) : null}

        <Card className="mi-question-card">
          <div className="mi-question-text">{q.text}</div>
          {q.focus.length > 0 && (
            <div className="mi-focus">
              <Text type="secondary" style={{ fontSize: 12 }}>考察点：</Text>
              {q.focus.map((f) => <Tag key={f} bordered={false}>{f}</Tag>)}
            </div>
          )}
          {q.jdRef ? <div className="mi-q-jd">对应 JD：{q.jdRef}</div> : null}
          {q.resumeRef ? <div className="mi-q-jd">锚定简历：{q.resumeRef}</div> : null}

          {inProbe && s.pendingProbe ? (
            <div className="mi-probe">
              <div className="mi-probe-title">面试官追问（{probes + 1}/2）</div>
              <div>{s.pendingProbe.question}</div>
            </div>
          ) : null}

          <div className="mi-answer-box">
            {voiceMode ? (
              <div className="mi-record">
                <Button
                  type={recording ? 'default' : 'primary'}
                  danger={recording}
                  size="small"
                  icon={recording ? <StopOutlined /> : <AudioOutlined />}
                  loading={transcribing}
                  disabled={!asrReady || busy === 'advance' || busy === 'rescore'}
                  onClick={toggleRecording}
                >
                  {recording ? `停止并转写（${recSec}s）` : transcribing ? '正在转写…' : answer.trim() ? '重新录音' : '开始语音回答'}
                </Button>
                {recording ? (
                  <div className="mi-level" aria-hidden>
                    <span style={{ width: `${Math.round(recLevel * 100)}%` }} />
                  </div>
                ) : null}
                {voiceMetrics ? (
                  <span className="mi-record-metrics">
                    语速 {voiceMetrics.charsPerMinute} 字/分（{paceLabel(voiceMetrics.charsPerMinute).text}）· 长停顿{' '}
                    {voiceMetrics.longPauses} 次 · 口头禅 {voiceMetrics.fillerTotal} 次
                  </span>
                ) : (
                  <span className="mi-caption">
                    {recording ? '正在录音…说完点「停止并转写」' : '录音只在本地转写；体征（语速/停顿/口头禅）不计入内容分'}
                  </span>
                )}
                {!asrReady ? (
                  <Button size="small" type="link" onClick={() => openSettings('speech')}>
                    安装语音识别包
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Input.TextArea
              value={answer}
              autoSize={{ minRows: 7, maxRows: 16 }}
              placeholder={
                voiceMode
                  ? inProbe
                    ? '说完点「停止并转写」，结果会出现在这里，可修改后提交…'
                    : '点上方「开始语音回答」说一段，转写结果会出现在这里；也可以直接打字修改。'
                  : inProbe
                    ? '补充回答这个追问…'
                    : '用 STAR 讲清楚：背景 → 你做了什么 → 结果（带数字与口径）→ 复盘。先写下来，比说得好听更重要。'
              }
              onChange={(e) => setAnswer(e.target.value)}
              disabled={busy === 'advance'}
            />
            <div className="mi-answer-meta">
              <Text type="secondary" style={{ fontSize: 12 }}>{answer.trim().length} 字</Text>
              <Space>
                {!inProbe && !retrying && (
                  <Button size="small" onClick={() => { stopSpeaking(); void skipQuestion(); }} disabled={busy === 'advance'}>跳过这题</Button>
                )}
                <Button
                  type="primary"
                  onClick={() => void onSubmit()}
                  loading={busy === 'advance' || busy === 'rescore' || busy === 'phase2'}
                  disabled={recording || transcribing}
                >
                  {inProbe ? '提交补答' : retrying ? '提交并重新评分' : '提交回答'}
                </Button>
              </Space>
            </div>
          </div>
          {att && att.probes.length > 0 ? (
            <div className="mi-past-probes">
              {att.probes.filter((p) => p.answer).map((p) => (
                <div key={p.id} className="mi-past-probe">
                  <div className="mi-past-probe-q">追问：{p.question}</div>
                  <div className="mi-past-probe-a">你的补答：{p.answer}</div>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
        <div className="mi-foot-hint">
          <BulbOutlined /> 回答不会上传到任何服务器；AI 只看到题目、你的回答与简历原文。
        </div>
      </div>
    );
  };

  // ===== 反问 =====
  const renderReverse = (s: MockSession) => (
    <div className="mi-scroll">
      <div className="mi-head">
        <div>
          <h1 className="page-title">反问环节</h1>
          <Text type="secondary">
            面试最后通常会问你「有什么想问的」。问得好是加分项；这一步可跳过，不影响分数。
          </Text>
        </div>
      </div>

      {s.reverse ? (
        <Card size="small" title="你的提问" className="mi-card">
          <div className="mi-reverse-q">{s.reverse.question}</div>
          {s.reverse.kept && s.reverse.answer ? (
            <>
              <div className="mi-reverse-a-label">面试官的模拟回答</div>
              <div className="mi-reverse-a">{s.reverse.answer}</div>
              <div className="mi-caption">基于 JD 的模拟回答，不代表该公司真实情况</div>
            </>
          ) : (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="这个问题涉及公司内部信息，模拟面试无法替你回答"
              description="这个我在这儿没法替公司回答，真实情况得你到面试时问。建议你从这个角度准备：先想清楚你最想了解的是「岗位日常做什么」还是「团队怎么协作」，面试时直接问面试官。"
            />
          )}
          {s.reverse.comment ? <div className="mi-reverse-comment">点评：{s.reverse.comment}</div> : null}
          <div style={{ marginTop: 16 }}>
            <Button type="primary" size="large" loading={busy === 'report'} onClick={() => { stopSpeaking(); void finishInterview(); }}>
              生成报告
            </Button>
          </div>
        </Card>
      ) : (
        <Card size="small" title="你想问面试官什么？" className="mi-card">
          <Input.TextArea
            value={reverseInput}
            autoSize={{ minRows: 3, maxRows: 6 }}
            maxLength={300}
            showCount
            placeholder="例如：这个岗位入职后前三个月最需要解决的问题是什么？"
            onChange={(e) => setReverseInput(e.target.value)}
          />
          <div className="mi-form-hint">
            涉及团队人数、汇报线、薪资、HC、内部技术栈的问题，模拟面试无法替你回答（它只知道 JD）。
          </div>
          <Space style={{ marginTop: 12 }}>
            <Button
              type="primary"
              loading={busy === 'reverse'}
              disabled={!reverseInput.trim()}
              onClick={() => void submitReverse(reverseInput)}
            >
              提交提问
            </Button>
            <Button loading={busy === 'report'} onClick={() => { stopSpeaking(); void finishInterview(); }}>跳过反问，生成报告</Button>
          </Space>
        </Card>
      )}

      {s.config.phase1Count + s.config.phase2Count > 0 && s.status === 'reverse' && !s.reverse ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="跳过反问不会扣分"
          description="报告里会标注「未提问」。想练也可以稍后在报告出来后重新开一场。"
        />
      ) : null}
    </div>
  );

  // ===== 报告 =====
  const renderReport = (s: MockSession) => {
    const report = s.report;
    if (!report) {
      return (
        <div className="mi-scroll">
          <Empty description="报告尚未生成" />
        </div>
      );
    }
    return (
      <div className="mi-scroll">
        <div className="mi-report-head">
          <div>
            <h1 className="page-title">{s.job.jobTitle || '模拟面试报告'}</h1>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {[s.job.company, fmtDate(s.finishedAt || s.updatedAt), `评分口径 v${report.rubricVersion}`].filter(Boolean).join(' · ')}
            </Text>
          </div>
          <Space>
            <Button icon={<ExportOutlined />} onClick={() => void exportAll()}>导出记录</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>再练一场</Button>
          </Space>
        </div>

        {!report.aiAvailable || report.total == null ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="AI 评估不可用，本场不显示分数"
            description="报告只保留了你的回答转录。不显示分数是刻意的：既然评不出来，就不给一个看起来像真的数字。"
          />
        ) : (
          <div className="mi-score-card">
            <div className="mi-score-main">
              <div className="mi-score-num" style={{ color: toneColor(report.total) }}>{report.total}</div>
              <div className="mi-score-unit">/ 100</div>
            </div>
            <div className="mi-score-side">
              {report.band ? <Tag color={bandColor(report.band.key)} className="mi-band-tag">{report.band.label}</Tag> : null}
              <div className="mi-caption">
                分数由本地按维度权重计算（模型只给档位），同一份回答重算结果恒定。档位只描述这场答得够不够硬，不预测录用结果。
              </div>
            </div>
          </div>
        )}

        <Card size="small" title="维度分" className="mi-card">
          {report.dimensions.map((d: MockDimensionResult) => (
            <div className="mi-dim-row" key={d.key}>
              <div className="mi-dim-label">
                {d.label}
                <span className="mi-dim-weight">{Math.round(d.weight * 100)}%</span>
              </div>
              <div className="mi-dim-bar">
                <Progress
                  percent={d.na ? 0 : (d.score as number)}
                  showInfo={false}
                  strokeColor={toneColor(d.score)}
                  trailColor="var(--border)"
                  size="small"
                />
              </div>
              <div className="mi-dim-score" style={{ color: toneColor(d.score) }}>
                {d.na ? '不适用' : d.score}
              </div>
            </div>
          ))}
          <div className="mi-caption" style={{ marginTop: 8 }}>
            N/A（不适用 / 未作答）的维度不参与加权，剩余权重按比例归一化，不按 0 分处理。
          </div>
        </Card>

        <Card size="small" title="表达（不计入内容分）" className="mi-card">
          {report.delivery ? (
            <>
              <div className="mi-delivery-grid">
                <div>
                  <span>语速</span>
                  <b>{report.delivery.charsPerMinute}</b>
                  <em>字/分 · {paceLabel(report.delivery.charsPerMinute).text}</em>
                </div>
                <div>
                  <span>长停顿</span>
                  <b>{report.delivery.longPauses}</b>
                  <em>次（≥1.5s）</em>
                </div>
                <div>
                  <span>口头禅</span>
                  <b>{report.delivery.fillerTotal}</b>
                  <em>
                    {Object.keys(report.delivery.fillerWords).length
                      ? Object.entries(report.delivery.fillerWords)
                          .map(([k, v]) => `${k}×${v}`)
                          .slice(0, 3)
                          .join(' ')
                      : '未发现明显口头禅'}
                  </em>
                </div>
                <div>
                  <span>有声占比</span>
                  <b>{Math.round((report.delivery.speechRatio || 0) * 100)}%</b>
                  <em>录音合计 {Math.round(report.delivery.durationSec)}s</em>
                </div>
              </div>
              <div className="mi-caption">
                由本地 VAD 与转写文本计算，同一段录音重算结果恒定。内容分只看说了什么，这里只看怎么说的。
              </div>
            </>
          ) : (
            <div className="mi-caption">
              本场没有录音作答，无体征数据。语速 / 长停顿 / 口头禅由本地能量 VAD 与转写文本算，不参与内容分。
            </div>
          )}
          {report.deliveryAdvice ? (
            <div className="mi-delivery-advice">
              <div className="mi-reverse-a-label">表达建议（AI 主观，不给分）</div>
              <div>{report.deliveryAdvice}</div>
            </div>
          ) : null}
        </Card>

        <Card size="small" title={`逐题复盘（${report.questions.length} 题）`} className="mi-card">
          {report.questions.map((r, i) => {
            const q = s.questions.find((x) => x.id === r.questionId);
            const rw = rewrites[r.questionId];
            const sourceLabel = r.evidenceSource === 'rule' ? '规则判定' : 'AI 判定';
            return (
              <div className="mi-review-item" key={r.questionId}>
                <div className="mi-review-head">
                  <div className="mi-review-title">
                    <span className="mi-q-index">{i + 1}</span>
                    <span>{r.questionText}</span>
                  </div>
                  <Space size={4} wrap>
                    {r.skipped ? <Tag>跳过</Tag> : null}
                    {q ? <Tag bordered={false}>{MOCK_CATEGORY_LABELS[q.category]}</Tag> : null}
                    <Tooltip
                      title={
                        r.keyPointsFrom === 'bank'
                          ? '要点来自题库，判「漏答」有确定依据'
                          : r.keyPointsFrom === 'none'
                            ? '这道题（多为内置题）没有评分要点，报告不据此判漏答'
                            : '这道题的要点是 AI 现编的，仅供参考'
                      }
                    >
                      <Tag bordered={false} color={r.keyPointsFrom === 'bank' ? 'green' : 'default'}>
                        {r.keyPointsFrom === 'bank' ? '题库要点' : r.keyPointsFrom === 'none' ? '无要点依据' : 'AI 推断'}
                      </Tag>
                    </Tooltip>
                    <Tag bordered={false}>
                      证据{MOCK_EVIDENCE_LABELS[r.evidenceState]}（{sourceLabel}）
                    </Tag>
                    <Tag bordered={false}>
                      {r.scoredWith === 'withProbes' ? `基于主答 + 追问 ${r.probes.length} 轮` : '基于主答'}
                    </Tag>
                    {r.score != null ? (
                      <span className="mi-review-score" style={{ color: toneColor(r.score) }}>{r.score}</span>
                    ) : (
                      <span className="mi-review-score mi-review-score--na">{r.skipped ? '未作答' : '无法评分'}</span>
                    )}
                  </Space>
                </div>

                <div className="mi-review-answer">{r.answer || '（未作答）'}</div>

                {r.probes.length > 0 && (
                  <div className="mi-past-probes">
                    {r.probes.map((p, pi) => (
                      <div key={`${r.questionId}-p-${pi}`} className="mi-past-probe">
                        <div className="mi-past-probe-q">追问：{p.question}</div>
                        <div className="mi-past-probe-a">补答：{p.answer}</div>
                      </div>
                    ))}
                  </div>
                )}

                {r.delivery ? (
                  <div className="mi-review-delivery">
                    语音 {r.delivery.durationSec}s · 语速 {r.delivery.charsPerMinute} 字/分 · 长停顿{' '}
                    {r.delivery.longPauses} 次 · 口头禅 {r.delivery.fillerTotal} 次
                  </div>
                ) : null}
                {!r.skipped && (
                  <div className="mi-review-dims">
                    {report.dimensions.map((d) => {
                      const v = r.dimensionScores[d.key];
                      return (
                        <span key={d.key} className="mi-review-dim">
                          {d.label}：
                          <b style={{ color: toneColor(v == null ? null : v) }}>{v == null ? 'N/A' : v}</b>
                        </span>
                      );
                    })}
                  </div>
                )}

                {r.invalidEvidence ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message="引用的原句未能在你的回答中定位，相关维度已按无证据压分"
                  />
                ) : null}

                {r.hitPoints.length > 0 && (
                  <div className="mi-points">
                    <span className="mi-points-label mi-points-label--hit">命中</span>
                    {r.hitPoints.map((p) => <span key={p} className="mi-point mi-point--hit">{p}</span>)}
                  </div>
                )}
                {r.missedPoints.length > 0 && (
                  <div className="mi-points">
                    <span className="mi-points-label mi-points-label--miss">漏答</span>
                    {r.missedPoints.map((p) => <span key={p} className="mi-point mi-point--miss">{p}</span>)}
                  </div>
                )}
                {r.suggestion ? <div className="mi-review-suggestion">建议：{r.suggestion}</div> : null}

                <Space style={{ marginTop: 10 }}>
                  <Button
                    size="small"
                    loading={busy === 'rewrite'}
                    disabled={r.skipped}
                    onClick={() => void rewriteCurrent(r.questionId)}
                  >
                    改写我的回答
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => retryQuestion(r.questionId)}
                  >
                    重答此题
                  </Button>
                </Space>

                {rw && (
                  <div className="mi-rewrite">
                    {rw.text ? (
                      <>
                        <div className="mi-reverse-a-label">改写稿（只引用你的原答与简历事实）</div>
                        <div className="mi-rewrite-text">{rw.text}</div>
                      </>
                    ) : (
                      <Alert
                        type={rw.blocked ? 'warning' : 'info'}
                        showIcon
                        message={rw.blocked ? '改写稿未通过数字校验，已回退为原答' : '本次未生成改写稿'}
                      />
                    )}
                    {rw.gaps.length > 0 && (
                      <div className="mi-rewrite-gaps">
                        <div className="mi-reverse-a-label">需要你自己补充的真实细节</div>
                        <ul>
                          {rw.gaps.map((g) => <li key={g}>{g}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <Card size="small" title="反问环节" className="mi-card">
          {report.reverse ? (
            <>
              <div className="mi-reverse-q">{report.reverse.question}</div>
              {report.reverse.kept && report.reverse.answer ? (
                <>
                  <div className="mi-reverse-a">{report.reverse.answer}</div>
                  <div className="mi-caption">基于 JD 的模拟回答，不代表该公司真实情况</div>
                </>
              ) : (
                <div className="mi-caption">该提问涉及公司内部信息，模拟回答未存入报告。</div>
              )}
              {report.reverse.comment ? <div className="mi-reverse-comment">提问点评：{report.reverse.comment}</div> : null}
            </>
          ) : (
            <div className="mi-caption">未完成反问（本轮跳过，不影响分数）。</div>
          )}
        </Card>

        <Card size="small" title="总结" className="mi-card">
          {report.summary.gaps.length > 0 && (
            <>
              <div className="mi-reverse-a-label">最该补的缺口</div>
              <ul className="mi-gap-list">
                {report.summary.gaps.map((g) => (
                  <li key={g.text}>
                    {g.text}
                    {g.jdRef ? <span className="mi-gap-jd">（JD：{g.jdRef}）</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          {report.summary.advice.length > 0 && (
            <>
              <div className="mi-reverse-a-label" style={{ marginTop: 12 }}>可执行建议</div>
              <ol className="mi-advice-list">
                {report.summary.advice.map((a) => <li key={a}>{a}</li>)}
              </ol>
            </>
          )}
          {report.summary.gaps.length === 0 && report.summary.advice.length === 0 ? (
            <div className="mi-caption">本场没有生成总结。</div>
          ) : null}
        </Card>
      </div>
    );
  };

  // ===== 主区分发 =====
  const renderMain = () => {
    if (tab === 'bank') {
      const running = Boolean(session && ['running', 'ready', 'planning', 'reverse', 'reporting'].includes(session.status));
      return <MockBankPanel sessionActive={running} />;
    }

    if (busy === 'list') {
      return (
        <div className="mi-center">
          <Spin size="large" />
          <div className="mi-planning-text">正在读取面试记录…</div>
        </div>
      );
    }

    if (!session) {
      return (
        <div className="mi-center">
          <Empty description="还没有面试记录">
            <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>新建一场</Button>
          </Empty>
        </div>
      );
    }

    const s = session;

    if (s.status === 'planning') {
      return (
        <div className="mi-center">
          <Spin size="large" />
          <div className="mi-planning-text">面试官正在整理你的回答…</div>
          <div className="mi-caption">正在生成针对你的简历与刚才回答的深挖题，通常需要 10–30 秒。</div>
        </div>
      );
    }

    if (busy === 'rescore') {
      return (
        <div className="mi-center">
          <Spin size="large" />
          <div className="mi-planning-text">正在重新评分…</div>
          <div className="mi-caption">只重算这一题，其他题的分数保持不变。</div>
        </div>
      );
    }

    if (s.status === 'reporting' || busy === 'report') {
      return (
        <div className="mi-center">
          <Spin size="large" />
          <div className="mi-planning-text">正在逐题评分…</div>
          <div className="mi-caption">一次性对全部题目打分（模型能横向校准），约 10–30 秒。</div>
        </div>
      );
    }

    if (s.status === 'finished') {
      if (s.retry && currentQuestion) return renderAnswer(s, currentQuestion);
      return renderReport(s);
    }

    if (s.status === 'reverse') return renderReverse(s);

    if ((s.status === 'running' || s.status === 'ready') && currentQuestion) {
      if (s.status === 'ready') return renderConfig(s);
      return renderAnswer(s, currentQuestion);
    }

    return renderConfig(s);
  };

  return (
    <div className="mock-interview-page">
      {renderRail()}
      <section className="mi-main">{renderMain()}</section>
    </div>
  );
}
