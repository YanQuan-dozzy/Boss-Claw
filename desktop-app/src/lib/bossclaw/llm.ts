// OpenAI 兼容的模型调用层（移植并适配自 callModel）
// 支持 JSON 模式、网关不兼容 response_format 时自动回退、超时与 JSON 解析兜底
// P05：LLM 主进程代理（AGENTS.md「LLM 经预加载脚本代理真实请求」架构约定），不再渲染层直连 fetch 规避 CORS。
import type { AppConfig } from './types';
import { electronApi } from '@/lib/electronApi';

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

// ---- JSON 修复辅助（严格解析失败后的有界、确定性尽力修复）----

/** 从首个 [ 或 { 起做括号深度扫描，返回第一个「括号平衡回 0」的下标；未闭合返回 -1。
 *  正确地跳过字符串内的双引号与反斜杠转义，避免把字符串里的括号计入深度。 */
function balancedJsonEnd(text: string): number {
  const start = String(text || '').search(/[[{]/);
  if (start < 0) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 去除尾部逗号（如 {"a":1, } → {"a":1 }）。 */
function stripTrailingCommas(text: string): string {
  return String(text || '').replace(/,\s*([}\]])/g, '$1');
}

/** 在末尾补齐未闭合的 { / [（粗处理：仅当其余部分已完整时才有意义，作为最后手段）。 */
function closeBrackets(text: string): string {
  const source = String(text || '');
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const c of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = source;
  while (stack.length) {
    out += stack.pop() === '{' ? '}' : ']';
  }
  return out;
}

/** 剥离 BOM / 零宽字符等不可见噪声（部分网关或模型会在响应开头注入，导致 JSON.parse 直接失败）。 */
function stripInvisible(text: string): string {
  return String(text || '').replace(/[\uFEFF\u200B-\u200D\u2060]/g, '');
}

/**
 * 转义 JSON 字符串内部的裸控制字符。
 * 模型输出长文本字段（reason / greeting / summary）时常直接换行、或带制表符，
 * 而 JSON 字符串内不允许出现裸换行 → JSON.parse 报 "Bad control character"。
 * 该修复只在「字符串内部」生效（字符串外的换行是合法的），不改变结构语义。
 */
function escapeControlCharsInStrings(text: string): string {
  const src = String(text || '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const code = src.charCodeAt(i);
    if (inString) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { out += c; escaped = true; continue; }
      if (c === '"') { out += c; inString = false; continue; }
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/** 单次修复尝试：对候选文本依次套用各确定性修复变体并解析。 */
function tryParseVariants(raw: string): { ok: boolean; value?: any } {
  const variants = [
    raw,
    stripTrailingCommas(raw),
    escapeControlCharsInStrings(raw),
    stripTrailingCommas(escapeControlCharsInStrings(raw)),
    closeBrackets(stripTrailingCommas(escapeControlCharsInStrings(raw))),
  ];
  for (const variant of variants) {
    try { return { ok: true, value: JSON.parse(variant) }; } catch { /* next */ }
  }
  return { ok: false };
}

// 从模型返回文本中提取 JSON（兼容 ```json 代码块或前缀噪声），
// 并对常见 malformed / 截断 JSON 做有界自动修复
// （不可见字符 / 尾逗号 / 字符串内裸控制字符 / 缺右括号 / 尾随说明文字 / 尾部残留垃圾）。
export function extractJson(text: string): any {
  const cleaned = stripInvisible(String(text || '')).trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const base = (fence ? fence[1].trim() : cleaned).replace(/^json\s*\n/i, '');

  // 候选池：优先原始，其次从首个 [ 或 { 截取（去掉前缀噪声）
  const candidates = [base];
  const start = base.search(/[[{]/);
  if (start > 0) candidates.push(base.slice(start));

  for (const raw of candidates) {
    // 1) 直接解析 + 确定性修复变体
    const direct = tryParseVariants(raw);
    if (direct.ok) return direct.value;

    // 2) 定位完整 JSON 值末端（去掉尾随说明文字），再尝试修复变体
    const end = balancedJsonEnd(raw);
    if (end > 0) {
      const trimmed = raw.slice(0, end + 1);
      if (trimmed !== raw) {
        const cut = tryParseVariants(trimmed);
        if (cut.ok) return cut.value;
      }
    }

    // 3) 渐进截尾兜底：补齐括号 + 去尾逗号/控制字符后，从末尾逐字符截掉 0..N，
    //    覆盖「完整值后残留垃圾」场景
    const probe = closeBrackets(stripTrailingCommas(escapeControlCharsInStrings(raw)));
    const maxTail = 48;
    for (let n = 0; n <= maxTail; n++) {
      try { return JSON.parse(probe.slice(0, probe.length - n)); } catch { /* 继续截断 */ }
    }
  }
  throw new Error('无法解析 JSON');
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
  /** 用途标签（如「职业画像」「打招呼语」），用于日志/展示 */
  purpose?: string;
}

// ===== JSON 输出（对齐 DeepSeek JSON Output 官方文档）=====
// 官方要求与已知限制（https://api-docs.deepseek.com/zh-cn/guides/json_mode）：
//   ① response_format 设为 {'type':'json_object'}；
//   ② system 或 user prompt 中必须含 "json" 字样，并给出希望输出的 JSON 格式样例；
//   ③ 需合理设置 max_tokens，防止 JSON 被中途截断；
//   ④ JSON 模式下有概率返回空的 content（官方建议通过修改 prompt 缓解）。
// 本文件集中实现 ①②③④ 的工程化保障，业务侧只需给出「含 json 字样 + 输出样例」的提示词。

/** 模型单次输出 token 上限（DeepSeek 各模型输出上限 8K），作为抬升重试的封顶值。 */
const MODEL_MAX_OUTPUT_TOKENS = 8192;

/** JSON 模式下的 max_tokens 下限。
 *  官方要求③「合理设置 max_tokens 防截断」：过小的上限（如 500）在模型多写几条解释或长字符串时
 *  会触发 finish_reason=length，导致 JSON 半截、整次调用作废。max_tokens 不产生额外费用（只按实际输出计费），
 *  因此这里给一个安全下限，宁大勿小。 */
const JSON_MODE_MIN_MAX_TOKENS = 2000;

/** 空内容 / 截断各允许的最大追加重试次数（有界，避免费用失控）。 */
const JSON_MODE_MAX_RETRY = 1;

/**
 * 计算实际下发给模型的 max_tokens：JSON 模式下不低于安全下限，且不超过模型输出上限。
 * 纯函数（幂等）——cachedCallModel 的缓存 key 与真实请求使用同一口径，保证 key 反映真实请求。
 */
export function effectiveMaxTokens(maxTokens: number | undefined, jsonMode: boolean): number {
  const raw = Number(maxTokens);
  const base = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2800;
  const bounded = jsonMode ? Math.max(base, JSON_MODE_MIN_MAX_TOKENS) : base;
  return Math.min(Math.max(256, bounded), MODEL_MAX_OUTPUT_TOKENS);
}

/**
 * JSON 输出契约：由 llm 层统一追加在 system 提示词的**最末尾**（紧贴模型输出位置，避免被前置的长篇
 * 业务指令与后置的技能正文稀释），把「结构、字段、可解析性」要求收敛成一套固定口径。
 * 契约文本本身含 "json" 字样，同时满足官方要求②对 prompt 的最低要求。
 */
export const JSON_OUTPUT_CONTRACT = `【JSON 输出契约（必须遵守）】
1. 只输出一个合法的 JSON 对象：直接以 { 开头、以 } 结尾。不要输出 Markdown 代码块围栏（\`\`\`json）、不要任何解释、前置说明或后置补充文字。
2. 字段名与类型严格按上文给出的 json 样例：不得新增、删减或改名字段；缺信息的字段用 "" / [] / null 占位，不要省略字段。
3. 必须能被 JSON.parse 直接解析：字符串内的换行与引号必须转义，不得出现尾随逗号、注释、NaN/Infinity，也不要用单引号包裹键名。
4. 合理控制长度，确保 JSON 在输出上限内完整闭合（宁可表述精简，也不要被截断）。`;

/** 契约已注入的标记（幂等判断，避免重复拼接）。 */
const JSON_CONTRACT_MARK = '【JSON 输出契约';

/** 官方要求②的最小合规样例（仅在 prompt 完全没有 json 字样时使用）。 */
const JSON_MINIMAL_HINT =
  '【JSON 输出要求】请严格以 json 格式输出结果，只输出一个 JSON 对象，不要任何解释、代码块围栏或多余文字。\n' +
  '输出样例：{"example_key": "example_value"}';

/**
 * JSON 模式的 prompt 合规保障（幂等，统一注入点）：
 *  - 官方要求②：system 或 user prompt 必须含 "json" 字样并给出输出样例，否则部分 provider 直接返回 400
 *    （如 DeepSeek：「Prompt must contain the word 'json'」）。缺失时注入最小合规提示；
 *  - 统一把 JSON 输出契约追加到 system 末尾，保证结构要求紧贴输出位置、不被后置的长篇技能正文冲淡。
 * 已合规时原样返回（不改动 messages，保住服务端 prompt cache 前缀与本地缓存 key 的稳定性）。
 */
function ensureJsonPromptContract(messages: ChatMessage[]): ChatMessage[] {
  const hasJsonWord = messages.some((m) => /json/i.test(String(m?.content || '')));
  const hasContract = messages.some((m) => String(m?.content || '').includes(JSON_CONTRACT_MARK));
  if (hasJsonWord && hasContract) return messages;
  const blocks: string[] = [];
  if (!hasJsonWord) blocks.push(JSON_MINIMAL_HINT);
  if (!hasContract) blocks.push(JSON_OUTPUT_CONTRACT);
  const patch = `\n\n${blocks.join('\n\n')}`;
  const next = messages.map((m) => ({ ...m }));
  const idx = next.findIndex((m) => m.role === 'system');
  if (idx >= 0) next[idx].content = `${next[idx].content}${patch}`;
  else next.unshift({ role: 'system', content: `你是严谨的结构化数据输出助手。${patch}` });
  return next;
}

/** 追加一句「纠偏提示」到 messages 末尾（用于空内容/截断重试），不污染原有 system 前缀。 */
function withNudge(messages: ChatMessage[], nudge: string): ChatMessage[] {
  const next = messages.map((m) => ({ ...m }));
  const text = `\n\n${nudge}`;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'user') {
      next[i].content = `${next[i].content}${text}`;
      return next;
    }
  }
  next.push({ role: 'user', content: nudge });
  return next;
}


// P05：LLM 主进程代理（AGENTS.md「LLM 经预加载脚本代理真实请求」架构约定）。
// 不再渲染层直连 fetch 规避 CORS；经 electronApi.llmProxy → preload → 主进程 Node fetch 转发。

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

async function requestModel(url: string, payload: any, apiKey: string, timeoutMs: number): Promise<HttpResponseLike> {
  try {
    const r = await electronApi.llmProxy(url, payload, apiKey, timeoutMs);
    if (!r.ok && r.error) {
      if (r.error === 'timeout') throw new AIError('AI_TIMEOUT', 'AI 请求超时');
      throw new AIError('AI_NETWORK', `AI 网络请求失败：${r.error}`);
    }
    return {
      ok: r.ok,
      status: r.status,
      text: () => Promise.resolve(r.text),
    };
  } catch (error: any) {
    if (error instanceof AIError) throw error;
    throw new AIError('AI_NETWORK', `AI 网络请求失败：${error?.message || '连接异常'}`);
  }
}

const REPAIR_JSON_SYSTEM =
  '你是 JSON 修复助手。下面是一段可能被截断或损坏的 json 文本（可能含 ```json 围栏或多余说明文字）。' +
  '请把它修复、补全为一段合法且完整的 JSON：保持原有字段名与层级不变，只补全被截断的结构，' +
  '不得凭想象新增原内容中不存在的字段或事实，不得改写已有取值。' +
  '只输出 json，不要任何解释、不要代码块围栏。';

/**
 * 二次 AI 补全：当首次输出 JSON 无法解析或被截断时，用一次低成本调用让模型把残缺/损坏的 JSON 补齐修正。
 * @param opts.maxTokens 补齐调用的输出上限（截断场景应比首次更大，避免再次被截断）
 * @param opts.systemPrompt 原始 system 提示词（含目标 JSON 结构样例）。带上它可让模型按正确 Schema 补全，
 *                          而不是自由发挥——截断补齐场景尤其重要。
 * 失败返回 null（由调用方决定如何降级）。直接走 requestModel，不递归 callModel，杜绝递归。
 */
async function repairJsonViaModel(
  url: string,
  brokenContent: string,
  originalPayload: any,
  apiKey: string,
  timeoutMs: number,
  opts: { maxTokens?: number; systemPrompt?: string } = {}
): Promise<any | null> {
  const content = String(brokenContent || '').trim();
  if (content.length < 12 || !/[[{]/.test(content)) return null; // 太短/不像 JSON，不值得二次调用
  const schemaHint = String(opts.systemPrompt || '').trim();
  const requested = Number(opts.maxTokens ?? originalPayload.max_tokens ?? 600);
  const payload = {
    ...originalPayload,
    messages: [
      { role: 'system', content: schemaHint ? `${schemaHint}\n\n${REPAIR_JSON_SYSTEM}` : REPAIR_JSON_SYSTEM },
      { role: 'user', content: content.slice(0, 8000) },
    ],
    temperature: 0,
    max_tokens: Math.min(Math.max(600, requested), MODEL_MAX_OUTPUT_TOKENS),
    response_format: { type: 'json_object' },
  };
  delete payload.thinking; // 修复不需要思考模式
  try {
    const r = await requestModel(url, payload, apiKey, timeoutMs);
    const body = await r.text();
    if (!r.ok) return null;
    const parsed = JSON.parse(body);
    const repaired = String(parsed?.choices?.[0]?.message?.content || '').trim();
    return repaired ? extractJson(repaired) : null;
  } catch {
    return null;
  }
}

/**
 * 发起模型调用。
 * 未配置 API Key 时直接抛 AI_CONFIG（不转交 agent 代答）：由上层业务走**本地规则**兜底
 * （职业画像 buildLocalProfile、求职信/定制简历 localFallback 等）。单向链路：应用不再反向调 agent。
 *
 * JSON 模式（jsonMode=true，默认）严格对齐 DeepSeek JSON Output 官方要求与已知失败模式：
 *   ① 请求体设置 response_format = {'type':'json_object'}（网关不支持时自动降级重发）；
 *   ② prompt 必须含 "json" 字样并给出输出样例 —— 样例由各提示词构造器提供，llm 侧再做运行时兜底；
 *   ③ 合理设置 max_tokens 防截断 —— JSON 模式下有下限保护；命中 finish_reason=length 时抬升上限重试；
 *   ④ 官方提示「JSON 模式下有概率返回空的 content」—— 空内容时追加「必须输出完整 JSON」提示重试一次。
 * 重试次数有界（各 1 次）；最终仍失败时抛 AIError，由上层走本地规则兜底，绝不静默返回半截结果。
 */
export async function callModel(messages: ChatMessage[], config: AppConfig['model'], options: CallOptions = {}): Promise<any> {
  const jsonMode = options.jsonMode ?? true;
  if (!config.apiKey) {
    throw new AIError('AI_CONFIG', '尚未配置 AI API Key，请在「设置 → AI」填写密钥；未配置时使用本地规则生成。');
  }
  const url = `${String(config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`;
  // DeepSeek V4 默认开启思考模式（官方文档：thinking 默认 enabled，effort 默认 high），
  // 思维链放在 reasoning_content、最终答案放 content；max_tokens 偏小时 content 会为空。
  // 本项目需要模型直接输出结构化 JSON，无需思维链，故对 DeepSeek 端点显式关闭思考，
  // 确保答案落在 content 字段（同时避免温度等参数在思考模式下被忽略）。
  const isDeepSeek = config.provider === 'deepseek' || /deepseek/i.test(String(config.baseUrl || ''));
  const timeoutMs = Number(options.timeoutMs || 90000);
  const temperature = Number(options.temperature ?? config.temperature ?? 0.1);
  const baseMaxTokens = effectiveMaxTokens(options.maxTokens, jsonMode);
  // 官方要求②兜底：JSON 模式 prompt 必须含 json 字样，并统一注入 JSON 输出契约（幂等）。
  // 已合规时原样透传，不改动 messages（保住服务端 prompt cache 前缀）。
  const effectiveMessages = jsonMode ? ensureJsonPromptContract(messages) : messages;

  // 服务端提示词缓存（DeepSeek 等 provider 的 context caching）用量：命中时输入价约为未命中的 1/10。
  // 多轮尝试（重试/补齐）时逐次累计到会话统计（设置页可见）。
  let usageHit = 0;
  let usageMiss = 0;
  let usageSeen = false;
  const recordUsage = (usage: any): void => {
    if (!usage || typeof usage !== 'object') return;
    const hit = Number(usage.prompt_cache_hit_tokens || 0);
    const miss = Number(usage.prompt_cache_miss_tokens || 0);
    usageSeen = true;
    usageHit += hit;
    usageMiss += miss;
    llmUsageSession.requests += 1;
    llmUsageSession.cacheHitTokens += hit;
    llmUsageSession.cacheMissTokens += miss;
  };

  /** 单次往返：发请求 → 网关不支持 response_format 时降级重发 → 取出 content / finish_reason。 */
  const requestOnce = async (over: { maxTokens?: number; nudge?: string } = {}) => {
    const payload: any = {
      model: config.model || 'deepseek-v4-flash',
      messages: over.nudge ? withNudge(effectiveMessages, over.nudge) : effectiveMessages,
      temperature,
      max_tokens: over.maxTokens ?? baseMaxTokens,
    };
    if (isDeepSeek) payload.thinking = { type: 'disabled' };
    if (jsonMode) payload.response_format = { type: 'json_object' };

    let response = await requestModel(url, payload, config.apiKey, timeoutMs);
    let bodyText = await response.text();
    if (!response.ok && jsonMode && [400, 404, 422].includes(response.status) && /response[_ -]?format|json_object|unsupported/i.test(bodyText)) {
      const retryPayload = { ...payload };
      delete retryPayload.response_format;
      response = await requestModel(url, retryPayload, config.apiKey, timeoutMs);
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
    recordUsage(result.usage);
    const choice = result?.choices?.[0];
    let content = String(choice?.message?.content || '').trim();
    // 兜底：若端点仍以思考模式返回（content 为空但 reasoning_content 有内容），取 reasoning_content
    if (!content) {
      const reasoning = String(choice?.message?.reasoning_content || '').trim();
      if (reasoning) content = reasoning;
    }
    return { content, finishReason: String(choice?.finish_reason || ''), payload };
  };

  // ---- 第 1 次调用 ----
  let attempt = await requestOnce();
  let content = attempt.content;
  let finishReason = attempt.finishReason;
  let payload = attempt.payload;

  // 官方已知失败模式③④：截断（finish_reason=length）与空 content。各做一次有界纠偏重试。
  for (let retry = 0; retry < JSON_MODE_MAX_RETRY && (!content || finishReason === 'length'); retry++) {
    const truncated = finishReason === 'length';
    const nudge = !content
      ? jsonMode
        ? '（上一次回复内容为空）请严格按 schema 输出完整 json：必须以 { 开头、以 } 结尾，不得为空、不得只输出解释文字。'
        : '（上一次回复内容为空）请直接输出正文内容。'
      : '（上一次输出因过长被截断）请在保证信息完整的前提下精简表述，确保结构完整、json 正常闭合。';
    try {
      const second = await requestOnce({
        nudge,
        maxTokens: truncated ? Math.min(baseMaxTokens * 2, MODEL_MAX_OUTPUT_TOKENS) : baseMaxTokens,
      });
      if (second.content) {
        content = second.content;
        finishReason = second.finishReason;
        payload = second.payload;
      }
    } catch (error) {
      // 重试本身失败：首次已有内容则沿用首次结果，否则抛出（保留 AI_EMPTY 语义供上层判断可重试性）
      if (content) break;
      if (error instanceof AIError && error.code !== 'AI_EMPTY') throw error;
      break;
    }
  }

  if (!content) throw new AIError('AI_EMPTY', 'AI 返回为空');
  if (!jsonMode) {
    if (finishReason === 'length') {
      throw new AIError('AI_TRUNCATED', 'AI 输出被截断', { finishReason, partial: content });
    }
    return content;
  }

  // ---- JSON 模式：确定性解析修复 → 二次 AI 补齐 ----
  // 截断场景不做「宽松截尾修复」：那会拿到字段缺失的半截对象（静默错值比报错更危险），
  // 直接交二次补齐（带原始 schema 重问）或抛 AI_TRUNCATED 让上层走既定降级（如画像的精简重试）。
  const truncatedFinal = finishReason === 'length';
  let parsed: any;
  let repaired = false;
  if (!truncatedFinal) {
    try {
      parsed = extractJson(content);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) {
    const viaModel = await repairJsonViaModel(url, content, payload, config.apiKey, timeoutMs, {
      maxTokens: truncatedFinal ? Math.min(baseMaxTokens * 2, MODEL_MAX_OUTPUT_TOKENS) : baseMaxTokens,
      systemPrompt: effectiveMessages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n'),
    });
    if (viaModel === null || viaModel === undefined) {
      if (truncatedFinal) {
        throw new AIError('AI_TRUNCATED', 'AI 输出被截断', { finishReason, partial: content });
      }
      throw new AIError('AI_INVALID_JSON', 'AI 返回 JSON 不完整，自动修复未能成功', { partial: content });
    }
    parsed = viaModel;
    repaired = true;
  }
  // 非枚举标记：调用方可据此区分「修复成功（仍属 AI 结果）」与「整体降级本地」，
  // 不落入 JSON.stringify、不污染缓存语义。
  if (repaired) {
    try {
      Object.defineProperty(parsed, '_repaired', { value: true, enumerable: false, writable: true, configurable: true });
    } catch {
      /* 附加失败不影响主流程 */
    }
  }
  // 服务端提示词缓存用量附加：统一在 parsed 确定后执行（覆盖正常与修复两条路径）
  if (usageSeen) {
    try {
      Object.defineProperty(parsed, '_usage', {
        value: { prompt_cache_hit_tokens: usageHit, prompt_cache_miss_tokens: usageMiss },
        enumerable: false,
        writable: true,
        configurable: true,
      });
    } catch {
      /* 附加失败不影响主流程 */
    }
  }
  return parsed;
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

export type AICacheScope = 'profile' | 'job-analysis' | 'greetings' | 'assistant';

export interface AICacheMeta {
  /** 缓存作用域：画像 / 岗位分析 / 打招呼语 / 求职助手（用于分类管理与清空） */
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

const AI_CACHE_DEFAULT_TTL: Record<AICacheScope, number> = {  // 画像 / 打招呼语：key 已含简历与画像全文哈希，内容不变结果必然有效，仅设长 TTL 防陈旧
  profile: 90 * 24 * 3600 * 1000,
  greetings: 90 * 24 * 3600 * 1000,
  // 岗位分析：key 含岗位描述全文，描述更新自动失效；TTL 仅防「很久以前的同 jobId 缓存」被命中
  'job-analysis': 7 * 24 * 3600 * 1000,
  // 求职助手（定制简历/求职信、评估报告）：key 含简历/画像/岗位全文，内容变化自动失效
  assistant: 7 * 24 * 3600 * 1000,
};

/** 缓存作用域 → 中文用途标签（用于「转交 agent 代答」时的任务描述与日志） */
const AI_SCOPE_LABELS: Record<AICacheScope, string> = {
  profile: '职业画像',
  greetings: '打招呼语',
  'job-analysis': '岗位分析',
  assistant: '定制简历 / 求职助手',
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
  // P30：entries/totalBytes 直接读原始 key 字符串长度——旧实现对每条缓存重新 JSON.stringify
  // 累加字节数，缓存接近 2.5MB 时设置页每次刷新统计都会触发一次全量序列化（主线程卡顿）。
  let rawCache = '';
  let entries = 0;
  try {
    rawCache = localStorage.getItem(AI_CACHE_KEY) || '';
    const parsed = JSON.parse(rawCache) as Record<string, unknown> | null;
    entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    entries = 0;
  }
  const totalBytes = rawCache.length;
  // P30：命中/未命中统计统一以轻量 stats key（bossclaw-ai-cache-stats）为准——
  // 命中计数改为内存累加后不再写回每条缓存条目（避免读缓存触发整份缓存序列化），
  // 原 hits 读的是条目内 e.hits（从未随 bumpCacheStats 落盘），与 misses 来源不一致，
  // 现改为与 misses 同一来源（stats key），口径一致且不再随缓存条目的生命周期丢失。
  let hits = 0;
  let misses = 0;
  let since = Date.now();
  try {
    const raw = localStorage.getItem(AI_CACHE_STATS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      hits = Number(s?.hits || 0);
      misses = Number(s?.misses || 0);
      since = Number(s?.since || since);
    }
  } catch {
    /* 忽略 */
  }
  return { entries, totalBytes, hits, misses, since };
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
  const jsonMode = options.jsonMode ?? true;
  // 与 callModel 用同一口径计算真实下发的 max_tokens（JSON 模式下有下限保护），
  // 保证缓存 key 反映「实际请求参数」而非调用方传入的原始值。
  const maxTokens = effectiveMaxTokens(options.maxTokens, jsonMode);
  const key = hashText(
    JSON.stringify([scope, config.provider, config.model, temperature, maxTokens, jsonMode, messages])
  );

  const now = Date.now();
  const map = loadAICache();
  const hit = map[key];
  if (hit && hit.ts + hit.ttlMs > now) {
    // P30：命中不写盘——命中计数（hits）仅作内存统计，避免「读缓存」触发对整份缓存
    // （上限 2.5MB）的全量 JSON.stringify + localStorage 写盘（网络慢/批量重复分析时
    // 高频命中会造成渲染主线程阻塞、卡顿）。实际缓存条目仍在其写入时持久化，不受影响。
    bumpCacheStats(1, 0);
    return hit.value;
  }
  if (map[key]) delete map[key]; // 已过期：清理

  const inFlight = aiCacheInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const result = await callModel(messages, config, { ...options, purpose: options.purpose ?? AI_SCOPE_LABELS[scope] });
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
