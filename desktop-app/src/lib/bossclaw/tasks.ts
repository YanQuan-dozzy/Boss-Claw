// 移植自 job-claw-main\source\src\background.js 的任务创建逻辑
// 注意：本文件仅保留"搜索任务(TaskRun)创建"逻辑。岗位入库的状态流转（pending→approved→approved_queue→sent）
// 统一由 Workbench 的 ingestJob/onJoinTask + priority.promoteApprovedToQueue 处理，采集一律进入
// 「确认队列(pending)」、批准只进「投递队列·等待(approved)」、只有「一键投递」才提升为「投递中(approved_queue)」
// 并启动引擎。历史上曾存在 addPending 在 auto 模式下直接将岗位置为 approved_queue 的"采集即投递"逻辑，
// 已移除，避免未批准即投递。
import type { AppConfig, DirectionPlan, TaskRun, Profile } from './types';
import { selectedDirectionItems } from './directions';

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createTasks(_profile: Profile | null, config: AppConfig, directionPlan: DirectionPlan | null): TaskRun[] {
  const directions = selectedDirectionItems(directionPlan);
  const locations = config.targetLocations?.length ? config.targetLocations : [''];
  const employmentTypes = config.employmentTypes?.length ? config.employmentTypes : ['不限'];
  const tasks: TaskRun[] = [];
  const seen = new Set<string>();
  for (const direction of directions) {
    for (const keyword of direction.keywords) {
      for (const location of locations) {
        for (const employmentType of employmentTypes) {
          const dedupeKey = [keyword, location, employmentType].map((v) => String(v || '').trim().toLowerCase()).join('|');
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          tasks.push({
            id: uid(),
            directionId: direction.id,
            directionName: direction.name,
            directionPriority: direction.priority,
            directionScore: direction.score,
            keyword,
            location,
            employmentType,
            // L-20：experience/degree/salary 并不在 TaskRun 上 —— 原先靠 `as unknown as TaskRun` 强转
            // 硬塞进去（类型校验被绕过，实际是「未声明字段」）。收进已声明的 searchTask（检索条件），
            // 并去掉不安全的强转。
            searchTask: {
              experience: config.experiences?.[0] || '',
              degree: config.degrees?.[0] || '',
              salary: config.salary || '不限',
            },
            attempts: 0,
            status: 'pending',
            progress: 0,
            // L-20：补 stage（原实现缺该字段，一旦有代码按 stage 分支渲染会出现未定义态）。
            // 新建任务处于「已排队」。
            stage: 'queued',
            stageLabel: '等待开始',
            processed: 0,
            discovered: 0,
            analyzed: 0,
            failed: 0,
            createdAt: Date.now(),
          });
        }
      }
    }
  }
  return tasks;
}
