// 本地数据导出/导入工具（基于 localStorage，Zustand persist 已使用以下键）
// 必须与 store 实际写入的 key 保持一致，否则导入数据会丢失
//   - bossclaw-app       ← useAppStore
//   - bossclaw-settings-v2 ← useSettingsStore（v2 含字段迁移，新老数据自动合并）
//   - bossclaw-data      ← useDataStore
import { discardPendingPersistWrites } from './persistSafe';

const BOSS_CLAW_KEYS = ['bossclaw-app', 'bossclaw-settings-v2', 'bossclaw-data'] as const;

/** 同时识别老 key（v1 历史版本），仅导出、不参与导入，避免误删后无法恢复 */
const LEGACY_KEYS = ['bossclaw-settings'] as const;

export function exportData(): string {
  const data: Record<string, string | null> = {};
  for (const k of BOSS_CLAW_KEYS) data[k] = localStorage.getItem(k);
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
    for (const k of BOSS_CLAW_KEYS) {
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
  for (const k of BOSS_CLAW_KEYS) localStorage.removeItem(k);
  // 旧版本遗留键也一并清理（如有），防止 reset 失败导致旧数据复活
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  // P22：补齐遗漏键（技能启用态 / 城市码缓存），确保「完整清理/恢复出厂」名副其实
  localStorage.removeItem('bossclaw-skills-v1');
  localStorage.removeItem('bossclaw-city-codes');
}
