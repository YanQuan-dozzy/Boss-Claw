import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Alert, Button, Card, Input, InputNumber, Space, Switch, Tag, Typography, Upload, message, Modal, Progress,
} from 'antd';
import {
  MessageOutlined, QrcodeOutlined,
  ReloadOutlined, SafetyCertificateOutlined, StopOutlined, DeleteOutlined,
  UploadOutlined, CheckOutlined, CaretRightOutlined,
  LockOutlined, EyeOutlined, PictureOutlined, FileTextOutlined,
  UsergroupAddOutlined, SafetyOutlined, FieldTimeOutlined,
  ThunderboltOutlined, HourglassOutlined, PlusOutlined, CodeOutlined,
  RobotOutlined, SyncOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useAutoChatStore } from '@/store/useAutoChatStore';
import {
  camoufoxStatus, camoufoxLogin, camoufoxLogout,
  type CamoufoxStatus,
} from '@/lib/bossclaw/camoufox';
import { electronApi } from '@/lib/electronApi';
import {
  isLockedOut, cooldownRemaining, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { rerankPending } from '@/lib/bossclaw/priority';
import { cleanTitle, formatMetaLine } from '@/lib/bossclaw/jobDisplay';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import type { PendingItem, ImageResume } from '@/lib/bossclaw/types';
import { EmptyState } from '@/components/feedback';
import { ChatLogPanel } from '@/components/ChatLogPanel';

const { Text, Paragraph } = Typography;

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'gold', label: '待确认' },
  approved: { color: 'processing', label: '待沟通' },
  approved_queue: { color: 'cyan', label: '沟通中' },
  opened: { color: 'geekblue', label: '已打开' },
  failed: { color: 'error', label: '失败' },
  sent: { color: 'success', label: '已沟通' },
  skipped: { color: 'default', label: '已跳过' },
  ignored: { color: 'default', label: '已忽略' },
};

