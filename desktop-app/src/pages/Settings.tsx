import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  notification,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
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
  PlusOutlined,
  DeleteOutlined,
  FileAddOutlined,
  FileTextOutlined,
  HddOutlined,
  SyncOutlined,
  DisconnectOutlined,
  InfoCircleOutlined,
  RedoOutlined,
  FolderOpenOutlined,
  SaveOutlined,
  GlobalOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import { useSettingsStore, PROVIDER_DEFAULTS } from '@/store/useSettingsStore';
import { useAppStore, ThemeMode } from '@/store/useAppStore';
import { callModel, clearAICache, getAICacheStats, getLLMUsageStats, resetLLMUsageStats } from '@/lib/bossclaw/llm';
import {
  allSkillsWithState,
  setSkillEnabled,
  resetAllSkills,
  ensureSkillsLoaded,
  importSkillFromRaw,
  createCustomSkill,
  deleteCustomSkill,
  type CustomSkillFields,
} from '@/lib/bossclaw/skills';
import { exportData, importData, clearAllData } from '@/lib/storage';
import { useDataStore } from '@/store/useDataStore';
import { bridgeStatus } from '@/lib/bridgeClient';
import { electronApi } from '@/lib/electronApi';
import {
  getBackupDir,
  writeLocalBackup,
  restoreFromLocalBackup,
  clearLocalBackup,
} from '@/lib/localBackup';
import { HR_ACTIVITY_FILTER_OPTIONS } from '@/lib/bossclaw/hrActivity';
import { INTERVIEW_MODE_FILTER_OPTIONS } from '@/lib/bossclaw/interviewMode';
import { CHINA_PROVINCES } from '@/lib/bossclaw/locationFilter';
import { cleanSalary } from '@/lib/bossclaw/jobDisplay';
import { camoufoxStatus, camoufoxLogin, camoufoxLogout, camoufoxStop, type CamoufoxStatus } from '@/lib/bossclaw/camoufox';
import {
  PLATFORM_META, PLATFORM_IDS, platformEnabled, platformPriority,
  platformDailyCap, PLATFORM_DEFAULT_DAILY_TARGET,
  type JobPlatform,
} from '@/lib/bossclaw/platforms';
import type { LLMProvider } from '@/store/useSettingsStore';
import type { PendingItem } from '@/lib/bossclaw/types';

const { Paragraph, Text } = Typography;

/** 达标岗位的去重键（当天内去重依据）：优先 jobId/url，缺失时回退 platform|公司|标题|地点 */
function qualifiedJobKey(p: PendingItem): string {
  const j = p.job || {};
  const id = j.jobId || j.url || '';
  if (id) return `${j.platform || 'boss'}|${id}`;
  return `${j.platform || 'boss'}|${j.company || ''}|${j.title || ''}|${j.location || ''}`;
}

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: 'light', label: '浅色模式' },
  { key: 'dark', label: '深色模式' },
  { key: 'system', label: '跟随系统' },
];

// 自定义技能可绑定的 AI 调用作用域（与 skills.ts SkillScope 一致）
const SKILL_SCOPE_OPTIONS = [
  { label: '职业画像（profile）', value: 'profile' },
  { label: '岗位匹配评估（job-analysis）', value: 'job-analysis' },
  { label: '打招呼语（greetings）', value: 'greetings' },
  { label: '岗位定制简历（assistant）', value: 'assistant' },
];

// 新建技能的默认表单
const DEFAULT_CREATE_SKILL: CustomSkillFields = { name: '', description: '', scope: 'assistant', instructions: '' };

// ===== 无关键字采集（随机岗位推荐）说明 =====
// 仅在开关「开启」时于应用顶部弹出一次，**不在页面上常驻**；
// 时长放宽到 9s（附倒计时进度条），让用户读完前置提醒后自动消失。
const NO_KEYWORD_NOTICE_KEY = 'no-keyword-collect-notice';
const NO_KEYWORD_NOTICE_DURATION = 9;
function notifyNoKeywordCollectEnabled() {
  notification.warning({
    key: NO_KEYWORD_NOTICE_KEY,
    placement: 'top',
    duration: NO_KEYWORD_NOTICE_DURATION,
    showProgress: true,
    message: '无关键字采集已开启：请先在 BOSS 直聘内完善在线简历与求职意向',
    description: (
      <div style={{ fontSize: 13, lineHeight: '20px' }}>
        <div>
          采集链接只去掉关键词（query），城市 / 求职类型 / 经验 / 学历 / 薪资 / 公司规模仍按当前设置保留，岗位由平台按你账号内的求职意向推荐。
        </div>
        <div style={{ marginTop: 6 }}>
          适用于「同一关键词反复重试、结果大量重复」的场景。若账号资料未完善，可能返回不相关岗位或空结果。
        </div>
      </div>
    ),
  });
}

