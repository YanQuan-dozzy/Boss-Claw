import { useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Input, InputNumber, Modal, Segmented, Select, Slider, Switch, Tag, Typography, message } from 'antd';
import { CheckCircleOutlined, DownloadOutlined, UploadOutlined, ClearOutlined, BgColorsOutlined, ApiOutlined, SettingOutlined, StopOutlined, SearchOutlined, ThunderboltOutlined, QrcodeOutlined, PoweroffOutlined, RobotOutlined, DatabaseOutlined, FilterOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useSettingsStore, PROVIDER_DEFAULTS } from '@/store/useSettingsStore';
import { useAppStore, ThemeMode } from '@/store/useAppStore';
import { callModel } from '@/lib/bossclaw/llm';
import { exportData, importData, clearAllData } from '@/lib/storage';
import { bridgeStatus } from '@/lib/bridgeClient';
import { HR_ACTIVITY_FILTER_OPTIONS } from '@/lib/bossclaw/hrActivity';
import { INTERVIEW_MODE_FILTER_OPTIONS } from '@/lib/bossclaw/interviewMode';
import { CHINA_PROVINCES } from '@/lib/bossclaw/locationFilter';
import { camoufoxStatus, camoufoxLogin, camoufoxLogout, camoufoxStop, type CamoufoxStatus } from '@/lib/bossclaw/camoufox';
import type { LLMProvider } from '@/store/useSettingsStore';

const { Paragraph, Text } = Typography;

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
];

