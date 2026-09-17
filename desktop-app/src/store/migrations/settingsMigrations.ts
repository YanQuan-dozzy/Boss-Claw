// useSettingsStore merge 的历史迁移注册表（P2-06）
// 背景：merge 曾是 78 行的「一次性迁移堆栈」——每次启动都把所有历史迁移判断执行一遍，
// 混着补默认值 / 改历史值 / 剥离字段四种语义，且 `delete pcRaw.batchDelivery` 直接改写入参。
// 现收敛为显式注册表：新增迁移只需要往 MIGRATIONS 追加一项；merge 保持「纯合并」。
// 约定：每条迁移 id = 落地日期 + 主题；describe = 一句话说明；apply = 返回修补后的配置片段。
// 迁移是「一次性的」——新用户打入没有这些历史字段，apply 对缺字段为幂等空操作。
import type { AppConfig } from '@/lib/bossclaw/types';

/** 已退役的 config.batchDelivery（早中晚分批）在 merge 时被剥离前的老结构，仅用于一次性迁移。 */
export interface LegacyBatchDelivery {
  enabled?: boolean;
  morningTime?: string;
  noonTime?: string;
  eveningTime?: string;
  counts?: { morning?: number; noon?: number; evening?: number };
}

/** 已退役的 DeepSeek 模型名 → 官方现行名 的同义映射（唯一权威，供 persist merge 迁移用）。 */
export const RETIRED_DEEPSEEK_MODEL_MAP: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-0731': 'deepseek-flash',
  'deepseek-v4-flash-202605': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1': 'deepseek-flash',
};

/** apply 需要的「基线」：DEFAULT_CONFIG 派生出的当前配置与退役模型映射。
 *  迁移补默认值 / 对齐当前结构时引用，避免每次启动从 localStorage 原样覆盖默认。 */
export interface MigrationBase {
  current: AppConfig;
  deepseekMap: Record<string, string>;
}

export interface SettingsMigration {
  id: string;
  describe: string;
  /** 幂等修补：返回要合并进 config 的片段；不依赖也不再改写入参对象。 */
  apply: (pc: Partial<AppConfig>, base: MigrationBase) => Partial<AppConfig>;
}

const MIGRATIONS: SettingsMigration[] = [
  {
    // 2026-08-28：每日目标/每日沟通上限旧默认值 30 → 120。
    // 仅当两个字段都仍为旧默认 30 时视为「未手动修改」一并升级；任一被改过则保留。
    id: '2026-08-28-daily-30-to-120',
    describe: '每日目标旧默认 30 → 120',
    apply: (pc) =>
      pc.maxDailySent === 30 && pc.dailyTarget === 30
        ? { maxDailySent: 120, dailyTarget: 120 }
        : {},
  },
  {
    // 2026-09-09：招聘平台 platforms 老数据只有 {enabled}，自动按基线补齐 priority；
    // 用户手动修改过的 priority/dailyTarget 保留（persisted 值存在时优先采用）。
    id: '2026-09-09-platforms-normalize',
    describe: 'platforms 补 priority 与 dailyTarget（按基线补默认，用户值优先）',
    apply: (pc, base) => {
      const defaultPlatforms = base.current.platforms || ({} as AppConfig['platforms']);
      const persisted = (pc.platforms || {}) as Record<string, { enabled?: boolean; priority?: number; dailyTarget?: number }>;
      // 老版本 dailyTarget 在顶层（pc.dailyTarget），下放到 platforms[k].dailyTarget。
      const legacyDailyTarget = Number(pc.dailyTarget ?? defaultPlatforms.boss?.dailyTarget ?? 120);
      const merged: AppConfig['platforms'] = { ...defaultPlatforms };
      for (const [k, v] of Object.entries(persisted)) {
        if (k in defaultPlatforms) {
          const def = (defaultPlatforms as Record<string, { enabled: boolean; priority: number; dailyTarget: number }>)[k];
          (merged as Record<string, { enabled: boolean; priority: number; dailyTarget: number }>)[k] = {
            enabled: v?.enabled !== false,
            priority: Number.isFinite(Number(v?.priority)) ? Number(v.priority) : def.priority,
            dailyTarget: Number.isFinite(Number(v?.dailyTarget)) ? Number(v.dailyTarget) : legacyDailyTarget,
          };
        }
      }
      return { platforms: merged };
    },
  },
  {
    // 2026-09-16：DeepSeek 模型名收敛 + model.thinking 形态补齐。
    // 老用户 localStorage 残留 deepseek-chat / deepseek-reasoner / deepseek-v4-flash 等官方已退役名，
    // 第三方网关会直接 HTTP 400。仅对 DeepSeek 端点做同义归一，非 DeepSeek 与当前合法名一律不动。
    id: '2026-09-16-model-normalize',
    describe: 'DeepSeek 退役模型名归一 + thinking 字段补齐',
    apply: (pc, base) => {
      const pcModel = (pc.model || {}) as Partial<AppConfig['model']>;
      const curModel = base.current.model;
      const isDeepSeekEndpoint =
        pcModel.provider === 'deepseek' || /deepseek/i.test(String(pcModel.baseUrl || ''));
      const mapped = isDeepSeekEndpoint ? base.deepseekMap[String(pcModel.model || '').toLowerCase()] : undefined;
      return {
        model: {
          ...curModel,
          ...pcModel,
          ...(mapped ? { model: mapped } : {}),
          // thinking 为新增字段，老用户持久化缺失 → 回填默认「关闭 + high」。
          // 只做形态补齐，不按模型能力改写用户意图（能力判定归 thinkingCapability.ts）。
          thinking: {
            enabled: pcModel.thinking?.enabled === true,
            effort: String(pcModel.thinking?.effort || curModel.thinking?.effort || 'high'),
          },
        },
      };
    },
  },
  {
    // 2026-09-16：沟通阶段看门狗 180s → 60s（字段未在设置页暴露，180 只可能来自旧默认值）。
    id: '2026-09-16-comm-stuck-180-to-60',
    describe: '沟通看门狗旧默认 180s → 60s',
    apply: (pc) => (Number(pc.commStuckTimeoutSec) === 180 ? { commStuckTimeoutSec: 60 } : {}),
  },
];

/** 顺序执行全部迁移，返回各迁移补丁的合并（纯函数，不改写入参；pc 由调用方展开进最终 config）。 */
export function applyMigrations(pc: Partial<AppConfig>, base: MigrationBase): Partial<AppConfig> {
  return MIGRATIONS.reduce<Partial<AppConfig>>((acc, m) => ({ ...acc, ...m.apply(pc, base) }), {});
}

/** 剥离退役字段 batchDelivery（纯函数，返回新副本而非 delete 入参）：
 *  artifact = 剥离出的旧配置（消费方决定怎么用）；cleaned = 去除该字段后的配置。 */
export function extractLegacyBatchDelivery(pc: Partial<AppConfig>): {
  artifact: LegacyBatchDelivery | null;
  cleaned: Partial<AppConfig>;
} {
  // batchDelivery 是已退役字段，不在 AppConfig 类型上——用 cast 访问并解构剥离
  const raw = pc as Partial<AppConfig> & { batchDelivery?: LegacyBatchDelivery };
  if (!raw.batchDelivery) return { artifact: null, cleaned: { ...pc } };
  const { batchDelivery, ...rest } = raw;
  void batchDelivery;
  return { artifact: batchDelivery, cleaned: rest };
}