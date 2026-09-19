// src/lib/bossclaw/agentAnswer.ts —— 无 API Key 时的「agent 代答」通道
// ---------------------------------------------------------------------------
// 背景：应用内 AI（岗位分析 / 职业画像 / 打招呼语 / 定制简历）在**未配置 API Key** 时，
// 若外部 agent（bossclaw-mcp 的调用方：Claude / WorkBuddy / Cursor 等）在线，则由它代答：
//   ① 应用把这一次 AI 调用（完整 messages + 用途 + 是否 JSON 模式）挂进本地待答队列；
//   ② agent 调 `bossclaw_agent_tasks` 领取队列（这一步同时刷新「agent 在线」心跳）；
//   ③ agent 用自己的模型生成回答，调 `bossclaw_agent_submit` 回填文本；
//   ④ 应用按与真实模型调用**完全相同**的口径解析该文本（JSON 模式经 extractJson + 一次纠偏重试），
//      交给上层业务，结果形态与「配了 API Key」时一致。
//
// 链路方向仍然是**单向**的：应用无法主动调用 stdio MCP，只能把任务放到本地队列等 agent 来取，
// 因此「有没有 agent」由**心跳**判定（agent 最近一次调 `agentTasks` 的时间）。
// agent 不在线 / 超时未答 / 主动放弃 → 立即回落既有本地规则兜底（buildLocalProfile、localFallback 等），
// 行为与本通道引入前**完全一致**，不引入任何新的失败态。
//
// 安全边界：本模块只搬运「提示词 → 文本」的生成请求，**不**触碰投递、发送、验证码、
// 速率限制、SAFETY_LIMITS 等任何安全逻辑；代答结果同样要过后端既有的
// 事实校验 / 口吻 / 校名披露 / 招呼语截断等校验链。

/** 代答相关错误码（由 llm.ts 转成 AIError，避免本模块反向依赖 llm.ts 造成循环引用） */
export type AgentAnswerErrorCode = 'AI_AGENT_UNAVAILABLE' | 'AI_AGENT_TIMEOUT' | 'AI_AGENT_CANCELLED';

export class AgentAnswerError extends Error {
  code: AgentAnswerErrorCode;
  details: Record<string, unknown>;

  constructor(code: AgentAnswerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentAnswerError';
    this.code = code;
    this.details = details;
  }
}

export interface AgentAnswerTaskMessage {
  role: string;
  content: string;
}

export interface AgentAnswerTask {
  id: string;
  /** 用途标签（职业画像 / 岗位分析 / 打招呼语 / 定制简历 等），供 agent 判断优先级与口径 */
  purpose: string;
  /** true = 必须回填 JSON（应用会按 JSON 解析）；false = 回填纯文本 */
  jsonMode: boolean;
  /** 期望的最大输出量（token），仅作提示 */
  maxTokens: number;
  createdAt: number;
  deadlineAt: number;
  /** 1 = 首次索取；2 = 上一次回填不是合法 JSON，请只输出 JSON 的纠偏重试 */
  attempt: number;
  /** 完整提示词（system + user），agent 需据此作答 */
  messages: AgentAnswerTaskMessage[];
}

export interface AgentAnswerStats {
  /** 是否有 agent 在线（最近一次 `agentTasks` 调用在 presenceWindowMs 内） */
  online: boolean;
  lastSeenAt: number | null;
  lastSeenAgoMs: number | null;
  presenceWindowMs: number;
  /** 当前挂起等待代答的任务数 */
  pending: number;
  /** agent 已领取过的任务数 */
  claimed: number;
  answered: number;
  timeouts: number;
  cancelled: number;
  /** 因「无 agent 在线」直接回落本地规则的次数 */
  unavailable: number;
  lastEvent: string | null;
  events: string[];
}

/** 「agent 在线」的判定窗口：agent 最近一次调用 `bossclaw_agent_tasks` 距现在不超过该时长 */
export const AGENT_PRESENCE_WINDOW_MS = 90_000;
/** 单个代答任务的等待上限（超过即超时回落本地规则） */
export const AGENT_ANSWER_MAX_WAIT_MS = 240_000;
/** 单个代答任务的等待下限（避免业务侧传入过小 timeout 导致必然超时） */
export const AGENT_ANSWER_MIN_WAIT_MS = 30_000;
const AGENT_EVENT_KEEP = 20;

