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
    return extractJson(content);
  } catch {
    throw new AIError('AI_INVALID_JSON', 'AI 返回 JSON 不完整', { partial: content });
  }
}
