import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Empty, Input, InputNumber, Segmented, Space, Switch, Tag, Typography, Upload, message, Modal, Progress,
} from 'antd';
import {
  MessageOutlined, ThunderboltOutlined, QrcodeOutlined, PoweroffOutlined,
  ReloadOutlined, SafetyCertificateOutlined, StopOutlined, DeleteOutlined,
  UploadOutlined, PictureOutlined, CheckOutlined, CaretRightOutlined,
  RobotOutlined, FilterOutlined, LockOutlined, EyeOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAppStore } from '@/store/useAppStore';
import {
  camoufoxStatus, camoufoxLogin, camoufoxLogout, camoufoxChat,
  isCamoufoxStopCode, isCamoufoxEnvCode, type CamoufoxStatus,
} from '@/lib/bossclaw/camoufox';
import {
  ActionPacer, effectiveDailyCap, dailySentCount, isLockedOut,
  cooldownRemaining, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { DEFAULT_GREETING_PROMPT, resolveGreetingPrompt } from '@/lib/bossclaw/greetings';
import { rerankPending } from '@/lib/bossclaw/priority';
import { cleanTitle, formatMetaLine } from '@/lib/bossclaw/jobDisplay';
import type { PendingItem, ImageResume } from '@/lib/bossclaw/types';

const { Text, Paragraph } = Typography;

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待确认' },
  approved: { color: 'blue', label: '待沟通' },
  approved_queue: { color: 'cyan', label: '沟通中' },
  failed: { color: 'red', label: '失败' },
  sent: { color: 'green', label: '已沟通' },
  skipped: { color: 'default', label: '已跳过' },
  ignored: { color: 'default', label: '已忽略' },
};

