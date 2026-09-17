import type { ModelProvider } from './types';

/**
 * 思考模式（thinking）能力判定 —— **唯一权威**。
 *
 * 为什么需要单独一个模块：思考开关在不同服务商之间的**参数写法完全不同**，而且
 * 「能不能关」也有差别。写错会直接让整条 AI 链路 400（本项目已踩过一次模型名的坑）。
 * 因此这里集中声明「哪个模型能不能思考、开关字段叫什么、强度档有哪些」，
 * 由 **设置页 UI** 与 **llm.ts 请求构造** 共用同一份结论 —— 禁止在别处另写一套判断。
 *
 * 口径来源（2026-09-16 联网核对官方文档）：
 *   · DeepSeek  `api-docs.deepseek.com/guides/thinking_mode`
 *       开关 `{"thinking":{"type":"enabled"|"disabled"}}`，强度 `reasoning_effort: low|high|max`，
 *       默认 thinking=enabled + effort=high；思考模式下 `temperature` 无效（不报错）；
 *       思维链在 `reasoning_content` 字段（llm.ts 已有兜底取用）。
 *   · 智谱 GLM（腾讯云 / 阿里云 GLM 文档）
 *       开关 `{"thinking":{"type":"enabled"|"disabled"}}`；
 *       **glm-5.3 默认开启且不可关闭，传 disabled 会让请求失败** → 记为 always-on。
 *   · 通义千问 Qwen3.8（qwen.ai 官方博客）
 *       开关为顶层布尔 `enable_thinking`，强度同为 `reasoning_effort: low|medium|xhigh`。
 *   · 火山方舟（`docs.volcengine.com/docs/82379/2662855`）
 *       开关 `thinking: enabled|disabled`，强度 `reasoning_effort: minimal|low|medium|high`。
 *   · OpenAI（GPT-5.6 家族 / GPT-6 Astra）
 *       没有独立 thinking 字段，只有 `reasoning_effort`；GPT-5.6 可用 `none` 关闭，
 *       Astra 只提供 low…max（无法关闭）→ 记为 always-on。
 *   · 硅基流动 / 自定义端点：**模型名前缀与真实能力无法离线确认 → 一律判不支持**。
 *     与「基础求职条件」的既有约定一致：**未验证的码一律不附加**，
 *     宁可少发一个可选参数，也不能凭猜测发出一个可能 400 的字段。
 */

/** unsupported：不发送任何思考参数（UI 强制关闭）；toggleable：可显式开关；always-on：服务侧固定开启，无法关闭 */
export type ThinkingMode = 'unsupported' | 'toggleable' | 'always-on';

export interface ThinkingProfile {
  mode: ThinkingMode;
  /** 开启思考时并入请求体的字段片段（可能为空对象：该服务商只需给强度即可） */
  on: Record<string, unknown>;
  /** 关闭思考时并入请求体的字段片段；null = 没有可用的关闭写法 */
  off: Record<string, unknown> | null;
  /** 强度字段名（如 reasoning_effort）；undefined / efforts 为空 = 不支持调档 */
  effortField?: string;
  /** 可选强度档位（值为 API 原始取值） */
  efforts: string[];
  /** 默认档位（须在 efforts 中） */
  defaultEffort?: string;
  /** 档位的中文标签（UI 用），缺省时回退为原值 */
  effortLabels?: Record<string, string>;
  /** 设置页显示的口径说明（一行，随模型变化） */
  note: string;
}

const UNSUPPORTED: ThinkingProfile = {
  mode: 'unsupported',
  on: {},
  off: null,
  efforts: [],
  note: '当前模型未验证支持思考模式，不会发送任何思考参数',
};

const DEEPSEEK: ThinkingProfile = {
  mode: 'toggleable',
  on: { thinking: { type: 'enabled' } },
  off: { thinking: { type: 'disabled' } },
  effortField: 'reasoning_effort',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  effortLabels: { low: '快速', high: '标准', max: '最高' },
  note: '开启后返回思维链（计费计入输出 token）；思考模式下 temperature 不生效',
};

/** GLM 5.x：可开关；5.3 例外（always-on） */
const GLM: ThinkingProfile = {
  mode: 'toggleable',
  on: { thinking: { type: 'enabled' } },
  off: { thinking: { type: 'disabled' } },
  efforts: [],
  note: 'GLM 系列思考开关由 thinking 字段控制，本应用不调整其强度档',
};

const GLM_ALWAYS_ON: ThinkingProfile = {
  mode: 'always-on',
  on: { thinking: { type: 'enabled' } },
  off: null,
  efforts: [],
  note: 'GLM-5.3 思考固定开启（传 disabled 会请求失败），仅可关闭其强度调节',
};

