// src/tools/state.mjs —— 状态与诊断工具组
// ---------------------------------------------------------------------------
// 数据来源：应用每 5 分钟脏检查写盘的本地备份快照（bossclaw-local-backup.json），
// 内含 4 个 zustand persist 键。**只读**：写操作一律经控制桥直达运行中的应用，
// 避免「改了快照文件但应用不读」的假象。
import path from 'node:path';
import {
  PATHS,
  PERSIST_KEYS,
  readSnapshot,
  stateOf,
  getPath,
  ok,
  fail,
  truncate,
  statSafe,
  probePort,
  tailTextFile,
  readJsonSafe,
  humanBytes,
  controlCall,
  BOSSCLAW_HOME,
} from '../context.mjs';
import { obj, str, num, bool, enumStr, READ_ONLY } from '../schema.mjs';

function maskKey(k) {
  if (!k) return null;
  const s = String(k);
  return s.length <= 8 ? `${s.slice(0, 2)}***` : `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function groupCount(items, field) {
  const out = {};
  for (const it of items || []) {
    const k = it?.[field] ?? 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function fmtCounts(obj2) {
  const entries = Object.entries(obj2 || {});
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join('，') : '无';
}

export const stateTools = [
  {
    name: 'bossclaw_state_read',
    title: '读取持久化状态',
    description:
      '读取本地备份快照中的持久化状态（bossclaw-app / bossclaw-settings-v2 / bossclaw-data / bossclaw-schedule）。' +
      '支持按点路径取子节点（如 "config.minScore"）；mode=summary 只返回结构概要（键名 + 数组长度），避免大对象撑爆上下文。' +
      `快照由应用每 5 分钟刷新一次，数据可能偏旧；需要实时状态请用 bossclaw_app_state。`,
    annotations: READ_ONLY,
    inputSchema: obj({
      key: enumStr('要读取的持久化键（默认 all）', [...PERSIST_KEYS, 'all']),
      path: str('点路径，如 "config.platforms.boss" 或 "pending.0.title"'),
      mode: enumStr('返回粒度', ['summary', 'raw']),
      maxChars: num('raw 模式下的字符上限（默认 20000）', { default: 20000 }),
    }),
    handler: async (args = {}) => {
      const snap = await readSnapshot();
      if (!snap.ok) return fail(`${snap.error}\n提示：应用需至少运行过一次并完成一次备份心跳（或应用内点「立即备份」）。`);
      const key = args.key && args.key !== 'all' ? args.key : null;
      const mode = args.mode === 'raw' ? 'raw' : 'summary';
      const maxChars = Math.min(Math.max(Number(args.maxChars) || 20000, 500), 200000);

      const picked = {};
      for (const k of PERSIST_KEYS) {
        if (key && k !== key) continue;
        const st = stateOf(snap.keys[k]);
        picked[k] = args.path ? getPath(st, args.path) : st;
      }
      if (key && !(key in picked)) return fail(`未知键：${key}（可用：${PERSIST_KEYS.join(', ')}）`);

      const summarize = (v) => {
        if (v == null) return v;
        if (Array.isArray(v)) return { __type: 'array', length: v.length, sample: v.slice(0, 2) };
        if (typeof v === 'object') {
          const out = {};
          for (const [k2, v2] of Object.entries(v)) {
            out[k2] = Array.isArray(v2)
              ? `[Array(${v2.length})]`
              : v2 && typeof v2 === 'object'
                ? `{Object(${Object.keys(v2).length} keys: ${Object.keys(v2).slice(0, 8).join(', ')})}`
                : typeof v2 === 'string' && v2.length > 120
                  ? `${v2.slice(0, 120)}…(${v2.length} 字符)`
                  : v2;
          }
          return out;
        }
        return v;
      };

      const payload = {};
      for (const [k, v] of Object.entries(picked)) payload[k] = mode === 'raw' ? v : summarize(v);

      const body =
        mode === 'raw'
          ? truncate(JSON.stringify(payload, null, 2), maxChars)
          : JSON.stringify(payload, null, 2);

      const lines = [
        `快照：${snap.file}`,
        `更新时间：${snap.updatedAtIso || '未知'}（${snap.ageMinutes} 分钟前）`,
        `键：${Object.keys(picked).join(', ')}${args.path ? `，路径 ${args.path}` : ''}｜模式 ${mode}`,
        '',
        body,
      ];
      return ok(lines.join('\n'), { updatedAt: snap.updatedAtIso, ageMinutes: snap.ageMinutes, mode, data: payload });
    },
  },

  {
    name: 'bossclaw_state_summary',
    title: '状态速览（任务 / 安全 / 配置）',
    description:
      '从备份快照汇总出可读的运营与安全状态：岗位队列分布、任务运行分布、当日统计、投递安全参数（暂停冷却 / 每日上限 / 每分钟上限）、' +
      '平台开关、LLM 配置（apiKey 打码）、简历与画像就绪度、定时任务、引擎状态。排查「为什么不投递」先看它。',
    annotations: READ_ONLY,
    inputSchema: obj({}),
    handler: async () => {
      const snap = await readSnapshot();
      if (!snap.ok) return fail(`${snap.error}`);
      const cfg = getPath(stateOf(snap.keys['bossclaw-settings-v2']), 'config') || {};
      const data = stateOf(snap.keys['bossclaw-data']) || {};
      const appState = stateOf(snap.keys['bossclaw-app']) || {};
      const sched = stateOf(snap.keys['bossclaw-schedule']) || {};

      const now = Date.now();
      const pausedUntil = Number(cfg.pausedUntil) || 0;
      const pauseRemainMin = pausedUntil > now ? Math.ceil((pausedUntil - now) / 60000) : 0;

      const pendingCounts = groupCount(data.pending, 'status');
      const taskRunCounts = groupCount(data.taskRuns, 'status');
      const platforms = cfg.platforms || {};
      const platformRows = Object.entries(platforms).map(([k, v]) => ({
        platform: k,
        enabled: v?.enabled !== false,
        priority: v?.priority,
        dailyTarget: v?.dailyTarget,
      }));

      // 引擎状态文件 / 端口探测 / 控制桥健康，三者相互独立，并发执行以降低单次调用延迟
      const [engineState, camoufoxUp, bridge] = await Promise.all([
        readJsonSafe(PATHS.engineState),
        probePort(18767),
        controlCall('GET', '/health', null, 2500),
      ]);
      const stats = data.stats || {};

      const lines = [
        `# 状态速览`,
        `快照时间：${snap.updatedAtIso || '未知'}（${snap.ageMinutes} 分钟前，${humanBytes(snap.fileInfo?.size || 0)}）`,
        ``,
        `## 投递安全参数`,
        `- 执行模式：${cfg.executionMode ?? '-'}（review=人工确认 / auto=自动）`,
        `- 冷却暂停：${pauseRemainMin > 0 ? `⏸ 暂停中，剩余约 ${pauseRemainMin} 分钟（pausedUntil=${new Date(pausedUntil).toISOString()}）` : '未暂停'}`,
        `- 每分钟动作上限：${cfg.maxActionsPerMinute ?? '-'}｜最低匹配分：${cfg.minScore ?? '-'}｜岗位间隔：${cfg.betweenJobsSeconds ?? '-'}s`,
        `- 硬上限：单日 ${150}（SAFETY_LIMITS.MAX_SAFE_DAILY）｜单次动作 ${8}/分钟`,
        `- 平台：${platformRows.map((p) => `${p.platform}${p.enabled ? '✓' : '✗'}(优先级${p.priority}, 日目标${p.dailyTarget})`).join('，') || '-'}`,
        ``,
        `## 岗位队列（bossclaw-data.pending，共 ${(data.pending || []).length}）`,
        `- ${fmtCounts(pendingCounts)}`,
        `## 任务运行（taskRuns，共 ${(data.taskRuns || []).length}）`,
        `- ${fmtCounts(taskRunCounts)}`,
        `## 当日统计（stats）`,
        `- ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join('，') || '无'}`,
        ``,
        `## 素材就绪度`,
        `- 简历文本：${data.resumeText ? `${data.resumeText.length} 字（${data.resumeFileName || '未命名'}）` : '❌ 未导入'}`,
        `- 职业画像：${data.profile ? `✅ ${data.profile.primaryRole || data.profile.role || '已生成'}` : '❌ 未生成'}`,
        `- 打招呼语：${(data.greetings || []).length} 条｜提示词：${data.greetingPrompt ? `${String(data.greetingPrompt).length} 字` : '未设置'}`,
        `- 日志：${(data.logs || []).length} 条（最近 ${data.logs?.length ? new Date(data.logs[data.logs.length - 1].time).toISOString() : '-'}）｜沟通日志：${(data.chatLogs || []).length} 条`,
        ``,
        `## LLM 配置`,
        `- provider=${cfg.model?.provider ?? '-'}｜model=${cfg.model?.model ?? '-'}｜baseUrl=${cfg.model?.baseUrl || '-'}｜apiKey=${maskKey(cfg.model?.apiKey)}`,
        ``,
        `## 定时任务（bossclaw-schedule，共 ${(sched.entries || []).length}）`,
        ...(sched.entries || []).map((e) => `- ${e.enabled ? '✓' : '✗'} ${e.time} ${e.name}（${e.action}${e.platforms?.length ? `，平台 ${e.platforms.join('/')}` : ''}${e.limitPerRun ? `，限 ${e.limitPerRun}` : ''}）`),
        ...((sched.entries || []).length ? [] : ['- 无']),
        ``,
        `## 引擎与运行时`,
        `- Camoufox 桥 :18767：${camoufoxUp ? '✅ 可达' : '未监听'}`,
        `- 引擎状态文件：${engineState.ok ? JSON.stringify(engineState.data) : '不存在'}`,
        `- 应用界面状态：route=${appState.activeRoute ?? '-'}｜theme=${appState.theme ?? '-'}｜autoAssist=${appState.autoAssist ?? '-'}｜engineStatus=${appState.engineStatus ?? '-'}`,
        `- 控制桥：${bridge?.ok ? `✅ 可用（实时数据请用 bossclaw_app_state）` : `未就绪（${bridge?.error || '未知'}）`}`,
      ];

      const payload = {
        snapshot: { file: snap.file, updatedAt: snap.updatedAtIso, ageMinutes: snap.ageMinutes },
        safety: { executionMode: cfg.executionMode, pausedUntil, pauseRemainMin, maxActionsPerMinute: cfg.maxActionsPerMinute, minScore: cfg.minScore, maxSafeDaily: 150 },
        platforms: platformRows,
        pending: { total: (data.pending || []).length, counts: pendingCounts },
        taskRuns: { total: (data.taskRuns || []).length, counts: taskRunCounts },
        stats,
        readiness: {
          resume: !!data.resumeText,
          resumeChars: data.resumeText?.length || 0,
          profile: !!data.profile,
          greetings: (data.greetings || []).length,
        },
        llm: { provider: cfg.model?.provider, model: cfg.model?.model, baseUrl: cfg.model?.baseUrl, apiKeyMasked: maskKey(cfg.model?.apiKey) },
        schedule: (sched.entries || []).map((e) => ({ id: e.id, name: e.name, time: e.time, action: e.action, enabled: e.enabled })),
        engine: { camoufoxPort: camoufoxUp, engineState: engineState.ok ? engineState.data : null },
      };
      return ok(lines.join('\n'), payload);
    },
  },

  {
    name: 'bossclaw_logs',
    title: '读取运行日志',
    description:
      '读取应用日志尾部：app=主进程 bossclaw-debug.log、render=白屏诊断 debug-render.log、webview=webview preload 诊断日志。' +
      '支持正则过滤与行数控制。排查崩溃/白屏/注入失败的首选工具。',
    annotations: READ_ONLY,
    inputSchema: obj({
      target: enumStr('日志类型（默认 app；all=全部）', ['app', 'render', 'webview', 'all']),
      lines: num('返回尾部行数（默认 80，最大 2000）', { default: 80 }),
      filter: str('正则过滤（如 "camoufox|error"），仅保留匹配行'),
      caseSensitive: bool('区分大小写（默认 false，即忽略大小写）', { default: false }),
    }),
    handler: async (args = {}) => {
      const lines = Math.min(Math.max(Number(args.lines) || 80, 1), 2000);
      let re = null;
      if (args.filter) {
        try {
          re = new RegExp(args.filter, args.caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return fail(`filter 正则无效：${e?.message || e}`);
        }
      }
      const targets = args.target && args.target !== 'all' ? [args.target] : Object.keys(PATHS.logs);
      const out = [];
      const data = {};
      for (const t of targets) {
        const file = PATHS.logs[t];
        if (!file) return fail(`未知日志类型：${t}`);
        const res = await tailTextFile(file, { lines, filterRe: re });
        data[t] = { file: res.file, exists: res.exists, mtime: res.mtime, total: res.total, lines: res.lines };
        out.push(
          `## ${t} —— ${file}`,
          res.exists ? `更新时间 ${res.mtime}${re ? `，匹配 ${res.total} 行` : `，共 ${res.total} 行`}` : '（不存在）',
          ...(res.lines.length ? res.lines.map((l) => `  ${l}`) : ['  (无)']),
          ''
        );
      }
      return ok(`# 日志\n\n${out.join('\n')}`, data);
    },
  },

  {
    name: 'bossclaw_engine_status',
    title: '投递引擎状态',
    description:
      '探测隐蔽引擎状态：Camoufox 桥（Python，端口 18767 / token bossclaw-camoufox / Cookie 文件）、CloakBrowser（持久 profile）、' +
      '引擎状态文件 ~/.bossclaw/engine-state.json，以及控制桥可读到的实时 engineStatus。',
    annotations: READ_ONLY,
    inputSchema: obj({}),
    handler: async () => {
      const engineState = await readJsonSafe(PATHS.engineState);
      const cookies = await statSafe(PATHS.camoufoxCookies);
      const cloakProfile = await statSafe(path.join(PATHS.userData, 'cloakbrowser-profile'));
      const camoufoxUp = await probePort(18767);
      const bridge = await controlCall('GET', '/state?path=engine', null, 4000);

      const lines = [
        `# 引擎状态`,
        ``,
        `## Camoufox 隐身引擎（Python 桥）`,
        `- 端口 18767：${camoufoxUp ? '✅ 监听中' : '未监听'}`,
        `- 状态文件 ${PATHS.engineState}：${engineState.ok ? JSON.stringify(engineState.data) : '不存在'}`,
        `- Cookie ${PATHS.camoufoxCookies}：${cookies.exists ? `${cookies.mtime}（${humanBytes(cookies.size)}）` : '不存在（需先完成隐身引擎扫码登录，code 38 前置条件）'}`,
        `- 脚本：desktop-app/camoufox/camoufox_server.py｜Python：${engineState.data?.python || '未知'}`,
        ``,
        `## CloakBrowser 隐身浏览器`,
        `- 持久 profile：${cloakProfile.exists ? `${path.join(PATHS.userData, 'cloakbrowser-profile')}（存在）` : '不存在（尚未启动过）'}`,
        `- 二进制缓存：${(await statSafe(path.join(BOSSCLAW_HOME, 'cloakbrowser'))).exists ? '~/.bossclaw/cloakbrowser 存在' : '未缓存（首次启动会自动下载 ~200MB）'}`,
        ``,
        `## 实时（需控制桥）`,
        bridge?.ok ? `- ${JSON.stringify(bridge.data?.state ?? bridge.data)}` : `- 不可用：${bridge?.error || '未知'}`,
        ``,
        `安全提醒：code 31/32/35/36/37/38 一律立即停止并交人工，不得自动重试或换号。`,
      ];
      return ok(lines.join('\n'), {
        camoufox: { portUp: camoufoxUp, cookiesExists: cookies.exists, engineState: engineState.ok ? engineState.data : null },
        cloak: { profileExists: cloakProfile.exists },
        live: bridge?.ok ? bridge.data : null,
      });
    },
  },
];