/** 从岗位元信息中提取纯 encryptJobId（对齐 Workbench extractEncryptJobId 口径） */
function extractJobId(job: PendingItem['job']): string {
  const j = job || {};
  let jid = String(j.jobId || '').trim();
  const kv = jid.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
  if (kv) jid = kv[1];
  jid = jid.replace(/\.html$/i, '').trim();
  if (jid && !/^https?:/i.test(jid)) return jid;
  const m = String(j.url || '').match(/job_detail\/([^/?#.]+)/i);
  return m ? m[1].replace(/\.html$/i, '') : '';
}

export default function AutoChat() {
  const pending = useDataStore((s) => s.pending);
  const updatePending = useDataStore((s) => s.updatePending);
  const addLog = useDataStore((s) => s.addLog);
  const logs = useDataStore((s) => s.logs);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const imageResumes = useDataStore((s) => s.imageResumes);
  const addImageResume = useDataStore((s) => s.addImageResume);
  const removeImageResume = useDataStore((s) => s.removeImageResume);
  const storeGreetingPrompt = useDataStore((s) => s.greetingPrompt);
  const setGreetingPromptStore = useDataStore((s) => s.setGreetingPrompt);

  const config = useSettingsStore((s) => s.config);
  const setConfig = useSettingsStore((s) => s.setConfig);
  const profile = useDataStore((s) => s.profile);

  // ===== Camoufox 隐身引擎状态 =====
  const [cfx, setCfx] = useState<CamoufoxStatus | null>(null);
  const [cfxLoading, setCfxLoading] = useState(false);
  const [cfxLogining, setCfxLogining] = useState(false);
  const cfxConfig = config.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };

  // ===== 打招呼语提示词编辑器（本地草稿）=====
  const [customPrompt, setCustomPrompt] = useState(storeGreetingPrompt || DEFAULT_GREETING_PROMPT);

  // ===== 自动沟通引擎状态 =====
  const [chatRunning, setChatRunning] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number }>({ index: 0, total: 0 });
  const chatActiveRef = useRef(false);
  const pacerRef = useRef<ActionPacer>(new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE));
  const logRef = useRef<HTMLDivElement>(null);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  useEffect(() => { recomputeStats(); }, [pending, recomputeStats]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, progress]);

  const refreshCamoufox = async (silent = false) => {
    if (!silent) setCfxLoading(true);
    const s = await camoufoxStatus();
    setCfx(s);
    // 引擎不可用时强制关闭启用开关，避免「开了但没安装」的失效状态
    if (!s.ready && cfxConfig.enabled) setConfig({ camoufox: { ...cfxConfig, enabled: false } });
    if (!silent) setCfxLoading(false);
  };

  const onCamoufoxLogin = async () => {
    setCfxLogining(true);
    try {
      const r = await camoufoxLogin(180, cfxConfig.os);
      if (r.ok && r.loggedIn) message.success('Camoufox 登录成功，会话 Cookie 已持久化');
      else message.warning(r.message || r.error || '登录未完成（可能超时或取消）');
    } catch (e: any) {
      message.error('登录失败：' + (e?.message || e));
    } finally {
      setCfxLogining(false);
      refreshCamoufox(true);
    }
  };

  const onCamoufoxLogout = () => {
    Modal.confirm({
      title: '退出 Camoufox 登录态？',
      content: '将清除 Camoufox 会话 Cookie，自动沟通需要重新扫码登录。',
      okText: '确认退出',
      cancelText: '取消',
      onOk: async () => {
        await camoufoxLogout();
        message.success('已清除 Camoufox 会话');
        refreshCamoufox(true);
      },
    });
  };

  // ===== 图片简历管理（对齐 AI-BossJob 的 imageResumes，首次沟通后自动打包发送）=====
  const MAX_IMAGE_RESUMES = 4;
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const onImageResumeFile = (file: File) => {
    if (imageResumes.length >= MAX_IMAGE_RESUMES) { message.warning(`最多保存 ${MAX_IMAGE_RESUMES} 张图片简历`); return; }
    if (!/image\/(jpeg|jpg|png)/.test(file.type || '')) { message.warning('仅支持 JPG / PNG 图片简历'); return; }
    if (file.size > MAX_IMAGE_BYTES) { message.warning('单张图片简历请控制在 1MB 以内'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      addImageResume({ id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name: file.name, data: String(reader.result || ''), createdAt: Date.now() });
      message.success(`已添加图片简历：${file.name}`);
    };
    reader.onerror = () => message.error('图片读取失败');
    reader.readAsDataURL(file);
  };

  const onSavePrompt = () => {
    const resolved = resolveGreetingPrompt(customPrompt);
    setGreetingPromptStore(resolved === DEFAULT_GREETING_PROMPT ? '' : customPrompt);
    message.success('打招呼语提示词已保存（将用于岗位分析的招呼语生成）');
  };
  const onResetPrompt = () => {
    setCustomPrompt(DEFAULT_GREETING_PROMPT);
    setGreetingPromptStore('');
    message.info('已恢复为系统默认提示词');
  };

  // ===== 核心：真实浏览器自动沟通 =====
  // 单条岗位沟通：返回 'success' | 'failed' | 'stop' | 'continue'
  const chatJob = async (item: PendingItem): Promise<'success' | 'failed' | 'stop' | 'continue'> => {
    const cfg = useSettingsStore.getState().config;
    const greeting = String(item.deliveryGreeting || item.analysis?.greeting || '').trim();
    if (!greeting) {
      updatePending(item.id, { status: 'failed', error: '招呼语为空，无法自动沟通，请补充后再试', retryable: true });
      addLog('error', `自动沟通失败：${cleanTitle(item.job?.title)}（招呼语为空）`);
      return 'failed';
    }
    const jobId = extractJobId(item.job);
    if (!jobId) {
      updatePending(item.id, { status: 'failed', error: '岗位缺少 jobId，无法自动沟通', retryable: false });
      addLog('error', `自动沟通失败：${cleanTitle(item.job?.title)}（缺少 jobId）`);
      return 'failed';
    }

    addLog('info', `打开可见浏览器窗口，自动沟通「${cleanTitle(item.job?.title)}」@ ${item.job?.company || ''}…`);
    try {
      const result = await camoufoxChat(jobId, greeting, {
        os: cfg.camoufox?.os,
        sendResumeImage: Boolean(cfg.sendResumeImage),
        sendOnlineResume: Boolean(cfg.sendOnlineResume),
      });
      if (result.ok && result.sent) {
        updatePending(item.id, { status: 'sent', error: '', sentAt: Date.now() });
        addLog('success', `自动沟通成功：${cleanTitle(item.job?.title)}（${result.method === 'browser-chat' ? '浏览器真实操作' : result.method || 'ok'}）`);
        return 'success';
      }
      const code = result.code ?? null;
      const msg = String(result.message || result.error || '自动沟通失败');
      if (isCamoufoxStopCode(code)) {
        updatePending(item.id, { status: 'failed', error: msg, retryable: false, riskBlocked: true });
        useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + SAFETY_LIMITS.DEFAULT_COOLDOWN_MS });
        addLog('error', `自动沟通命中风控码 ${code}：${msg}。立即暂停并进入冷却，请人工处理，切勿重复重试。`);
        return 'stop';
      }
      if (isCamoufoxEnvCode(code)) {
        addLog('error', `自动沟通命中环境异常码 ${code}：${msg}。请先点击上方「扫码登录」。`);
        return 'stop';
      }
      updatePending(item.id, { status: 'failed', error: msg, retryable: true });
      addLog('error', `自动沟通失败：${cleanTitle(item.job?.title)}（${msg}）`);
      return 'failed';
    } catch (e: any) {
      const msg = String(e?.message || e);
      updatePending(item.id, { status: 'failed', error: msg, retryable: true });
      addLog('error', `自动沟通异常：${cleanTitle(item.job?.title)}（${msg}）`);
      return 'failed';
    }
  };

  // 启动前置检查：画像 / 冷却 / 引擎 / 队列
  const precheck = async (): Promise<{ ok: boolean; queue: PendingItem[] }> => {
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return { ok: false, queue: [] }; }
    const cfg = useSettingsStore.getState().config;
    if (isLockedOut(cfg)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟），暂不能自动沟通`);
      return { ok: false, queue: [] };
    }
    const st = await camoufoxStatus();
    if (!st.ready) {
      message.warning('隐身引擎未就绪：' + (st.message || '请检测本机 Chrome/Edge/Firefox 或安装 camoufox'));
      return { ok: false, queue: [] };
    }
    const queue = rerankPending(useDataStore.getState().pending)
      .filter((p) => p.status === 'approved' || p.status === 'pending' || p.status === 'approved_queue');
    if (!queue.length) { message.info('没有待沟通的岗位（请先在工作台确认岗位或批准进入队列）'); return { ok: false, queue: [] }; }
    return { ok: true, queue };
  };

  // 批量自动沟通（逐岗位：冷却/上限/限速 + 首次成功暂停验收）
  const runBatchChat = async () => {
    if (chatActiveRef.current) return;
    const { ok, queue } = await precheck();
    if (!ok) return;

    chatActiveRef.current = true;
    setChatRunning(true);
    setProgress({ index: 0, total: queue.length });
    let sentCount = 0;
    const cfg = useSettingsStore.getState().config;
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacerRef.current.budget !== pacerMax) pacerRef.current = new ActionPacer(pacerMax);
    addLog('info', `开始自动沟通：共 ${queue.length} 个岗位（真实浏览器窗口逐条操作）`);

    let stopAll = false;
    for (let i = 0; i < queue.length; i += 1) {
      if (!chatActiveRef.current) break;
      const item = queue[i];
      setActiveChatId(item.id);
      setProgress({ index: i + 1, total: queue.length });

      // 冷却 / 每日上限 / 限速
      const nowCfg = useSettingsStore.getState().config;
      if (isLockedOut(nowCfg)) {
        addLog('warn', `账号处于冷却期，已暂停自动沟通（剩余约 ${Math.ceil(cooldownRemaining(nowCfg) / 60000)} 分钟）`);
        break;
      }
      if (dailySentCount(useDataStore.getState().pending) >= effectiveDailyCap(nowCfg)) {
        addLog('warn', `今日沟通已达安全上限 ${effectiveDailyCap(nowCfg)} 条，已暂停（避免账号受限）`);
        break;
      }
      await pacerRef.current.waitForSlot();
      const baseSec = Math.max(Number(nowCfg.betweenJobsSeconds) || 15, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
      await sleep(baseSec * 1000 * (0.8 + Math.random() * 0.4));

      const outcome = await chatJob(item);
      if (outcome === 'success') {
        sentCount += 1;
        // 首次成功投递后暂停验收（安全不变量）
        if (nowCfg.requireSingleJobValidation && !nowCfg.singleJobValidationCompletedAt) {
          useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
          addLog('warn', '首次自动沟通成功，已暂停：请核对浏览器窗口中的沟通对象、文字气泡与附件，确认无误后再继续');
          break;
        }
      } else if (outcome === 'stop') {
        stopAll = true;
        break;
      }
      await sleep(800);
    }

    chatActiveRef.current = false;
    setActiveChatId(null);
    setChatRunning(false);
    setProgress({ index: 0, total: 0 });
    recomputeStats();
    if (!stopAll) addLog(sentCount > 0 ? 'success' : 'info', `自动沟通结束：共成功沟通 ${sentCount} 个岗位`);
  };

  // 单条沟通
  const chatOne = async (item: PendingItem) => {
    if (chatActiveRef.current) { message.warning('已有自动沟通正在进行，请先停止'); return; }
    const { ok } = await precheck();
    if (!ok) return;
    chatActiveRef.current = true;
    setChatRunning(true);
    setActiveChatId(item.id);
    await chatJob(item);
    chatActiveRef.current = false;
    setActiveChatId(null);
    setChatRunning(false);
    recomputeStats();
  };

  const stopChat = () => {
    chatActiveRef.current = false;
    setChatRunning(false);
    setActiveChatId(null);
    setProgress({ index: 0, total: 0 });
    addLog('warn', '已停止自动沟通');
  };

  // 队列（仅展示可行动状态：待确认/待沟通/沟通中/失败/已沟通）
  const queueItems = rerankPending(pending).filter((p) => ['pending', 'approved', 'approved_queue', 'failed', 'sent'].includes(p.status));
  const queueCount = pending.filter((p) => p.status === 'approved' || p.status === 'pending' || p.status === 'approved_queue').length;
  const sentCount = pending.filter((p) => p.status === 'sent').length;
  const failedCount = pending.filter((p) => p.status === 'failed').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <MessageOutlined className="page-title-icon" />自动沟通
          </h1>
          <p className="page-sub">
            真正的浏览器操作：打开可见浏览器窗口，真实点击「立即沟通」、真实输入招呼语并发送，逐条对已确认岗位自动沟通。
          </p>
        </div>
      </div>

      {/* ===== 引擎状态 + 扫码登录 ===== */}
      <Card size="small" className="setting-card" style={{ marginBottom: 12 }}
        title={<><span className="setting-card__icon"><ThunderboltOutlined /></span> 隐身引擎 · 真实浏览器窗口</>}
        extra={
          <Tag color={cfx?.ready ? 'green' : 'orange'}>{cfx?.ready ? '引擎就绪' : (cfx ? '未就绪' : '检测中…')}</Tag>
        }>
        <div className="setting-actions" style={{ marginBottom: 8 }}>
          <Button size="middle" onClick={() => refreshCamoufox()} loading={cfxLoading}>检测状态</Button>
          <Button size="middle" type="primary" icon={<QrcodeOutlined />} loading={cfxLogining} onClick={onCamoufoxLogin}>
            扫码登录（打开可见窗口）
          </Button>
          <Button size="middle" danger icon={<StopOutlined />} disabled={!cfx?.engine?.cookieCount} onClick={onCamoufoxLogout}>
            退出登录
          </Button>
        </div>
        {cfx?.ready ? (
          <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
            <Tag color="green" style={{ marginRight: 8 }}>{cfx.engine?.kernel || '引擎就绪'}</Tag>
            {cfx.engine?.kernelMessage || cfx.message}
          </Paragraph>
        ) : (
          <Alert type="warning" showIcon style={{ borderRadius: 8, marginBottom: 0 }}
            message="隐身引擎当前不可用"
            description={cfx?.message || '请检查本机浏览器内核（Chrome/Edge/Firefox），或点击「检测状态」重新检查。'} />
        )}
        <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          「自动沟通」会<Text strong>新建一个可见的浏览器窗口</Text>，真实打开岗位详情页、真实点击沟通按钮、真实键盘输入招呼语并发送，
          随后确认文字气泡出现才算成功（对齐 F:\boss-auto-job-main 的浏览器操作方式）。请在自动沟通时不要遮挡或最小化该浏览器窗口。
        </Paragraph>
      </Card>

      {/* ===== 执行模式 ===== */}
      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><RobotOutlined /></span> 执行模式</>} style={{ marginBottom: 12 }}>
        <Segmented
          className="setting-segmented"
          size="large"
          value={config.executionMode === 'auto' ? 'auto' : 'review'}
          onChange={(v) => setConfig({ executionMode: v as 'auto' | 'review' })}
          options={[
            { label: '人工确认（半自动）', value: 'review' },
            { label: '全自动', value: 'auto' },
          ]}
        />
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          全自动：达标岗位自动以应聘者身份沟通投递；人工确认：AI 筛选后由你逐条或批量确认再沟通。遇到安全验证、登录异常、对象不确定或结果不可确认时立即暂停。
        </Paragraph>
      </Card>

      {/* ===== 沟通与投递附件 + 图片简历 ===== */}
      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><SafetyCertificateOutlined /></span> 沟通与附件</>} style={{ marginBottom: 12 }}>
        <div className="setting-row">
          <div className="setting-row__main">
            <div className="setting-row__label">发送简历附件（图片）</div>
            <div className="setting-row__desc">首次沟通确认文字气泡后自动打包发送</div>
          </div>
          <div className="setting-row__control"><Switch checked={config.sendResumeImage} onChange={(v) => setConfig({ sendResumeImage: v })} /></div>
        </div>
        <div className="setting-row">
          <div className="setting-row__main">
            <div className="setting-row__label">发送在线简历</div>
            <div className="setting-row__desc">向 HR 同步 BOSS 在线简历</div>
          </div>
          <div className="setting-row__control"><Switch checked={config.sendOnlineResume} onChange={(v) => setConfig({ sendOnlineResume: v })} /></div>
        </div>
        <div className="setting-row">
          <div className="setting-row__main">
            <div className="setting-row__label">排除猎头</div>
            <div className="setting-row__desc">加入任务时自动跳过猎头岗位</div>
          </div>
          <div className="setting-row__control"><Switch checked={config.excludeHeadhunters} onChange={(v) => setConfig({ excludeHeadhunters: v })} /></div>
        </div>

        <div className="field-group">
          <div className="field-group__title"><PictureOutlined className="fg-icon" /> 图片简历</div>
          <Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 8, fontSize: 12 }}>
            开启「发送简历附件」后，首次沟通确认文字气泡后自动打包发送。上传前请务必删除或打码联系方式（手机号 / 微信 / 邮箱），防止被判定为引流。
          </Paragraph>
          <Upload accept=".jpg,.jpeg,.png" showUploadList={false} beforeUpload={(f) => { onImageResumeFile(f as unknown as File); return false; }}>
            <Button size="middle" icon={<UploadOutlined />}>添加图片简历</Button>
          </Upload>
          <div>
            {imageResumes.length === 0 ? null : imageResumes.map((r: ImageResume) => (
              <div key={r.id} className="image-resume-row">
                <img src={r.data} alt={r.name} />
                <Text className="ir-name" ellipsis>{r.name}</Text>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeImageResume(r.id)} />
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* ===== 打招呼语提示词 ===== */}
      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><MessageOutlined /></span> 打招呼语提示词</>}
        style={{ marginBottom: 12 }}
        extra={<Space><Button size="small" icon={<CheckOutlined />} onClick={onSavePrompt}>保存</Button><Button size="small" onClick={onResetPrompt} disabled={customPrompt === DEFAULT_GREETING_PROMPT}>恢复默认</Button></Space>}>
        <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 8, fontSize: 12 }}>
          自定义 AI 生成打招呼语的提示词（求职者第一人称、仅引用真实简历事实）。留空或恢复默认则使用系统内置提示词，供工作台岗位分析时生成个性化招呼语。
        </Paragraph>
        <Input.TextArea
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          rows={6}
          placeholder="在此编辑 AI 打招呼语提示词，控制生成口吻、角度、长度等..."
          style={{ fontSize: 12, lineHeight: 1.7, fontFamily: 'monospace' }}
        />
      </Card>

      {/* ===== 防封号节奏 ===== */}
      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><LockOutlined /></span> 账号安全 · 防封号节奏</>} style={{ marginBottom: 12 }}
        extra={isLockedOut(config) ? <Tag color="red">冷却中</Tag> : <Tag color="green">正常</Tag>}>
        {isLockedOut(config) && (
          <Alert type="warning" showIcon style={{ borderRadius: 8, marginBottom: 12 }}
            message={`账号处于冷却期，剩余约 ${Math.ceil(cooldownRemaining(config) / 60000)} 分钟`}
            description="触发风控（验证码/限速/环境异常）后自动进入冷却，期间自动沟通不可启动。请勿在冷却期内反复启动，否则会升级封禁等级。" />
        )}
        <div className="safety-grid">
          <div className="sg-item"><span className="field-label">每日投递上限（条）</span>
            <InputNumber min={1} max={SAFETY_LIMITS.MAX_SAFE_DAILY} value={config.maxDailySent} onChange={(v) => setConfig({ maxDailySent: v ?? 30 })} style={{ width: '100%' }} />
          </div>
          <div className="sg-item"><span className="field-label">岗位间隔（秒，最小 15）</span>
            <InputNumber min={15} max={600} value={config.betweenJobsSeconds} onChange={(v) => setConfig({ betweenJobsSeconds: v ?? 20 })} style={{ width: '100%' }} />
          </div>
          <div className="sg-item"><span className="field-label">每分钟动作上限（次）</span>
            <InputNumber min={1} max={15} value={config.maxActionsPerMinute} onChange={(v) => setConfig({ maxActionsPerMinute: v ?? 6 })} style={{ width: '100%' }} />
          </div>
          <div className="sg-item"><span className="field-label">风控冷却（分钟）</span>
            <InputNumber min={5} max={720} value={config.autoCooldownMinutes} onChange={(v) => setConfig({ autoCooldownMinutes: v ?? 30 })} style={{ width: '100%' }} />
          </div>
          <div className="sg-item"><span className="field-label">沟通卡住跳过（秒）</span>
            <InputNumber min={10} max={600} value={config.commStuckTimeoutSec} onChange={(v) => setConfig({ commStuckTimeoutSec: v ?? 60 })} style={{ width: '100%' }} />
          </div>
        </div>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          依据 BOSS 直聘风控链路（高频 → 限速 1006 → 验证 35 → 异常 36 → 封禁 32）设定：每日投递以 {SAFETY_LIMITS.MAX_SAFE_DAILY} 条为硬封顶，岗位间隔与每分钟动作加入人类化抖动；触发验证码/封禁后强制冷却并禁止重试。数值越低越安全。
        </Paragraph>
      </Card>

      {/* ===== 投递安全 ===== */}
      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><SafetyCertificateOutlined /></span> 沟通安全（请务必遵守）</>} style={{ marginBottom: 12 }}
        extra={<Tag color="orange">平台合规</Tag>}>
        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 8, marginBottom: 8 }}
          message="本应用不提供也不实现任何绕过平台安全措施的能力"
          description={
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>控制沟通频率：BOSS 直聘每日打招呼有上限，建议分时段沟通，避免触发风控。</li>
              <li>优先沟通「在线 / 刚刚活跃」的 HR，避免把配额花在长期不活跃的岗位上。</li>
              <li>如使用图片简历，务必先删除或打码联系方式（手机号 / 微信 / 邮箱），防止被判定为引流。</li>
              <li>招呼语一律使用求职者第一人称，仅引用真实简历事实；不得替用户承诺薪资、到岗或面试时间。</li>
            </ul>
          }
        />
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
          未确认沟通对象与文字气泡时不发送、不跳下一岗位；首次成功沟通后自动暂停供核对。
        </Paragraph>
      </Card>

      {/* ===== 自动沟通队列 ===== */}
      <Card size="small" className="setting-card" title="自动沟通队列"
        extra={
          <Space size={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>待沟通 {queueCount} · 已沟通 {sentCount} · 失败 {failedCount}</Text>
            {chatRunning ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={stopChat}>停止</Button>
            ) : (
              <Button size="small" type="primary" icon={<CaretRightOutlined />} onClick={runBatchChat} disabled={queueCount === 0}>
                开始自动沟通
              </Button>
            )}
          </Space>
        }>
        {chatRunning && progress.total > 0 && (
          <div style={{ marginBottom: 10, padding: '8px 12px', background: 'var(--hover-bg)', borderRadius: 8, border: '1px dashed var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Progress percent={Math.round((progress.index / progress.total) * 100)} size="small" style={{ flex: 1 }} strokeColor={{ from: '#13b5ac', to: '#078A83' }} />
              <Text style={{ fontSize: 12, flex: '0 0 auto' }}>{progress.index}/{progress.total}</Text>
              <Tag color="processing" style={{ margin: 0 }}>浏览器沟通中</Tag>
            </div>
          </div>
        )}
        {queueItems.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待沟通岗位。请先在工作台搜索采集岗位并确认加入队列。" />
        ) : (
          <div className="wb-jobs">
            {queueItems.map((p: PendingItem) => {
              const st = STATUS_TAG[p.status] || { color: 'default', label: p.status };
              const isActive = p.id === activeChatId;
              const canChat = p.status !== 'sent';
              return (
                <div key={p.id} className={'job-card' + (isActive ? ' is-active' : '')} style={{ marginBottom: 8 }}>
                  <div className="job-header">
                    <div className="job-header-main" style={{ minWidth: 0 }}>
                      <div className="job-title-row">
                        <div className="job-title">{cleanTitle(p.job?.title, p.job?.salary)}</div>
                        {p.priorityRank != null && <span className="score-rank">#{p.priorityRank}</span>}
                      </div>
                      <div className="job-company">{formatMetaLine(p.job?.company, p.job?.location, p.job?.salary)}</div>
                    </div>
                    <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto' }}>{st.label}</Tag>
                  </div>
                  <div className="job-body" style={{ paddingTop: 8 }}>
                    <div className="job-greeting-label">{isActive ? '正在沟通中，请勿遮挡浏览器窗口' : '沟通招呼语（可编辑）'}</div>
                    <Input.TextArea
                      value={p.deliveryGreeting || p.analysis?.greeting || ''}
                      onChange={(e) => updatePending(p.id, { deliveryGreeting: e.target.value })}
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      placeholder="请输入你希望发送给招聘方的求职招呼语"
                      disabled={p.status === 'sent'}
                      style={{ fontSize: 12, lineHeight: 1.65 }}
                    />
                  </div>
                  {p.error && <div className="job-error">⚠ {p.error}</div>}
                  <div className="job-actions">
                    <div className="job-actions-right">
                      {canChat ? (
                        <Button size="small" type="primary" icon={<MessageOutlined />} loading={isActive} disabled={chatRunning && !isActive} onClick={() => chatOne(p)}>
                          沟通
                        </Button>
                      ) : (
                        <Button size="small" type="primary" icon={<CheckOutlined />} disabled>已沟通</Button>
                      )}
                    </div>
                    <div className="job-actions-left">
                      <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && (window as any).electron?.openExternal?.(p.job.url)}>打开岗位</Button>
                      {p.status === 'failed' && !p.riskBlocked && (
                        <Button size="small" icon={<ReloadOutlined />} onClick={() => updatePending(p.id, { status: 'pending', retryCount: (p.retryCount || 0) + 1, error: '' })}>重试</Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ===== 日志 ===== */}
      <div className="log-block">
        <div className="log-head">沟通日志</div>
        {logs.length === 0 ? (
          <div style={{ padding: '14px 12px', color: 'var(--fg-muted)', fontSize: 12 }}>暂无消息</div>
        ) : (
          <div className="log-stream" ref={logRef} style={{ maxHeight: 260, overflow: 'auto' }}>
            {logs.slice(-60).map((l, i) => (
              <div className="log-line" key={`${l.time}-${i}`}>
                <span className="log-time">{new Date(l.time).toLocaleTimeString()}</span>
                <span className={'log-lv ' + (l.level || 'info')} />
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
