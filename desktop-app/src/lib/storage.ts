// 本地数据导出/导入工具（基于 localStorage，Zustand persist 已使用以下键）
// 必须与 store 实际写入的 key 保持一致，否则导入数据会丢失
//   - bossclaw-app       ← useAppStore
//   - bossclaw-settings-v2 ← useSettingsStore（v2 含字段迁移，新老数据自动合并）
//   - bossclaw-data      ← useDataStore
import { discardPendingPersistWrites, persistFailureOf, getLatestPersistSnapshot } from './persistSafe';
import { isQueueFileMode } from './bossclaw/queueMode';
import { QUEUE_STORE_KEY, clearQueueStore, getQueueSnapshotText, importQueueData } from './bossclaw/queueRepo';

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
  // 定制历史纳入本地备份；模块排序 / 模板 / 照片仅留在主存储。均不纳入换机导出，清空时删。
  { key: 'bossclaw-tailor-history-v1', export: false, backup: true, clear: true },
  { key: 'bossclaw-resume-module-order-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-resume-template-v1', export: false, backup: false, clear: true },
  { key: 'bossclaw-resume-photo-v1', export: false, backup: false, clear: true },
  // 数据版本号：豁免（启动迁移依赖此键判断是否重建数据，清空后需经版本重写）
  { key: 'bossclaw-data-version', export: false, backup: false, clear: false },
  // 运行时日志（P2-05）：从 bossclaw-data 拆出的独立小键。日志为运行时产物、重启即重新累积，
  // 不导出不备份；「清空全部数据/恢复出厂」时随业务数据一并清除
  { key: 'bossclaw-runtime-logs', export: false, backup: false, clear: true },
  // 岗位队列（issue #10）：虚拟键 —— 文件模式下数据实际位于 <userData>/queue/queue-store.json，
  // 不在 localStorage 里。登记在这里是为了让导出/备份/清空三处共用同一份清单，
  // 具体读写由 lib/bossclaw/queueRepo.ts 接管（见下方各函数的 SPECIAL 分支）。
  { key: QUEUE_STORE_KEY, export: true, backup: true, clear: true },
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
  for (const k of EXPORT_KEYS) {
    if (k === QUEUE_STORE_KEY && isQueueFileMode()) {
      // 虚拟键：队列在文件里，直接从 store 内存同步取一份完整快照（与导出时刻一致）
      data[k] = getQueueSnapshotText();
      continue;
    }
    // issue #10：写失败期间 localStorage 是**旧快照**，此处若照读，导出出来的就是「回退版」，
    // 用户以为救下的其实是那批已经过期的数据。改用 persist 内存中的最新值。
    const failed = persistFailureOf(k);
    const snap = failed ? getLatestPersistSnapshot(k) : null;
    data[k] = snap != null ? snap : localStorage.getItem(k);
  }
  for (const k of LEGACY_KEYS) {
    if (localStorage.getItem(k) != null) data[`__legacy__${k}`] = localStorage.getItem(k);
  }
  return JSON.stringify(data, null, 2);
}

