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
import { PLATFORM_IDS, type JobPlatform } from '@/lib/bossclaw/platforms';
import { SAFETY_LIMITS } from '@/lib/bossclaw/safety';
import { analyzeJob } from '@/lib/bossclaw/matching';
import { tailorForJob } from '@/lib/bossclaw/jobAssistant';
import { getBrowser } from '@/lib/browserRegistry';
import type { JobMeta, Profile, PendingItem, TaskRun } from '@/lib/bossclaw/types';
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
    version: '1.0.0',
    actions: Object.keys(handlers),
    dispatch,
    snapshot: snapshotState,
  };
}