export default function Settings() {
  const { config, setConfig, setModel, applyProviderDefaults, isLLMConfigured } = useSettingsStore();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setRoute = useAppStore((s) => s.setRoute);
  const [testing, setTesting] = useState(false);
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

  // 在 strict TS 下用单一 helper 收口所有 window.electron 调用（vite-env.d.ts 已声明全部为可选）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cloakE: any = (typeof window !== 'undefined' ? window.electron : undefined) || {};

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
    // 引擎不可用时强制关闭启用开关，避免出现「开了但没安装」的失效状态
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
    if (!isLLMConfigured()) { message.warning('请先填写 Base URL / API Key / 模型名'); return; }
    setTesting(true);
    try {
      const r = await callModel([{ role: 'user', content: 'ping' }], config.model, { jsonMode: false, maxTokens: 128, temperature: 0 });
      message.success('连接成功：' + (typeof r === 'string' ? r.slice(0, 40) : JSON.stringify(r).slice(0, 40)));
    } catch (e: any) {
      message.error('连接失败：' + (e?.message || e));
    } finally { setTesting(false); }
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <SettingOutlined className="page-title-icon" />设置
          </h1>
          <p className="page-sub">外观、LLM 配置、求职条件与本地数据管理。所有配置保存在本机 localStorage。</p>
        </div>
      </div>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><BgColorsOutlined /></span> 外观</>} style={{ marginBottom: 12 }}>
        <Segmented
          className="setting-segmented"
          size="large"
          value={theme}
          onChange={(v) => setTheme(v as ThemeMode)}
          options={THEME_OPTIONS.map((opt) => ({ label: opt.label, value: opt.key }))}
        />
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          主题状态持久化保存在本机；「跟随系统」将随操作系统的浅色/深色偏好自动切换。
        </Paragraph>
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><QrcodeOutlined /></span> 内置浏览器</>} style={{ marginBottom: 12 }}>
        <div className="safety-grid">
          <div className="sg-item"><span className="field-label">自动关闭闲置标签页</span>
            <Switch checked={config.autoCloseIdleTabs} onChange={(v) => setConfig({ autoCloseIdleTabs: v })} />
          </div>
          <div className="sg-item"><span className="field-label">闲置关闭阈值（分钟）</span>
            <InputNumber min={1} max={120} disabled={!config.autoCloseIdleTabs} value={config.idleCloseMinutes} onChange={(v) => setConfig({ idleCloseMinutes: v ?? 5 })} style={{ width: '100%' }} />
          </div>
        </div>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
          开启后，超过设定时长未被切换或导航的后台标签页将自动关闭；当前正在查看的标签页不会被关闭，且至少保留一个标签页，保证浏览器始终可用。
        </Paragraph>
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><FilterOutlined /></span> 求职条件</>} style={{ marginBottom: 12 }}>
        <div className="settings-grid">
          <div className="sg-item"><span className="field-label">城市（逗号分隔）</span><Input value={config.targetLocations.join(',')} onChange={(e) => setConfig({ targetLocations: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="北京,上海" /></div>
          <div className="sg-item"><span className="field-label">薪资</span><Input value={config.salary} onChange={(e) => setConfig({ salary: e.target.value })} placeholder="不限 / 15-25K" /></div>
          <div className="sg-item"><span className="field-label">求职类型</span><Select mode="tags" style={{ width: '100%' }} value={config.employmentTypes} onChange={(v) => setConfig({ employmentTypes: v })} options={['不限', '全职', '实习', '校招', '兼职'].map(x => ({ label: x, value: x }))} /></div>
          <div className="sg-item"><span className="field-label">学历</span><Select mode="tags" style={{ width: '100%' }} value={config.degrees} onChange={(v) => setConfig({ degrees: v })} options={['不限', '大专', '本科', '硕士', '博士'].map(x => ({ label: x, value: x }))} /></div>
          <div className="sg-item"><span className="field-label">经验</span><Select mode="tags" style={{ width: '100%' }} value={config.experiences} onChange={(v) => setConfig({ experiences: v })} options={['不限', '在校生', '应届生', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'].map(x => ({ label: x, value: x }))} /></div>
          <div className="sg-item"><span className="field-label">HR 活跃度过滤</span>
            <Select
              style={{ width: '100%' }}
              value={config.hrActivityFilter || 'any'}
              onChange={(v) => setConfig({ hrActivityFilter: v })}
              options={HR_ACTIVITY_FILTER_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
          </div>
          <div className="sg-item"><span className="field-label">面试方式筛选</span>
            <Select
              style={{ width: '100%' }}
              value={config.interviewModeFilter || 'any'}
              onChange={(v) => setConfig({ interviewModeFilter: v })}
              options={INTERVIEW_MODE_FILTER_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
          </div>
          <div className="sg-item"><span className="field-label">每日目标</span><InputNumber min={0} value={config.dailyTarget} onChange={(v) => setConfig({ dailyTarget: v ?? 0 })} style={{ width: '100%' }} /></div>
          <div className="sg-item"><span className="field-label">最低匹配分</span><InputNumber min={0} max={100} value={config.minScore} onChange={(v) => setConfig({ minScore: v ?? 75 })} style={{ width: '100%' }} /></div>
        </div>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          HR 活跃度过滤按你设定的阈值确定性跳过长期不活跃的岗位，由页面识别 + 用户阈值共同决定，不交给 AI 判断。
        </Paragraph>

        <div className="field-group">
          <div className="field-group__title"><StopOutlined className="fg-icon" /> 城市反选</div>
          <div className="settings-grid">
            <div className="sg-item"><span className="field-label">排除省份 / 直辖市 / 自治区</span>
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
            <div className="sg-item"><span className="field-label">排除城市（直接输入城市名）</span>
              <Select
                mode="tags"
                allowClear
                style={{ width: '100%' }}
                placeholder="输入城市名，回车添加，如 杭州"
                value={config.excludedCities}
                onChange={(v) => setConfig({ excludedCities: (v as string[]).map((s) => String(s).trim()).filter(Boolean) })}
                tokenSeparators={[',', '，']}
                maxTagCount="responsive"
              />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Tag color="red">已排除 {config.excludedProvinces.length} 省 · {config.excludedCities.length} 市</Tag>
          </div>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            城市反选为确定性过滤（不依赖 AI）：加入任务的岗位若所在地命中上述省份（含其下辖市，即便只显示城市名）或城市，会被自动跳过、不进入投递队列。与「目标城市」互补——目标城市决定去哪搜，城市反选决定哪些地方一律不去。
          </Paragraph>
        </div>

        <div className="field-group">
          <div className="field-group__title"><SearchOutlined className="fg-icon" /> 搜索采集范围</div>
          <div className="settings-grid">
            <div className="sg-item"><span className="field-label">采集时自动下拉加载更多</span>
              <div><Switch checked={config.listAutoScroll !== false} onChange={(v) => setConfig({ listAutoScroll: v })} /></div>
            </div>
            <div className="sg-item"><span className="field-label">自动下拉最大轮数</span>
              <InputNumber min={1} max={40} value={config.listScrollRounds || 12} onChange={(v) => setConfig({ listScrollRounds: v ?? 12 })} style={{ width: '100%' }} />
            </div>
            <div className="sg-item"><span className="field-label">可视化采集滚动间隔（毫秒）</span>
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
            <div className="sg-item"><span className="field-label">断点续采起始序号</span>
              <InputNumber min={0} value={config.collectResumeIndex || 0} onChange={(v) => setConfig({ collectResumeIndex: Math.max(0, v ?? 0) })} style={{ width: '100%' }} />
            </div>
          </div>
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            开启后，每次「搜索采集」会先自动把 BOSS 列表滚动到底部、触发无限加载，连续两轮没有新岗位即停止，从而收集到比首屏多得多的岗位（轮数越大收集越多，耗时也越长）。滚动间隔控制逐岗位滚动的快慢（越大越慢、越接近人工）。断点续采起始序号用于中断后从第 N 个岗位继续（0 = 从头；已入库岗位会自动按 URL 去重跳过）。
          </Paragraph>
        </div>
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><RobotOutlined /></span> AI / LLM 配置</>} style={{ marginBottom: 12 }}>
        <div className="settings-grid">
          <div className="sg-item"><span className="field-label">服务商预设</span>
            <Select
              style={{ width: '100%' }} value={config.model.provider as LLMProvider}
              onChange={(p) => { applyProviderDefaults(p); message.success(`已套用 ${PROVIDER_DEFAULTS[p].label} 默认端点（可继续修改）`); }}
              options={(Object.keys(PROVIDER_DEFAULTS) as LLMProvider[]).map(p => ({ label: PROVIDER_DEFAULTS[p].label, value: p }))}
            />
          </div>
          <div className="sg-item"><span className="field-label">Base URL</span><Input value={config.model.baseUrl} onChange={(e) => setModel({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com" /></div>
          <div className="sg-item wide"><span className="field-label">模型名（可下拉选择，也可自主填入）</span>
            <AutoComplete
              style={{ width: '100%' }}
              value={config.model.model}
              onChange={(v) => setModel({ model: v })}
              options={(PROVIDER_DEFAULTS[config.model.provider as LLMProvider]?.models || []).map((m) => ({ value: m, label: m }))}
              placeholder="选择或输入模型名"
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </div>
        </div>
        <div className="sg-item" style={{ marginTop: 14 }}>
          <span className="field-label">API Key</span>
          <div className="llm-keyrow">
            <Input.Password value={config.model.apiKey} onChange={(e) => setModel({ apiKey: e.target.value })} placeholder="sk-..." />
            <Button type="primary" icon={<CheckCircleOutlined />} loading={testing} onClick={testConnection}>测试连接</Button>
          </div>
        </div>
        <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
          API Key 仅保存在本机 localStorage；切勿提交到仓库或公开日志。未配置时画像/匹配将回退本地规则初稿。
        </Paragraph>
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><ApiOutlined /></span> OpenClaw 连接</>} style={{ marginBottom: 12 }}>
        <div className="card-actions setting-actions">
          <Tag color={bridge?.ok ? 'green' : 'red'}>{bridge?.ok ? `已连接（${bridge.version || ''}）` : '未连接'}</Tag>
          <Button size="middle" onClick={refreshBridge} loading={bridgeLoading}>刷新状态</Button>
          <Button size="middle" type="primary" onClick={() => setRoute('openclaw')}>到 OpenClaw 管理</Button>
        </div>
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          OpenClaw（OCR / 日报 / 简历解析 / 任务恢复）为可选能力，默认未连接；到 OpenClaw 页点击「启动」按需连接，端口 127.0.0.1:18765。
        </Paragraph>
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><ApiOutlined /></span> 隐身引擎</>} style={{ marginBottom: 12 }}
        extra={
          <Tag color={config.engineMode === 'webview' ? 'default' : (engineReady ? 'green' : 'orange')}>
            {config.engineMode === 'webview' ? 'WebView（默认）' : engineReady ? '引擎就绪' : '未就绪'}
          </Tag>
        }>
        <Segmented
          className="setting-segmented"
          size="large"
          value={config.engineMode}
          onChange={(v) => {
            const next = v as 'webview' | 'cloak' | 'camoufox';
            // engineMode 与 camoufox.enabled 互相同步（保持 Workbench 既有消费语义不变）
            setConfig({
              engineMode: next,
              camoufox: { ...cfxConfig, enabled: next === 'camoufox' },
            });
            if (next === 'webview') message.success('已切换回 Electron <webview> 引擎（默认底座）');
            else if (next === 'cloak') message.success('已切换到 CloakBrowser 隐身浏览器（下次进入工作台时生效）');
            else message.success('已切换到 Camoufox 隐身引擎（下次进入工作台时生效）');
          }}
          options={[
            { label: 'WebView（默认）', value: 'webview' },
            { label: 'CloakBrowser', value: 'cloak' },
            { label: 'Camoufox', value: 'camoufox' },
          ]}
        />
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          在三种引擎中切换内置浏览器底座：WebView 是默认的 Electron 原生 <code>&lt;webview&gt;</code>；
          CloakBrowser 与 Camoufox 为可选隐身增强，仅用于降低「正常操作被 BOSS 误判为机器人」的概率。
          切换后需要刷新工作台才能生效；<Text strong>任何引擎都不绕过验证码 / 账户验证</Text>，code 35/36/32 仍立即停止并交人工。
        </Paragraph>

        {config.engineMode === 'webview' && (
          <Alert type="info" showIcon style={{ borderRadius: 8, marginTop: 8 }}
            message="当前为默认 WebView 引擎" description="内置浏览器使用 Electron <webview> 加载 BOSS 直聘，无需下载额外二进制，登录态由 webview 会话持久化。" />
        )}

        {config.engineMode === 'cloak' && (
          <div className="engine-panel" style={{ marginTop: 12 }}>
            <div className="field-group">
              <div className="field-group__title"><RobotOutlined className="fg-icon" /> CloakBrowser 隐身浏览器</div>
              <div className="setting-actions" style={{ marginBottom: 12 }}>
                <Button size="middle" onClick={refreshCloakBinary} loading={cloakBinaryLoading}>检测状态</Button>
                {cloakReady && <Button size="middle" danger icon={<PoweroffOutlined />} onClick={onCloakStop}>停止引擎</Button>}
              </div>
              {!cloakBinaryInfo?.installed && !cloakReady && (
                <Alert type="info" showIcon style={{ borderRadius: 8, marginBottom: 8 }}
                  message="首次启用 CloakBrowser 时会自动从 cloakbrowser.dev 下载 ~200MB 隐身 Chromium 并校验 Ed25519 签名（缓存 ~/.cloakbrowser/）" />
              )}
              <div className="settings-grid">
                {cloakBinaryInfo && (
                  <div className="sg-item"><span className="field-label">二进制</span>
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <div>已安装：{String(Boolean(cloakBinaryInfo.installed))}</div>
                      <div>版本：{cloakBinaryInfo.version || '-'}</div>
                      <div>等级：{cloakBinaryInfo.tier || '-'}</div>
                      <div>路径：{cloakBinaryInfo.binaryPath || '-'}</div>
                    </div>
                  </div>
                )}
              </div>
              <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                CloakBrowser 是 <Text code>F:\CloakBrowser-main</Text> 的隐身 Chromium：71 个 C++ 层指纹补丁 + humanize 类人行为，
                持久 profile 路径 <Text code>app.getPath('userData')/cloakbrowser-profile</Text>，登录态（wt2 cookie）跨重启保留。
              </Paragraph>
            </div>
          </div>
        )}

        {config.engineMode === 'camoufox' && (
          <div className="engine-panel" style={{ marginTop: 12 }}>
            <div className="field-group">
              <div className="field-group__title"><ThunderboltOutlined className="fg-icon" /> Camoufox 隐身引擎</div>
              <div className="setting-actions" style={{ marginBottom: 12 }}>
                <Button size="middle" onClick={() => refreshCamoufox()} loading={cfxLoading}>检测状态</Button>
                {cfx?.running && <Button size="middle" danger icon={<PoweroffOutlined />} onClick={onCamoufoxStop}>停止桥</Button>}
              </div>
              {!cfx?.ready && (
                <Alert type="warning" showIcon style={{ borderRadius: 8, marginBottom: 8 }}
                  message="隐身引擎当前不可用"
                  description={cfx?.message || '请检查本机浏览器内核（Chrome/Edge/Firefox），或点击「检测状态」重新检查。'} />
              )}
              <div className="settings-grid">
                <div className="sg-item"><span className="field-label">指纹伪装系统</span>
                  <Select
                    style={{ width: '100%' }}
                    value={cfxConfig.os}
                    onChange={(v) => setConfig({ camoufox: { ...cfxConfig, os: v } })}
                    options={[
                      { label: 'Windows（推荐，国内主流）', value: 'windows' },
                      { label: 'macOS', value: 'macos' },
                      { label: 'Linux', value: 'linux' },
                    ]}
                  />
                </div>
                <div className="sg-item"><span className="field-label">隐身搜索页数（1-5）</span>
                  <InputNumber min={1} max={5} value={cfxConfig.pages} onChange={(v) => setConfig({ camoufox: { ...cfxConfig, pages: v ?? 1 } })} style={{ width: '100%' }} />
                </div>
              </div>
              <div className="switch-actions setting-actions">
                <Text>优先走隐身通道</Text>
                <Switch
                  checked={cfxConfig.prefer}
                  onChange={(v) => setConfig({ camoufox: { ...cfxConfig, prefer: v } })}
                />
                <Button size="middle" icon={<QrcodeOutlined />} loading={cfxLogining} disabled={!cfx?.ready && !cfxConfig.enabled} onClick={onCamoufoxLogin}>
                  隐身扫码登录
                </Button>
                <Button size="middle" danger icon={<StopOutlined />} disabled={!cfx?.engine?.cookieCount} onClick={onCamoufoxLogout}>
                  退出登录
                </Button>
              </div>
              <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                引擎按可用性自动选择内核：优先 Camoufox 原生内核（C++ 级指纹伪装 Canvas/WebGL/Audio/字体/时区 + humanize 类人行为），
                没有则复用系统 Chrome / Edge（Playwright + stealth 初始化，无需下载任何新内核）。
                它降低的是「正常操作被 BOSS 误判为机器人（code 37）」的概率，<Text strong>不绕过验证码 / 账户验证</Text>，
                也不会替你承诺任何薪资、到岗或面试时间。
              </Paragraph>
              {cfx?.ready && (
                <div className="field-group">
                  <div className="field-group__title"><CheckCircleOutlined className="fg-icon" /> 当前引擎状态</div>
                  <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0, fontSize: 12 }}>
                    <Tag color="green" style={{ marginRight: 8 }}>{cfx.engine?.kernel || '引擎就绪'}</Tag>
                    {cfx.engine?.kernelMessage || cfx.message}
                  </Paragraph>
                </div>
              )}
              {!cfx?.camoufox && !cfx?.ready && (
                <div className="field-group">
                  <div className="field-group__title"><InfoCircleOutlined className="fg-icon" /> 可用性说明</div>
                  <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0, fontSize: 12 }}>
                    本引擎<b>复用本机已安装的浏览器内核</b>（优先 Camoufox 原生内核，其次系统 Chrome / Edge / Firefox），
                    不需要下载额外内核。请确认已安装任一浏览器后点击「检测状态」。
                  </Paragraph>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card size="small" className="setting-card" title={<><span className="setting-card__icon"><DatabaseOutlined /></span> 数据</>} style={{ marginBottom: 12 }}>
        <div className="data-actions setting-actions">
          <Button size="middle" icon={<DownloadOutlined />} onClick={onExport}>导出备份</Button>
          <Button size="middle" icon={<UploadOutlined />} onClick={() => importRef.current?.click()}>导入备份</Button>
          <Button size="middle" danger icon={<ClearOutlined />} onClick={onClear}>清空缓存</Button>
          <input ref={importRef} type="file" accept=".json" hidden onChange={onImport} />
        </div>
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          所有数据（简历、画像、方向、任务、设置）默认保存在本机 localStorage。导出为 JSON 文件可随时备份或迁移到其他设备；清空不可恢复，请先导出。
        </Paragraph>
      </Card>
    </div>
  );
}
