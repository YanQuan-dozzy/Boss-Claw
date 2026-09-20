// src/tools/agent.mjs —— agent 代答工具组（依赖控制桥）
// ---------------------------------------------------------------------------
// 用途：应用**未配置 AI API Key** 时，它内部的 AI 能力（岗位分析 / 职业画像 / 打招呼语 / 定制简历）
// 会把提示词挂进应用的本地待答队列，等外部 agent 用**自己的模型**作答后回填。
// 链路方向仍是单向的：应用不会反过来调用 agent，只能把任务放进队列等 agent 来取，因此：
//   · agent 必须先调 `bossclaw_agent_tasks` 才算「在线」（这就是心跳，窗口 90s，见 agentAnswer.ts）；
//   · 应用侧还有「首次调用算在线」的判定，所以想代答就先拉一次任务，别等到有任务才第一次调用。
// 领取（tasks）→ 生成 → 回填（submit）三步，全部只搬运「提示词 ↔ 生成文本」，
// **不涉及**验证码 / 速率限制 / SAFETY_LIMITS。
// 例外：`bossclaw_agent_send` 是代答组内唯一发送类能力——仅在用户已在应用内开启
// 「全自动」（executionMode==='auto'）时对 agent 开放，走 webview 链路并复用应用自带
// 安全投递引擎（domApply：招呼语非空 / 外部网申跳过 / 气泡确认 / 风控即停），
// 门控与实现都在渲染层 controlRuntime.ts 的 deliverySendNow（唯一权威），此处只透传。
import { controlCall, truncate, PATHS, ok, fail } from '../context.mjs';
import { obj, str, bool, num, READ_ONLY, WRITE_LOCAL } from '../schema.mjs';

async function bridgeHint() {
  return [
    `应用内控制桥当前不可用。启用方式（三选一）：`,
    `  1) 用 bossclaw_app_start 启动（默认带 BOSSCLAW_CONTROL=1），或`,
    `  2) 让用户运行仓库根的 start-bossclaw.cmd（本地启动器默认已开启 agent 桥），或`,
    `  3) 手动以 BOSSCLAW_CONTROL=1 启动 Electron。`,
    `桥信息文件：${PATHS.controlBridgeFile}`,
  ].join('\n');
}

/** 渲染层动作名 → 长超时（长轮询动作按 waitMs 放宽） */
function timeoutFor(action, params) {
  if (action === 'agentTasks') {
    const wait = Math.min(Math.max(Number(params?.waitMs) || 0, 0), 55_000);
    return wait + 20_000;
  }
  return 30_000;
}

async function callAgentAction(action, params = {}) {
  return controlCall('POST', '/action', { action, params }, timeoutFor(action, params));
}

function renderTask(task) {
  const head = [
    `### 任务 ${task.id}`,
    `- 用途：${task.purpose}｜输出格式：${task.jsonMode ? 'JSON（必须是合法 JSON）' : '纯文本'}` +
      (task.maxTokens ? `｜期望上限 ${task.maxTokens} token` : ''),
    `- 剩余等待：${Math.max(0, Math.round(((task.deadlineAt || 0) - Date.now()) / 1000))}s` +
      (task.attempt > 1 ? '｜**第 2 次索取：上一次回填不是合法 JSON，请只输出 JSON**' : ''),
  ];
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const body = messages.map((m) => `\n----- ${m.role} -----\n${m.content}`).join('\n');
  return `${head.join('\n')}${body ? `\n\n**提示词（请据此作答，不要照抄提示词本身）**：${body}` : ''}`;
}

