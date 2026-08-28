import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  UploadOutlined,
  ClearOutlined,
  BgColorsOutlined,
  ApiOutlined,
  SettingOutlined,
  StopOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  QrcodeOutlined,
  PoweroffOutlined,
  RobotOutlined,
  DatabaseOutlined,
  FilterOutlined,
  AimOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useSettingsStore, PROVIDER_DEFAULTS } from '@/store/useSettingsStore';
import { useAppStore, ThemeMode } from '@/store/useAppStore';
import { callModel, clearAICache, getAICacheStats, getLLMUsageStats, resetLLMUsageStats } from '@/lib/bossclaw/llm';
import { exportData, importData, clearAllData } from '@/lib/storage';
import { bridgeStatus } from '@/lib/bridgeClient';
import { HR_ACTIVITY_FILTER_OPTIONS } from '@/lib/bossclaw/hrActivity';
import { INTERVIEW_MODE_FILTER_OPTIONS } from '@/lib/bossclaw/interviewMode';
import { CHINA_PROVINCES } from '@/lib/bossclaw/locationFilter';
import { camoufoxStatus, camoufoxLogin, camoufoxLogout, camoufoxStop, type CamoufoxStatus } from '@/lib/bossclaw/camoufox';
import type { LLMProvider } from '@/store/useSettingsStore';

const { Paragraph, Text } = Typography;

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: 'light', label: '浅色模式' },
  { key: 'dark', label: '深色模式' },
  { key: 'system', label: '跟随系统' },
];

