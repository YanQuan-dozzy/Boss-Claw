// 本地数据导出/导入工具（基于 localStorage，Zustand persist 已使用 'bossclaw-*' 键）
const BOSS_CLAW_KEYS = ['bossclaw-app', 'bossclaw-settings', 'bossclaw-data'];

export function exportData(): string {
  const data: Record<string, string | null> = {};
  for (const k of BOSS_CLAW_KEYS) data[k] = localStorage.getItem(k);
  return JSON.stringify(data, null, 2);
}

export function importData(json: string): { ok: boolean; error?: string } {
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
  for (const k of BOSS_CLAW_KEYS) localStorage.removeItem(k);
}