export const agentTools = [
  {
    name: 'bossclaw_agent_tasks',
    title: '领取待代答任务（agent 代答）',
    description:
      '**应用未配置 AI API Key 时，用它接管应用内 AI 生成。**\n' +
      '拉取应用挂起的待代答任务（含完整提示词与期望输出格式），拿到后用你自己的模型生成回答，' +
      '再调 `bossclaw_agent_submit { id, content }` 回填。\n' +
      '· 本调用同时是**心跳**：应用只在「最近 90s 内有过本调用」时才把 AI 任务交给 agent 代答；否则应用内 AI 直接回落本地规则。\n' +
      '· 想持续代答就循环调用（建议 `waitMs: 30000` 长轮询，比空转轮询省事）；`online=false` 说明应用内没有 API Key 也没轮到代答。\n' +
      '· 一次最多返回 10 个任务（`limit` 可调）；任务有等待时限，过期即由应用回落本地规则，此时回填会返回「任务不存在或已结束」。\n' +
      '· 无法作答时用 `bossclaw_agent_cancel { id, reason }` 主动放弃，让应用立刻回落本地规则（不必等满超时）。\n' +
      '前提：应用内**未配置** API Key（配了就用真模型，不会走代答）；控制桥需开启。',
    annotations: READ_ONLY,
    inputSchema: obj({
      waitMs: num('长轮询等待：无任务时最多挂起这么久（毫秒，0-55000，默认 0 立即返回）', { default: 0 }),
      includeMessages: bool('是否返回完整提示词（默认 true；仅看队列概况时可设 false）', { default: true }),
      limit: num('一次最多返回多少个任务（1-50，默认 10）', { default: 10 }),
    }),
    handler: async (args = {}) => {
      const res = await callAgentAction('agentTasks', {
        waitMs: Number(args.waitMs) || 0,
        includeMessages: args.includeMessages !== false,
        limit: Number(args.limit) || 10,
      });
      if (!res.ok) return fail(`${res.error}\n\n${await bridgeHint()}`, { unavailable: !!res.unavailable });

      const payload = res.data || {};
      const next = payload.next || {};
      const tasks = Array.isArray(next.tasks) ? next.tasks : [];
      const lines = [
        `# 代答任务（${tasks.length} 个，已等待 ${Math.round((next.waitedMs || 0) / 1000)}s）`,
        '',
        `- agent 在线：${next.online ? '是' : '否'}（心跳窗口 ${Math.round((next.presenceWindowMs || 0) / 1000)}s，最近一次 ${next.lastSeenAgoMs === null || next.lastSeenAgoMs === undefined ? '从未' : `${Math.round(next.lastSeenAgoMs / 1000)}s 前`}）`,
        `- 队列：挂起 ${next.pending ?? 0}｜已领取 ${next.claimed ?? 0}｜已回填 ${next.answered ?? 0}｜超时 ${next.timeouts ?? 0}｜放弃 ${next.cancelled ?? 0}｜无 agent 回落本地 ${next.unavailable ?? 0}`,
        next.lastEvent ? `- 最近事件：${next.lastEvent}` : '',
        '',
      ];
      if (!tasks.length) {
        lines.push(
          '暂无待代答任务。',
          '',
          '提示：应用未配置 API Key 且**首次**需要 AI 时才会入队，所以这里空是正常的——保持循环调用即可。'
        );
      } else {
        lines.push(
          tasks.map(renderTask).map((t) => truncate(t, 20000)).join('\n\n'),
          '',
          '拿到后请生成回答，并调 `bossclaw_agent_submit { id, content }` 回填；无法作答则 `bossclaw_agent_cancel { id, reason }`。'
        );
      }
      return ok(lines.filter(Boolean).join('\n'), {
        online: !!next.online,
        waitedMs: next.waitedMs || 0,
        stats: {
          pending: next.pending ?? 0,
          claimed: next.claimed ?? 0,
          answered: next.answered ?? 0,
          timeouts: next.timeouts ?? 0,
          cancelled: next.cancelled ?? 0,
          unavailable: next.unavailable ?? 0,
        },
        tasks,
      });
    },
  },

  {
    name: 'bossclaw_agent_submit',
    title: '回填代答结果',
    description:
      '把某个待代答任务的回答回填给应用（配套 `bossclaw_agent_tasks`）。\n' +
      '· `content`：**任务要求的原始输出文本** —— 任务 `jsonMode=true` 时必须给合法 JSON 字符串（必须以 { 开头、以 } 结尾，' +
      '不要 Markdown 代码块围栏、不要解释文字）；否则给纯文本。应用会按与真实模型调用相同的口径解析。\n' +
      '· 回填后应用会继续它自己的校验链（事实/口吻/校名披露/招呼语长度截断等），不合规仍可能被本地规则替换——这是预期行为，不要绕过。\n' +
      '· 返回「任务不存在或已结束」= 已超时/已取消/id 过期，属于正常结果，重新 `bossclaw_agent_tasks` 领新任务即可。',
    annotations: WRITE_LOCAL,
    inputSchema: obj(
      {
        id: str('待代答任务 id（来自 bossclaw_agent_tasks）'),
        content: str('回填正文：jsonMode 任务必须是合法 JSON 字符串；否则为纯文本'),
      },
      ['id', 'content']
    ),
    handler: async (args = {}) => {
      if (!args.id) return fail('缺少 id（来自 bossclaw_agent_tasks 的任务 id）');
      if (typeof args.content !== 'string' || !args.content.trim()) return fail('content 不能为空');
      const res = await callAgentAction('agentSubmit', { id: String(args.id), content: args.content });
      if (!res.ok) return fail(`${res.error}\n\n${await bridgeHint()}`, { unavailable: !!res.unavailable });
      const payload = res.data || {};
      const out = ok(
        `${payload.applied === false ? '❌ 未回填' : '✅ 已回填'}\n说明：${payload.message || '-'}\n队列剩余挂起：${payload.next?.remaining ?? '-'}`,
        { applied: payload.applied !== false, message: payload.message, remaining: payload.next?.remaining }
      );
      if (payload.applied === false) out.isError = true;
      return out;
    },
  },

  {
    name: 'bossclaw_agent_cancel',
    title: '放弃代答任务',
    description:
      '放弃某个待代答任务，让应用**立刻**回落本地规则（不必等满等待时限）。\n' +
      '适用：任务需要的能力/信息你没有、提示词本身有问题、或用户要求别代答了。\n' +
      '`reason` 会记进应用日志，便于用户排查为什么这次结果来自本地规则。',
    annotations: WRITE_LOCAL,
    inputSchema: obj(
      {
        id: str('待代答任务 id（来自 bossclaw_agent_tasks）'),
        reason: str('放弃原因（会写入应用日志）'),
      },
      ['id']
    ),
    handler: async (args = {}) => {
      if (!args.id) return fail('缺少 id（来自 bossclaw_agent_tasks 的任务 id）');
      const res = await callAgentAction('agentCancel', {
        id: String(args.id),
        ...(args.reason ? { reason: String(args.reason) } : {}),
      });
      if (!res.ok) return fail(`${res.error}\n\n${await bridgeHint()}`, { unavailable: !!res.unavailable });
      const payload = res.data || {};
      return ok(`${payload.applied === false ? '❌ 未生效' : '✅ 已放弃'}\n说明：${payload.message || '-'}`, {
        applied: payload.applied !== false,
        message: payload.message,
        remaining: payload.next?.remaining,
      });
    },
  },

  {
    name: 'bossclaw_agent_send',
    title: '全自动模式下触发 webview 投递（代答组发送工具）',
    description:
      '**仅当用户在应用内已开启「全自动」（executionMode===\'auto\'）时可用**：' +
      '对当前激活的 webview 标签页触发一次真实投递（复用应用自带安全投递引擎 domApply：' +
      '招呼语非空 / 外部网申跳过 / 文字气泡确认 / 风控码立即停止交人工等不变量仍由应用强制）。\n' +
      '· `greeting` 可选：不传则用页面当前已填的招呼语（引擎会自行校验非空）。\n' +
      '· 典型用法：`bossclaw_agent_tasks` 领到「打招呼语」类任务 → 用自己的模型生成 → ' +
      '`bossclaw_agent_submit` 回填 → 调本工具触发发送（前提：页面已打开对应聊天窗口）。\n' +
      '· review（人工确认）模式一律拒绝：只能 `bossclaw_app_action { action: "deliveryDraft" }` 草拟 + 人工发送。\n' +
      '· 只透传渲染层白名单的 `deliverySendNow` 动作，门控与实现以 `controlRuntime.ts` 为唯一权威。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      greeting: str('招呼语（可选；不传则用页面当前内容）'),
    }),
    handler: async (args = {}) => {
      const params = {};
      if (args.greeting != null && String(args.greeting).trim()) params.greeting = String(args.greeting);
      const res = await callAgentAction('deliverySendNow', params);
      if (!res.ok) return fail(`${res.error}\n\n${await bridgeHint()}`, { unavailable: !!res.unavailable });
      const payload = res.data || {};
      const out = ok(
        `${payload.applied === false ? '❌ 未触发' : '✅ 已触发'}\n说明：${payload.message || '-'}` +
          (payload.next && payload.next.hint ? `\n${payload.next.hint}` : ''),
        { applied: payload.applied !== false, message: payload.message, next: payload.next }
      );
      if (payload.applied === false) out.isError = true;
      return out;
    },
  },
];
