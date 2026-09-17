import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { AppConfig, ModelProvider } from '@/lib/bossclaw/types';
import { DEFAULT_CONFIG } from '@/lib/bossclaw/defaults';

export type LLMProvider = ModelProvider;

export interface LLMConfig {
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 已退役的 config.batchDelivery（早中晚分批）在 merge 时被剥离前的老结构，仅用于一次性迁移。 */
export interface LegacyBatchDelivery {
  enabled?: boolean;
  morningTime?: string;
  noonTime?: string;
  eveningTime?: string;
  counts?: { morning?: number; noon?: number; evening?: number };
}

/** merge 时剥离到的旧分批配置（仅老用户升级后的首次启动存在，消费后置空） */
export let legacyBatchDelivery: LegacyBatchDelivery | null = null;

/**
 * 已退役的 DeepSeek 模型名 → 官方现行名 的同义映射（唯一权威，供 persist merge 迁移用）。
 * 依据 2026-09-16 DeepSeek 官方定价页 `api-docs.deepseek.com/quick_start/pricing`：
 * 现行仅有 `deepseek-flash`（= DeepSeek-V4.1-Flash）与 `deepseek-v4-pro`（= V4-Pro-0813）。
 * `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 退役；`deepseek-v4-flash*` 为已退役别名，
 * 官方端点仍接收并由 V4.1-Flash 承接，但第三方 OpenAI 兼容网关会直接 400 拒绝 —— 故统一归一。
 */
export const RETIRED_DEEPSEEK_MODEL_MAP: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-0731': 'deepseek-flash',
  'deepseek-v4-flash-202605': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1': 'deepseek-flash',
};

/** App 启动调用：取走一次性的旧分批配置（幂等；已消费后返回 null）。 */
export function consumeLegacyBatchDelivery(): LegacyBatchDelivery | null {
  const v = legacyBatchDelivery;
  legacyBatchDelivery = null;
  return v;
}

// 预设提供商的默认端点、默认模型与可选模型名建议（自定义可改）
// 模型口径以 2026-09-16 联网核对官方文档为准，已移除停用/下线模型：
//   OpenAI：gpt-6-astra（09-03 发布，最新旗舰）+ gpt-5.6 Sol/Terra/Luna + gpt-5.5-pro；
//   DeepSeek（api-docs.deepseek.com/quick_start/pricing）：**只有 `deepseek-flash`（= DeepSeek-V4.1-Flash）
//     与 `deepseek-v4-pro`（= V4-Pro-0813）两个名字**；`deepseek-v4-flash` / `deepseek-v4-flash-0731`
//     为已退役别名（官方仍接收但已由 V4.1-Flash 承接），第三方网关会直接 400 拒绝，故一律不再推荐；
//   glm-4.x/5.0 → glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5.1 / glm-5；Qwen3.5/3.6 → Qwen3.8；
//   doubao 2.0 → doubao-seed-2.1（保留 2.0-lite 作为低成本档）。
// 注意：模型名是本项目最容易「配错就整个 AI 链路 400」的开关 —— 改动时必须同步
//   `defaults.ts` 的 DEFAULT_CONFIG.model.model、`llm.ts` 的兜底模型名，以及本文件 merge 里的迁移表。
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