export async function importData(json: string): Promise<{ ok: boolean; error?: string }> {
  // 顺序很重要：**先解析、再丢弃**。原实现先 discardPendingPersistWrites() 再 JSON.parse——
  // 一旦解析失败，防抖窗口内的合法待写值已被丢掉，等于「一次失败的导入顺带丢了最近的编辑」（见审查 #45）。
  let data: Record<string, string | null>;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  // 队列在文件模式下先落文件：写失败就整体中止，避免「设置/简历已导入、队列还停在旧值」的半截状态
  if (isQueueFileMode() && QUEUE_STORE_KEY in data) {
    const queueText = data[QUEUE_STORE_KEY];
    if (typeof queueText === 'string' && queueText.trim()) {
      const r = await importQueueData(queueText);
      if (!r.ok) return { ok: false, error: `岗位队列导入失败：${r.error || '未知错误'}` };
    } else if (queueText == null) {
      await clearQueueStore();
    }
  } else if (QUEUE_STORE_KEY in data) {
    // 回滚模式（BOSSCLAW_QUEUE_STORE=localstorage）：队列必须并回 bossclaw-data，
    // 否则写进一个没人读的 localStorage 键等于「导入丢队列」。
    const queueText = data[QUEUE_STORE_KEY];
    if (typeof queueText === 'string' && queueText.trim()) {
      try {
        const q = JSON.parse(queueText) as { pending?: unknown; qualifiedExports?: unknown };
        const legacyRaw = data['bossclaw-data'] ?? localStorage.getItem('bossclaw-data');
        const legacy = legacyRaw ? (JSON.parse(legacyRaw) as { state?: Record<string, unknown>; version?: number }) : { state: {}, version: 2 };
        legacy.state = {
          ...(legacy.state || {}),
          pending: Array.isArray(q.pending) ? q.pending : [],
          qualifiedExports: q.qualifiedExports && typeof q.qualifiedExports === 'object' ? q.qualifiedExports : {},
        };
        data['bossclaw-data'] = JSON.stringify(legacy);
      } catch {
        return { ok: false, error: '备份里的岗位队列结构非法' };
      }
    }
    delete data[QUEUE_STORE_KEY];
  }
  // 解析成功：丢弃 persist 防抖窗口内残留的待写值，避免 reload 前的 pagehide flush 覆盖刚导入的数据
  discardPendingPersistWrites();
  try {
    for (const k of EXPORT_KEYS) {
      if (k === QUEUE_STORE_KEY && isQueueFileMode()) continue; // 已由 importQueueData 写入文件
      if (k in data) {
        if (data[k] == null) localStorage.removeItem(k);
        else localStorage.setItem(k, data[k] as string);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function clearAllData(): Promise<void> {
  // P30：先丢弃 persist 防抖窗口内残留的待写值——否则清空后若窗口内有旧值，reload 前的
  // pagehide flush 会把这些旧状态写回 localStorage，导致「清空/恢复出厂」无效
  discardPendingPersistWrites();
  // P2-03：清理范围由登记表派生（clear:false 即豁免，如版本号），不再手写键清单
  for (const k of keysWhere((s) => s.clear)) localStorage.removeItem(k);
  // 旧版本遗留键也一并清理（如有），防止 reset 失败导致旧数据复活
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  // issue #10：队列文件必须同批删除，否则清空后重新启动会从文件里读回整份队列
  await clearQueueStore();
}

// ===== 本地存储用量（issue #10）=====
// 配额口径（2026-10-27 在本机实测，Electron 42.11.10 + file:// 源，方法见 docs/issue-10-修复记录.md §7）：
//   · 计费单位 = 键名 + 值的 UTF-16 码元总数（不是磁盘字节数）；
//   · 单源上限 **52,428,800 码元**（= 50 Mi 码元，即常说的「50MB 额度」）：单键最多 52,428,799 字符
//     （键名占 1），多键加总同样卡在这个数 → 「所有键共用一份额度」；
//   · 中文与英文占用相同（均按 1 码元/字计），emoji（代理对）按 2 码元计；
//   · `--unlimited-storage` 开关**无效**（实测数字一模一样）→ 无法靠命令行调大；
//   · 历史代码/文档里的「5MB」是旧口径，实际是它的 10 倍。
// 展示口径：1 码元按 1 字节折算成 MB（52,428,800 码元 = 50.00 MB），与内核那边的「50MB」表述对齐。
// 配额写满后所有键的写入都会失败（persistSafe 会静默丢弃并登记健康状态），
// 因此这里给出「哪个键吃掉了多少」的可视化，让用户在写失败前就能看到并清理。
export const LOCAL_STORAGE_QUOTA_UNITS = 52_428_800;

export interface StorageUsageRow {
  key: string;
  /** 占用码元数（含键名，对齐 Chromium 的计费口径） */
  units: number;
  /** 是否纳入「导出 JSON 备份」 */
  exportable: boolean;
}

export interface StorageUsage {
  rows: StorageUsageRow[];
  totalUnits: number;
  quotaUnits: number;
  /** 占用率 0~1 */
  ratio: number;
}

/** 估算各存储键的占用（按登记表枚举，缺失键也列出 0 值，便于用户理解结构） */
export function measureStorageUsage(): StorageUsage {
  const rows: StorageUsageRow[] = [];
  let totalUnits = 0;
  for (const spec of STORAGE_KEYS) {
    // 文件模式下队列不占 localStorage 额度，单独由 queueRepo 统计并在用量面板单列一行
    if (spec.key === QUEUE_STORE_KEY && isQueueFileMode()) continue;
    let units = 0;
    try {
      const raw = localStorage.getItem(spec.key);
      if (raw != null) units = spec.key.length + raw.length;
    } catch {
      units = 0;
    }
    totalUnits += units;
    rows.push({ key: spec.key, units, exportable: spec.export });
  }
  rows.sort((a, b) => b.units - a.units);
  return {
    rows,
    totalUnits,
    quotaUnits: LOCAL_STORAGE_QUOTA_UNITS,
    ratio: Math.min(1, totalUnits / LOCAL_STORAGE_QUOTA_UNITS),
  };
}

/** 人类可读的占用文案（MB 记法：1 码元按 1 字节折算，与 Chromium「50MB 额度」的表述同口径） */
const UNITS_PER_KB = 1024;
const UNITS_PER_MB = 1024 * 1024;

export function formatStorageSize(units: number): string {
  if (units >= UNITS_PER_MB) return `${(units / UNITS_PER_MB).toFixed(2)} MB`;
  if (units >= UNITS_PER_KB) return `${Math.round(units / UNITS_PER_KB)} KB`;
  return `${units} B`;
}
