// OpenAI 兼容的模型调用层（移植并适配自 callModel）
// 支持 JSON 模式、网关不兼容 response_format 时自动回退、超时与 JSON 解析兜底
import type { AppConfig } from './types';

export class AIError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.details = details;
  }
}

export function aiFailureKind(error: { code?: string; message?: string } | null): string {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'AI_CONFIG' || /API Key|未配置|401|unauthorized/i.test(message)) return 'config-missing';
  if (['AI_NETWORK', 'AI_HTTP', 'AI_TIMEOUT'].includes(code) || /HTTP|fetch|网络|超时|服务不可用/i.test(message)) return 'service-error';
  return 'output-invalid';
}

export function isRetryableAiOutputError(error: { code?: string } | null): boolean {
  return ['AI_TRUNCATED', 'AI_EMPTY', 'AI_INVALID_JSON', 'AI_PROFILE_INCOMPLETE'].includes(String(error?.code || ''));
}

// 从模型返回文本中提取 JSON（兼容 ```json 代码块或前缀噪声）
export function extractJson(text: string): any {
  const cleaned = String(text || '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start > 0) {
      const sliced = candidate.slice(start);
      try {
        return JSON.parse(sliced);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('无法解析 JSON');
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

async function requestModel(url: string, payload: any, apiKey: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new AIError('AI_TIMEOUT', 'AI 请求超时');
    throw new AIError('AI_NETWORK', `AI 网络请求失败：${error?.message || '连接异常'}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(messages: ChatMessage[], config: AppConfig['model'], options: CallOptions = {}): Promise<any> {
  if (!config.apiKey) throw new AIError('AI_CONFIG', '请先填写 AI API Key');
  const url = `${String(config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`;
  const jsonMode = options.jsonMode ?? true;
  // DeepSeek V4 默认开启思考模式（官方文档：thinking 默认 enabled，effort 默认 high），
  // 思维链放在 reasoning_content、最终答案放 content；max_tokens 偏小时 content 会为空。
  // 本项目需要模型直接输出结构化 JSON，无需思维链，故对 DeepSeek 端点显式关闭思考，
  // 确保答案落在 content 字段（同时避免温度等参数在思考模式下被忽略）。
  const isDeepSeek = config.provider === 'deepseek' || /deepseek/i.test(String(config.baseUrl || ''));
  const payload: any = {
    model: config.model || 'deepseek-v4-flash',
    messages,
    temperature: Number(options.temperature ?? config.temperature ?? 0.1),
    max_tokens: Number(options.maxTokens ?? 2800),
  };
  if (isDeepSeek) payload.thinking = { type: 'disabled' };
  if (jsonMode) payload.response_format = { type: 'json_object' };

  let response = await requestModel(url, payload, config.apiKey, Number(options.timeoutMs || 90000));
  let bodyText = await response.text();

  if (!response.ok && jsonMode && [400, 404, 422].includes(response.status) && /response[_ -]?format|json_object|unsupported/i.test(bodyText)) {
    const retryPayload = { ...payload };
    delete retryPayload.response_format;
    response = await requestModel(url, retryPayload, config.apiKey, Number(options.timeoutMs || 90000));
    bodyText = await response.text();
  }

  if (!response.ok) {
    throw new AIError('AI_HTTP', `AI 请求失败 HTTP ${response.status}: ${bodyText.substring(0, 500)}`, { status: response.status });
  }

  let result: any;
  try {
    result = JSON.parse(bodyText);
  } catch {
    throw new AIError('AI_INVALID_RESPONSE', 'AI 接口返回了无法识别的响应');
  }
  // 服务端提示词缓存（DeepSeek 等 provider 的 context caching）用量：命中缓存时输入价约为未命中的 1/10。
  // 累计到会话统计（设置页可见），并在 jsonMode 返回对象上附加非枚举 _usage 供调用方检查。
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : null;
  if (usage) {
    llmUsageSession.requests += 1;
    llmUsageSession.cacheHitTokens += Number(usage.prompt_cache_hit_tokens || 0);
    llmUsageSession.cacheMissTokens += Number(usage.prompt_cache_miss_tokens || 0);
  }
  const choice = result.choices?.[0];
  let content = String(choice?.message?.content || '').trim();
  // 兜底：若端点仍以思考模式返回（content 为空但 reasoning_content 有内容），取 reasoning_content
  if (!content) {
    const reasoning = String(choice?.message?.reasoning_content || '').trim();
    if (reasoning) content = reasoning;
  }
  if (!content) throw new AIError('AI_EMPTY', 'AI 返回为空');
  if (choice.finish_reason === 'length') {
    throw new AIError('AI_TRUNCATED', 'AI 输出被截断', { finishReason: choice.finish_reason, partial: content });
  }
  if (!jsonMode) return content;
  try {
    const parsed = extractJson(content);
    if (usage) {
      try {
        Object.defineProperty(parsed, '_usage', { value: usage, enumerable: false, writable: true, configurable: true });
      } catch {
        /* 附加失败不影响主流程 */
      }
    }
    return parsed;
  } catch {
    throw new AIError('AI_INVALID_JSON', 'AI 返回 JSON 不完整', { partial: content });
  }
}

// ===== 服务端提示词缓存（prompt cache）会话统计 =====
// 统计本会话内各次请求返回的 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
// 用于确认「相同前缀的请求是否命中了 provider 的上下文缓存」（命中价约为未命中价的 1/10）。
export interface LLMUsageStats {
  requests: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

let llmUsageSession: LLMUsageStats = { requests: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

export function getLLMUsageStats(): LLMUsageStats {
  return { ...llmUsageSession };
}

export function resetLLMUsageStats(): void {
  llmUsageSession = { requests: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

// ===== AI 结果缓存（降低重复调用费用）=====
// 原理：对「模型 + 参数 + 完整 messages」做稳定哈希作为 key，相同输入直接命中本地缓存，
// 不再重复计费。任何输入变化（简历/画像/岗位描述/自定义提示词/模型/温度）都会自然产生新 key。
// 缓存只存成功结果；失败与测试连接（ping）一律不缓存。

export type AICacheScope = 'profile' | 'job-analysis' | 'greetings';

export interface AICacheMeta {
  /** 缓存作用域：画像 / 岗位分析 / 打招呼语（用于分类管理与清空） */
  scope: AICacheScope;
  /** 有效期毫秒，缺省按作用域内置默认值 */
  ttlMs?: number;
}

interface AICacheEntry {
  key: string;
  value: unknown;
  ts: number;
  ttlMs: number;
  hits: number;
  scope: string;
}

const AI_CACHE_KEY = 'bossclaw-ai-cache-v1';
const AI_CACHE_STATS_KEY = 'bossclaw-ai-cache-stats';
const AI_CACHE_MAX_ENTRIES = 300;
const AI_CACHE_MAX_BYTES = 2_500_000; // localStorage 建议上限 5MB，缓存控制在 2.5MB 内

const AI_CACHE_DEFAULT_TTL: Record<AICacheScope, number> = {
  // 画像 / 打招呼语：key 已含简历与画像全文哈希，内容不变结果必然有效，仅设长 TTL 防陈旧
  profile: 90 * 24 * 3600 * 1000,
  greetings: 90 * 24 * 3600 * 1000,
  // 岗位分析：key 含岗位描述全文，描述更新自动失效；TTL 仅防「很久以前的同 jobId 缓存」被命中
  'job-analysis': 7 * 24 * 3600 * 1000,
};

// djb2 双哈希（碰撞概率足够低），渲染进程无 node crypto，用稳定字符串哈希
function hashText(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return `${h1.toString(36)}_${h2.toString(36)}_${s.length.toString(36)}`;
}

function loadAICache(): Record<string, AICacheEntry> {
  try {
    const raw = localStorage.getItem(AI_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, AICacheEntry>;
    }
  } catch {
    /* 数据损坏则重建 */
  }
  return {};
}

function saveAICache(map: Record<string, AICacheEntry>): void {
  try {
    const json = JSON.stringify(map);
    if (json.length > AI_CACHE_MAX_BYTES) {
      // 超出总字节上限：按写入时间淘汰最旧的一半
      const entries = Object.values(map).sort((a, b) => a.ts - b.ts);
      const keepKeys = new Set(entries.slice(-Math.floor(entries.length / 2)).map((e) => e.key));
      for (const key of Object.keys(map)) {
        if (!keepKeys.has(key)) delete map[key];
      }
    }
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(map));
  } catch {
    /* 存储不可用（隐私模式/超限）时静默降级为不持久化 */
  }
}

function trimAICache(map: Record<string, AICacheEntry>): void {
  const keys = Object.keys(map);
  if (keys.length <= AI_CACHE_MAX_ENTRIES) return;
  // 超条数上限：删除最旧的差额（保守一点，多删 10% 减少反复裁剪）
  const entries = keys
    .map((key) => map[key])
    .sort((a, b) => a.ts - b.ts);
  const dropCount = keys.length - Math.floor(AI_CACHE_MAX_ENTRIES * 0.9);
  const dropKeys = new Set(entries.slice(0, Math.max(1, dropCount)).map((e) => e.key));
  for (const key of keys) {
    if (dropKeys.has(key)) delete map[key];
  }
}

function bumpCacheStats(hits: number, misses: number): void {
  try {
    const raw = localStorage.getItem(AI_CACHE_STATS_KEY);
    const stats = raw
      ? JSON.parse(raw)
      : { hits: 0, misses: 0, since: Date.now() };
    stats.hits = Number(stats.hits || 0) + hits;
    stats.misses = Number(stats.misses || 0) + misses;
    if (!stats.since) stats.since = Date.now();
    localStorage.setItem(AI_CACHE_STATS_KEY, JSON.stringify(stats));
  } catch {
    /* 统计失败不影响主流程 */
  }
}

/** 清空 AI 结果缓存；scope 省略时清空全部。返回清除的条目数。 */
export function clearAICache(scope?: AICacheScope): number {
  const map = loadAICache();
  let count = 0;
  for (const key of Object.keys(map)) {
    if (!scope || map[key].scope === scope) {
      delete map[key];
      count += 1;
    }
  }
  saveAICache(map);
  return count;
}

/** AI 缓存统计（供设置页展示） */
export function getAICacheStats(): { entries: number; totalBytes: number; hits: number; misses: number; since: number } {
  const map = loadAICache();
  let hits = 0;
  let bytes = 0;
  for (const key of Object.keys(map)) {
    const e = map[key];
    hits += e.hits || 0;
    bytes += key.length + JSON.stringify(e.value).length;
  }
  let misses = 0;
  let since = Date.now();
  try {
    const raw = localStorage.getItem(AI_CACHE_STATS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      misses = Number(s?.misses || 0);
      since = Number(s?.since || since);
    }
  } catch {
    /* 忽略 */
  }
  return { entries: Object.keys(map).length, totalBytes: bytes, hits, misses, since };
}

// 并发去重：同一 key 的并发调用只发一次真实请求，其余等待同一 Promise
const aiCacheInFlight = new Map<string, Promise<any>>();

/**
 * 带缓存的模型调用：相同输入命中本地缓存直接返回（不重复计费）。
 * 缓存 key = scope + provider + model + temperature + maxTokens + jsonMode + 完整 messages。
 * 任何输入（简历/画像/岗位/提示词/模型参数）变化都会产生新 key，保证命中结果与当前输入严格一致。
 * 仅缓存成功结果；AI 错误、测试连接不受缓存影响。
 */
export async function cachedCallModel(
  messages: ChatMessage[],
  config: AppConfig['model'],
  options: CallOptions = {},
  cacheMeta: AICacheMeta
): Promise<any> {
  const scope = cacheMeta.scope;
  const ttlMs = cacheMeta.ttlMs ?? AI_CACHE_DEFAULT_TTL[scope] ?? 7 * 24 * 3600 * 1000;
  const temperature = Number(options.temperature ?? config.temperature ?? 0.1);
  const maxTokens = Number(options.maxTokens ?? 2800);
  const jsonMode = options.jsonMode ?? true;
  const key = hashText(
    JSON.stringify([scope, config.provider, config.model, temperature, maxTokens, jsonMode, messages])
  );

  const now = Date.now();
  const map = loadAICache();
  const hit = map[key];
  if (hit && hit.ts + hit.ttlMs > now) {
    hit.hits = (hit.hits || 0) + 1; // 命中只计次，不滑动续期（TTL 保持绝对过期）
    saveAICache(map);
    bumpCacheStats(1, 0);
    return hit.value;
  }
  if (map[key]) delete map[key]; // 已过期：清理

  const inFlight = aiCacheInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const result = await callModel(messages, config, options);
    map[key] = { key, value: result, ts: Date.now(), ttlMs, hits: 0, scope };
    trimAICache(map);
    saveAICache(map);
    bumpCacheStats(0, 1);
    return result;
  })();

  aiCacheInFlight.set(key, task);
  try {
    return await task;
  } finally {
    aiCacheInFlight.delete(key);
  }
}
