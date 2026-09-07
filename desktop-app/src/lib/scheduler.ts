// 全局定时任务调度器（模块级单例）
// ---------------------------------------------------------
// 心跳每 15s 检查一次。对启用的条目：命中「当前 HH:mm == 设定 time 且星期匹配（空=每天）」，
// 并在 90s 容差窗口内、按设定时刻去重（lastRunStamp 记录目标时刻 epoch），触发一次动作：
//   deliver → useAutoChatStore.start()（内部保留冷却/每日上限/分批/首条验收等安全守卫）
//   collect → useScheduleStore.setCollectRequested(true)（由常驻工作台组件消费触发采集）
//   backup  → 调本地备份写盘（无备份目录则跳过并记日志）
import { useAutoChatStore } from '@/store/useAutoChatStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import { useDataStore } from '@/store/useDataStore';
import { getBackupDir, writeLocalBackup } from './localBackup';
import type { ScheduleEntry } from '@/store/useScheduleStore';

const TICK_MS = 15_000;
const GRACE_MS = 90_000; // 目标时刻后的容差窗口（应对节流/半分延迟）
let started = false;

function parseMinute(t: string): number {
  const m = String(t || '').match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/** 某日 0 点 epoch + 指定当日分钟 → 目标时刻绝对毫秒 */
function targetMsForMinute(day: Date, minuteOfDay: number): number {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  return dayStart + minuteOfDay * 60_000;
}

function weekdayMatches(entry: ScheduleEntry, day: Date): boolean {
  if (!entry.daysOfWeek || entry.daysOfWeek.length === 0) return true; // 空=每天
  const todayW = day.getDay(); // 0=周日…6=周六
  return entry.daysOfWeek.includes(todayW);
}

async function fireAction(entry: ScheduleEntry): Promise<void> {
  const store = useScheduleStore.getState();
  switch (entry.action) {
    case 'deliver': {
      // 投递引擎为模块级单例，跨页后台运行；内部已有冷却/每日上限/分批/首条验收等守卫
      useAutoChatStore.getState().start();
      useDataStore.getState().addChatLog({
        level: 'info',
        stage: 'system',
        msg: `⏰ 定时任务「${entry.name}」触发：已启动批量自动投递。`,
      });
      break;
    }
    case 'collect': {
      // 置位采集请求，由常驻工作台组件消费（跨页可触发）
      store.setCollectRequested(true);
      useDataStore.getState().addChatLog({
        level: 'info',
        stage: 'system',
        msg: `⏰ 定时任务「${entry.name}」触发：已请求搜索采集。`,
      });
      break;
    }
    case 'backup': {
      const dir = await getBackupDir();
      if (!dir) {
        useDataStore.getState().addLog('warn', `定时备份「${entry.name}」触发但未设置本地备份目录，已跳过`);
        break;
      }
      const r = await writeLocalBackup();
      if (r.wrote) {
        useDataStore.getState().addLog('success', `定时备份「${entry.name}」已写入本地备份（${dir}）`);
      } else {
        useDataStore.getState().addLog('info', `定时备份「${entry.name}」：内容未变化，未重写文件`);
      }
      break;
    }
  }
}

function tick(): void {
  const s = useScheduleStore.getState();
  if (!s.entries) return;
  const now = new Date();
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  for (const entry of s.entries) {
    if (!entry.enabled) continue;
    const targetMinute = parseMinute(entry.time);
    if (targetMinute < 0) continue;
    if (nowMinute !== targetMinute) continue; // 只在本分钟匹配
    if (!weekdayMatches(entry, now)) continue;
    const targetMs = targetMsForMinute(now, targetMinute);
    if (now.getTime() < targetMs || now.getTime() >= targetMs + GRACE_MS) continue;
    if (entry.lastRunStamp === targetMs) continue; // 已在本目标时刻触发过 → 去重
    // 先生成新 lastRunStamp 再触发，避免异步动作期间重复进入
    useScheduleStore.getState().markRun(entry.id, targetMs);
    void fireAction(entry);
  }
}

/** 启动定时任务调度器（幂等）；应用启动时调用一次。 */
export function startScheduler(): void {
  if (started) return;
  started = true;
  // 初次进入先补一次检查（覆盖启动即到点的情况）
  tick();
  setInterval(tick, TICK_MS);
}