// src/lib/controlRuntime.ts —— 渲染层控制运行时（配合 electron/control-bridge.cjs）
// ---------------------------------------------------------------------------
// 外部 agent（bossclaw-mcp）通过主进程控制桥 → executeJavaScript → window.__bossclawControl.dispatch()
// 来读取实时状态与执行**白名单**动作。这里就是白名单的唯一权威实现。
//
// 安全边界（硬约束，任何扩展都必须保持）：
//   · 不提供发送消息 / 触发批量投递 / 绕过验证码 / 修改安全上限的能力；
//   · patchConfig 只允许修改**已存在**且不在 DENY 列表中的 config 字段；
//   · 暂停/恢复投递走专用动作，写 config.pausedUntil（与人工在设置页操作等价）。
import { useAppStore, NAV_ITEMS } from '@/store/useAppStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDataStore } from '@/store/useDataStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import { useAutoChatStore } from '@/store/useAutoChatStore';
import { writeLocalBackup, restoreFromLocalBackup } from '@/lib/localBackup';
import { electronApi } from '@/lib/electronApi';
import { PLATFORM_IDS, platformEnabled, type JobPlatform } from '@/lib/bossclaw/platforms';
import { SAFETY_LIMITS, isLockedOut, effectiveDailyCap, dailySentCount, cooldownRemaining } from '@/lib/bossclaw/safety';
import { analyzeJob } from '@/lib/bossclaw/matching';
import { tailorForJob } from '@/lib/bossclaw/jobAssistant';
import { buildProfile } from '@/lib/bossclaw/profile';
import { buildDirectionPlan } from '@/lib/bossclaw/directions';
import { createTasks } from '@/lib/bossclaw/tasks';
import { buildStatsSnapshot, DEFAULT_STATS_RANGE, rangeText, type StatsRangeKey } from '@/lib/bossclaw/statsAggregate';
import { buildDetailRows, buildSummaryRows, exportFilename, toCsv } from '@/lib/bossclaw/statsExport';
import { buildStatsReportHtml } from '@/lib/bossclaw/statsReport';
import { rerankPending, promoteApprovedToQueue } from '@/lib/bossclaw/priority';
import { TASK_STAGE_META, TERMINAL_RUN_STATUSES, taskStageMetaFor } from '@/lib/bossclaw/taskState';
import { isDeliveryClaimed } from '@/lib/bossclaw/deliveryLock';
import { getBrowser } from '@/lib/browserRegistry';
import {
  queryInteractive,
  snapshotInteractive,
  clickElement,
  typeInto,
  submitBy,
  scrollElement,
  waitFor,
  waitForSelector,
} from '@/lib/uiOps';
import type { JobMeta, Profile, PendingItem, TaskRun, TaskStage, PendingStatus, DirectionPlan } from '@/lib/bossclaw/types';
import type { ScheduleEntry } from '@/store/useScheduleStore';

interface ControlOp {
  action: string;
  params?: Record<string, unknown>;
}

interface ControlResult {
  applied: boolean;
  message?: string;
  previous?: unknown;
  next?: unknown;
  [key: string]: unknown;
}

/** 禁止通过 patchConfig 直接改写的字段（走专用动作或会破坏安全语义） */
const CONFIG_DENY = new Set(['model', 'pausedUntil', 'platforms']);

const ROUTE_KEYS = new Set(NAV_ITEMS.map((n) => n.key));