/** Qwen3.8：开关是顶层布尔 enable_thinking，强度 reasoning_effort */
const QWEN38: ThinkingProfile = {
  mode: 'toggleable',
  on: { enable_thinking: true },
  off: { enable_thinking: false },
  effortField: 'reasoning_effort',
  efforts: ['low', 'medium', 'xhigh'],
  defaultEffort: 'medium',
  effortLabels: { low: '快速', medium: '标准', xhigh: '最高' },
  note: '通过 enable_thinking 开关，强度用 reasoning_effort（默认 xhigh）',
};

/** 火山方舟豆包 seed 系列 */
const DOUBAO_SEED: ThinkingProfile = {
  mode: 'toggleable',
  on: { thinking: { type: 'enabled' } },
  off: { thinking: { type: 'disabled' } },
  effortField: 'reasoning_effort',
  efforts: ['minimal', 'low', 'medium', 'high'],
  defaultEffort: 'high',
  effortLabels: { minimal: '最低', low: '快速', medium: '标准', high: '最高' },
  note: 'thinking 开关 + reasoning_effort 强度，由方舟按模型元数据兜底',
};

/** OpenAI GPT-5.6 家族：无 thinking 字段，用 reasoning_effort:'none' 关闭 */
const OPENAI_56: ThinkingProfile = {
  mode: 'toggleable',
  on: {},
  off: { reasoning_effort: 'none' },
  effortField: 'reasoning_effort',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  effortLabels: { low: '快速', medium: '标准', high: '高', xhigh: '更高', max: '最高' },
  note: 'GPT-5.6 通过 reasoning_effort 控制（none 即关闭思考）',
};

/** GPT-6 Astra：官方只提供 low…max，无法关闭 */
const OPENAI_ASTRA: ThinkingProfile = {
  mode: 'always-on',
  on: {},
  off: null,
  effortField: 'reasoning_effort',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  effortLabels: { low: '快速', medium: '标准', high: '高', xhigh: '更高', max: '最高' },
  note: 'GPT-6 Astra 推理固定开启，本应用只调整强度',
};

/**
 * 解析某模型的思考能力。**未知模型一律返回 unsupported**（fail-safe）。
 * 匹配按「服务商 + 模型名前缀」：服务商已知时优先用其专属规则，避免同名模型跨服务商误判。
 */
export function resolveThinkingProfile(
  provider: ModelProvider | string | undefined,
  modelName: string | undefined,
  baseUrl?: string,
): ThinkingProfile {
  const name = String(modelName || '').trim().toLowerCase();
  if (!name) return UNSUPPORTED;
  const url = String(baseUrl || '').toLowerCase();
  const isDeepSeekEndpoint = provider === 'deepseek' || url.includes('deepseek');

  // ---- DeepSeek（自建端点或任何域名含 deepseek 的中转）----
  if (isDeepSeekEndpoint && name.startsWith('deepseek')) return DEEPSEEK;

  // ---- OpenAI ----
  if (name.startsWith('gpt-6-astra')) return OPENAI_ASTRA;
  if (/^gpt-5\.6/.test(name)) return OPENAI_56;
  if (/^gpt-5\.5/.test(name)) return OPENAI_56;

  // ---- 智谱 GLM ----
  if (/^glm-5\.3(?!-)/.test(name)) return GLM_ALWAYS_ON;
  if (/^glm-5\.3-flash/.test(name)) return GLM;
  if (/^glm-(5|4\.7|4\.6)/.test(name)) return GLM;

  // ---- 通义千问 ----
  if (/^qwen3\.8-/.test(name)) return QWEN38;

  // ---- 火山方舟豆包 ----
  if (name.startsWith('doubao-seed')) return DOUBAO_SEED;

  // 其余（硅基流动的 组织/模型 全名、自定义模型、已退役名等）一律不做猜测
  return UNSUPPORTED;
}

/** 该模型当前**实际生效**的思考状态：不支持的模型恒为关闭（UI 与请求侧共用同一判据）。 */
export function isThinkingActive(
  profile: ThinkingProfile,
  preference: { enabled?: boolean } | undefined,
): boolean {
  if (profile.mode === 'unsupported') return false;
  if (profile.mode === 'always-on') return true;
  return preference?.enabled === true;
}

/** 强度档位的中文标签（UI 展示用） */
export function thinkingEffortLabel(profile: ThinkingProfile, effort: string): string {
  return profile.effortLabels?.[effort] || effort;
}
