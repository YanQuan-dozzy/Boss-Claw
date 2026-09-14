// 「目标城市」同源同步层 —— 设置页（config.targetLocations）⇄ 职业画像（profile.hardConstraints.locations）
//
// 唯一权威存储是设置页的 `config.targetLocations`（它是采集 URL 的输入，也是用户显式填写的意图）；
// 画像里的 locations 保持与它同值，供 jobMatch 的「岗位地点不在目标城市」硬约束使用。
//
// 三种写入语义（这是「不同就相互补充、删除由用户决定」的落地口径）：
//   1. writeTargetLocations  —— **覆盖**：用户在设置页或画像编辑里显式改了城市（含删除）→ 两处同值覆盖。
//   2. mergeTargetLocationsWith —— **并集**：简历/画像新推断出城市（画像生成完成）→ 只补不删，用户随后可自行删除。
//   3. syncTargetLocationsOnStart —— **并集补齐**：启动时存量数据两处不一致 → 取并集写回两处（幂等）。
//      正常使用下两处恒等，此处不触发；因此不会把用户已删除的城市「复活」。
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Profile } from './types';
import {
  mergeTargetLocations,
  normalizeTargetLocations,
  profileTargetLocations,
  sameTargetLocations,
} from './targetLocations';

/** 读当前目标城市（两处同源，以设置页为权威存储） */
export function getTargetLocations(): string[] {
  return normalizeTargetLocations(useSettingsStore.getState().config.targetLocations);
}

/** 覆盖写：设置页与画像同时写成同一份内容（用户显式编辑，允许删除城市） */
export function writeTargetLocations(next: unknown): string[] {
  const locs = normalizeTargetLocations(next);
  applyTargetLocations(locs);
  return locs;
}

/** 并集补齐：把新推断出的城市补进目标城市（已有城市顺序与内容不变，不删除任何城市） */
export function mergeTargetLocationsWith(candidates: unknown): string[] {
  const merged = mergeTargetLocations(getTargetLocations(), candidates);
  applyTargetLocations(merged);
  return merged;
}

/**
 * 启动时补齐（幂等）：存量数据里设置页与画像两份城市不一致 → 取并集写回两处。
 * 两者一致（正常使用下的恒等状态）时直接返回，不做任何写入。
 */
export function syncTargetLocationsOnStart(): string[] {
  const configLocs = getTargetLocations();
  const profileLocs = profileTargetLocations(useDataStore.getState().profile);
  if (sameTargetLocations(configLocs, profileLocs)) return configLocs;
  const merged = mergeTargetLocations(configLocs, profileLocs);
  applyTargetLocations(merged);
  return merged;
}

/** 单一写入点：一次调用同时更新设置页配置与画像硬约束（顺序一致） */
function applyTargetLocations(locs: string[]): void {
  const settings = useSettingsStore.getState();
  if (!sameTargetLocations(settings.config.targetLocations, locs)) {
    settings.setConfig({ targetLocations: locs });
  }
  const data = useDataStore.getState();
  const profile = data.profile;
  if (!profile) return;
  if (sameTargetLocations(profile.hardConstraints?.locations, locs)) return;
  const next: Profile = {
    ...profile,
    hardConstraints: { ...profile.hardConstraints, locations: locs },
  };
  data.setProfile(next);
}
