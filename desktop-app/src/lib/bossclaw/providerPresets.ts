// 模型提供商的预设配置（P1-10：模型名单一来源）
// ---------------------------------------------------------
// 背景：模型名是本项目最容易「配错就整个 AI 链路 400」的开关——曾需在
// useSettingsStore(PROVIDER_DEFAULTS) / defaults.ts(DEFAULT_CONFIG.model) / llm.ts(兜底)
// 三处同步，改一处漏一处即 400。现收敛为本无依赖模块（只 import types）的唯一来源：
//   - useSettingsStore / Settings 页：PROVIDER_DEFAULTS（下拉/套用默认）
//   - defaults.ts：DEFAULT_CONFIG.model 引用 deepseek 预设
//   - llm.ts：callModel 兜底模型名引用 DEFAULT_MODEL_NAME
// 换模型名只改本文件；退役名迁移仍须同步 settingsMigrations.ts 的 RETIRED_DEEPSEEK_MODEL_MAP。
//
// 模型口径以 2026-09-16 联网核对官方文档为准，已移除停用/下线模型：
//   OpenAI：gpt-6-astra（09-03 发布，最新旗舰）+ gpt-5.6 Sol/Terra/Luna + gpt-5.5-pro；
//   DeepSeek（api-docs.deepseek.com/quick_start/pricing）：**只有 `deepseek-flash`（= DeepSeek-V4.1-Flash）
//     与 `deepseek-v4-pro`（= V4-Pro-0813）两个名字**；`deepseek-v4-flash` / `deepseek-v4-flash-0731`
//     为已退役别名（官方仍接收但已由 V4.1-Flash 承接），第三方网关会直接 400 拒绝，故一律不再推荐；
//   glm-4.x/5.0 → glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5.1 / glm-5；Qwen3.5/3.6 → Qwen3.8；
//   doubao 2.0 → doubao-seed-2.1（保留 2.0-lite 作为低成本档）。
import type { ModelProvider } from './types';

export type LLMProvider = ModelProvider;

export interface ProviderPreset {
  baseUrl: string;
  model: string;
  /** 可选模型名建议（下拉选择用），用户仍可在输入框自主填入任意模型名 */
  models: string[];
  label: string;
}

export const PROVIDER_DEFAULTS: Record<LLMProvider, ProviderPreset> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-luna',
    models: ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5-pro', 'gpt-5.5'],
    label: 'OpenAI',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    label: 'DeepSeek',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-flash'],
    label: '通义千问',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5'],
    label: '智谱 GLM',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3.8-2.4T-A95B',
    // 硅基流动的 model 参数用「组织/模型」全名（以模型广场复制到的字符串为准）。
    // DeepSeek-V4-Pro / DeepSeek-V4-Pro-0813 为 2026-08-13 上架版本（官方博客口径）。
    models: [
      'Qwen/Qwen3.8-2.4T-A95B',
      'Qwen/Qwen3.6-27B',
      'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
    ],
    label: '硅基流动',
  },
  volces: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2.1-pro',
    models: ['doubao-seed-2.1-pro', 'doubao-seed-2.1-turbo', 'doubao-seed-evolving', 'doubao-seed-2.0-lite'],
    label: '火山方舟',
  },
  custom: { baseUrl: '', model: '', models: [], label: '自定义（OpenAI 兼容）' },
};

/** 默认提供商与默认模型（defaults.ts 的 DEFAULT_CONFIG.model 与 llm.ts 兜底共用，P1-10） */
export const DEFAULT_PROVIDER: LLMProvider = 'deepseek';
export const DEFAULT_MODEL_NAME: string = PROVIDER_DEFAULTS[DEFAULT_PROVIDER].model;