function countByStatus(items: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of (items as Array<{ status?: string }>) || []) {
    const k = it?.status ?? 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function maskKey(key?: string): string | null {
  if (!key) return null;
  return key.length <= 8 ? `${key.slice(0, 2)}***` : `${key.slice(0, 4)}***${key.slice(-4)}`;
}

/** 实时状态快照（把内存里的 store 汇总成一个可 JSON 序列化的对象） */
function snapshotState(): Record<string, unknown> {
  const app = useAppStore.getState();
  const cfg = useSettingsStore.getState().config;
  const data = useDataStore.getState();
  const sched = useScheduleStore.getState();
  const auto = useAutoChatStore.getState();
  const now = Date.now();
  const pausedUntil = Number(cfg.pausedUntil) || 0;
  const profile = data.profile as unknown as { primaryRole?: string; role?: string } | null;

  return {
    at: now,
    app: {
      activeRoute: app.activeRoute,
      theme: app.theme,
      effectiveTheme: (() => {
        try {
          return document.documentElement.getAttribute('data-theme') || app.theme;
        } catch {
          return app.theme;
        }
      })(),
      autoAssist: app.autoAssist,
      engineStatus: app.engineStatus,
      bridgeStatus: app.bridgeStatus,
      bossLoggedIn: app.bossLoggedIn,
      sidebarCollapsed: app.sidebarCollapsed,
      currentAction: app.currentAction,
      pauseRemainMin: pausedUntil > now ? Math.ceil((pausedUntil - now) / 60000) : 0,
      pausedUntil,
    },
    browser: (() => {
      const b = getBrowser();
      if (!b) return { available: false, mode: null, tabs: [] };
      return { available: true, mode: b.mode, tabs: (() => { try { return b.tabs(); } catch { return []; } })() };
    })(),
    settings: {
      config: { ...cfg, model: { ...cfg.model, apiKey: maskKey(cfg.model?.apiKey) } },
      safetyLimits: SAFETY_LIMITS,
    },
    data: {
      stats: data.stats,
      pendingCounts: countByStatus(data.pending),
      pendingTotal: (data.pending || []).length,
      taskRunCounts: countByStatus(data.taskRuns),
      resume: { chars: (data.resumeText || '').length, fileName: data.resumeFileName || null },
      profile: { present: !!data.profile, role: profile?.primaryRole || profile?.role || null },
      greetings: data.greetings || [],
      greetingPromptChars: (data.greetingPrompt || '').length,
      directionPlan: !!data.directionPlan,
      logs: { count: (data.logs || []).length, tail: (data.logs || []).slice(-20) },
      chatLogs: { count: (data.chatLogs || []).length, tail: (data.chatLogs || []).slice(-20) },
    },
    schedule: { entries: sched.entries || [] },
    autochat: { chatRunning: auto.chatRunning, activeChatId: auto.activeChatId, progress: auto.progress },
    engine: {
      engineStatus: app.engineStatus,
      autoAssist: app.autoAssist,
      pausedUntil,
      engineMode: (cfg as unknown as { engineMode?: string }).engineMode ?? null,
    },
    routes: NAV_ITEMS,
  };
}

// ===========================================================================
// 动作白名单
// ===========================================================================

type Handler = (params: Record<string, unknown>) => Promise<ControlResult> | ControlResult;

const handlers: Record<string, Handler> = {
  state: () => ({ applied: true, message: '实时状态快照', next: snapshotState() }),

  navigate: ({ route }) => {
    const r = String(route || '');
    if (!ROUTE_KEYS.has(r as never)) {
      return { applied: false, message: `未知路由 ${r}（可用：${[...ROUTE_KEYS].join(', ')}）` };
    }
    const prev = useAppStore.getState().activeRoute;
    useAppStore.getState().setRoute(r as never);
    return { applied: true, message: `已切换到「${NAV_ITEMS.find((n) => n.key === r)?.label ?? r}」`, previous: prev, next: r };
  },

  setTheme: ({ theme }) => {
    if (theme !== 'light' && theme !== 'dark') return { applied: false, message: 'theme 必须是 light 或 dark' };
    const prev = useAppStore.getState().theme;
    useAppStore.getState().setTheme(theme);
    return { applied: true, message: `主题已切换为 ${theme}`, previous: prev, next: theme };
  },

  setSidebarCollapsed: ({ collapsed }) => {
    const prev = useAppStore.getState().sidebarCollapsed;
    useAppStore.getState().setSidebarCollapsed(Boolean(collapsed));
    return { applied: true, message: `侧栏${collapsed ? '已收起' : '已展开'}`, previous: prev, next: Boolean(collapsed) };
  },

  /** 等价于标题栏「投递引擎」开关；不会自行发起任何投递 */
  setAutoAssist: ({ enabled }) => {
    const prev = useAppStore.getState().autoAssist;
    useAppStore.getState().setAutoAssist(Boolean(enabled));
    return {
      applied: true,
      message: `投递引擎开关已${enabled ? '开启' : '关闭'}（仅切换开关，不会自动投递）`,
      previous: prev,
      next: Boolean(enabled),
    };
  },

  pauseDelivery: ({ minutes }) => {
    const m = Math.min(Math.max(Number(minutes) || 30, 1), 1440);
    const prev = useSettingsStore.getState().config.pausedUntil;
    const next = Date.now() + m * 60_000;
    useSettingsStore.getState().setConfig({ pausedUntil: next });
    return { applied: true, message: `投递已暂停 ${m} 分钟（至 ${new Date(next).toLocaleString()}）`, previous: prev, next };
  },

  resumeDelivery: () => {
    const prev = useSettingsStore.getState().config.pausedUntil;
    useSettingsStore.getState().setConfig({ pausedUntil: 0 });
    return { applied: true, message: '已解除暂停', previous: prev, next: 0 };
  },

  patchConfig: ({ patch }) => {
    if (!patch || typeof patch !== 'object') return { applied: false, message: 'patch 必须是对象' };
    const cfg = useSettingsStore.getState().config as unknown as Record<string, unknown>;
    const applied: Record<string, unknown> = {};
    const skipped: string[] = [];
    const previous: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (CONFIG_DENY.has(k)) {
        skipped.push(`${k}（受保护，请用专用动作）`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(cfg, k)) {
        skipped.push(`${k}（不是已有配置字段）`);
        continue;
      }
      previous[k] = cfg[k];
      applied[k] = v;
    }
    if (!Object.keys(applied).length) {
      return { applied: false, message: `没有可应用的字段：${skipped.join('；')}`, next: { skipped } };
    }
    useSettingsStore.getState().setConfig(applied as never);
    return {
      applied: true,
      message: `已修改 ${Object.keys(applied).join(', ')}${skipped.length ? `；跳过 ${skipped.join('；')}` : ''}`,
      previous,
      next: applied,
    };
  },

  setPlatform: ({ platform, enabled, dailyTarget, priority }) => {
    const p = String(platform || '') as JobPlatform;
    if (!PLATFORM_IDS.includes(p)) return { applied: false, message: `未知平台 ${p}（可用：${PLATFORM_IDS.join(', ')}）` };
    const cfg = useSettingsStore.getState().config;
    const prev = { ...(cfg.platforms?.[p] as object) };
    const patch: Record<string, unknown> = {};
    if (enabled !== undefined) patch.enabled = Boolean(enabled);
    if (dailyTarget !== undefined) patch.dailyTarget = Math.min(Math.max(Number(dailyTarget) || 0, 0), SAFETY_LIMITS.MAX_SAFE_DAILY);
    if (priority !== undefined) patch.priority = Number(priority);
    if (!Object.keys(patch).length) return { applied: false, message: '至少提供 enabled / dailyTarget / priority 之一' };
    useSettingsStore.getState().setConfig({
      platforms: { ...cfg.platforms, [p]: { ...cfg.platforms[p], ...patch } },
    } as never);
    return {
      applied: true,
      message: `平台 ${p} 已更新${patch.dailyTarget !== undefined ? `（日目标会被平台侧上限与 ${SAFETY_LIMITS.MAX_SAFE_DAILY} 封顶）` : ''}`,
      previous: prev,
      next: patch,
    };
  },

  backupNow: async () => {
    const r = await writeLocalBackup(true);
    return {
      applied: r.wrote,
      message: r.wrote ? '已立即写入本地备份快照' : `未写盘：${r.error || '内容无变化'}`,
      next: r,
    };
  },

  restoreBackup: async () => {
    const r = await restoreFromLocalBackup();
    if (r.restored) setTimeout(() => { try { window.location.reload(); } catch { /* 忽略 */ } }, 400);
    return {
      applied: r.restored,
      message: r.restored ? '已从备份恢复，400ms 后整页重载生效' : `未恢复：${r.error || '备份中没有可用数据'}`,
      next: r,
    };
  },

  addLog: ({ level, msg }) => {
    const lv = (['info', 'warn', 'error', 'success'] as const).includes(level as never) ? (level as 'info' | 'warn' | 'error' | 'success') : 'info';
    useDataStore.getState().addLog(lv, `[agent] ${String(msg ?? '').slice(0, 400)}`);
    return { applied: true, message: '已写入日志面板' };
  },

  clearLogs: () => {
    useDataStore.getState().clearLogs();
    return { applied: true, message: '日志面板已清空' };
  },

  /** 只读：探测两套隐身引擎的真实状态（可能耗时数百毫秒，按需调用） */
  engineStatus: async () => {
      const [camoufox, cloak] = await Promise.all([
        electronApi.camoufox.status().catch(() => ({ ready: false, running: false, message: '探测失败' })),
        electronApi.cloak.status().catch(() => ({ ready: false, lastError: '探测失败' })),
      ]);
      return { applied: true, message: '引擎状态', next: { camoufox, cloak } };
    },

  // ---- 业务数据管理（直接读写 store）----
  dataSetResume: ({ text, fileName }) => {
    const next = String(text ?? '');
    const prev = useDataStore.getState().resumeText;
    useDataStore.getState().setResumeText(next, fileName !== undefined ? String(fileName) : undefined);
    return { applied: true, message: `已保存简历（${next.length} 字）`, previous: { length: prev.length }, next: { length: next.length } };
  },
  dataSetProfile: ({ profile }) => {
    useDataStore.getState().setProfile((profile ?? null) as Profile | null);
    return { applied: true, message: profile ? '职业画像已更新' : '职业画像已清空', next: Boolean(profile) };
  },
  dataSetDirectionPlan: ({ plan }) => {
    useDataStore.getState().setDirectionPlan((plan ?? null) as never);
    return { applied: true, message: plan ? '投递方向计划已更新' : '投递方向计划已清空' };
  },
  dataSetGreetings: ({ items }) => {
    const list = Array.isArray(items) ? items.map((x) => String(x)) : [];
    const prev = useDataStore.getState().greetings.length;
    useDataStore.getState().setGreetings(list);
    const next = useDataStore.getState().greetings.length;
    return { applied: true, message: `打招呼语已保存（有效 ${next} 条，已过滤过短项）`, previous: prev, next };
  },
  dataSetGreetingPrompt: ({ prompt }) => {
    useDataStore.getState().setGreetingPrompt(String(prompt ?? ''));
    return { applied: true, message: '打招呼语提示词已更新' };
  },
  dataSetCommunicationInfo: ({ info }) => {
    useDataStore.getState().setCommunicationInfo(String(info ?? ''));
    return { applied: true, message: '沟通信息已更新' };
  },
  dataPendingAdd: ({ item }) => {
    if (!item || typeof item !== 'object') return { applied: false, message: '缺少待沟通岗位对象 item' };
    useDataStore.getState().addPendingItem(item as PendingItem);
    return { applied: true, message: '已加入待沟通岗位' };
  },
  dataPendingUpdate: ({ id, patch }) => {
    const pid = String(id ?? '');
    if (!pid || !patch || typeof patch !== 'object') return { applied: false, message: '需要 id 与 patch' };
    const exist = useDataStore.getState().pending.some((p) => p.id === pid);
    if (!exist) return { applied: false, message: `待沟通岗位不存在：${pid}` };
    useDataStore.getState().updatePending(pid, patch as Partial<PendingItem>);
    return { applied: true, message: `待沟通岗位 ${pid} 已更新` };
  },
  dataTaskRunUpdate: ({ id, patch }) => {
    const rid = String(id ?? '');
    if (!rid || !patch || typeof patch !== 'object') return { applied: false, message: '需要 id 与 patch' };
    useDataStore.getState().updateTaskRun(rid, patch as Partial<TaskRun>);
    return { applied: true, message: `任务进度 ${rid} 已更新` };
  },
  dataAddChatLog: ({ entry }) => {
    if (!entry || typeof entry !== 'object') return { applied: false, message: '缺少沟通日志对象 entry' };
    useDataStore.getState().addChatLog(entry as never);
    return { applied: true, message: '已追加一条沟通日志' };
  },
  scheduleAdd: ({ entry }) => {
    if (!entry || typeof entry !== 'object') return { applied: false, message: '缺少定时任务对象 entry' };
    const created = useScheduleStore.getState().addEntry(entry as never);
    return { applied: true, message: `已新增定时任务「${created.name}」`, next: { id: created.id } };
  },
  scheduleUpdate: ({ id, patch }) => {
    const sid = String(id ?? '');
    if (!sid || !patch || typeof patch !== 'object') return { applied: false, message: '需要 id 与 patch' };
    useScheduleStore.getState().updateEntry(sid, patch as Partial<ScheduleEntry>);
    return { applied: true, message: `定时任务 ${sid} 已更新` };
  },
  scheduleRemove: ({ id }) => {
    const sid = String(id ?? '');
    if (!sid) return { applied: false, message: '缺少 id' };
    useScheduleStore.getState().removeEntry(sid);
    return { applied: true, message: `定时任务 ${sid} 已删除` };
  },
  scheduleToggle: ({ id, enabled }) => {
    const sid = String(id ?? '');
    if (!sid) return { applied: false, message: '缺少 id' };
    useScheduleStore.getState().toggleEntry(sid, Boolean(enabled));
    return { applied: true, message: `定时任务 ${sid} 已${enabled ? '启用' : '停用'}` };
  },

  // ---- AI 按需生成（复用工作台定制提示词链路，自带 agent 代答与缓存；长耗时）----
  aiAnalyzeJob: async ({ job, resumeText, customGreetingPrompt }) => {
    if (!job || typeof job !== 'object') return { applied: false, message: '缺少岗位对象 job（含 title/company/salary/location/description 等字段）' };
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const out = await analyzeJob(
      job as JobMeta,
      data.profile,
      resumeText !== undefined ? String(resumeText) : data.resumeText,
      cfg,
      cfg.model,
      customGreetingPrompt !== undefined ? String(customGreetingPrompt) : undefined
    );
    return { applied: true, message: 'AI 岗位分析完成（含决策/分数/打招呼语）', next: out };
  },
  aiTailorResume: async ({ job, greetingInstructions }) => {
    if (!job || typeof job !== 'object') return { applied: false, message: '缺少岗位对象 job' };
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const out = await tailorForJob(
      job as JobMeta,
      data.resumeText,
      data.profile,
      cfg.model,
      greetingInstructions !== undefined ? String(greetingInstructions) : undefined
    );
    return { applied: true, message: 'AI 定制简历/求职信完成', next: out };
  },

  // ---- 浏览器只读探索（经 browserRegistry；cloak 引擎不可用或返回明确说明）----
  browserSearch: async ({ query, city, page, pageSize }) => {
    const b = getBrowser();
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    const out = await b.joblist(String(query ?? ''), city !== undefined ? String(city) : undefined, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
    const err = (out as { error?: string })?.error;
    return { applied: !err, message: err ? `岗位列表获取失败：${err}` : '岗位列表（BOSS 官方 API，只读）', next: out };
  },
  browserOpenJob: ({ url, tabId }) => {
    const b = getBrowser();
    const u = String(url ?? '');
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    if (!/^https?:\/\//.test(u)) return { applied: false, message: `URL 必须是 http(s) 绝对地址` };
    b.loadURL(u, tabId !== undefined ? String(tabId) : undefined);
    return { applied: true, message: '已在浏览器打开岗位详情', next: { url: u, mode: b.mode } };
  },
  browserReadPage: async ({ tabId }) => {
    const b = getBrowser();
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    const out = await b.readPage(tabId !== undefined ? String(tabId) : undefined);
    return { applied: true, message: '页面文本读取（只读）', next: out };
  },
  browserReadJob: async ({ encryptJobId }) => {
    const b = getBrowser();
    const jid = String(encryptJobId ?? '');
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    if (!jid) return { applied: false, message: '缺少岗位 encryptJobId' };
    const out = await b.jobCard(jid);
    const err = (out as { error?: string })?.error;
    return { applied: !err, message: err ? `岗位详情获取失败：${err}` : '岗位详情（BOSS 官方 API，只读）', next: out };
  },
  browserDomDump: ({ tabId }) => {
    const b = getBrowser();
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    const out = b.domDump(tabId !== undefined ? String(tabId) : undefined);
    return { applied: true, message: '已触发 DOM 诊断', next: out };
  },

  // ---- 投递（半自动 / 全自动，跟随 executionMode）----
  deliverySetMode: ({ mode }) => {
    if (mode !== 'auto' && mode !== 'review') return { applied: false, message: 'mode 必须是 auto 或 review' };
    const prev = useSettingsStore.getState().config.executionMode;
    useSettingsStore.getState().setConfig({ executionMode: mode } as never);
    return { applied: true, message: `投递模式已切换为 ${mode === 'auto' ? '全自动' : '人工确认(半自动)'}`, previous: prev, next: mode };
  },
  deliveryDraft: async ({ greeting }) => {
    const g = String(greeting ?? '');
    if (!g.trim()) return { applied: false, message: '缺少招呼语 greeting' };
    const b = getBrowser();
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    const out = await b.prefillGreeting(g);
    return { applied: out.ok, message: out.ok ? '已在沟通框填入草稿（未发送，请用户核对后发送）' : `预填失败：${out.reason || '未知原因'}`, next: out };
  },
  deliverySendNow: async ({ greeting }) => {
    // 安全护栏：仅当用户已开启「全自动」（executionMode==='auto'）时，agent 才能触发自动投递
    const mode = useSettingsStore.getState().config.executionMode;
    if (mode !== 'auto') {
      return { applied: false, message: '全自动未开启（executionMode 为 review），自动投递已被拒绝；请先在应用内开启全自动，或用 delivery.draft 草拟后由用户发送' };
    }
    const b = getBrowser();
    if (!b) return { applied: false, message: '浏览器控制不可用（需 webview 引擎运行）' };
    const out = await b.sendApply(greeting !== undefined ? { greeting: String(greeting) } : {});
    return { applied: out.ok, message: out.ok ? (out.hint || '已触发自动投递') : (out.reason || '触发失败'), next: out };
  },

  // ===== A. 通用 UI 接管（scope: app → document；webview → browser.uiExec）=====
  uiSnapshot: async ({ scope, selector, limit }) => {
    if (scope === 'webview') {
      const b = getBrowser();
      if (!b) return { applied: false, message: 'webview 引擎不可用' };
      const res = await b.uiExec('query', { selector, limit });
      if (!res?.ok) return { applied: false, message: res?.result?.error || res?.error || '页面查询失败', next: res?.result };
      const elements = res.result?.elements || res.result || [];
      return { applied: true, message: 'webview 交互元素快照', next: { elements, count: elements?.length || 0 } };
    }
    const elements = snapshotInteractive(document, selector ? String(selector) : undefined, Number(limit) || undefined);
    return { applied: true, message: '应用界面交互元素快照', next: { elements, count: elements.length } };
  },

  uiClick: async ({ scope, selector, label, index }) => {
    if (scope === 'webview') {
      const b = getBrowser();
      if (!b) return { applied: false, message: 'webview 引擎不可用' };
      const res = await b.uiExec('click', { selector, label, index });
      if (!res?.ok) return { applied: false, message: res?.result?.error || res?.error || '点击失败', next: res?.result };
      return { applied: true, message: '已在 webview 点击元素', next: res.result };
    }
    const el = queryInteractive(selector ? String(selector) : undefined, label ? String(label) : undefined, Number(index) || 0);
    if (!el) return { applied: false, message: `未命中可见元素${selector ? `：${selector}` : '（无候选）'}` };
    clickElement(el);
    return { applied: true, message: '已点击元素', previous: { selector: selector || null }, next: { clicked: true } };
  },

  uiType: async ({ scope, selector, into, label, index, value, clear }) => {
    const targetSel = String(into || selector || '');
    const v = String(value ?? '');
    if (!targetSel) return { applied: false, message: '需要 selector/into 指定输入框' };
    if (scope === 'webview') {
      const b = getBrowser();
      if (!b) return { applied: false, message: 'webview 引擎不可用' };
      const res = await b.uiExec('type', { selector: targetSel, label, index, value: v, clear: !!clear });
      if (!res?.ok) return { applied: false, message: res?.result?.error || res?.error || '输入失败', next: res?.result };
      return { applied: true, message: '已在 webview 写入输入框', next: res.result };
    }
    const el = queryInteractive(targetSel, label ? String(label) : undefined, Number(index) || 0);
    if (!el) return { applied: false, message: `未命中输入框：${targetSel}` };
    if (el.matches('[contenteditable]')) return { applied: false, message: 'contenteditable 聊天框请用 deliveryDraft' };
    const ok = typeInto(el, v);
    if (!ok) return { applied: false, message: '目标不是可输入的 input/textarea' };
    return { applied: true, message: '已写入输入框', previous: { value: v }, next: { value: v, selector: targetSel } };
  },

  uiSubmit: async ({ scope, selector }) => {
    if (scope === 'webview') {
      const b = getBrowser();
      if (!b) return { applied: false, message: 'webview 引擎不可用' };
      const res = await b.uiExec('click', { selector: selector || 'button[type="submit"], input[type="submit"]' });
      if (!res?.ok) return { applied: false, message: res?.result?.error || res?.error || '提交失败', next: res?.result };
      return { applied: true, message: '已在 webview 触发提交', next: res.result };
    }
    const el = selector ? queryInteractive(String(selector)) : (document.activeElement as HTMLElement);
    if (!el) return { applied: false, message: '未命中可提交元素' };
    const ok = submitBy(el);
    return { applied: ok, message: ok ? '已提交表单' : '该元素不是可提交目标', next: { submitted: ok } };
  },

  uiScroll: async ({ scope, selector, dy, to }) => {
    const target = selector ? String(selector) : undefined;
    if (scope === 'webview') {
      const b = getBrowser();
      if (!b) return { applied: false, message: 'webview 引擎不可用' };
      const res = await b.uiExec('scroll', { selector: target, dy: dy ? Number(dy) : undefined, to });
      if (!res?.ok) return { applied: false, message: res?.result?.error || res?.error || '滚动失败', next: res?.result };
      return { applied: true, message: '已滚动 webview', next: res.result };
    }
    const el = target ? queryInteractive(target) : null;
    const ok = scrollElement(el, dy ? Number(dy) : undefined, to === 'top' || to === 'bottom' ? to : undefined);
    return { applied: ok, message: ok ? '已滚动' : '滚动参数无效', next: {} };
  },

  uiWait: async ({ ms, selector, timeoutMs }) => {
    if (ms != null) {
      await waitFor(Number(ms));
      return { applied: true, message: `等待 ${ms}ms` };
    }
    if (selector && String(selector).trim()) {
      const el = await waitForSelector(String(selector), Number(timeoutMs) || 10_000);
      return { applied: !!el, message: el ? '元素已就绪' : `等待元素超时：${selector}`, next: { found: !!el } };
    }
    return { applied: false, message: 'uiWait 需要 ms 或 selector' };
  },

  // ===== B. 自动沟通引擎接管 =====
  autochatStart: ({ platforms, maxCount }) => {
    const auto = useAutoChatStore.getState();
    if (auto.chatRunning) return { applied: false, message: '后台沟通已在运行' };
    const cfg = useSettingsStore.getState().config;
    if (isLockedOut(cfg)) return { applied: false, message: `冷却期内不可启动（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟）` };
    auto.start({
      platforms: Array.isArray(platforms) ? (platforms.map(String) as JobPlatform[]) : undefined,
      maxCount: maxCount != null ? Number(maxCount) : undefined,
    });
    return { applied: true, message: '后台自动沟通已启动（持续处理队列，切页仍运行）', next: { chatRunning: true } };
  },

  autochatStop: () => {
    useAutoChatStore.getState().stop();
    return { applied: true, message: '已停止后台沟通', next: { chatRunning: false } };
  },

  autochatStep: ({ id }) => {
    const auto = useAutoChatStore.getState();
    if (auto.chatRunning) return { applied: false, message: '后台沟通运行中，请先 autochatStop 再单步' };
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    if (isLockedOut(cfg)) return { applied: false, message: `冷却期内不可投递（剩余约 ${Math.ceil(cooldownRemaining(cfg) / 60000)} 分钟）` };
    if (dailySentCount(data.pending) >= effectiveDailyCap(cfg)) return { applied: false, message: `今日已达上限 ${effectiveDailyCap(cfg)} 条` };
    let item: PendingItem | undefined;
    if (id) {
      item = data.pending.find((p) => p.id === String(id));
      if (!item) return { applied: false, message: `待沟通岗位不存在：${id}` };
    } else {
      item = rerankPending(data.pending, cfg).find(
        (p) =>
          (p.status === 'approved' || p.status === 'opened') &&
          !isDeliveryClaimed(p.id) &&
          platformEnabled(cfg, String(p.job?.platform || 'boss') as JobPlatform)
      );
    }
    if (!item) return { applied: false, message: '没有可单步沟通的岗位（需 status∈approved/opened 且平台已启用）' };
    if (!(item.deliveryGreeting || '').trim()) return { applied: false, message: '该岗位招呼语为空，拒绝发送' };
    auto.chatOne(item);
    return {
      applied: true,
      message: '已触发单条沟通（结果异步，可轮询 autochatStatus / bossclaw_app_state）',
      next: { id: item.id, title: item.job?.title, company: item.job?.company, note: '异步' },
    };
  },

  autochatStatus: () => {
    const auto = useAutoChatStore.getState();
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const nextEligible = rerankPending(data.pending, cfg).find(
      (p) =>
        (p.status === 'approved' || p.status === 'opened') &&
        platformEnabled(cfg, String(p.job?.platform || 'boss') as JobPlatform)
    );
    return {
      applied: true,
      message: '自动沟通状态',
      next: {
        chatRunning: auto.chatRunning,
        activeChatId: auto.activeChatId,
        progress: auto.progress,
        eligibleNext: nextEligible
          ? { id: nextEligible.id, title: nextEligible.job?.title, company: nextEligible.job?.company }
          : null,
      },
    };
  },

  // ===== C. 完整数据读取 =====
  appDataFull: ({ sections, maxPending, maxLogs }) => {
    const data = useDataStore.getState();
    const sched = useScheduleStore.getState();
    const want = (k: string) => !Array.isArray(sections) || sections.length === 0 || (sections as string[]).map(String).includes(k);
    const maxP = Math.min(Math.max(Number(maxPending) || 100, 1), 500);
    const maxL = Math.min(Math.max(Number(maxLogs) || 200, 1), 500);
    const sectionsOut: Record<string, unknown> = {};
    if (want('resume')) sectionsOut.resume = { present: !!data.resumeText, chars: data.resumeText.length, fileName: data.resumeFileName, text: data.resumeText };
    if (want('profile')) sectionsOut.profile = { present: !!data.profile, value: data.profile };
    if (want('directionPlan')) sectionsOut.directionPlan = { present: !!data.directionPlan, value: data.directionPlan };
    if (want('greetings')) sectionsOut.greetings = data.greetings || [];
    if (want('greetingPrompt')) sectionsOut.greetingPrompt = data.greetingPrompt || '';
    if (want('communicationInfo')) sectionsOut.communicationInfo = data.communicationInfo || '';
    if (want('pending')) {
      sectionsOut.pending = {
        present: (data.pending || []).length > 0,
        items: (data.pending || []).slice(0, maxP).map((p) => (p.job ? { ...p, job: { ...p.job, description: (p.job.description || '').slice(0, 200), cardText: (p.job.cardText || '').slice(0, 200) } } : p)),
      };
    }
    if (want('taskRuns')) sectionsOut.taskRuns = { present: (data.taskRuns || []).length > 0, items: (data.taskRuns || []).slice(0, 200) };
    if (want('schedule')) sectionsOut.schedule = { present: (sched.entries || []).length > 0, items: sched.entries };
    if (want('chatLogs')) sectionsOut.chatLogs = { present: (data.chatLogs || []).length > 0, items: (data.chatLogs || []).slice(-maxL) };
    if (want('imageResumes')) sectionsOut.imageResumes = (data.imageResumes || []).map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt }));
    return {
      applied: true,
      message: '完整数据读取（不含 base64 图片）',
      next: {
        counts: {
          pending: data.pending.length,
          taskRuns: data.taskRuns.length,
          greetings: data.greetings.length,
          chatLogs: data.chatLogs.length,
          schedule: sched.entries.length,
          imageResumes: (data.imageResumes || []).length,
        },
        sections: sectionsOut,
      },
    };
  },

  // ===== D. 队列与任务深度接管 =====
  pendingApprove: ({ id, ids }) => {
    const data = useDataStore.getState();
    const targets = Array.isArray(ids) ? ids.map(String) : id ? [String(id)] : [];
    if (!targets.length) return { applied: false, message: '需要 id 或 ids' };
    const updated: string[] = [];
    const missing: string[] = [];
    for (const t of targets) {
      if (!data.pending.some((p) => p.id === t)) { missing.push(t); continue; }
      data.updatePending(t, { status: 'approved' as PendingStatus, approvedAt: Date.now() });
      updated.push(t);
    }
    return { applied: updated.length > 0, message: `已批准 ${updated.length} 条${missing.length ? `；缺失 ${missing.join(', ')}` : ''}`, next: { updated, missing } };
  },

  pendingReject: ({ id, ids }) => {
    const data = useDataStore.getState();
    const targets = Array.isArray(ids) ? ids.map(String) : id ? [String(id)] : [];
    if (!targets.length) return { applied: false, message: '需要 id 或 ids' };
    const updated: string[] = [];
    const missing: string[] = [];
    for (const t of targets) {
      if (!data.pending.some((p) => p.id === t)) { missing.push(t); continue; }
      data.updatePending(t, { status: 'rejected' as PendingStatus });
      updated.push(t);
    }
    return { applied: updated.length > 0, message: `已拒绝 ${updated.length} 条${missing.length ? `；缺失 ${missing.join(', ')}` : ''}`, next: { updated, missing } };
  },

  pendingRerank: () => {
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const next = rerankPending(data.pending, cfg);
    data.setPending(next);
    return { applied: true, message: `已按优先级重排 ${next.length} 条`, next: { reordered: next.length } };
  },

  pendingPromote: ({ ids }) => {
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    let base = data.pending;
    if (Array.isArray(ids) && ids.length) {
      const set = new Set(ids.map(String));
      base = base.filter((p) => set.has(p.id));
    }
    const r = promoteApprovedToQueue(base, cfg);
    data.setPending(r.next);
    return { applied: r.count > 0, message: `已将 ${r.count} 条 approved 提升为 approved_queue`, next: { count: r.count } };
  },

  pendingRemove: ({ id }) => {
    const data = useDataStore.getState();
    const tid = String(id ?? '');
    if (!tid) return { applied: false, message: '需要 id' };
    if (!data.pending.some((p) => p.id === tid)) return { applied: false, message: `待沟通岗位不存在：${tid}` };
    data.setPending(data.pending.filter((p) => p.id !== tid));
    return { applied: true, message: `已移除岗位 ${tid}`, next: { removed: true } };
  },

  taskStage: ({ id, direct }) => {
    const data = useDataStore.getState();
    const run = data.taskRuns.find((r) => r.id === String(id ?? ''));
    if (!run) return { applied: false, message: `任务不存在：${id}` };
    const ORDER = Object.keys(TASK_STAGE_META) as TaskStage[];
    const terminal = TERMINAL_RUN_STATUSES.has(run.status);
    let nextStage: TaskStage | null = null;
    if (direct === 'next' || direct === 'prev') {
      if (terminal) return { applied: false, message: '任务已到终态，无法默认 next/prev，请显式传 stage' };
      const idx = ORDER.indexOf(run.stage);
      const ni = direct === 'next' ? (idx < 0 ? 0 : Math.min(idx + 1, ORDER.length - 1)) : idx <= 0 ? 0 : idx - 1;
      nextStage = ORDER[ni];
    } else if (typeof direct === 'string' && ORDER.includes(direct as TaskStage)) {
      nextStage = direct as TaskStage;
    } else {
      return { applied: false, message: `direct 必须是 next/prev 或合法阶段（${ORDER.join('/')}）` };
    }
    const meta = taskStageMetaFor(run.job?.platform, nextStage);
    data.updateTaskRun(run.id, { stage: nextStage, progress: meta.progress, stageLabel: meta.label, updatedAt: Date.now() });
    return { applied: true, message: `任务 ${run.id} 阶段 → ${nextStage}`, previous: { stage: run.stage }, next: { stage: nextStage, progress: meta.progress, stageLabel: meta.label } };
  },

  // ===== E. 模块级控制（简历中心 / 定制简历 / 投递方向 / 任务进度）=====
  profileRebuild: async () => {
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const text = (data.resumeText || '').trim();
    if (!text) return { applied: false, message: '尚未导入简历，无法生成职业画像' };
    const profile = await buildProfile(text, cfg.model);
    data.setProfile(profile);
    return { applied: true, message: '职业画像已重建（简历中心 → 生成画像）', next: { method: profile.generation?.mode || 'local' } };
  },

  greetingsAppend: ({ items }) => {
    const data = useDataStore.getState();
    const list = (Array.isArray(items) ? items : []).map(String);
    if (!list.length) return { applied: false, message: '缺少 items' };
    const prev = data.greetings.length;
    data.setGreetings([...data.greetings, ...list]);
    const after = useDataStore.getState().greetings.length;
    return { applied: true, message: '已追加打招呼语', previous: { count: prev }, next: { count: after } };
  },

  resumeTailor: async ({ job, saveTo }) => {
    if (!job || typeof job !== 'object') return { applied: false, message: '缺少岗位对象 job（含 title/company/description 等）' };
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const out = await tailorForJob(job as JobMeta, data.resumeText, data.profile, cfg.model, data.greetingPrompt || undefined);
    const save = String(saveTo || 'none');
    if (save === 'greetings' && out.coverLetter?.trim()) {
      data.setGreetings([...data.greetings, out.coverLetter.trim()]);
    }
    if (save === 'resume') {
      const block = [
        out.tailoredSummary,
        ...(out.tailoredExperiences || []).map((e) => `- ${e}`),
        `技能：${(out.highlightedSkills || []).join('、')}`,
      ].filter(Boolean).join('\n');
      const jm = job as JobMeta;
      const label = `${jm.title || jm.company || '该岗位'}`;
      data.setResumeText(`${data.resumeText.trim()}\n\n== 岗位定制版本（${label}）==\n${block}`, data.resumeFileName);
    }
    return {
      applied: true,
      message: `定制简历完成（method=${out.method}${save !== 'none' ? `，已存至 ${save}` : '，未落盘'}）`,
      next: out,
    };
  },

  directionPlanRebuild: () => {
    const data = useDataStore.getState();
    const next = buildDirectionPlan(data.profile, data.directionPlan, { preserveEdits: true, preserveSelections: true });
    data.setDirectionPlan(next);
    return { applied: true, message: '投递方向计划已重建', next: { count: next.items?.length || 0 } };
  },

  directionItem: ({ id, patch }) => {
    const data = useDataStore.getState();
    const plan = data.directionPlan;
    if (!plan) return { applied: false, message: '尚未生成投递方向计划，请先 directionPlanRebuild' };
    const tid = String(id ?? '');
    const items = plan.items || [];
    const idx = items.findIndex((it) => it.id === tid);
    if (idx < 0) return { applied: false, message: `方向项不存在：${tid}` };
    if (!patch || typeof patch !== 'object') return { applied: false, message: '需要 patch' };
    const previous = { enabled: items[idx].enabled, priority: items[idx].priority };
    const nextItems = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    data.setDirectionPlan({ ...plan, items: nextItems, updatedAt: Date.now() } as DirectionPlan);
    return { applied: true, message: `方向项 ${tid} 已更新`, previous, next: { ...patch } };
  },

  tasksGenerate: () => {
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const tasks = createTasks(data.profile, cfg, data.directionPlan);
    // 与首页「新建任务」（Home.handleCreateTasks）保持同一口径：本动作只重建**投递任务**，
    // 采集任务（cr_ 前缀，由工作台「搜索采集」经 markCollectRun → upsertTaskRun 逐条写入）
    // 必须原样保留 —— taskRuns 是「投递任务 / 采集任务」共用的单一数组，整表 setTaskRuns(tasks)
    // 会把任务进度页的采集卡片、工作台的采集统计条、定时定向采集的 runIds 目标一起抹掉。
    const keptCollectRuns = data.taskRuns.filter((r) => String(r.id || '').startsWith('cr_'));
    data.setTaskRuns([...tasks, ...keptCollectRuns]);
    return {
      applied: true,
      message: `已生成 ${tasks.length} 个任务进度卡片（不自动投递；保留 ${keptCollectRuns.length} 个采集任务）`,
      next: { count: tasks.length, keptCollectRuns: keptCollectRuns.length },
    };
  },

  /**
   * 统计数据导出（**只读**）：返回与统计页完全同源的汇总 / 明细 / 报表文本。
   * 安全边界：不落盘、不弹对话框、不改任何状态 —— 落盘必须由人工在应用内完成
   * （导出硬契约：每次导出都要用户自己选保存位置），因此这里只回传文本。
   */
  statsExport: ({ range, kind }) => {
    const cfg = useSettingsStore.getState().config;
    const data = useDataStore.getState();
    const raw = String(range ?? '');
    const rk: StatsRangeKey = raw === '30d' || raw === 'all' ? raw : DEFAULT_STATS_RANGE;
    const snapshot = buildStatsSnapshot({
      pending: data.pending,
      taskRuns: data.taskRuns,
      directionPlan: data.directionPlan,
      config: cfg,
      range: rk,
    });
    const base = {
      range: rk,
      rangeText: rangeText(snapshot),
      generatedAt: snapshot.generatedAt,
      total: snapshot.total,
      sent: snapshot.sent,
      failed: snapshot.failed,
      waiting: snapshot.waiting,
      successRate: snapshot.successRate,
      avgScore: snapshot.avgScore,
    };
    const k = String(kind ?? 'summary');
    if (k === 'detail') {
      return {
        applied: true,
        message: `岗位明细 ${snapshot.total} 条（范围内，已剔除会话 token 与招呼语正文）`,
        next: {
          ...base,
          kind: 'detail',
          filename: exportFilename('detail', snapshot, 'csv'),
          content: toCsv(buildDetailRows(data.pending, snapshot)),
        },
      };
    }
    if (k === 'report') {
      return {
        applied: true,
        message: '统计报表 HTML（A4 横版，落盘需在应用内导出）',
        next: { ...base, kind: 'report', filename: exportFilename('report', snapshot, 'pdf'), content: buildStatsReportHtml(snapshot) },
      };
    }
    return {
      applied: true,
      message: `统计汇总（长表）${snapshot.total} 条岗位范围内`,
      next: {
        ...base,
        kind: 'summary',
        filename: exportFilename('summary', snapshot, 'csv'),
        content: toCsv(buildSummaryRows(snapshot, { pending: data.pending, taskRuns: data.taskRuns, config: cfg })),
      },
    };
  },
};

// ===========================================================================
// 对外暴露
// ===========================================================================

async function dispatch(op: ControlOp): Promise<ControlResult> {
  const action = String(op?.action || '');
  const handler = handlers[action];
  if (!handler) {
    return { applied: false, message: `不支持的动作：${action}（可用：${Object.keys(handlers).join(', ')}）` };
  }
  try {
    return await handler(op.params || {});
  } catch (e) {
    return { applied: false, message: `动作 ${action} 执行异常：${(e as Error)?.message || e}` };
  }
}

declare global {
  interface Window {
    __bossclawControl?: {
      version: string;
      actions: string[];
      dispatch: (op: ControlOp) => Promise<ControlResult>;
      snapshot: () => Record<string, unknown>;
    };
  }
}

let installed = false;

/** 在应用启动时调用一次（main.tsx） */
export function installControlRuntime(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.__bossclawControl = {
    version: '1.1.0',
    actions: Object.keys(handlers),
    dispatch,
    snapshot: snapshotState,
  };
}
