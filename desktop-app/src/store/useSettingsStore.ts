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

/** App 启动调用：取走一次性的旧分批配置（幂等；已消费后返回 null）。 */
export function consumeLegacyBatchDelivery(): LegacyBatchDelivery | null {
  const v = legacyBatchDelivery;
  legacyBatchDelivery = null;
  return v;
}

// 预设提供商的默认端点、默认模型与可选模型名建议（自定义可改）
// 模型口径以 2026-08-14 联网核对为准，已移除停用/下线模型：
//   gpt-4o/gpt-5-mini → gpt-5.6 系列；deepseek-chat/reasoner（2026-07-24 停用）→ deepseek-v4-flash/v4-pro；
//   glm-4.x → glm-5.2/glm-5.1/glm-5；Qwen3.5/3.6 → Qwen3.8；doubao 2.0 → doubao-seed-2.1
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
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5'],
    label: 'OpenAI',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    label: 'DeepSeek',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-flash'],
    label: '通义千问',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.6'],
    label: '智谱 GLM',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3.8-2.4T-A95B',
    models: ['Qwen/Qwen3.8-2.4T-A95B', 'Qwen/Qwen3.6-27B', 'deepseek-ai/DeepSeek-V4-Flash-0731'],
    label: '硅基流动',
  },
  volces: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2.1-pro',
    models: ['doubao-seed-2.1-pro', 'doubao-seed-2.1-turbo', 'doubao-seed-evolving'],
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
        return {
          ...current,
          ...p,
          config: { ...(current as SettingsState).config, ...pcRest, ...migrated, ...platformsMigrated },
        };
      },
    }
  )
);

export const getLLMConfig = (): LLMConfig & AppConfig['model'] => {
  const { model } = useSettingsStore.getState().config;
  return model;
};
