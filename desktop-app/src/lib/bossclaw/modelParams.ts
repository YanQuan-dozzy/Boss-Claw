import type { ModelProvider } from './types';

/**
 * 模型请求参数口径（输出长度字段名 / temperature 是否可调）—— **唯一权威**。
 *
 * 为什么单独一个模块：`thinkingCapability.ts` 管「思考开关怎么写」，本模块管「请求体里另外两个
 * 最容易 400 的参数怎么写」。issue #28 就是这里踩的坑：
 *
 *   OpenAI 新一代模型（gpt-5.x / gpt-6 / o 系列）把输出长度参数从 `max_tokens` 改成了
 *   `max_completion_tokens`，旧字段直接 400：
 *     Unsupported parameter: 'max_tokens' is not supported with this model.
 *     Use 'max_completion_tokens' instead.
 *
 * 与思考参数同一原则（未验证的码不猜），但代价不同：这里**猜错的代价只有一次往返**——
 * 400 的 body 会明确点名不支持的字段，改写后重发即可。因此采用三层口径：
 *   ① 静态表：模型名可判定的（gpt-5 / gpt-6 / o1 / o3 / o4）默认直接发 `max_completion_tokens`，
 *      省掉一次必然失败的往返；
 *   ② 运行时纠偏：任何 400 / 422 明确表示「该字段不支持」时改写请求体重发（**双向**——第三方网关
 *      若只认 `max_tokens`，也会被纠回 `max_tokens`）；
 *   ③ 会话记忆：纠偏结果按「服务商|模型|端点」记住，后续调用不再重复踩同一个坑。
 *
 * temperature 同理：推理模型只接受默认值，显式传 0.1 会 400（`Unsupported value: 'temperature'`），
 * 纠偏后直接省略该字段（省略 ≠ 传 0，但总比整条链路失败好；省略时由服务端取默认值）。
 */

export type OutputTokenField = 'max_tokens' | 'max_completion_tokens';

/** 模型名 → 默认输出长度字段。只看模型名（同名模型跨网关的能力差异交给运行时纠偏兜底）。 */
export function defaultOutputTokenField(model: string | undefined): OutputTokenField {
  const raw = String(model || '').trim().toLowerCase();
  // 兼容「组织/模型」写法（硅基流动等）：只按最后一段判断，避免组织名里的数字误判
  const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  if (/^(gpt-5|gpt-6|o1|o3|o4)/.test(name)) return 'max_completion_tokens';
  return 'max_tokens';
}

/** 会话记忆键：同一模型在不同端点上的口径可能不同，故端点也参与 key。 */
export function modelParamKey(
  provider: ModelProvider | string | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
): string {
  const p = String(provider || 'custom').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  const u = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  return `${p}|${m}|${u}`;
}

export interface ModelParamPlan {
  /** 输出长度字段名（`max_tokens` | `max_completion_tokens`） */
  tokenField: OutputTokenField;
  /** 是否可以把 temperature 一起发出去（推理模型会被服务端拒绝） */
  supportsTemperature: boolean;
}

/** 已被服务端明确拒绝过的参数（会话内有效，进程重启即失效）。 */
interface AdaptedParams {
  tokenField?: OutputTokenField;
  noTemperature?: boolean;
}

const sessionAdaptations = new Map<string, AdaptedParams>();

/** 解析该模型当前应当使用的参数口径（静态表 + 会话内纠偏记忆）。 */
export function resolveModelParamPlan(
  provider: ModelProvider | string | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
): ModelParamPlan {
  const learned = sessionAdaptations.get(modelParamKey(provider, model, baseUrl)) || {};
  return {
    tokenField: learned.tokenField || defaultOutputTokenField(model),
    supportsTemperature: learned.noTemperature !== true,
  };
}

/** 清空会话记忆（回归测试用；用户换模型/换端点后 key 变了，无需手动清理）。 */
export function resetModelParamAdaptations(): void {
  sessionAdaptations.clear();
}

/** 服务端在报错里点名「这个参数我不认识/不支持」。 */
const LOOKS_UNSUPPORTED =
  /unsupported|not supported|does ?not support|unknown (?:parameter|argument|field)|unrecognized|不支持|无效的参数/i;

/**
 * 从报错 body 里提取被点名的参数名。
 * 覆盖两种常见写法：`Unsupported parameter: 'max_tokens'` 与 `"param": "max_tokens"`。
 */
function unsupportedParamName(text: string): string {
  const quoted = text.match(/unsupported\s+(?:parameter|value|field)[:：]?\s*['"`]([a-z_]+)['"`]/i);
  if (quoted) return quoted[1].toLowerCase();
  const field = text.match(/"param"\s*:\s*"([a-z_]+)"/i);
  if (field) return field[1].toLowerCase();
  return '';
}

/**
 * 按服务端报错改写请求体（自适应纠偏）。
 * @returns 改写后的新请求体；无需改写（或不认识这条报错）时返回 null —— 调用方据此停止重试。
 *
 * 每次只改一处，调用方把重试次数限制在 2 次内，避免「改来改去」把请求刷成死循环。
 */
export function adaptPayloadToError(
  payload: Record<string, any>,
  status: number,
  bodyText: string,
  key: string,
): Record<string, any> | null {
  // 只处理「参数不被接受」这一类 4xx（400 invalid_request_error / 422 语义化校验）
  if (status !== 400 && status !== 422) return null;
  const text = String(bodyText || '');
  if (!text || !LOOKS_UNSUPPORTED.test(text)) return null;
  const name = unsupportedParamName(text);
  const lower = text.toLowerCase();
  const hasLegacy = Object.prototype.hasOwnProperty.call(payload, 'max_tokens');
  const hasModern = Object.prototype.hasOwnProperty.call(payload, 'max_completion_tokens');

  // ① temperature：推理模型只接受默认值 —— 直接省略（省略时取服务端默认，不报错）
  if (Object.prototype.hasOwnProperty.call(payload, 'temperature') && (name === 'temperature' || lower.includes('temperature'))) {
    const next = { ...payload };
    delete next.temperature;
    sessionAdaptations.set(key, { ...(sessionAdaptations.get(key) || {}), noTemperature: true });
    return next;
  }

  // ② 输出长度字段名：max_tokens ⇄ max_completion_tokens（双向，兼容只认旧字段的第三方网关）
  let target: OutputTokenField | '' = '';
  if (hasLegacy && (name === 'max_tokens' || lower.includes('max_completion_tokens'))) {
    target = 'max_completion_tokens';
  } else if (hasModern && (name === 'max_completion_tokens' || (lower.includes('max_tokens') && !lower.includes('max_completion_tokens')))) {
    target = 'max_tokens';
  }
  if (target) {
    const value = hasLegacy ? payload.max_tokens : payload.max_completion_tokens;
    const next: Record<string, any> = { ...payload };
    delete next.max_tokens;
    delete next.max_completion_tokens;
    next[target] = value;
    sessionAdaptations.set(key, { ...(sessionAdaptations.get(key) || {}), tokenField: target });
    return next;
  }

  return null;
}