export default function Settings() {
  const { config, setConfig, setModel, applyProviderDefaults, isLLMConfigured } = useSettingsStore();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setRoute = useAppStore((s) => s.setRoute);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [aiCacheStats, setAiCacheStats] = useState<ReturnType<typeof getAICacheStats> | null>(null);
  const [llmUsage, setLlmUsage] = useState<ReturnType<typeof getLLMUsageStats> | null>(null);

  const refreshAICacheStats = () => {
    setAiCacheStats(getAICacheStats());
    setLlmUsage(getLLMUsageStats());
  };
  useEffect(() => {
    refreshAICacheStats();
  }, []);

  const [bridge, setBridge] = useState<{ ok: boolean; version?: string } | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  // ===== Camoufox 隐身引擎（设置页检测与操作）=====
  const [cfx, setCfx] = useState<CamoufoxStatus | null>(null);
  const [cfxLoading, setCfxLoading] = useState(false);
  const [cfxLogining, setCfxLogining] = useState(false);
  const cfxConfig = config.camoufox || { enabled: false, os: 'windows', pages: 1, prefer: false };

  // ===== CloakBrowser 隐身浏览器（设置页检测与操作）=====
  const [cloakBinaryInfo, setCloakBinaryInfo] = useState<any>(null);
  const [cloakReady, setCloakReady] = useState(false);
  const [cloakBinaryLoading, setCloakBinaryLoading] = useState(false);

  // 当前引擎是否就绪（用于 Card 角标）：webview 始终可用；cloak 看 cloakReady；camoufox 看 cfx.ready
  const engineReady = config.engineMode === 'webview' || (config.engineMode === 'cloak' ? cloakReady : (cfx?.ready ?? false));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cloakE: any = (typeof window !== 'undefined' ? window.electron : undefined) || {};

  // 页面首次加载时静默刷新连接状态
  useEffect(() => {
    refreshBridge();
    refreshCamoufox(true);
    if (cloakE.cloakStatus) {
      cloakE.cloakStatus().then((st: any) => setCloakReady(Boolean(st?.ready))).catch(() => {});
    }
  }, []);

  const refreshCloakBinary = async () => {
    if (!cloakE.cloakBinary) return;
    setCloakBinaryLoading(true);
    try {
      const r = await cloakE.cloakBinary();
      setCloakBinaryInfo(r.binary || r);
      const st = await cloakE.cloakStatus();
      setCloakReady(Boolean(st?.ready));
    } catch (err) {
      message.error('CloakBrowser 检测失败：' + ((err as any)?.message || err));
    } finally {
      setCloakBinaryLoading(false);
    }
  };

  const onCloakStop = async () => {
    try {
      await cloakE.cloakStop();
      setCloakReady(false);
      message.success('已停止 CloakBrowser 引擎');
    } catch (err: any) {
      message.error('停止失败：' + (err?.message || err));
    }
  };

  const refreshCamoufox = async (silent = false) => {
    if (!silent) setCfxLoading(true);
    const s = await camoufoxStatus();
    setCfx(s);
    if (!s.ready && cfxConfig.enabled) setConfig({ camoufox: { ...cfxConfig, enabled: false } });
    if (!silent) setCfxLoading(false);
  };

  const onCamoufoxLogin = async () => {
    setCfxLogining(true);
    try {
      const r = await camoufoxLogin(180, cfxConfig.os);
      if (r.ok && r.loggedIn) {
        message.success('Camoufox 登录成功，会话 Cookie 已持久化');
      } else {
        message.warning(r.message || r.error || '登录未完成（可能超时或取消）');
      }
    } catch (e: any) {
      message.error('登录失败：' + (e?.message || e));
    } finally {
      setCfxLogining(false);
      refreshCamoufox(true);
    }
  };

  const onCamoufoxLogout = async () => {
    Modal.confirm({
      title: '退出 Camoufox 登录态？',
      content: '将清除 Camoufox 会话 Cookie，隐身搜索/发送将需要重新扫码登录。',
      okText: '确认退出',
      cancelText: '取消',
      onOk: async () => {
        await camoufoxLogout();
        message.success('已清除 Camoufox 会话');
        refreshCamoufox(true);
      },
    });
  };

  const onCamoufoxStop = () => {
    camoufoxStop();
    setCfx((s) => (s ? { ...s, running: false, ready: false } : s));
    message.info('已停止 Camoufox 桥（下次使用会自动重启）');
  };

  const refreshBridge = async () => {
    setBridgeLoading(true);
    const s = await bridgeStatus();
    setBridge(s as any);
    setBridgeLoading(false);
  };

  const testConnection = async () => {
    if (!isLLMConfigured()) {
      message.warning('请先填写 Base URL / API Key / 模型名');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await callModel([{ role: 'user', content: 'ping' }], config.model, { jsonMode: false, maxTokens: 128, temperature: 0 });
      const msg = typeof r === 'string' ? r.slice(0, 60) : JSON.stringify(r).slice(0, 60);
      setTestResult({ ok: true, msg });
      message.success('LLM 连接成功！');
    } catch (e: any) {
      const msg = e?.message || String(e);
      setTestResult({ ok: false, msg });
      message.error('连接失败：' + msg);
    } finally {
      setTesting(false);
    }
  };

  const onExport = () => {
    const json = exportData();
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bossclaw-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('已导出数据备份');
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const json = await file.text();
      const r = importData(json);
      if (!r.ok) { message.error('导入失败：' + (r.error || '格式错误')); return; }
      message.success('导入成功，正在刷新数据…');
      setTimeout(() => window.location.reload(), 600);
    } catch (err: any) {
      message.error('导入失败：' + (err?.message || err));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const onClear = () => {
    Modal.confirm({
      title: '清空全部本地数据？',
      content: '将删除简历原文、职业画像、投递方向、任务记录与全部设置（包括 LLM 配置）。此操作不可恢复，建议先导出备份。',
      okText: '确认清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        clearAllData();
        message.success('已清空本地数据，正在刷新…');
        setTimeout(() => window.location.reload(), 600);
      },
    });
  };

  const llmReady = isLLMConfigured();

  // 定义 5 大分类 Tab
  const tabItems = [
    {
      key: 'appearance',
      label: (
        <span>
          <BgColorsOutlined style={{ marginRight: 6 }} />
          常规与外观
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <RobotOutlined />
                </div>
                执行模式
              </div>
              <Tag color={config.executionMode === 'auto' ? 'purple' : 'blue'}>
                {config.executionMode === 'auto' ? '全自动投递' : '人工确认 (半自动)'}
              </Tag>
            </div>
            <Segmented
              className="setting-segmented"
              size="large"
              value={config.executionMode === 'auto' ? 'auto' : 'review'}
              onChange={(v) => setConfig({ executionMode: v as 'auto' | 'review' })}
              options={[
                { label: '人工确认 (半自动)', value: 'review' },
                { label: '全自动投递', value: 'auto' },
              ]}
            />
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              {config.executionMode === 'auto'
                ? '全自动投递：岗位由 AI 评估符合要求后，自动确认并直接进入投递队列唤起沟通。'
                : '人工确认：由 AI 筛选评分后，岗位保留在待确认队列，需在工作台手动点击「确认」或「批量确认」后才进入投递队列。'}
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <BgColorsOutlined />
                </div>
                界面主题
              </div>
            </div>
            <Segmented
              className="setting-segmented"
              size="large"
              value={theme}
              onChange={(v) => setTheme(v as ThemeMode)}
              options={THEME_OPTIONS.map((opt) => ({ label: opt.label, value: opt.key }))}
            />
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              主题偏好自动持久化保存在本机 localStorage；选择「跟随系统」时将随操作系统的浅色 / 深色偏好实时切换。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <QrcodeOutlined />
                </div>
                内置浏览器标签页管理
              </div>
            </div>
            <div className="safety-grid">
              <div className="sg-item">
                <span className="field-label">自动关闭闲置标签页</span>
                <Switch
                  checked={config.autoCloseIdleTabs}
                  onChange={(v) => setConfig({ autoCloseIdleTabs: v })}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">闲置关闭阈值（分钟）</span>
                <InputNumber
                  min={1}
                  max={120}
                  disabled={!config.autoCloseIdleTabs}
                  value={config.idleCloseMinutes}
                  onChange={(v) => setConfig({ idleCloseMinutes: v ?? 5 })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              开启后，超过设定时长未被切换或导航的后台标签页将自动关闭；当前正在查看的标签页不会被关闭，且系统会自动保留至少一个标签页，保证浏览器始终可用。
            </Paragraph>
          </div>
        </div>
      ),
    },

    {
      key: 'criteria',
      label: (
        <span>
          <FilterOutlined style={{ marginRight: 6 }} />
          求职偏好
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <AimOutlined />
                </div>
                基础求职条件
              </div>
            </div>
            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">目标城市（逗号分隔）</span>
                <Input
                  value={config.targetLocations.join(',')}
                  onChange={(e) =>
                    setConfig({
                      targetLocations: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="北京,上海,杭州"
                />
              </div>
              <div className="sg-item">
                <span className="field-label">薪资期望</span>
                <Input
                  value={config.salary}
                  onChange={(e) => setConfig({ salary: e.target.value })}
                  placeholder="不限 / 15-25K"
                />
              </div>
              <div className="sg-item">
                <span className="field-label">求职类型</span>
                <Select
                  mode="tags"
                  style={{ width: '100%' }}
                  value={config.employmentTypes}
                  onChange={(v) => setConfig({ employmentTypes: v })}
                  options={['不限', '全职', '实习', '校招', '兼职'].map((x) => ({ label: x, value: x }))}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">学历要求</span>
                <Select
                  mode="tags"
                  style={{ width: '100%' }}
                  value={config.degrees}
                  onChange={(v) => setConfig({ degrees: v })}
                  options={['不限', '大专', '本科', '硕士', '博士'].map((x) => ({ label: x, value: x }))}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">经验要求</span>
                <Select
                  mode="tags"
                  style={{ width: '100%' }}
                  value={config.experiences}
                  onChange={(v) => setConfig({ experiences: v })}
                  options={['不限', '在校生', '应届生', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'].map((x) => ({
                    label: x,
                    value: x,
                  }))}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">每日目标投递数</span>
                <InputNumber
                  min={0}
                  value={config.dailyTarget}
                  onChange={(v) => setConfig({ dailyTarget: v ?? 0 })}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">最低匹配要求分</span>
                <InputNumber
                  min={0}
                  max={100}
                  value={config.minScore}
                  onChange={(v) => setConfig({ minScore: v ?? 75 })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <SafetyCertificateOutlined />
                </div>
                硬性智能过滤
              </div>
            </div>
            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">HR 活跃度过滤</span>
                <Select
                  style={{ width: '100%' }}
                  value={config.hrActivityFilter || 'any'}
                  onChange={(v) => setConfig({ hrActivityFilter: v })}
                  options={HR_ACTIVITY_FILTER_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">面试方式筛选</span>
                <Select
                  style={{ width: '100%' }}
                  value={config.interviewModeFilter || 'any'}
                  onChange={(v) => setConfig({ interviewModeFilter: v })}
                  options={INTERVIEW_MODE_FILTER_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              HR 活跃度与面试方式过滤按设定的规则确定性跳过岗位（由页面解析 + 用户阈值共同判定，不消耗 AI Token）。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <StopOutlined />
                </div>
                城市反选黑名单（确定性过滤）
              </div>
              <Space>
                <Tag color="red">已排除 {config.excludedProvinces.length} 省</Tag>
                <Tag color="volcano">已排除 {config.excludedCities.length} 市</Tag>
              </Space>
            </div>
            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">排除省份 / 直辖市 / 自治区</span>
                <Select
                  mode="multiple"
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="选择省份，如 浙江 / 广东 / 北京"
                  value={config.excludedProvinces}
                  onChange={(v) => setConfig({ excludedProvinces: v })}
                  options={CHINA_PROVINCES.map((p) => ({ label: p, value: p }))}
                  maxTagCount="responsive"
                />
              </div>
              <div className="sg-item wide">
                <span className="field-label">排除城市（输入城市名）</span>
                <Select
                  mode="tags"
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="输入城市名，回车添加，如 杭州"
                  value={config.excludedCities}
                  onChange={(v) =>
                    setConfig({
                      excludedCities: (v as string[]).map((s) => String(s).trim()).filter(Boolean),
                    })
                  }
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              城市反选为确定性过滤（不依赖 AI）：加入任务的岗位所在地若命中上述省份或城市，会被自动跳过、不进入投递队列。与「目标城市」互补。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <StopOutlined />
                </div>
                公司 / 招聘方黑名单（确定性过滤）
              </div>
              <Space>
                <Tag color="red">屏蔽 {config.excludedCompanies?.length || 0} 家公司</Tag>
                <Tag color="volcano">屏蔽 {config.excludedRecruiters?.length || 0} 位招聘方</Tag>
              </Space>
            </div>
            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">不想投的公司（输入公司名）</span>
                <Select
                  mode="tags"
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="输入公司名，回车添加，如 人力资源"
                  value={config.excludedCompanies || []}
                  onChange={(v) =>
                    setConfig({
                      excludedCompanies: (v as string[]).map((s) => String(s).trim()).filter(Boolean),
                    })
                  }
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </div>
              <div className="sg-item wide">
                <span className="field-label">不想沟通的招聘方 / HR（输入姓名）</span>
                <Select
                  mode="tags"
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="输入招聘方姓名，回车添加，如 王老师"
                  value={config.excludedRecruiters || []}
                  onChange={(v) =>
                    setConfig({
                      excludedRecruiters: (v as string[]).map((s) => String(s).trim()).filter(Boolean),
                    })
                  }
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              公司 / 招聘方黑名单为确定性过滤（不依赖 AI）：加入任务的岗位若公司名或招聘方姓名命中黑名单（支持子串匹配），会被自动跳过、不进入投递队列。与「城市反选」互补。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <SearchOutlined />
                </div>
                搜索采集范围控制
              </div>
            </div>
            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">采集时自动下拉加载更多</span>
                <div>
                  <Switch
                    checked={config.listAutoScroll !== false}
                    onChange={(v) => setConfig({ listAutoScroll: v })}
                  />
                </div>
              </div>
              <div className="sg-item">
                <span className="field-label">自动下拉最大轮数</span>
                <InputNumber
                  min={1}
                  max={40}
                  value={config.listScrollRounds || 12}
                  onChange={(v) => setConfig({ listScrollRounds: v ?? 12 })}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">可视化采集滚动间隔（毫秒）</span>
                <Slider
                  min={400}
                  max={3000}
                  step={100}
                  value={config.collectSpeedMs || 1500}
                  onChange={(v) => setConfig({ collectSpeedMs: v })}
                  tooltip={{ formatter: (v) => `${v}ms` }}
                  style={{ margin: '6px 8px 0 0' }}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">断点续采起始序号</span>
                <InputNumber
                  min={0}
                  value={config.collectResumeIndex || 0}
                  onChange={(v) => setConfig({ collectResumeIndex: Math.max(0, v ?? 0) })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              开启后，每次「搜索采集」会自动将 BOSS 岗位列表向下滑动以加载无限列表。已入库岗位将自动根据 URL 去重跳过。
            </Paragraph>
          </div>
        </div>
      ),
    },

    {
      key: 'llm',
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 6 }} />
          AI / LLM 配置
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <RobotOutlined />
                </div>
                大模型服务商与 API 接入
              </div>
              <Tag color={llmReady ? 'green' : 'orange'}>
                {llmReady ? '配置完整' : '待完善配置'}
              </Tag>
            </div>

            <div className="settings-grid">
              <div className="sg-item">
                <span className="field-label">服务商预设</span>
                <Select
                  style={{ width: '100%' }}
                  value={config.model.provider as LLMProvider}
                  onChange={(p) => {
                    applyProviderDefaults(p);
                    setTestResult(null);
                    message.success(`已套用 ${PROVIDER_DEFAULTS[p].label} 默认端点（可继续修改）`);
                  }}
                  options={(Object.keys(PROVIDER_DEFAULTS) as LLMProvider[]).map((p) => ({
                    label: PROVIDER_DEFAULTS[p].label,
                    value: p,
                  }))}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">Base URL</span>
                <Input
                  value={config.model.baseUrl}
                  onChange={(e) => { setModel({ baseUrl: e.target.value }); setTestResult(null); }}
                  placeholder="https://api.deepseek.com"
                />
              </div>
              <div className="sg-item wide">
                <span className="field-label">模型名称</span>
                <AutoComplete
                  style={{ width: '100%' }}
                  value={config.model.model}
                  onChange={(v) => { setModel({ model: v }); setTestResult(null); }}
                  options={(PROVIDER_DEFAULTS[config.model.provider as LLMProvider]?.models || []).map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  placeholder="选择或输入模型名"
                  filterOption={(input, option) =>
                    String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </div>
            </div>

            <div className="sg-item" style={{ marginTop: 16 }}>
              <span className="field-label">API Key</span>
              <div className="llm-keyrow">
                <Input.Password
                  value={config.model.apiKey}
                  onChange={(e) => { setModel({ apiKey: e.target.value }); setTestResult(null); }}
                  placeholder="sk-..."
                />
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  loading={testing}
                  onClick={testConnection}
                  className="btn-uniform"
                >
                  测试连接
                </Button>
              </div>
            </div>

            {testResult && (
              <Alert
                style={{ marginTop: 14, borderRadius: 8 }}
                type={testResult.ok ? 'success' : 'error'}
                showIcon
                message={testResult.ok ? 'LLM 接口连接成功' : 'LLM 接口连接失败'}
                description={testResult.msg}
              />
            )}

            <Paragraph type="secondary" style={{ marginTop: 14, marginBottom: 0, fontSize: 13 }}>
              🔒 API Key 仅加密保存在本机 localStorage，绝不会上传至第三方服务器。未配置时职业画像与岗位匹配将自动回退到本地规则初稿。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <DatabaseOutlined />
                </div>
                AI 结果缓存
              </div>
              <Tag color="blue">省流</Tag>
            </div>

            <Paragraph type="secondary" style={{ marginBottom: 14, fontSize: 13 }}>
              职业画像、岗位分析、打招呼语的 AI 生成结果会在本机缓存。相同输入（简历、画像、岗位、提示词均未变化）再次使用时直接命中缓存，
              不再调用模型计费；修改简历、提示词或模型参数后自动生成新结果。缓存仅保存在本机。
            </Paragraph>

            <div className="sg-item" style={{ marginBottom: 0 }}>
              <span className="field-label">本机缓存</span>
              <div className="llm-keyrow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {aiCacheStats ? (
                    <>
                      <Tag>{aiCacheStats.entries} 条结果</Tag>
                      <Tag>累计命中 {aiCacheStats.hits} 次</Tag>
                      <Tag>累计生成 {aiCacheStats.misses} 次</Tag>
                      <Tag>占用约 {(aiCacheStats.totalBytes / 1024).toFixed(0)} KB</Tag>
                    </>
                  ) : (
                    <Tag>读取中…</Tag>
                  )}
                </div>
                <Button
                  icon={<ClearOutlined />}
                  onClick={() => {
                    const count = clearAICache();
                    refreshAICacheStats();
                    message.success(count > 0 ? `已清空 ${count} 条 AI 缓存` : '缓存已为空');
                  }}
                  className="btn-uniform"
                >
                  清空缓存
                </Button>
              </div>
            </div>

            <div className="sg-item" style={{ marginTop: 14, marginBottom: 0 }}>
              <span className="field-label">服务端缓存</span>
              <div className="llm-keyrow">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {llmUsage ? (
                    <>
                      <Tag>{llmUsage.requests} 次请求</Tag>
                      <Tag>缓存命中 {llmUsage.cacheHitTokens.toLocaleString()} tokens</Tag>
                      <Tag>缓存未命中 {llmUsage.cacheMissTokens.toLocaleString()} tokens</Tag>
                      {llmUsage.cacheHitTokens + llmUsage.cacheMissTokens > 0 ? (
                        <Tag color={llmUsage.cacheHitTokens / (llmUsage.cacheHitTokens + llmUsage.cacheMissTokens) >= 0.5 ? 'green' : 'orange'}>
                          命中率 {Math.round((llmUsage.cacheHitTokens / (llmUsage.cacheHitTokens + llmUsage.cacheMissTokens)) * 100)}%
                        </Tag>
                      ) : null}
                    </>
                  ) : (
                    <Tag>读取中…</Tag>
                  )}
                </div>
                <Button
                  onClick={() => {
                    resetLLMUsageStats();
                    refreshAICacheStats();
                  }}
                  className="btn-uniform"
                >
                  清零统计
                </Button>
              </div>
              <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                记录本会话调用模型时返回的 prompt_cache_hit/miss_tokens。命中率越高说明请求前缀越稳定，账单中的「输入(缓存命中)」越多
                （DeepSeek 等供应商命中价约为未命中价的 1/10）。画像/简历/提示词未变化时，连续分析岗位应保持高命中率。
              </Paragraph>
            </div>
          </div>
        </div>
      ),
    },

    {
      key: 'engine',
      label: (
        <span>
          <ThunderboltOutlined style={{ marginRight: 6 }} />
          隐身引擎与桥接
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <ThunderboltOutlined />
                </div>
                内置浏览器底座引擎
              </div>
              <Tag color={config.engineMode === 'webview' ? 'blue' : engineReady ? 'green' : 'orange'}>
                {config.engineMode === 'webview' ? 'WebView（默认）' : engineReady ? '引擎就绪' : '未就绪'}
              </Tag>
            </div>

            <Segmented
              className="setting-segmented"
              size="large"
              value={config.engineMode}
              onChange={(v) => {
                const next = v as 'webview' | 'cloak' | 'camoufox';
                setConfig({
                  engineMode: next,
                  camoufox: { ...cfxConfig, enabled: next === 'camoufox' },
                });
                if (next === 'webview') message.success('已切换回 Electron <webview> 引擎（默认底座）');
                else if (next === 'cloak') message.success('已切换到 CloakBrowser 隐身浏览器');
                else message.success('已切换到 Camoufox 隐身引擎');
              }}
              options={[
                { label: 'WebView（默认）', value: 'webview' },
                { label: 'CloakBrowser', value: 'cloak' },
                { label: 'Camoufox', value: 'camoufox' },
              ]}
            />
            <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
              可在三种引擎间切换：WebView 为 Electron 原生底座；CloakBrowser 与 Camoufox 为可选隐身增强（降低误判机器人概率）。切换后需刷新工作台生效。
            </Paragraph>

            {config.engineMode === 'webview' && (
              <Alert
                type="info"
                showIcon
                style={{ borderRadius: 8, marginTop: 14 }}
                message="当前使用默认 WebView 引擎"
                description="内置浏览器使用 Electron <webview> 加载 BOSS 直聘，无需额外依赖，登录态由 WebContents 会话自动持久化。"
              />
            )}

            {config.engineMode === 'cloak' && (
              <div className="field-group" style={{ marginTop: 14 }}>
                <div className="field-group__title">
                  <RobotOutlined className="fg-icon" /> CloakBrowser 隐身浏览器面板
                </div>
                <div className="setting-actions" style={{ marginBottom: 12 }}>
                  <Space>
                    <Button size="middle" onClick={refreshCloakBinary} loading={cloakBinaryLoading}>
                      检测状态
                    </Button>
                    {cloakReady && (
                      <Button size="middle" danger icon={<PoweroffOutlined />} onClick={onCloakStop}>
                        停止引擎
                      </Button>
                    )}
                  </Space>
                </div>
                {!cloakBinaryInfo?.installed && !cloakReady && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ borderRadius: 8, marginBottom: 10 }}
                    message="首次使用将自动缓存隐身 Chromium 二进制（缓存于 ~/.cloakbrowser/）"
                  />
                )}
                {cloakBinaryInfo && (
                  <div className="settings-grid">
                    <div className="sg-item">
                      <span className="field-label">引擎诊断</span>
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <div>已安装：{String(Boolean(cloakBinaryInfo.installed))}</div>
                        <div>版本：{cloakBinaryInfo.version || '-'}</div>
                        <div>路径：{cloakBinaryInfo.binaryPath || '-'}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {config.engineMode === 'camoufox' && (
              <div className="field-group" style={{ marginTop: 14 }}>
                <div className="field-group__title">
                  <ThunderboltOutlined className="fg-icon" /> Camoufox 隐身引擎面板
                </div>
                <div className="setting-actions" style={{ marginBottom: 12 }}>
                  <Space>
                    <Button size="middle" onClick={() => refreshCamoufox()} loading={cfxLoading}>
                      检测状态
                    </Button>
                    {cfx?.running && (
                      <Button size="middle" danger icon={<PoweroffOutlined />} onClick={onCamoufoxStop}>
                        停止桥
                      </Button>
                    )}
                  </Space>
                </div>
                {!cfx?.ready && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ borderRadius: 8, marginBottom: 10 }}
                    message="隐身引擎未就绪"
                    description={cfx?.message || '请确认已安装系统 Chrome/Edge/Firefox 内核，或点击「检测状态」。'}
                  />
                )}
                <div className="settings-grid">
                  <div className="sg-item">
                    <span className="field-label">指纹伪装系统</span>
                    <Select
                      style={{ width: '100%' }}
                      value={cfxConfig.os}
                      onChange={(v) => setConfig({ camoufox: { ...cfxConfig, os: v } })}
                      options={[
                        { label: 'Windows（推荐）', value: 'windows' },
                        { label: 'macOS', value: 'macos' },
                        { label: 'Linux', value: 'linux' },
                      ]}
                    />
                  </div>
                  <div className="sg-item">
                    <span className="field-label">隐身搜索页数</span>
                    <InputNumber
                      min={1}
                      max={5}
                      value={cfxConfig.pages}
                      onChange={(v) => setConfig({ camoufox: { ...cfxConfig, pages: v ?? 1 } })}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                <div className="setting-actions" style={{ marginTop: 12 }}>
                  <Space wrap>
                    <Text>优先隐身通道</Text>
                    <Switch
                      checked={cfxConfig.prefer}
                      onChange={(v) => setConfig({ camoufox: { ...cfxConfig, prefer: v } })}
                    />
                    <Button
                      size="middle"
                      icon={<QrcodeOutlined />}
                      loading={cfxLogining}
                      disabled={!cfx?.ready && !cfxConfig.enabled}
                      onClick={onCamoufoxLogin}
                    >
                      隐身扫码登录
                    </Button>
                    <Button
                      size="middle"
                      danger
                      icon={<StopOutlined />}
                      disabled={!cfx?.engine?.cookieCount}
                      onClick={onCamoufoxLogout}
                    >
                      退出登录
                    </Button>
                  </Space>
                </div>
              </div>
            )}
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <ApiOutlined />
                </div>
                OpenClaw 本地桥接
              </div>
              <Tag color={bridge?.ok ? 'green' : 'default'}>
                {bridge?.ok ? `已连接 (${bridge.version || 'v2.0'})` : '未连接'}
              </Tag>
            </div>
            <div className="setting-actions">
              <Space>
                <Button size="middle" onClick={refreshBridge} loading={bridgeLoading}>
                  刷新状态
                </Button>
                <Button size="middle" type="primary" onClick={() => setRoute('openclaw')}>
                  前往 OpenClaw 管理页
                </Button>
              </Space>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
              OpenClaw 后端服务提供 OCR、简历文本解析与任务恢复等本地扩展能力（端口 127.0.0.1:18765）。
            </Paragraph>
          </div>
        </div>
      ),
    },

    {
      key: 'data',
      label: (
        <span>
          <DatabaseOutlined style={{ marginRight: 6 }} />
          数据管理
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <DatabaseOutlined />
                </div>
                本地数据备份与清空
              </div>
            </div>
            <div className="data-actions setting-actions">
              <Space size={12} wrap>
                <Button
                  size="middle"
                  className="btn-uniform"
                  icon={<DownloadOutlined />}
                  onClick={onExport}
                >
                  导出 JSON 备份
                </Button>
                <Button
                  size="middle"
                  className="btn-uniform"
                  icon={<UploadOutlined />}
                  onClick={() => importRef.current?.click()}
                >
                  导入 JSON 备份
                </Button>
                <Button
                  size="middle"
                  className="btn-uniform"
                  danger
                  icon={<ClearOutlined />}
                  onClick={onClear}
                >
                  清空全部数据
                </Button>
              </Space>
              <input ref={importRef} type="file" accept=".json" hidden onChange={onImport} />
            </div>
            <Paragraph type="secondary" style={{ marginTop: 14, marginBottom: 0, fontSize: 13 }}>
              数据（简历、画像、投递方向、任务记录、偏好设置）全量保存在本机浏览器 localStorage。建议定期导出 JSON 文件备份。
            </Paragraph>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">
            <SettingOutlined className="page-title-icon" />
            设置中心
          </h1>
          <p className="page-sub">
            偏好设置、LLM 大模型接入、求职过滤规则与数据备份。所有数据均安全保存在本机。
          </p>
        </div>

        {/* 顶部快速状态指示 */}
        <div className="settings-header-chips">
          <span className="setting-chip is-active">
            <RobotOutlined />
            模式: {config.executionMode === 'auto' ? '全自动' : '人工确认'}
          </span>
          <span className={`setting-chip ${llmReady ? 'is-active' : ''}`}>
            <RobotOutlined />
            {llmReady ? `${config.model.provider}` : 'LLM未接入'}
          </span>
          <span className="setting-chip is-active">
            <ThunderboltOutlined />
            引擎: {config.engineMode}
          </span>
          <span className={`setting-chip ${bridge?.ok ? 'is-active' : ''}`}>
            <ApiOutlined />
            OpenClaw: {bridge?.ok ? '连通' : '断开'}
          </span>
        </div>
      </div>

      <Tabs
        className="settings-tabs"
        defaultActiveKey="appearance"
        items={tabItems}
        type="line"
      />
    </div>
  );
}
