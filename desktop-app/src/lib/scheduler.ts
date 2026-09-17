// 全局定时任务调度器（模块级单例）
// ---------------------------------------------------------
// 心跳每 15s 检查一次。对启用的条目：命中「当前 HH:mm == 设定 time 且星期匹配（空=每天）」，
// 并在 90s 容差窗口内、按设定时刻去重（lastRunStamp 记录目标时刻 epoch），触发一次动作：
//   deliver → useAutoChatStore.start(scope)（按条目平台范围/单轮上限，内部保留冷却/每日上限/
//             首条验收/风控等安全守卫；引擎已在运行则跳过本次触发）
//   collect → useScheduleStore.setCollectRequest({platforms})（由常驻工作台组件按平台消费触发采集）
//   backup  → 调本地备份写盘（无备份目录则跳过并记日志）
import { useAutoChatStore } from '@/store/useAutoChatStore';
import { useScheduleStore } from '@/store/useScheduleStore';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import { getBackupDir, writeLocalBackup } from './localBackup';
import { platformLabel } from './bossclaw/platforms';
import type { ScheduleEntry } from '@/store/useScheduleStore';
import type { JobPlatform } from '@/lib/bossclaw/types';

const TICK_MS = 15_000;
const GRACE_MS = 90_000; // 目标时刻后的容差窗口（应对节流/半分延迟）
let started = false;
// P2-08：保存 interval 句柄，支持 stop（此前 setInterval 返回值被丢弃，测试/重置场景定时器持续累积）
let tickTimer: ReturnType<typeof setInterval> | null = null;

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

/** 条目的目标平台：空/缺省 = undefined（引擎按全部已启用平台处理） */
function targetPlatforms(entry: ScheduleEntry): JobPlatform[] | undefined {
  return Array.isArray(entry.platforms) && entry.platforms.length > 0 ? entry.platforms : undefined;
}

function platformText(platforms?: JobPlatform[]): string {
  if (!platforms || platforms.length === 0) return '全部启用平台';
  return platforms.map((p) => platformLabel(p)).join('/');
}

async function fireAction(entry: ScheduleEntry): Promise<void> {
  const store = useScheduleStore.getState();
  switch (entry.action) {
    case 'deliver': {
      // 引擎为模块级单例，跨页后台运行；若已有批量沟通（含手动启动）在运行则跳过本次触发，
      // 避免两条 run 争抢岗位（start() 内部 busy 互斥也会静默丢弃，这里显式留痕）。
      if (useAutoChatStore.getState().chatRunning) {
        useRuntimeLogsStore.getState().addChatLog({
          level: 'warn',
          stage: 'system',
          msg: `⏰ 定时任务「${entry.name}」触发但已有批量沟通在运行，本次触发已跳过（将于下一个触发时刻再次尝试）。`,
        });
        break;
      }
      const maxCount = Math.max(0, Number(entry.limitPerRun) || 0);
      useAutoChatStore.getState().start({
        platforms: targetPlatforms(entry),
        maxCount: maxCount > 0 ? maxCount : undefined,
      });
      useRuntimeLogsStore.getState().addChatLog({
        level: 'info',
        stage: 'system',
        msg: `⏰ 定时任务「${entry.name}」触发：已启动批量自动投递（平台：${platformText(targetPlatforms(entry))}${maxCount > 0 ? `；本次上限 ${maxCount} 条` : ''}）。`,
      });
      break;
    }
    case 'collect': {
      // 置位采集请求（携带目标平台），由常驻工作台组件消费（跨页可触发）
      store.setCollectRequest({ platforms: targetPlatforms(entry) });
      useRuntimeLogsStore.getState().addChatLog({
        level: 'info',
        stage: 'system',
        msg: `⏰ 定时任务「${entry.name}」触发：已请求搜索采集（平台：${platformText(targetPlatforms(entry))}）。`,
      });
      break;
    }
    case 'backup': {
      const dir = await getBackupDir();
      if (!dir) {
        useRuntimeLogsStore.getState().addLog('warn', `定时备份「${entry.name}」触发但未设置本地备份目录，已跳过`);
        break;
      }
      const r = await writeLocalBackup();
      if (r.wrote) {
        useRuntimeLogsStore.getState().addLog('success', `定时备份「${entry.name}」已写入本地备份（${dir}）`);
      } else {
        useRuntimeLogsStore.getState().addLog('info', `定时备份「${entry.name}」：内容未变化，未重写文件`);
      }
      break;
    }
  }
}

function tick(): void {
  try {
    const s = useScheduleStore.getState();
    if (!s.entries) return;
    const now = new Date();
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    for (const entry of s.entries) {
      try {
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
        // P30：单条触发异常不得影响其余条目与整个间隔循环（网络/备份失败等）
        void fireAction(entry).catch((e: unknown) => {
          useRuntimeLogsStore.getState().addLog('error', `定时任务「${entry.name}」执行异常：${e instanceof Error ? e.message : String(e)}`);
        });
      } catch (e: unknown) {
        useRuntimeLogsStore.getState().addLog('error', `定时任务「${entry.name}」处理异常：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e: unknown) {
    useRuntimeLogsStore.getState().addLog('error', `定时任务调度心跳异常：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 启动定时任务调度器（幂等）；应用启动时调用一次。返回 stop 函数（测试/重置用；重复调用返回空函数）。 */
export function startScheduler(): () => void {
  if (started) return () => {};
  started = true;
  // 初次进入先补一次检查（覆盖启动即到点的情况）
  tick();
  tickTimer = setInterval(tick, TICK_MS);
  return stopScheduler;
}

/** 停止定时任务调度器（幂等）。 */
export function stopScheduler(): void {
  if (!started) return;
  started = false;
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