interface PendingEntry {
  task: AgentAnswerTask;
  claimed: boolean;
  resolve: (content: string) => void;
  reject: (error: AgentAnswerError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingTasks = new Map<string, PendingEntry>();

let lastSeenAt: number | null = null;
let claimedCount = 0;
let answeredCount = 0;
let timeoutCount = 0;
let cancelledCount = 0;
let unavailableCount = 0;
const events: string[] = [];

function pushEvent(text: string): void {
  events.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${text}`);
  while (events.length > AGENT_EVENT_KEEP) events.shift();
}

function newTaskId(): string {
  return `at_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** agent 心跳：由 `agentTasks` / `agentSubmit` / `agentCancel` 调用刷新 */
export function touchAgentPresence(): void {
  lastSeenAt = Date.now();
}

export function isAgentOnline(now = Date.now()): boolean {
  return lastSeenAt !== null && now - lastSeenAt <= AGENT_PRESENCE_WINDOW_MS;
}

/** 超时清扫：把已过期的等待任务立刻判超时（除定时器外，任何代答侧 API 被调用时也会顺手清扫，
 *  避免渲染进程计时器在窗口最小化时被节流导致等待悬空） */
function sweepExpired(now = Date.now()): void {
  for (const [id, entry] of pendingTasks) {
    if (entry.task.deadlineAt > now) continue;
    pendingTasks.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    timeoutCount += 1;
    pushEvent(`代答超时（${entry.task.purpose}）：${id}`);
    // 用户可见文案同上方口径：不提代答通道，只说「等待超时 + 已回落本地规则」
    entry.reject(new AgentAnswerError('AI_AGENT_TIMEOUT', `AI 生成等待超时（${entry.task.purpose}），已回落本地规则`, { id }));
  }
}

/**
 * 发起一次 agent 代答请求，返回 agent 回填的**原始文本**。
 * agent 不在线时立刻抛 AI_AGENT_UNAVAILABLE（调用方据此回落本地规则，不产生等待）。
 */
export function requestAgentAnswer(input: {
  messages: AgentAnswerTaskMessage[];
  jsonMode: boolean;
  purpose?: string;
  maxTokens?: number;
  timeoutMs?: number;
  attempt?: number;
}): Promise<string> {
  const now = Date.now();
  sweepExpired(now);

  if (!isAgentOnline(now)) {
    unavailableCount += 1;
    pushEvent('无 agent 在线，直接回落本地规则');
    // 用户可见文案：只说明「未配置大模型 + 已用本地规则 + 去哪里配置」。
    // 不带任何 MCP / 代答通道字样 —— 普通用户不需要知道代答协议的存在。
    return Promise.reject(
      new AgentAnswerError(
        'AI_AGENT_UNAVAILABLE',
        '未配置大模型 API Key：本次已使用本地规则生成，AI 分析与生成未参与。可在「设置 → AI / LLM 配置」填写 API Key 后启用。',
      )
    );
  }

  const waitMs = Math.min(Math.max(Number(input.timeoutMs) || AGENT_ANSWER_MIN_WAIT_MS, AGENT_ANSWER_MIN_WAIT_MS), AGENT_ANSWER_MAX_WAIT_MS);
  const id = newTaskId();
  const task: AgentAnswerTask = {
    id,
    purpose: String(input.purpose || 'AI 生成'),
    jsonMode: Boolean(input.jsonMode),
    maxTokens: Number(input.maxTokens) || 0,
    createdAt: now,
    deadlineAt: now + waitMs,
    attempt: Number(input.attempt) || 1,
    messages: (input.messages || []).map((m) => ({ role: String(m.role || 'user'), content: String(m.content ?? '') })),
  };

  pushEvent(`派发代答任务 ${id}（${task.purpose}${task.attempt > 1 ? ` · 第 ${task.attempt} 次` : ''}）`);

  return new Promise<string>((resolve, reject) => {
    const entry: PendingEntry = {
      task,
      claimed: false,
      resolve: (content: string) => {
        if (entry.timer) clearTimeout(entry.timer);
        resolve(content);
      },
      reject: (error: AgentAnswerError) => {
        if (entry.timer) clearTimeout(entry.timer);
        reject(error);
      },
      timer: setTimeout(() => sweepExpired(Date.now()), waitMs),
    };
    pendingTasks.set(id, entry);
    // 兜底：定时器在渲染进程被节流时不会精确触发，sweepExpired 会在任何代答 API 调用时补救。
  });
}

/** agent 领取待答任务（这一步同时刷新心跳、把未领取过的任务标记为已领取） */
export function listAgentTasks(options: { includeMessages?: boolean; limit?: number } = {}): {
  online: boolean;
  tasks: AgentAnswerTask[];
  stats: AgentAnswerStats;
} {
  const now = Date.now();
  sweepExpired(now);
  touchAgentPresence();

  const includeMessages = options.includeMessages !== false;
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
  const all = [...pendingTasks.values()].sort((a, b) => a.task.createdAt - b.task.createdAt);

  const tasks = all.slice(0, limit).map((entry) => {
    if (!entry.claimed) {
      entry.claimed = true;
      claimedCount += 1;
    }
    const task = { ...entry.task };
    if (!includeMessages) delete (task as Partial<AgentAnswerTask>).messages;
    return task;
  });

  if (tasks.length) pushEvent(`agent 领取 ${tasks.length} 个任务（队列剩余 ${pendingTasks.size}）`);
  return { online: true, tasks, stats: agentAnswerStats() };
}

/** 提交代答结果（content 为 agent 模型输出的原始文本；JSON 模式由调用方负责让它是合法 JSON） */
export function submitAgentAnswer(id: string, content: string): { applied: boolean; message: string; remaining: number } {
  sweepExpired();
  touchAgentPresence();

  const taskId = String(id || '');
  const text = String(content ?? '');
  if (!taskId) return { applied: false, message: '缺少 id（待答任务 id，可用 bossclaw_agent_tasks 获取）', remaining: pendingTasks.size };
  if (!text.trim()) return { applied: false, message: `代答内容为空，未回填（${taskId}）`, remaining: pendingTasks.size };

  const entry = pendingTasks.get(taskId);
  if (!entry) {
    return {
      applied: false,
      message: `任务不存在或已结束（超时 / 已取消 / id 过期）：${taskId}`,
      remaining: pendingTasks.size,
    };
  }

  pendingTasks.delete(taskId);
  answeredCount += 1;
  pushEvent(`已回填代答 ${taskId}（${entry.task.purpose}，${text.length} 字）`);
  entry.resolve(text);
  return { applied: true, message: `已回填 ${taskId}（${entry.task.purpose}，${text.length} 字）`, remaining: pendingTasks.size };
}

/** 放弃某个代答任务：让应用立刻回落本地规则，不必等满超时 */
export function cancelAgentAnswer(id: string, reason?: string): { applied: boolean; message: string; remaining: number } {
  sweepExpired();
  touchAgentPresence();

  const taskId = String(id || '');
  const entry = pendingTasks.get(taskId);
  if (!entry) {
    return { applied: false, message: `任务不存在或已结束：${taskId}`, remaining: pendingTasks.size };
  }
  pendingTasks.delete(taskId);
  cancelledCount += 1;
  const why = String(reason || '').trim();
  pushEvent(`agent 放弃代答 ${taskId}${why ? `（${why}）` : ''}`);
  entry.reject(
    new AgentAnswerError('AI_AGENT_CANCELLED', `AI 生成已取消（${entry.task.purpose}）${why ? `：${why}` : ''}；已使用本地规则生成。`, {
      id: taskId,
    })
  );
  return { applied: true, message: `已放弃 ${taskId}（应用将回落本地规则）`, remaining: pendingTasks.size };
}

/** 只读状态（**不**刷新心跳，供应用自身状态快照展示） */
export function agentAnswerStats(): AgentAnswerStats {
  const now = Date.now();
  return {
    online: isAgentOnline(now),
    lastSeenAt,
    lastSeenAgoMs: lastSeenAt === null ? null : Math.max(0, now - lastSeenAt),
    presenceWindowMs: AGENT_PRESENCE_WINDOW_MS,
    pending: pendingTasks.size,
    claimed: claimedCount,
    answered: answeredCount,
    timeouts: timeoutCount,
    cancelled: cancelledCount,
    unavailable: unavailableCount,
    lastEvent: events.length ? events[events.length - 1] : null,
    events: [...events],
  };
}
