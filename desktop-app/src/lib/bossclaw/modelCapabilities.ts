/**
 * 模型能力探测 —— 网关 /v1/models 响应的单一权威解析层（动态能力发现）。
 *
 * 背景（见 thinkingCapability.ts 头注释）：旧实现只能靠「服务商 + 模型名前缀」的硬编码表
 * 离线猜测模型能力，本地网关 / 自定义 OpenAI 兼容端点一律被判「不支持思考」。
 * 本模块把判定前提从「猜」升级为「问」：向网关拉 /v1/models，按 id 建立能力索引，
 * 解析出上下文窗口 / 思考支持与等级 / 输入输出模态（文本、图像）/ 工具调用支持。
 *
 * 解析器必须容忍各种网关的边界情况（实测网关 /v1/models）：
 * - reasoning 可为 false，此时 reasoning_levels 为空数组、supported_parameters 无 reasoning；
 * - modalities 可为 null（网关未声明）或缺失 input/output 之一；
 * - supported_reasoning_levels 形态不统一：网关是 [{effort:"low"},...]，OpenAI 兼容实现可能是
 *   字符串数组 ["low","high",...]（等价地 reasoning_levels 字段兜底）；
 * - 上下文窗口字段名不统一：context_length / context_window / max_input_tokens 都可能出现，
 *   取值缺失时按 0（未知）处理，由调用方（contextBudget / 上下文选择 UI）决定如何回落。
 *
 * 不做网络请求：探测的发起（主进程 IPC `jc:models-probe`）与触发（设置页）在其它模块。
 */

/** 单一模型的归一化能力描述。字段语义都取「网关声明值」，缺省即未知，不做猜测。 */
export interface ModelCapability {
  /** 归一化后的模型 id（原样保留网关给的 id，不做大小写折叠） */
  id: string;
  /** 上下文窗口（tokens）。网关有 context_length/context_window/max_input_tokens 三种写法 */
  contextWindow: number;
  /** 是否声明支持思考（reasoning） */
  reasoning: boolean;
  /** 思考等级（字符串数组形态）。网关是 reasoning_levels / supported_reasoning_levels 两种 */
  reasoningLevels: string[];
  /** 输入模态。网关: ["text","image","video"]；缺失/null → 空数组 */
  inputModalities: string[];
  /** 输出模态。网关: ["text"]；缺失/null → 空数组 */
  outputModalities: string[];
  /** 是否声明支持工具调用（tool_call / supported_parameters 含 tools） */
  toolCall: boolean;
  /** 网关声明的展示名（display_name / label），缺失则为空串 */
  displayName: string;
}

export interface ModelCapabilitiesResult {
  /** 归一化后的能力表，按模型 id（原文）索引 */
  byId: Map<string, ModelCapability>;
  /** 解析失败/成功是否完整：整体成功 true；含 1 个坏条目仍 true，全坏才 false */
  ok: boolean;
  /** 成功解析的模型数 */
  count: number;
  /** 非致命提示（如部分条目缺字段） */
  notes: string[];
}

/** 剥掉路由分组前缀：/v1/models 的 id 常形如 "auto/model-a"、"vendor/Model-M3"，
 *  用户在设置页填的模型名可能是 "model-a"（路由分组名）。匹配时先精确、再剥首段 org/。 */
export function stripOrgPrefix(modelId: string): string {
  const id = String(modelId || '').trim();
  const slash = id.indexOf('/');
  if (slash > 0) return id.slice(slash + 1);
  return id;
}

const REASONING_LEVEL_FIELDS = ['supported_reasoning_levels', 'reasoning_levels'] as const;

/** 从单个 /v1/models 条目解析能力；无法识别为模型的条目返回 null（不进索引）。 */
export function parseModelEntry(raw: unknown): ModelCapability | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;

  const numOf = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const contextWindow = numOf(entry.context_length) || numOf(entry.context_window) || numOf(entry.max_input_tokens);

  const reasoning = entry.reasoning === true || entry.reasoning === 'true';

  const modalList = (v: unknown): string[] => {
    if (v && typeof v === 'object' && Array.isArray((v as { input?: unknown }).input)) {
      return (v as { input: unknown[] }).input.map((x) => String(x)).filter(Boolean);
    }
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    return [];
  };
  const inputModalities = modalList(entry.modalities);
  // modalities.input 已含输出时（罕见的把 input 塞进 output 的网关）不重复收集
  const outputModalities = (() => {
    if (entry.modalities && typeof entry.modalities === 'object') {
      const out = (entry.modalities as { output?: unknown }).output;
      if (Array.isArray(out)) return out.map((x) => String(x)).filter(Boolean);
    }
    if (Array.isArray(entry.output_modalities)) return entry.output_modalities.map((x) => String(x)).filter(Boolean);
    return [];
  })();

  // 思考等级：优先字符串数组；supported_reasoning_levels 可能是 [{effort:"low"},...] 的对象数组
  const levels: string[] = [];
  for (const field of REASONING_LEVEL_FIELDS) {
    const v = entry[field];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') {
          if (!levels.includes(item)) levels.push(item);
        } else if (item && typeof item === 'object') {
          const effort = (item as { effort?: unknown }).effort;
          if (typeof effort === 'string' && !levels.includes(effort)) levels.push(effort);
        }
      }
      break; // 取到非空等级就停（两字段同源）
    }
  }

  const params = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.map((x) => String(x))
    : [];
  const toolCall = entry.tool_call === true || params.includes('tools') || params.includes('tool_choice');

  return {
    id,
    contextWindow,
    reasoning,
    reasoningLevels: levels,
    inputModalities,
    outputModalities,
    toolCall,
    displayName:
      typeof entry.display_name === 'string'
        ? entry.display_name
        : typeof entry.label === 'string'
          ? entry.label
          : '',
  };
}

/** 解析完整 /v1/models 响应。信封不固定：有的网关 {data:[...]}，有的直接返回数组。 */
export function parseModelCapabilitiesResponse(text: string): ModelCapabilitiesResult {
  const notes: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { byId: new Map(), ok: false, count: 0, notes: ['模型列表不是合法 JSON'] };
  }

  let list: unknown[] = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown[] }).data)) {
    list = (parsed as { data: unknown[] }).data;
  } else {
    return { byId: new Map(), ok: false, count: 0, notes: ['模型列表缺少 data 数组'] };
  }

  const byId = new Map<string, ModelCapability>();
  let failed = 0;
  for (const item of list) {
    const cap = parseModelEntry(item);
    if (cap) byId.set(cap.id, cap);
    else failed += 1;
  }
  if (failed > 0) notes.push(`${failed} 个模型条目缺少 id 或无法识别，已跳过`);
  return { byId, ok: byId.size > 0, count: byId.size, notes };
}

/** 在能力索引里按 id 找模型：先精确匹配网关 id，再剥首段 org/ 前缀匹配（覆盖 auto/ 路由组）。 */
export function findModelCapability(
  byId: Map<string, ModelCapability>,
  modelName: string | undefined,
): ModelCapability | null {
  const name = String(modelName || '').trim();
  if (!name) return null;
  const exact = byId.get(name);
  if (exact) return exact;
  const nameStripped = stripOrgPrefix(name);
  for (const cap of byId.values()) {
    if (cap.id === name) return cap;
    // 用户可能只填路由分组名（无 org/ 前缀），网关 id 却带前缀（auto/…）；剥双方前缀后一致即命中
    if (stripOrgPrefix(cap.id) === nameStripped) return cap;
  }
  return null;
}