export default function Settings() {
  const { config, setConfig, setModel, applyProviderDefaults, isLLMConfigured } = useSettingsStore();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setRoute = useAppStore((s) => s.setRoute);
  const requestBrowserLogin = useAppStore((s) => s.requestBrowserLogin);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [aiCacheStats, setAiCacheStats] = useState<ReturnType<typeof getAICacheStats> | null>(null);
  const [llmUsage, setLlmUsage] = useState<ReturnType<typeof getLLMUsageStats> | null>(null);
  // AI 技能（skills 层）启用状态：初始用内置定义，加载 SKILL.md 后刷新
  const [skills, setSkills] = useState(() => allSkillsWithState());
  const refreshSkills = () => setSkills(allSkillsWithState());
  const onToggleSkill = (id: string, enabled: boolean) => {
    setSkillEnabled(id, enabled);
    refreshSkills();
  };
  useEffect(() => {
    ensureSkillsLoaded().then(refreshSkills).catch(() => {});
  }, []);

  // ===== 自定义技能（导入 / 新建 / 删除）=====
  const skillImportRef = useRef<HTMLInputElement>(null);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [createSkillForm, setCreateSkillForm] = useState(DEFAULT_CREATE_SKILL);
  const patchCreateSkill = (patch: Partial<typeof DEFAULT_CREATE_SKILL>) =>
    setCreateSkillForm((f) => ({ ...f, ...patch }));

  // 从本地 SKILL.md 文件导入
  const onImportSkillFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const r = await importSkillFromRaw(raw);
      if (!r.ok) {
        message.error('导入失败：' + (r.error || '格式错误'));
        return;
      }
      message.success('技能导入成功，已在列表中启用');
      await ensureSkillsLoaded();
      refreshSkills();
    } catch (err: any) {
      message.error('导入失败：' + (err?.message || err));
    } finally {
      if (skillImportRef.current) skillImportRef.current.value = '';
    }
  };

  // 手动新建技能
  const onCreateSkillSubmit = async () => {
    const name = createSkillForm.name.trim();
    const instructions = createSkillForm.instructions.trim();
    if (!name) { message.warning('请填写技能名称'); return; }
    if (!instructions) { message.warning('请填写技能指令正文'); return; }
    setCreatingSkill(true);
    try {
      const r = await createCustomSkill({ ...createSkillForm, name, instructions });
      if (!r.ok) {
        message.error('新建失败：' + (r.error || '未知错误'));
        return;
      }
      message.success(`技能「${name}」创建成功`);
      setCreateSkillOpen(false);
      setCreateSkillForm(DEFAULT_CREATE_SKILL);
      await ensureSkillsLoaded();
      refreshSkills();
    } catch (err: any) {
      message.error('新建失败：' + (err?.message || err));
    } finally {
      setCreatingSkill(false);
    }
  };

  // 删除自定义技能（内置技能不显示删除入口）
  const onDeleteSkill = (id: string, name: string) => {
    Modal.confirm({
      title: `删除自定义技能「${name}」？`,
      content: '删除后该技能的指令将不再注入任何 AI 调用，且无法恢复（SKILL.md 文件会被移除）。内置技能不受影响。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const r = await deleteCustomSkill(id);
        if (!r.ok) {
          message.error('删除失败：' + (r.error || '未知错误'));
          return;
        }
        message.success('已删除自定义技能');
        await ensureSkillsLoaded();
        refreshSkills();
      },
    });
  };

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

  // ===== 多平台适配：各平台 Camoufox 登录态与登录动作 =====
  const [cfxPlatforms, setCfxPlatforms] = useState<Record<string, CamoufoxStatus | null>>({});
  // 各平台在「内置浏览器（工作台）」会话中的登录态（webview persist 分区；j.c:boss-login 返回 platforms 映射）
  const [webviewPlatforms, setWebviewPlatforms] = useState<Record<string, boolean>>({});
  const refreshWebviewStatus = useCallback(async () => {
    try {
      const r: any = await (window.electron?.bossLogin as any)?.();
      if (r && typeof r === 'object' && r.platforms) setWebviewPlatforms(r.platforms);
    } catch { /* webview 登录态获取失败时忽略 */ }
  }, []);

  // ===== CloakBrowser 隐身浏览器（设置页检测与操作）=====
  const [cloakBinaryInfo, setCloakBinaryInfo] = useState<any>(null);
  const [cloakReady, setCloakReady] = useState(false);
  const [cloakBinaryLoading, setCloakBinaryLoading] = useState(false);

  // 当前引擎是否就绪（用于 Card 角标）：webview 始终可用；cloak 看 cloakReady；camoufox 看 cfx.ready
  const engineReady = config.engineMode === 'webview' || (config.engineMode === 'cloak' ? cloakReady : (cfx?.ready ?? false));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cloakE: any = (typeof window !== 'undefined' ? window.electron : undefined) || {};

  // 页面首次加载时静默刷新连接状态，并轮询 webview 登录态
  useEffect(() => {
    refreshBridge();
    refreshCamoufox(true);
    refreshAllPlatformStatus();
    refreshWebviewStatus();
    if (cloakE.cloakStatus) {
      cloakE.cloakStatus().then((st: any) => setCloakReady(Boolean(st?.ready))).catch(() => {});
    }
    const wvTimer = setInterval(() => refreshWebviewStatus(), 5000);
    return () => clearInterval(wvTimer);
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
    // 依赖首次安装中不算「不可用」，不自动关闭引擎开关
    if (!s.ready && !s.installing && cfxConfig.enabled) setConfig({ camoufox: { ...cfxConfig, enabled: false } });
    if (!silent) setCfxLoading(false);
  };

  // ===== 多平台适配：刷新各平台 Camoufox 登录态 =====
  const refreshAllPlatformStatus = async () => {
    const out: Record<string, CamoufoxStatus | null> = {};
    for (const p of PLATFORM_IDS) {
      try { out[p] = await camoufoxStatus(p); } catch { out[p] = null; }
    }
    setCfxPlatforms(out);
  };

  const onPlatformLogin = (p: string) => {
    const meta = PLATFORM_META[p as JobPlatform];
    // 改为在工作台 webview 新标签页打开对应平台登录页，由 persist:bossclaw 会话持久化登录态
    requestBrowserLogin(p as JobPlatform, meta.loginUrl);
    setRoute('workbench');
    message.info(`${meta.label} 登录页已在工作台打开，请在右侧内置浏览器中完成扫码/账号登录`);
  };

  // 当前启用中的招聘平台数（用于「至少启用一个平台」约束：唯一启用平台禁止取消勾选）
  const enabledPlatformCount = PLATFORM_IDS.filter((id) => platformEnabled(config, id)).length;

  const togglePlatformEnabled = (p: JobPlatform, enabled: boolean) => {
    // 招聘平台至少启用一个：取消勾选时若「除本平台外已无启用平台」，阻止并提示，保证不出现全空选择。
    if (!enabled && enabledPlatformCount <= 1) {
      message.warning(`至少需要保留一个启用的招聘平台，无法取消「${PLATFORM_META[p].label}」`);
      return;
    }
    setConfig({
      platforms: {
        ...(config.platforms || {}),
        [p]: { ...(config.platforms || {})[p], enabled },
      },
    });
  };

  // 调整某平台的每日投递目标（多平台独立配额，0 表示不限；上限按平台适配——输入值被本平台上限
  // min(平台侧上限, MAX_SAFE_DAILY=150) 封顶，如智联最多 100/日）
  const setPlatformDailyTarget = (p: JobPlatform, v: number) => {
    const cap = platformDailyCap(p);
    setConfig({
      platforms: {
        ...(config.platforms || {}),
        [p]: { ...(config.platforms || {})[p], dailyTarget: Math.max(0, Math.min(Number(v) || 0, cap)) },
      },
    });
  };

  // 平台搜索/投递优先级：与相邻平台交换 priority（数字小=排前=先搜索/先投递）。
  // 基于全部平台（含未启用）的优先级升序交换，保证 priority 唯一连续；UI「上移=优先一级」。
  const movePlatformPriority = (p: JobPlatform, dir: -1 | 1) => {
    const cur = config.platforms || {};
    const sorted = (PLATFORM_IDS as JobPlatform[]).slice().sort(
      (a, b) => platformPriority(config, a) - platformPriority(config, b)
    );
    const idx = sorted.indexOf(p);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const other = sorted[j];
    const a = cur[p] || { enabled: true, priority: 1 };
    const b = cur[other] || { enabled: true, priority: 1 };
    setConfig({
      platforms: {
        ...cur,
        [p]: { enabled: a.enabled !== false, priority: b.priority ?? 1 },
        [other]: { enabled: b.enabled !== false, priority: a.priority ?? 1 },
      },
    });
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

  // 保存「达标岗位」数据到本地：从工作台队列收集评分达标的岗位 → 按「每日一个新文件」写入本地磁盘。
  // 达标 = 岗位分析评分 >= 投递时设置的最低分（minScore）。
  // 去重范围：仅当天内去重（同一天已导出的岗位不再重复追写）；当天重复点击只追新增并去重。
  // 已导出记录持久化于 useDataStore.qualifiedExports（日期 → 该日达标岗位），保证当日数据累积完整。
  const [exportingQualified, setExportingQualified] = useState(false);
  const [qualifiedJobsDir, setQualifiedJobsDir] = useState('');
  const onSaveQualifiedJobs = async () => {
    const minScore = Number(config?.minScore ?? 0);
    const d = new Date();
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dataStore = useDataStore.getState();
    const existed = dataStore.qualifiedExports[dateKey] || [];
    const existedKeys = new Set(existed.map((e) => e.key));
    const newly = dataStore.pending
      .filter((p) => p.analysis && Number(p.analysis.score) >= minScore)
      .filter((p) => !existedKeys.has(qualifiedJobKey(p)))
      .map((p) => ({
        key: qualifiedJobKey(p),
        minScore,
        score: Number(p.analysis?.score),
        decision: p.analysis?.decision || '',
        title: p.job?.title || '',
        company: p.job?.company || '',
        salary: cleanSalary(p.job?.salary) || '',
        location: p.job?.location || '',
        url: p.job?.url || '',
        platform: p.job?.platform || 'boss',
        recruiterName: p.job?.recruiterName || '',
        status: p.status,
        createdAt: p.createdAt,
      }))
      // 队列内按去重键再兜底去重（同一岗位可能在队列中出现多次）
      .filter((e, i, arr) => arr.findIndex((x) => x.key === e.key) === i);
    if (!newly.length) {
      message.info(existed.length ? `今天（${dateKey}）已保存 ${existed.length} 条达标岗位，无新增` : `当前队列中没有新的达标岗位（评分 ≥ 推荐岗位分 ${minScore}）`);
      return;
    }
    const merged = [...existed, ...newly];
    const jsonText = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        日期: dateKey,
        最低分: minScore,
        达标数量: merged.length,
        jobs: merged,
      },
      null,
      2
    );
    const defaultName = `bossclaw-qualified-jobs-${dateKey}.json`;
    setExportingQualified(true);
    try {
      let savedPath = '';
      if (electronApi.saveQualifiedJobs) {
        const r = await electronApi.saveQualifiedJobs(defaultName, jsonText, qualifiedJobsDir || undefined);
        if (r.canceled) return; // 用户取消保存对话框（未设置导出目录时），不落记录
        if (!r.ok) {
          message.warning(r.error === 'saveQualifiedJobs API 不可用（仅 Electron 可用）' ? '本地保存仅桌面端可用' : `保存失败：${r.error || '未知错误'}`);
          return;
        }
        savedPath = r.filePath || '';
      } else {
        // 浏览器预览降级：走下载
        const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(url);
      }
      // 写入成功后才记入本地去重记录，保证「当天数据完整」且不因重复点击重复追写
      dataStore.mergeQualifiedExports(dateKey, merged);
      message.success(`新增保存 ${newly.length} 条达标岗位，今天共 ${merged.length} 条${savedPath ? `：${savedPath}` : ''}`);
    } catch (e: any) {
      message.error('保存失败：' + (e?.message || e));
    } finally {
      setExportingQualified(false);
    }
  };

  // 选一个本地文件夹作为达标岗位导出目录（选择即应用并持久化；设置后导出自动按天写进该目录）
  const onPickQualifiedJobsDir = async () => {
    const r = await electronApi.qualifiedJobsDir.pick();
    if (r.canceled) return;
    if (!r.ok) { message.error('选择失败：' + (r.error || '未知错误')); return; }
    setQualifiedJobsDir(r.dir || '');
    message.success(`达标岗位将自动保存到：${r.dir}`);
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
        void clearLocalBackup();
        message.success('已清空本地数据，正在刷新…');
        setTimeout(() => window.location.reload(), 600);
      },
    });
  };

  const llmReady = isLLMConfigured();

  // ===== 开机自启动 & 本地备份目录 =====
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [backupDir, setBackupDir] = useState('');
  useEffect(() => {
    electronApi.autostart
      .get()
      .then((r) => setAutostart(r.openAtLogin))
      .catch(() => setAutostart(false));
    getBackupDir().then(setBackupDir).catch(() => setBackupDir(''));
    electronApi.qualifiedJobsDir
      .get()
      .then(setQualifiedJobsDir)
      .catch(() => setQualifiedJobsDir(''));
  }, []);

  const onToggleAutostart = async (v: boolean) => {
    try {
      if (!electronApi.autostart.set) {
        message.warning('当前环境不支持开机自启动');
        return;
      }
      electronApi.autostart.set(v);
      setAutostart(v);
      message.success(v ? '已开启开机自启动（打包后随系统启动）' : '已关闭开机自启动');
    } catch (e: any) {
      setAutostart(!v);
      message.error('设置开机自启动失败：' + (e?.message || e));
    }
  };

  const onPickBackupDir = async () => {
    const r = await electronApi.backup.pick();
    if (r.canceled) return;
    if (!r.ok) { message.error('选择失败：' + (r.error || '未知错误')); return; }
    setBackupDir(r.dir || '');
    message.success(`备份目录已改为：${r.dir}`);
  };

  const onBackupNow = async () => {
    const r = await writeLocalBackup(true);
    if (r.error) {
      message.warning(r.error === 'backup API 不可用（仅 Electron 可用）' ? '本地备份仅在桌面端可用' : r.error);
      return;
    }
    message.success(r.wrote ? '已写入本地备份' : '内容未变化，未重写本地备份文件');
  };

  const onRestoreBackup = async () => {
    const r = await restoreFromLocalBackup();
    if (!r.restored) { message.warning(r.error || '未找到本地备份文件'); return; }
    message.success('已从本地备份恢复，正在刷新…');
    setTimeout(() => window.location.reload(), 600);
  };

  // 早中晚分批投递已并入「定时任务」模块（2026-09-09）：由多条「限量定时投递」任务表达，
  // config.batchDelivery 已退役（老配置在启动时一次性迁移为定时任务）。

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
                ? '全自动投递：岗位由 AI 评估符合要求后自动确认，直接进入「待投递」并按顺序发送。'
                : '人工确认：由 AI 筛选评分后，岗位停在「待确认」，需在工作台点「确认」或「批量确认」后才进入「待投递」。'}
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
                  <PoweroffOutlined />
                </div>
                开机自启动
              </div>
              {autostart ? <Tag color="green">已开启</Tag> : <Tag>未开启</Tag>}
            </div>
            <div className="sg-item">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="field-label">随系统启动自动打开 BossClaw</span>
                <Switch
                  checked={Boolean(autostart)}
                  loading={autostart === null}
                  onChange={onToggleAutostart}
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              开启后，Windows 登录时将自动启动 BossClaw（打包安装版生效）。配合「定时任务」可在应用保持运行时按设定时刻自动投递 / 采集 / 备份。
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
      key: 'platforms',
      label: (
        <span>
          <GlobalOutlined style={{ marginRight: 6 }} />
          招聘平台
        </span>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <GlobalOutlined />
                </div>
                招聘平台
              </div>
              <Tag color="blue">多平台</Tag>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0, fontSize: 13 }}>
              启用后在「工作台」搜索栏可选平台，且内置浏览器新建标签页可选对应平台首页；各平台独立在工作台
              内置浏览器扫码/账号登录，登录态由 Electron 持久化会话自动保存，投递动作按平台语义适配。
              <b>BOSS 直聘与其余平台一样支持自主勾选</b>：取消勾选后该平台不再参与搜索采集与自动沟通，
              已采集岗位仍保留在队列中，重新勾选后继续处理。
            </Paragraph>
            <div style={{ marginTop: 6, padding: '8px 12px', background: 'var(--hover-bg)', borderRadius: 8, fontSize: 13, color: 'var(--fg-muted)' }}>
              平台优先级（<ArrowUpOutlined style={{ fontSize: 11 }} /> <ArrowDownOutlined style={{ fontSize: 11 }} /> 调整，数字 1 = 最高优先）：
              决定「工作台搜索栏」的平台顺序，以及多平台任务执行顺序 —— 自动沟通会<b>先完成优先级较高平台的全部
              已确认任务，再切换下一优先级平台</b>（同级不重复，交换式调整）。
            </div>
            <div style={{ marginTop: 10 }}>
              {[...PLATFORM_IDS]
                .sort((a, b) => platformPriority(config, a) - platformPriority(config, b))
                .map((p) => {
                const meta = PLATFORM_META[p];
                const st = cfxPlatforms[p];
                const cfxLoggedIn = Boolean(st?.engine?.loggedIn);
                const wvLoggedIn = Boolean(webviewPlatforms[p]);
                const enabled = platformEnabled(config, p);
                const pri = platformPriority(config, p);
                // 至少启用一个平台的约束：唯一仍启用的平台禁止取消勾选（UI 禁用 + togglePlatformEnabled 逻辑兜底）
                const lastEnabledOnly = enabled && enabledPlatformCount === 1;
                // 本平台上限（平台侧收窄后，如智联=100；其余=MAX_SAFE_DAILY=150）与适配后的每日目标
                const dailyCap = platformDailyCap(p);
                const storedTarget = Number(config.platforms?.[p]?.dailyTarget ?? PLATFORM_DEFAULT_DAILY_TARGET[p]) || 0;
                const dailyTarget = storedTarget > 0 ? Math.min(storedTarget, dailyCap) : storedTarget;
                const overCap = storedTarget > dailyCap;
                const orderIdx = [...PLATFORM_IDS].sort((a, b) => platformPriority(config, a) - platformPriority(config, b)).indexOf(p);
                const canUp = orderIdx > 0;
                const canDown = orderIdx < PLATFORM_IDS.length - 1;
                return (
                  <div key={p} className="field-group" style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <Tooltip title={lastEnabledOnly ? '至少需保留一个启用的招聘平台：请先启用其他平台，再取消本平台' : undefined}>
                        <Checkbox
                          checked={enabled}
                          disabled={lastEnabledOnly}
                          onChange={(e) => togglePlatformEnabled(p, e.target.checked)}
                        >
                          <Text strong>{meta.label}</Text>
                        </Checkbox>
                      </Tooltip>
                      {!enabled && <Tag style={{ marginRight: 0 }}>未启用</Tag>}
                      {lastEnabledOnly && (
                        <Tag color="orange" style={{ marginRight: 0 }}>最后启用平台（不可取消）</Tag>
                      )}
                      <span style={{ flex: 1 }} />
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <Tooltip title={canUp ? '提高优先级（优先搜索 / 先投递）' : '已是最高优先级'}>
                          <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={!canUp} onClick={() => movePlatformPriority(p, -1)} />
                        </Tooltip>
                        <Tooltip title={canDown ? '降低优先级（延后搜索 / 后投递）' : '已是最低优先级'}>
                          <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={!canDown} onClick={() => movePlatformPriority(p, 1)} />
                        </Tooltip>
                        <Tag color={pri === 1 ? 'gold' : 'default'} style={{ margin: '0 4px 0 0', minWidth: 24, textAlign: 'center' }}>
                          {pri}
                        </Tag>
                      </span>
                      <Button
                        size="small"
                        icon={<QrcodeOutlined />}
                        disabled={wvLoggedIn}
                        onClick={() => onPlatformLogin(p)}
                      >
                        {wvLoggedIn ? '已登录' : '扫码登录'}
                      </Button>
                      <Button
                        size="small"
                        danger
                        disabled={!wvLoggedIn}
                        onClick={async () => {
                          const r = await electronApi.boss.logout(p);
                          if (r.ok) {
                            message.success(`${meta.label} 已退出登录`);
                          } else {
                            message.error('退出失败：' + (r.error || '未知错误'));
                          }
                          refreshWebviewStatus();
                        }}
                      >
                        退出
                      </Button>
                    </div>
                    <table style={{ marginTop: 8, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-color)' }}>模块</th>
                          <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-color)' }}>登录状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ padding: '4px 8px' }}>工作台（内置浏览器）</td>
                          <td style={{ padding: '4px 8px' }}>
                            <Tag color={wvLoggedIn ? 'green' : 'default'} style={{ margin: 0 }}>{wvLoggedIn ? '已登录' : '未登录'}</Tag>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '4px 8px' }}>自动沟通（Camoufox 隐身）</td>
                          <td style={{ padding: '4px 8px' }}>
                            <Tag color={cfxLoggedIn ? 'green' : 'default'} style={{ margin: 0 }}>
                              {!st?.ready ? '引擎未就绪' : (cfxLoggedIn ? '已登录' : '未登录')}
                            </Tag>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {meta.dailyHint && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-muted)' }}>{meta.dailyHint}</div>}
                    {/* 每日投递目标（多平台独立配额；上限按平台适配收窄） */}
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                        <AimOutlined style={{ marginRight: 4 }} />
                        每日投递目标
                      </span>
                      <InputNumber
                        size="small"
                        min={0}
                        max={dailyCap}
                        placeholder="0=不限"
                        value={dailyTarget}
                        onChange={(v) => setPlatformDailyTarget(p, v ?? 0)}
                        style={{ width: 120 }}
                      />
                      <span style={{ fontSize: 11, color: overCap ? '#d46b08' : 'var(--fg-subtle)' }}>
                        条 / 天；0 表示不限，本平台上限 {dailyCap} 条{overCap ? `（原设置 ${storedTarget} 已超出，按上限执行）` : '（按平台侧限制 / 防封号适配）'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
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
                <span className="field-label">公司规模</span>
                <Select
                  style={{ width: '100%' }}
                  value={config.companyScale || '不限'}
                  onChange={(v) => setConfig({ companyScale: v })}
                  options={['不限', '0-20人', '20-99人', '100-499人', '500-999人', '1000-9999人', '10000人以上'].map((x) => ({
                    label: x,
                    value: x,
                  }))}
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
                <span className="field-label">
                  推荐岗位分
                  <Tooltip title="岗位综合评分 ≥ 该值即判为「推荐」档（可放心投递）；低于该值但达到「最低入队分」的记入「谨慎」档，交人工把关。默认 75。">
                    <InfoCircleOutlined className="field-label__hint" />
                  </Tooltip>
                </span>
                <InputNumber
                  min={0}
                  max={100}
                  value={config.minScore}
                  onChange={(v) => setConfig({ minScore: v ?? 75 })}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="sg-item">
                <span className="field-label">
                  最低入队分
                  <Tooltip title="评分低于该值的岗位不会进入工作台队列（0 = 不限，仅拦「不推荐」硬伤岗位）。默认 60，取代原先固定的 60 分入队门槛。">
                    <InfoCircleOutlined className="field-label__hint" />
                  </Tooltip>
                </span>
                <InputNumber
                  min={0}
                  max={100}
                  value={config.minQueueScore}
                  onChange={(v) => setConfig({ minQueueScore: v ?? 60 })}
                  style={{ width: '100%' }}
                />
              </div>
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
              <div className="sg-item">
                <span className="field-label">最低日薪（元/天，0=不限）</span>
                <InputNumber
                  min={0}
                  max={2000}
                  step={10}
                  value={config.minSalaryPerDay ?? 0}
                  onChange={(v) => setConfig({ minSalaryPerDay: v ?? 0 })}
                  style={{ width: '100%' }}
                  addonAfter="元/天"
                  placeholder="如 100"
                />
              </div>
            </div>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <StopOutlined />
                </div>
                确定性过滤（黑名单）
              </div>
              <Space>
                <Tag color="red">排除 {config.excludedProvinces.length} 省 · {config.excludedCities.length} 市</Tag>
                <Tag color="geekblue">屏蔽 {config.excludedCompanies?.length || 0} 公司 · {config.excludedRecruiters?.length || 0} HR</Tag>
                <Tag color="volcano">排除 {config.excludedJobDescKeywords?.length || 0} 个关键字</Tag>
              </Space>
            </div>
            <div className="settings-grid">
              <div className="settings-grid__group-title">
                <span className="field-label">城市反选</span>
              </div>
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

              <div className="settings-grid__group-title">
                <span className="field-label">公司 / 招聘方</span>
              </div>
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

              <div className="settings-grid__group-title">
                <span className="field-label">岗位描述关键字</span>
              </div>
              <div className="sg-item wide">
                <span className="field-label">岗位描述出现以下关键字时排除（如 出差 / 驻场 / 长期外派）</span>
                <Select
                  mode="tags"
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="输入关键字，回车添加，如 出差 / 驻场"
                  value={config.excludedJobDescKeywords || []}
                  onChange={(v) =>
                    setConfig({
                      excludedJobDescKeywords: (v as string[]).map((s) => String(s).trim()).filter(Boolean),
                    })
                  }
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </div>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              以下过滤器均为确定性规则（不依赖 AI，不消耗 Token）：加入任务的岗位所在地、公司名或招聘方姓名命中黑名单（子串匹配），或岗位标题 / 卡片 / 描述文本中出现任一排除关键字，会被自动跳过、不进入「待投递」。与「目标城市」互补。
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
                <span className="field-label">无关键字采集（随机岗位推荐）</span>
                <div>
                  <Switch
                    checked={config.collectWithoutKeyword === true}
                    onChange={(v) => {
                      setConfig({ collectWithoutKeyword: v });
                      // 说明只在「开启」时顶部弹出（不常驻页面）；关闭时只给一条短提示说明口径已切回关键词
                      if (v) notifyNoKeywordCollectEnabled();
                      else message.info('已关闭无关键字采集：恢复为按投递方向的关键词采集');
                    }}
                  />
                </div>
              </div>
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
                <span className="field-label">搜索页加载等待上限（秒）</span>
                <InputNumber
                  min={5}
                  max={120}
                  step={5}
                  value={Math.round((config.collectPageTimeoutMs || 30000) / 1000)}
                  onChange={(v) => setConfig({ collectPageTimeoutMs: Math.max(5000, (v ?? 30) * 1000) })}
                  style={{ width: '100%' }}
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
                AI 结果缓存与省流
              </div>
              <Tag color="cyan" style={{ borderRadius: 10, fontWeight: 600 }}>0-Token 复用</Tag>
            </div>

            {/* 说明横幅 Banner */}
            <div className="ai-cache-banner">
              <div className="ai-cache-banner__icon">
                <ThunderboltOutlined />
              </div>
              <div className="ai-cache-banner__content">
                <div className="ai-cache-banner__title">智能本地结果缓存与 Context 节约</div>
                <div className="ai-cache-banner__desc">
                  职业画像、岗位分析与求职招呼语生成结果均加密保存在本机。相同输入（简历/画像/岗位/提示词均未变）时<strong>直接复用缓存（0 延迟、0 Token 计费）</strong>；更新简历或提示词后将自动重新计算生成。
                </div>
              </div>
            </div>

            {/* 本机磁盘缓存区 */}
            <div className="ai-cache-section">
              <div className="ai-cache-section__header">
                <div className="ai-cache-section__title">
                  <HddOutlined style={{ color: 'var(--brand)', marginRight: 6 }} />
                  本机磁盘缓存
                </div>
                <Button
                  size="small"
                  danger
                  type="dashed"
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    const count = clearAICache();
                    refreshAICacheStats();
                    message.success(count > 0 ? `已清空 ${count} 条 AI 本机缓存` : '缓存已为空');
                  }}
                  disabled={!aiCacheStats || aiCacheStats.entries === 0}
                >
                  清空缓存
                </Button>
              </div>

              <div className="ai-cache-grid">
                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(22, 119, 255, 0.1)', color: '#1677ff' }}>
                    <FileTextOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {aiCacheStats ? aiCacheStats.entries : 0} <span className="unit">条</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">缓存记录数</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(82, 196, 26, 0.1)', color: '#52c41a' }}>
                    <CheckCircleOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val" style={{ color: '#52c41a' }}>
                      {aiCacheStats ? aiCacheStats.hits : 0} <span className="unit">次</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">累计命中 (0-Token)</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(250, 140, 22, 0.1)', color: '#fa8c16' }}>
                    <SyncOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {aiCacheStats ? aiCacheStats.misses : 0} <span className="unit">次</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">新生成次数</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(114, 46, 209, 0.1)', color: '#722ed1' }}>
                    <HddOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {aiCacheStats ? (aiCacheStats.totalBytes / 1024).toFixed(1) : 0} <span className="unit">KB</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">占用磁盘容量</div>
                  </div>
                </div>
              </div>
            </div>

            {/* 服务端 Prompt Cache 统计区 */}
            <div className="ai-cache-section" style={{ marginTop: 14 }}>
              <div className="ai-cache-section__header">
                <div className="ai-cache-section__title">
                  <ApiOutlined style={{ color: '#13c2c2', marginRight: 6 }} />
                  服务端 Context Caching 统计
                </div>
                <Button
                  size="small"
                  icon={<RedoOutlined />}
                  onClick={() => {
                    resetLLMUsageStats();
                    refreshAICacheStats();
                    message.success('已重置服务端 Token 缓存统计');
                  }}
                >
                  重置统计
                </Button>
              </div>

              <div className="ai-cache-grid">
                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(19, 194, 194, 0.1)', color: '#13c2c2' }}>
                    <ApiOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {llmUsage ? llmUsage.requests : 0} <span className="unit">次</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">模型请求次数</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(82, 196, 26, 0.1)', color: '#52c41a' }}>
                    <ThunderboltOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val" style={{ color: '#52c41a' }}>
                      {llmUsage ? llmUsage.cacheHitTokens.toLocaleString() : 0} <span className="unit">tokens</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">缓存命中 (Hit Tokens)</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(245, 34, 45, 0.1)', color: '#ff4d4f' }}>
                    <DisconnectOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {llmUsage ? llmUsage.cacheMissTokens.toLocaleString() : 0} <span className="unit">tokens</span>
                    </div>
                    <div className="ai-cache-stat-card__lbl">缓存未命中 (Miss Tokens)</div>
                  </div>
                </div>

                <div className="ai-cache-stat-card">
                  <div className="ai-cache-stat-card__icon" style={{ background: 'rgba(24, 144, 255, 0.1)', color: '#1890ff' }}>
                    <CheckCircleOutlined />
                  </div>
                  <div className="ai-cache-stat-card__info">
                    <div className="ai-cache-stat-card__val">
                      {llmUsage && (llmUsage.cacheHitTokens + llmUsage.cacheMissTokens > 0)
                        ? `${Math.round((llmUsage.cacheHitTokens / (llmUsage.cacheHitTokens + llmUsage.cacheMissTokens)) * 100)}%`
                        : '100%'}
                    </div>
                    <div className="ai-cache-stat-card__lbl">Token 命中率</div>
                  </div>
                </div>
              </div>

              <div className="ai-cache-tip-footer">
                <InfoCircleOutlined className="tip-icon" />
                <span>
                  记录当前会话调用模型返回的 <code>prompt_cache_hit / miss_tokens</code>。前缀越稳定，账单中缓存命中越多（DeepSeek 等供应商命中价格低至未命中的 1/10）。连续分析岗位可保持极高命中率。
                </span>
              </div>
            </div>
          </div>

          {/* AI 技能（Skills 层）：调用 AI 时按作用域注入已启用技能的指令 */}
          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <AimOutlined />
                </div>
                AI 技能（Skills 层）
              </div>
              <Tag color="purple">运行时启用</Tag>
            </div>
            <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12, fontSize: 13 }}>
              调用 AI 时按任务作用域自动注入已启用的技能指令。
              关闭某技能后，对应 AI 调用的增强约束不再注入；开关变化会使相关 AI 缓存自动失效，下次调用按新状态重新生成。
              支持导入标准 SKILL.md（frontmatter + 正文）或手动新建自定义技能，自定义技能保存在本机用户数据目录。
            </Paragraph>
            {skills.map((sk) => (
              <div key={sk.id} className="sg-item" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <Space size={8} wrap>
                      <Text strong style={{ fontSize: 13 }}>{sk.name}</Text>
                      {sk.custom ? <Tag color="purple">自定义</Tag> : <Tag>内置</Tag>}
                      <Tag color="blue">{sk.scope}</Tag>
                      {sk.enabled ? <Tag color="green">启用中</Tag> : <Tag>已停用</Tag>}
                    </Space>
                    <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>{sk.description}</Paragraph>
                  </div>
                  <Space size={4}>
                    {sk.custom && (
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        title="删除自定义技能"
                        onClick={() => onDeleteSkill(sk.id, sk.name)}
                      />
                    )}
                    <Switch checked={sk.enabled} onChange={(v) => onToggleSkill(sk.id, v)} />
                  </Space>
                </div>
              </div>
            ))}
            <div className="setting-actions" style={{ marginTop: 8 }}>
              <Space wrap>
                <Button size="small" icon={<FileAddOutlined />} onClick={() => skillImportRef.current?.click()}>
                  导入 SKILL.md
                </Button>
                <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateSkillOpen(true)}>
                  新建技能
                </Button>
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={() => { resetAllSkills(); refreshSkills(); message.success('已恢复全部技能为默认启用'); }}
                >
                  恢复默认
                </Button>
              </Space>
              <input ref={skillImportRef} type="file" accept=".md,.markdown,.txt" hidden onChange={onImportSkillFile} />
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
                    description={cfx?.message || '请先下载 Camoufox 隐身引擎内核（暂未下载），或点击「检测状态」。'}
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
                      disabled={Boolean(cfx?.engine?.loggedIn) || (!cfx?.ready && !cfxConfig.enabled)}
                      onClick={onCamoufoxLogin}
                    >
                      {cfx?.engine?.loggedIn ? '已登录' : '隐身扫码登录'}
                    </Button>
                    <Button
                      size="middle"
                      danger
                      icon={<StopOutlined />}
                      disabled={!cfx?.engine?.loggedIn}
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

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <AimOutlined />
                </div>
                达标岗位导出
              </div>
              {qualifiedJobsDir ? <Tag color="green">已设置导出目录</Tag> : <Tag>未设置导出目录</Tag>}
            </div>
            <div className="setting-actions">
              <Space size={12} wrap>
                <Button
                  size="middle"
                  className="btn-uniform"
                  icon={<FolderOpenOutlined />}
                  onClick={onPickQualifiedJobsDir}
                >
                  选择导出文件夹
                </Button>
                <Button
                  size="middle"
                  className="btn-uniform"
                  icon={<SaveOutlined />}
                  loading={exportingQualified}
                  onClick={onSaveQualifiedJobs}
                >
                  保存达标岗位到本地
                </Button>
              </Space>
            </div>
            <Paragraph
              type="secondary"
              style={{ marginTop: 14, marginBottom: 0, fontSize: 13,
                wordBreak: 'break-all', fontFamily: 'monospace' }}
            >
              当前导出目录：{qualifiedJobsDir || '（未设置，保存时弹出系统对话框选择）'}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
              从工作台岗位队列中，把分析评分<strong>≥ 推荐岗位分（minScore）</strong>的达标岗位写入本地磁盘。
              每个自然日一个文件（bossclaw-qualified-jobs-YYYY-MM-DD.json）；同一天重复点击只追新增并去重，当日数据累积完整，不跨天重算、不删除。
            </Paragraph>
          </div>

          <div className="settings-section-card">
            <div className="settings-section-header">
              <div className="settings-section-header__title">
                <div className="section-icon-box">
                  <HddOutlined />
                </div>
                本地自动备份
              </div>
              {backupDir ? <Tag color="green">已设置备份目录</Tag> : <Tag>默认目录</Tag>}
            </div>
            <div className="setting-actions">
              <Space size={12} wrap>
                <Button size="middle" className="btn-uniform" icon={<FolderOpenOutlined />} onClick={onPickBackupDir}>
                  选择备份目录
                </Button>
                <Button size="middle" className="btn-uniform" icon={<SaveOutlined />} onClick={onBackupNow}>
                  立即备份
                </Button>
                <Button size="middle" className="btn-uniform" icon={<UploadOutlined />} onClick={onRestoreBackup}>
                  从本地备份恢复
                </Button>
              </Space>
            </div>
            <Paragraph
              type="secondary"
              style={{ marginTop: 14, marginBottom: 0, fontSize: 13,
                wordBreak: 'break-all', fontFamily: 'monospace' }}
            >
              当前备份目录：{backupDir || '（默认 userData/backup）'}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
              岗位信息、简历、登录/会话相关持久内容与日志信息将<strong>每 5 分钟</strong>自动备份到该目录；
              内容未变化则不重写文件（脏检查）。localStorage 仍为主存储，仅当其缺失/被清空时，才从本地备份文件恢复。
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

      {/* 新建自定义技能弹窗 */}
      <Modal
        title="新建自定义技能"
        open={createSkillOpen}
        onOk={onCreateSkillSubmit}
        onCancel={() => setCreateSkillOpen(false)}
        okText="创建技能"
        cancelText="取消"
        confirmLoading={creatingSkill}
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          <div>
            <span className="field-label">技能名称（必填，作为展示名）</span>
            <Input
              value={createSkillForm.name}
              onChange={(e) => patchCreateSkill({ name: e.target.value })}
              placeholder="如：销售话术优化 / English Greetings"
            />
          </div>
          <div>
            <span className="field-label">绑定作用域（该技能在什么 AI 调用时注入）</span>
            <Select
              style={{ width: '100%' }}
              value={createSkillForm.scope}
              onChange={(v) => patchCreateSkill({ scope: v as CustomSkillFields['scope'] })}
              options={SKILL_SCOPE_OPTIONS}
            />
          </div>
          <div>
            <span className="field-label">一句话描述（可选）</span>
            <Input
              value={createSkillForm.description}
              onChange={(e) => patchCreateSkill({ description: e.target.value })}
              placeholder="说明该技能的作用，显示在技能列表中"
            />
          </div>
          <div>
            <span className="field-label">技能指令正文（必填，注入 AI system prompt）</span>
            <Input.TextArea
              rows={6}
              value={createSkillForm.instructions}
              onChange={(e) => patchCreateSkill({ instructions: e.target.value })}
              placeholder={'例如：生成 3 条英文打招呼语，每条 30-60 词，以 "Hi, I would like to apply for..." 开头，只引用简历真实事实，输出严格 JSON。'}
            />
          </div>
          <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            自定义技能保存在本机用户数据目录（userData/skills），创建后立即生效，可随时停用或删除；开关变化会使相关 AI 缓存自动失效。
          </Paragraph>
        </div>
      </Modal>
    </div>
  );
}