interface SettingsState {
  config: AppConfig;
  setConfig: (patch: Partial<AppConfig>) => void;
  setModel: (patch: Partial<AppConfig['model']>) => void;
  applyProviderDefaults: (p: LLMProvider) => void;
  isLLMConfigured: () => boolean;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      setModel: (patch) => set((s) => ({ config: { ...s.config, model: { ...s.config.model, ...patch } } })),
      applyProviderDefaults: (p) =>
        set((s) => ({
          config: {
            ...s.config,
            model: {
              ...s.config.model,
              provider: p,
              baseUrl: PROVIDER_DEFAULTS[p].baseUrl,
              model: PROVIDER_DEFAULTS[p].model,
            },
          },
        })),
      isLLMConfigured: () => {
        const { model } = get().config;
        return Boolean(model.apiKey && model.baseUrl && model.model);
      },
    }),
    {
      // v2 命名空间：本次回滚强制重置旧 bossclaw-settings（含已被删除的 engineMode:'cloak' 持久化值）
      name: 'bossclaw-settings-v2',
      // P30：安全持久化——config 变更（含暂停冷却 pausedUntil 等安全字段）不得因 localStorage
      // 配额异常向上抛错中断引擎/UI；防抖合批也避免高频 setConfig 触发全量序列化
      storage: createSafePersistStorage(),
      // 浅合并持久化配置到最新 DEFAULT_CONFIG，自动补齐新增的安全字段
      // （老用户 localStorage 中缺少 maxDailySent 等字段时回退到安全默认值）
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<SettingsState>;
        const pc = (p.config || {}) as Partial<AppConfig>;
        // 迁移（2026-08-28）：每日目标/每日沟通上限旧默认值 30 → 120。
        // 仅当两个字段都仍为旧默认 30 时视为「未手动修改」，一并升级；
        // 任一字段被用户改过则保留其设置，不覆盖。
        const migrateOld30 = pc.maxDailySent === 30 && pc.dailyTarget === 30;
        const migrated = migrateOld30 ? { maxDailySent: 120, dailyTarget: 120 } : {};
        // 迁移（2026-09-09）：招聘平台 platforms 老数据只有 {enabled}，自动按 DEFAULT_CONFIG 补齐 priority；
        // 用户手动修改过的 priority 保留（pc.platforms[k].priority 存在时优先采用）。
        const defaultPlatforms = (current as SettingsState).config.platforms || ({} as AppConfig['platforms']);
        const persistedPlatforms = (pc.platforms || {}) as Record<string, { enabled?: boolean; priority?: number; dailyTarget?: number }>;
        // 迁移（2026-09-09）：每日投递目标 dailyTarget 从 AppConfig 顶层下放到 platforms[k].dailyTarget。
        // 优先采用老用户已下放的 platforms[k].dailyTarget；否则按顶层 pc.dailyTarget 回填每个平台；
        // 都没有则回退到 defaultPlatforms 的默认 dailyTarget。
        const legacyDailyTarget = Number(pc.dailyTarget ?? defaultPlatforms.boss?.dailyTarget ?? 120);
        const mergedPlatforms: AppConfig['platforms'] = { ...defaultPlatforms };
        for (const [k, v] of Object.entries(persistedPlatforms)) {
          if (k in defaultPlatforms) {
            const def = (defaultPlatforms as Record<string, { enabled: boolean; priority: number; dailyTarget: number }>)[k];
            (mergedPlatforms as Record<string, { enabled: boolean; priority: number; dailyTarget: number }>)[k] = {
              enabled: v?.enabled !== false,
              priority: Number.isFinite(Number(v?.priority)) ? Number(v.priority) : def.priority,
              dailyTarget: Number.isFinite(Number(v?.dailyTarget)) ? Number(v.dailyTarget) : legacyDailyTarget,
            };
          }
        }
        const platformsMigrated = { platforms: mergedPlatforms };
        // 迁移（2026-09-09）：早中晚分批投递从 config 迁出为「定时任务」——config.batchDelivery 已退役。
        // 剥离旧字段并转存到模块级变量，由 App 启动一次性迁移为 3 条限量定时投递任务（幂等）。
        const pcRaw = pc as unknown as { batchDelivery?: LegacyBatchDelivery };
        if (pcRaw.batchDelivery) legacyBatchDelivery = pcRaw.batchDelivery;
        delete pcRaw.batchDelivery;
        const pcRest = pc as Partial<AppConfig>;
        // 迁移（2026-09-16）：DeepSeek 模型名收敛。老用户 localStorage 里可能残留
        // deepseek-chat / deepseek-reasoner / deepseek-v4-flash（及手填的 deepseek-v4.1-flash 等
        // 形似名）。这些名字在官方端点已退役、在第三方网关会直接 HTTP 400，表现为
        // 「设置页看着配好了、一发请求就失败」。此处仅对 DeepSeek 端点做同义归一，
        // 非 DeepSeek 端点与当前合法名一律不动（用户自定义值优先）。
        const pcModel = (pc.model || {}) as Partial<AppConfig['model']>;
        const curModel = (current as SettingsState).config.model;
        const isDeepSeekEndpoint =
          pcModel.provider === 'deepseek' || /deepseek/i.test(String(pcModel.baseUrl || ''));
        const mappedModelName = isDeepSeekEndpoint
          ? RETIRED_DEEPSEEK_MODEL_MAP[String(pcModel.model || '').toLowerCase()]
          : undefined;
        // 同期补齐（2026-09-16）：model.thinking（思考强度）为本次新增字段，老用户的持久化里
        // 完全没有 → 回填默认「关闭 + high」，避免下游读到 undefined。
        // 注意只做形态补齐，**不按模型能力改写用户的 enabled 意图**：能力判定归 thinkingCapability.ts，
        // 不支持的模型即使这里存着 enabled:true，UI 与请求侧都按关闭处理（见 isThinkingActive）。
        const mergedModel: AppConfig['model'] = {
          ...curModel,
          ...pcModel,
          ...(mappedModelName ? { model: mappedModelName } : {}),
          thinking: {
            enabled: pcModel.thinking?.enabled === true,
            effort: String(pcModel.thinking?.effort || curModel.thinking?.effort || 'high'),
          },
        };
        // 迁移（2026-09-16）：沟通阶段看门狗 180s → 60s。
        // 该字段**未在设置页暴露**（Settings.tsx 无对应控件），持久化里出现 180 只可能来自旧默认值，
        // 不存在「用户显式选 180」。只改 defaults.ts 不动 localStorage 的话，老用户重启后仍是 180
        // （表现：点击未生效的岗位要白等 3 分钟才跳过，像卡死）。此处把旧默认值一次性收敛。
        const stuckMigrated: Partial<AppConfig> =
          Number(pc.commStuckTimeoutSec) === 180 ? { commStuckTimeoutSec: 60 } : {};
        return {
          ...current,
          ...p,
          config: {
            ...(current as SettingsState).config,
            ...pcRest,
            ...migrated,
            ...platformsMigrated,
            ...stuckMigrated,
            model: mergedModel,
          },
        };
      },
    }
  )
);

export const getLLMConfig = (): LLMConfig & AppConfig['model'] => {
  const { model } = useSettingsStore.getState().config;
  return model;
};