export default function AutoChat() {
  // ===== Store 订阅（按字段选择并使用 useShallow 避免全量重渲染） =====
  const pending = useDataStore(useShallow((s) => s.pending));
  const updatePending = useDataStore((s) => s.updatePending);
  const chatLogs = useDataStore(useShallow((s) => s.chatLogs));
  const clearChatLogs = useDataStore((s) => s.clearChatLogs);
  const recomputeStats = useDataStore((s) => s.recomputeStats);
  const imageResumes = useDataStore(useShallow((s) => s.imageResumes));
  const addImageResume = useDataStore((s) => s.addImageResume);
  const removeImageResume = useDataStore((s) => s.removeImageResume);
  const storeCommunicationInfo = useDataStore((s) => s.communicationInfo);
  const setCommunicationInfo = useDataStore((s) => s.setCommunicationInfo);
  const profile = useDataStore((s) => s.profile);

  const config = useSettingsStore(useShallow((s) => s.config));
  const setConfig = useSettingsStore((s) => s.setConfig);

  // ===== 自动沟通后台引擎（全局持久：切页仍继续运行，工作台新批准岗位自动加入）=====
  const chatRunning = useAutoChatStore((s) => s.chatRunning);
  const activeChatId = useAutoChatStore((s) => s.activeChatId);
  const progress = useAutoChatStore((s) => s.progress);
  const chatOne = useAutoChatStore((s) => s.chatOne);
  const start = useAutoChatStore((s) => s.start);
  const stop = useAutoChatStore((s) => s.stop);

  // ===== Camoufox 隐身引擎状态 =====
  const [cfx, setCfx] = useState<CamoufoxStatus | null>(null);
  const [cfxLoading, setCfxLoading] = useState(false);
  const [cfxLogining, setCfxLogining] = useState(false);
  const cfxConfig = useMemo(
    () => config.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false },
    [config.camoufox]
  );

  useEffect(() => { recomputeStats(); }, [pending, recomputeStats]);

  const refreshCamoufox = useCallback(async (silent = false) => {
    if (!silent) setCfxLoading(true);
    const s = await camoufoxStatus();
    setCfx(s);
    // 依赖安装中不算「不可用」，不自动关闭引擎开关
    if (!s.ready && !s.installing && cfxConfig.enabled) setConfig({ camoufox: { ...cfxConfig, enabled: false } });
    if (!silent) setCfxLoading(false);
  }, [cfxConfig, setConfig]);

  // 页面挂载时静默刷新引擎状态：跨路由重挂载后 `cfx` 会被重置为 null，导致误显示「引擎未就绪」。
  // 后台已预热，此处会即时返回就绪。
  useEffect(() => { refreshCamoufox(true); }, []);

  const onCamoufoxLogin = useCallback(async () => {
    setCfxLogining(true);
    try {
      const r = await camoufoxLogin(180, cfxConfig.os);
      if (r.ok && r.loggedIn) message.success('Camoufox 登录成功，会话 Cookie 已持久化');
      else message.warning(r.message || r.error || '登录未完成（可能超时或取消）');
    } catch (e: unknown) {
      message.error('登录失败：' + getErrorMessage(e));
    } finally {
      setCfxLogining(false);
      refreshCamoufox(true);
    }
  }, [cfxConfig.os, refreshCamoufox]);

  const onCamoufoxLogout = useCallback(() => {
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
  }, [refreshCamoufox]);

  // ===== 图片简历管理 =====
  const MAX_IMAGE_RESUMES = 4;
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const onImageResumeFile = useCallback((file: File) => {
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
  }, [imageResumes.length, addImageResume]);

  // ===== 派生计算与队列过滤缓存 =====
  const queueItems = useMemo(() => {
    return rerankPending(pending).filter((p) =>
      ['pending', 'approved', 'approved_queue', 'opened', 'failed', 'sent'].includes(p.status)
    );
  }, [pending]);

  const batchQueue = useMemo(() => {
    // 与后台引擎分工：本控制台只处理「已批准待沟通(approved)」与「已打开未发打招呼语(opened)」；
    // 投递中(approved_queue)归工作台「一键投递」，待确认(pending)不自动投递。
    return rerankPending(pending).filter((p) => p.status === 'approved' || p.status === 'opened');
  }, [pending]);

  const queueCount = useMemo(
    () => pending.filter((p) => p.status === 'approved' || p.status === 'opened').length,
    [pending]
  );
  const sentCount = useMemo(() => pending.filter((p) => p.status === 'sent').length, [pending]);
  const failedCount = useMemo(() => pending.filter((p) => p.status === 'failed').length, [pending]);

  const handleStartBatch = useCallback(async () => {
    if (!profile) { message.warning('请先在简历中心生成职业画像'); return; }
    if (isLockedOut(config)) {
      message.warning(`账号处于冷却期（剩余约 ${Math.ceil(cooldownRemaining(config) / 60000)} 分钟），暂不能自动沟通`);
      return;
    }
    const st = await camoufoxStatus();
    if (!st.ready) {
      message.warning('隐身引擎未就绪：' + (st.message || '请安装 Camoufox 隐身引擎内核（本地浏览器不可复用）'));
      return;
    }
    if (!batchQueue.length) {
      message.info('没有待沟通的岗位（请先在工作台确认岗位或批准进入队列）');
      return;
    }
    // 启动后台持久沟通：切到工作台仍继续运行，新批准的岗位会自动加入
    start();
  }, [profile, config, batchQueue, start]);

  return (
    <main className="page" aria-label="自动沟通控制台">
      {/* 顶部 Header 状态控制栏 */}
      <header className="page-head">
        <div>
          <h1 className="page-title">
            <MessageOutlined className="page-title-icon" aria-hidden="true" />自动沟通控制台
          </h1>
          <Paragraph className="page-sub">
            真正的浏览器自动化沟通：唤起独立可见窗口，模拟真实点击「立即沟通」并发送打招呼语，逐条批量代投已确认岗位。
          </Paragraph>
        </div>
        <div className="page-head-extra">
          <Space size={8}>
            <span className={`status-pill ${config.executionMode === 'auto' ? 'is-auto' : ''}`}>
              <span className="led-dot" />
              {config.executionMode === 'auto' ? '模式：全自动投递' : '模式：人工确认'}
            </span>
            <span className={`status-pill ${cfx?.ready ? 'is-ready' : 'is-warning'}`}>
              <span className="led-dot" />
              {cfx?.ready ? '隐身引擎已就绪' : '引擎未就绪'}
            </span>
            <span className={`status-pill ${isLockedOut(config) ? 'is-danger' : 'is-ready'}`}>
              <span className="led-dot" />
              {isLockedOut(config) ? '风控冷却中' : '安全监控正常'}
            </span>
          </Space>
        </div>
      </header>

      <div className="autochat-grid">
        {/* ===== 左侧主区域 (Main Console Stage) ===== */}
        <div className="autochat-main">
          {/* 隐身引擎控制卡片 */}
          <Card size="small" className="setting-card">
            <div className="autochat-control-bar">
              <div className="autochat-actions">
                <span style={{ fontSize: 15, fontWeight: 700, marginRight: 4 }}>隐身引擎投递控制</span>
                {chatRunning ? (
                  <Button type="primary" danger icon={<StopOutlined />} onClick={stop} className="btn-uniform">
                    停止沟通
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    icon={<CaretRightOutlined />}
                    onClick={handleStartBatch}
                    disabled={queueCount === 0}
                    className="btn-uniform btn-start-batch"
                  >
                    开始批量沟通
                  </Button>
                )}
                <Button onClick={() => refreshCamoufox()} loading={cfxLoading} icon={<ReloadOutlined />} className="btn-uniform">
                  检测状态
                </Button>
                <Button icon={<QrcodeOutlined />} loading={cfxLogining} disabled={Boolean(cfx?.engine?.loggedIn)} onClick={onCamoufoxLogin} className="btn-uniform">
                  {cfx?.engine?.loggedIn ? '已登录' : '扫码登录'}
                </Button>
                <Button danger icon={<StopOutlined />} disabled={!cfx?.engine?.loggedIn} onClick={onCamoufoxLogout} className="btn-uniform">
                  退出登录
                </Button>
              </div>

              <div className="autochat-metrics-row">
                <div className="autochat-metric-badge cyan">
                  待沟通 <span className="autochat-metric-num">{queueCount}</span>
                </div>
                <div className="autochat-metric-badge green">
                  已沟通 <span className="autochat-metric-num">{sentCount}</span>
                </div>
                <div className="autochat-metric-badge red">
                  失败 <span className="autochat-metric-num">{failedCount}</span>
                </div>
              </div>
            </div>

            {cfx?.installing ? (
              <Alert
                type="info"
                showIcon
                style={{ borderRadius: 10, marginTop: 12, marginBottom: 0 }}
                message="正在安装隐身引擎依赖"
                description={cfx?.message || '首次使用需安装 Python 依赖（playwright/camoufox），完成后请点击「检测状态」。'}
              />
            ) : cfx?.ready ? (
              <Paragraph type="secondary" style={{ margin: '12px 0 0', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Tag color="green" style={{ margin: 0, borderRadius: 4, fontWeight: 600 }}>
                  <RobotOutlined style={{ marginRight: 4 }} />
                  {cfx.engine?.kernel || '隐身内核就绪'}
                </Tag>
                <span>{cfx.engine?.kernelMessage || cfx.message}</span>
              </Paragraph>
            ) : (
              <Alert
                type="warning"
                showIcon
                style={{ borderRadius: 10, marginTop: 12, marginBottom: 0 }}
                message="隐身引擎当前不可用"
                description={cfx?.message || '请安装 Camoufox 隐身引擎内核（本地浏览器不可复用），或点击「检测状态」重新检查。'}
              />
            )}

            {chatRunning && progress.total > 0 && (
              <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--hover-bg)', borderRadius: 10, border: '1px dashed var(--border-brand)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Progress
                    percent={Math.round((progress.index / progress.total) * 100)}
                    size="small"
                    style={{ flex: 1 }}
                    strokeColor={{ from: '#14B8A6', to: '#0D9488' }}
                  />
                  <Text style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace' }}>
                    {progress.index} / {progress.total}
                  </Text>
                  <Tag color="processing" icon={<SyncOutlined spin />} style={{ margin: 0, borderRadius: 6, fontWeight: 600 }}>
                    独立窗口自动化沟通中...
                  </Tag>
                </div>
              </div>
            )}
          </Card>

          {/* 自动沟通岗位队列 */}
          <Card
            size="small"
            className="setting-card"
            title={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>
                  <MessageOutlined style={{ color: 'var(--brand)', marginRight: 8 }} />
                  待沟通岗位队列
                </span>
                <Tag color="cyan" style={{ margin: 0, borderRadius: 10, fontWeight: 600 }}>
                  {queueCount} 个岗位
                </Tag>
              </div>
            }
          >
            {queueItems.length === 0 ? (
              <EmptyState
                title="暂无待沟通岗位"
                description="请先在工作台搜索采集岗位并确认加入队列。"
              />
            ) : (
              <div className="wb-jobs">
                {queueItems.map((p: PendingItem) => {
                  const st = STATUS_TAG[p.status] || { color: 'default', label: p.status };
                  const isActive = p.id === activeChatId;
                  const canChat = p.status !== 'sent';
                  return (
                    <div key={p.id} className={'job-card' + (isActive ? ' is-active' : '')} style={{ marginBottom: 12 }}>
                      <div className="job-header">
                        <div className="job-header-main" style={{ minWidth: 0 }}>
                          <div className="job-title-row">
                            <div className="job-title">
                              {cleanTitle(p.job?.title, p.job?.salary)}
                              {p.job?.salary && <span className="job-salary-tag">{p.job.salary}</span>}
                            </div>
                            {p.priorityRank != null && <span className="score-rank">#{p.priorityRank}</span>}
                          </div>
                          <div className="job-company">{formatMetaLine(p.job?.company, p.job?.location, p.job?.salary)}</div>
                        </div>
                        <Tag color={st.color} style={{ margin: 0, flex: '0 0 auto', borderRadius: 6, fontWeight: 600 }}>
                          {st.label}
                        </Tag>
                      </div>
                      <div className="job-body" style={{ paddingTop: 10 }}>
                        <div className="job-greeting-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span>
                            <MessageOutlined style={{ color: 'var(--brand)', marginRight: 4 }} />
                            {isActive ? '正在沟通中，请勿遮挡浏览器窗口' : '沟通招呼语（可编辑）'}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                            {(p.deliveryGreeting || p.analysis?.greeting || '').length} 字
                          </span>
                        </div>
                        <Input.TextArea
                          value={p.deliveryGreeting || p.analysis?.greeting || ''}
                          onChange={(e) => updatePending(p.id, { deliveryGreeting: e.target.value })}
                          autoSize={{ minRows: 2, maxRows: 5 }}
                          placeholder="请输入你希望发送给招聘方的求职招呼语"
                          disabled={p.status === 'sent'}
                          style={{ fontSize: 12, lineHeight: 1.65, borderRadius: 8 }}
                        />
                      </div>
                      {p.error && <div className="job-error">⚠ {p.error}</div>}
                      <div className="job-actions" style={{ marginTop: 10 }}>
                        <div className="job-actions-right">
                          {canChat ? (
                            <Button
                              size="small"
                              type="primary"
                              icon={<MessageOutlined />}
                              loading={isActive}
                              disabled={chatRunning && !isActive}
                              onClick={() => chatOne(p)}
                              style={{ borderRadius: 6 }}
                            >
                              沟通
                            </Button>
                          ) : (
                            <Button size="small" type="primary" icon={<CheckOutlined />} disabled style={{ borderRadius: 6 }}>
                              已沟通
                            </Button>
                          )}
                        </div>
                        <div className="job-actions-left">
                          <Button size="small" icon={<EyeOutlined />} onClick={() => p.job?.url && electronApi.external.open(p.job.url)} style={{ borderRadius: 6 }}>
                            打开岗位
                          </Button>
                          {p.status === 'failed' && !p.riskBlocked && (
                            <Button
                              size="small"
                              icon={<ReloadOutlined />}
                              onClick={() => updatePending(p.id, { status: 'pending', retryCount: (p.retryCount || 0) + 1, error: '' })}
                              style={{ borderRadius: 6 }}
                            >
                              重试
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 实时沟通专属终端日志 */}
          <ChatLogPanel
            logs={chatLogs}
            onClear={clearChatLogs}
            isRunning={chatRunning}
            maxHeight={340}
          />
        </div>

        {/* ===== 右侧配置侧栏 (Sidebar Panel Stage) ===== */}
        <div className="autochat-side">
          {/* 沟通与附件设置 */}
          <Card size="small" className="setting-card" title={<><SafetyCertificateOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 沟通与附件设置</>}>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PictureOutlined style={{ color: 'var(--brand)' }} />
                  发送简历图片附件
                </div>
                <div className="setting-row__desc">沟通气泡确认后自动发送</div>
              </div>
              <div className="setting-row__control"><Switch checked={config.sendResumeImage} onChange={(v) => setConfig({ sendResumeImage: v })} /></div>
            </div>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FileTextOutlined style={{ color: 'var(--brand)' }} />
                  发送在线简历
                </div>
                <div className="setting-row__desc">同步 BOSS 直聘在线简历</div>
              </div>
              <div className="setting-row__control"><Switch checked={config.sendOnlineResume} onChange={(v) => setConfig({ sendOnlineResume: v })} /></div>
            </div>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <UsergroupAddOutlined style={{ color: 'var(--brand)' }} />
                  排除猎头岗位
                </div>
                <div className="setting-row__desc">自动跳过猎头招聘岗位</div>
              </div>
              <div className="setting-row__control"><Switch checked={config.excludeHeadhunters} onChange={(v) => setConfig({ excludeHeadhunters: v })} /></div>
            </div>

            {/* 图片简历 2x2 缩略图网格 */}
            <div className="field-group" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>图片简历附件 ({imageResumes.length}/4)</span>
                <Upload accept=".jpg,.jpeg,.png" showUploadList={false} beforeUpload={(f) => { onImageResumeFile(f as unknown as File); return false; }}>
                  <Button size="small" icon={<UploadOutlined />} disabled={imageResumes.length >= MAX_IMAGE_RESUMES}>
                    上传
                  </Button>
                </Upload>
              </div>

              <div className="image-resume-grid">
                {imageResumes.map((r: ImageResume) => (
                  <div key={r.id} className="image-resume-card">
                    <img src={r.data} alt={r.name} />
                    <div className="ir-overlay">
                      <span className="ir-name-overlay">{r.name}</span>
                      <Button
                        size="small"
                        type="primary"
                        danger
                        shape="circle"
                        icon={<DeleteOutlined />}
                        onClick={() => removeImageResume(r.id)}
                      />
                    </div>
                  </div>
                ))}

                {imageResumes.length < MAX_IMAGE_RESUMES && (
                  <Upload
                    accept=".jpg,.jpeg,.png"
                    showUploadList={false}
                    beforeUpload={(f) => { onImageResumeFile(f as unknown as File); return false; }}
                    style={{ width: '100%' }}
                  >
                    <div className="image-resume-upload-card">
                      <PlusOutlined style={{ fontSize: 18 }} />
                      <span style={{ fontSize: 11, fontWeight: 500 }}>上传简历图片</span>
                    </div>
                  </Upload>
                )}
              </div>
            </div>
          </Card>

          {/* 沟通信息（AI 跟聊引用：面试时间/到岗时间等，用户自行填写） */}
          <Card
            size="small"
            className="setting-card"
            title={<><CodeOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 沟通信息（AI 跟聊引用）</>}
          >
            <Paragraph type="secondary" style={{ margin: '0 0 8px', fontSize: 12 }}>
              填写你要提供给 HR 的真实信息（如薪资期望、面试时间、到岗时间等）。AI 跟聊回复 HR 时会引用其中填写的内容；留空则维持原有回复风格，不承诺任何这类信息。输入后自动保存。
            </Paragraph>
            <Input.TextArea
              value={storeCommunicationInfo}
              onChange={(e) => setCommunicationInfo(e.target.value)}
              rows={4}
              placeholder={'例：\n薪资期望：XK 或面议\n可面试时间：本周工作日晚上或周末\n可到岗时间：随时可到岗（或 3 月 1 日）'}
              style={{
                fontSize: 12,
                lineHeight: 1.6,
                borderRadius: 8,
                background: 'var(--bg)',
              }}
            />
          </Card>

          {/* 账号安全与防封号 Rate Limit Cards */}
          <Card size="small" className="setting-card" title={<><LockOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 防封号节奏限制</>}>
            {isLockedOut(config) && (
              <Alert
                type="warning"
                showIcon
                style={{ borderRadius: 8, marginBottom: 12 }}
                message={`账号处于冷却期，剩余约 ${Math.ceil(cooldownRemaining(config) / 60000)} 分钟`}
              />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="stat-input-card">
                <span className="sic-label">
                  <SafetyOutlined className="sic-icon" />
                  每日上限
                </span>
                <div className="sic-input-wrap">
                  <InputNumber
                    min={1}
                    max={SAFETY_LIMITS.MAX_SAFE_DAILY}
                    value={config.maxDailySent}
                    onChange={(v) => setConfig({ maxDailySent: v ?? 120 })}
                    style={{ width: '100%' }}
                  />
                  <span className="sic-unit">条/日</span>
                </div>
              </div>

              <div className="stat-input-card">
                <span className="sic-label">
                  <FieldTimeOutlined className="sic-icon" />
                  岗位间隔
                </span>
                <div className="sic-input-wrap">
                  <InputNumber
                    min={15}
                    max={600}
                    value={config.betweenJobsSeconds}
                    onChange={(v) => setConfig({ betweenJobsSeconds: v ?? 20 })}
                    style={{ width: '100%' }}
                  />
                  <span className="sic-unit">秒</span>
                </div>
              </div>

              <div className="stat-input-card">
                <span className="sic-label">
                  <ThunderboltOutlined className="sic-icon" />
                  每分动作
                </span>
                <div className="sic-input-wrap">
                  <InputNumber
                    min={1}
                    max={15}
                    value={config.maxActionsPerMinute}
                    onChange={(v) => setConfig({ maxActionsPerMinute: v ?? 6 })}
                    style={{ width: '100%' }}
                  />
                  <span className="sic-unit">次/分</span>
                </div>
              </div>

              <div className="stat-input-card">
                <span className="sic-label">
                  <HourglassOutlined className="sic-icon" />
                  风控冷却
                </span>
                <div className="sic-input-wrap">
                  <InputNumber
                    min={5}
                    max={720}
                    value={config.autoCooldownMinutes}
                    onChange={(v) => setConfig({ autoCooldownMinutes: v ?? 30 })}
                    style={{ width: '100%' }}
                  />
                  <span className="sic-unit">分钟</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
