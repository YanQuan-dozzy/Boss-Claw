// 本地数据导出/导入工具（基于 localStorage，Zustand persist 已使用以下键）
// 必须与 store 实际写入的 key 保持一致，否则导入数据会丢失
//   - bossclaw-app       ← useAppStore
//   - bossclaw-settings-v2 ← useSettingsStore（v2 含字段迁移，新老数据自动合并）
//   - bossclaw-data      ← useDataStore
import { discardPendingPersistWrites } from './persistSafe';

// ===== 存储键登记表（P2-03：单一事实来源）=====
// 曾被三处重复维护（storage.ts BOSS_CLAW_KEYS / localBackup BACKUP_KEYS / clearAllData 硬编码），
// 各自漂移导致「导出丢定时任务、备份不含缓存、清空漏键」。现收敛为一张表，按用途派生。
//  - export：纳入「导出数据/换机导入」（用户珍贵数据）
//  - backup：纳入本地 5 分钟备份（业务状态）
//  - clear ：「恢复出厂/清空全部」时删除；false = 豁免（如数据版本号，迁移依赖，不可删）
export interface StorageKeySpec {
  key: string;
  export: boolean;
  backup: boolean;
  clear: boolean;
}

export const STORAGE_KEYS: StorageKeySpec[] = [
  { key: 'bossclaw-app', export: true, backup: true, clear: true },
  { key: 'bossclaw-settings-v2', export: true, backup: true, clear: true },
  { key: 'bossclaw-data', export: true, backup: true, clear: true },
  // schedule 曾缺于导出键（P2-03）：导出数据将丢失全部定时投递/采集任务定义，且导入端静默成功
  { key: 'bossclaw-schedule', export: true, backup: true, clear: true },
  // 技能启用态 / 城市码缓存（P22 补清）
  { key: 'bossclaw-skills-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-city-codes', export: false, backup: false, clear: true },
  // AI 缓存 / 统计：可重建，不导出不备份，但清空时必须删（P2-02）
  { key: 'bossclaw-ai-cache-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-ai-cache-stats', export: false, backup: false, clear: true },
  // 定制简历历史 / 模块排序 / 模板 / 照片 dataURL（隐私）：清空时删，不导出不备份
  { key: 'bossclaw-tailor-history-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-resume-module-order-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-resume-template-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-resume-photo-v1', export: false, backup: false, clear: true },
  // 数据版本号：豁免（启动迁移依赖此键判断是否重建数据，清空后需经版本重写）
  { key: 'bossclaw-data-version', export: false, backup: false, clear: false },
  // 运行时日志（P2-05）：从 bossclaw-data 拆出的独立小键。日志为运行时产物、重启即重新累积，
  // 不导出不备份；「清空全部数据/恢复出厂」时随业务数据一并清除
  { key: 'bossclaw-runtime-logs', export: false, backup: false, clear: true },
] as const;

export const keysWhere = (pred: (s: StorageKeySpec) => boolean): string[] =>
  STORAGE_KEYS.filter(pred).map((s) => s.key);

/** 导出/导入使用的键（用户珍贵数据） */
export const EXPORT_KEYS = keysWhere((s) => s.export);
/** 本地备份使用的业务状态键（localBackup.ts 引用，不再单独维护一份） */
export const BACKUP_KEYS = keysWhere((s) => s.backup);

/** 同时识别老 key（v1 历史版本），仅导出、不参与导入，避免误删后无法恢复 */
const LEGACY_KEYS = ['bossclaw-settings'] as const;

export function exportData(): string {
  const data: Record<string, string | null> = {};
  for (const k of EXPORT_KEYS) data[k] = localStorage.getItem(k);
  for (const k of LEGACY_KEYS) {
    if (localStorage.getItem(k) != null) data[`__legacy__${k}`] = localStorage.getItem(k);
  }
  return JSON.stringify(data, null, 2);
}

export function importData(json: string): { ok: boolean; error?: string } {
  // P30：先丢弃 persist 防抖窗口内残留的待写值，避免 reload 前的 pagehide flush 覆盖刚导入的数据
  discardPendingPersistWrites();
  try {
    const data = JSON.parse(json);
    for (const k of EXPORT_KEYS) {
      if (k in data) {
        if (data[k] == null) localStorage.removeItem(k);
        else localStorage.setItem(k, data[k]);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function clearAllData(): void {
  // P30：先丢弃 persist 防抖窗口内残留的待写值——否则清空后若窗口内有旧值，reload 前的
  // pagehide flush 会把这些旧状态写回 localStorage，导致「清空/恢复出厂」无效
  discardPendingPersistWrites();
  // P2-03：清理范围由登记表派生（clear:false 即豁免，如版本号），不再手写键清单
  for (const k of keysWhere((s) => s.clear)) localStorage.removeItem(k);
  // 旧版本遗留键也一并清理（如有），防止 reset 失败导致旧数据复活
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}
