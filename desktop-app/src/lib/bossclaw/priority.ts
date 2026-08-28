// 移植自 job-claw-main\source\src\lib\job-priority.js
// 智能排序：综合匹配度、硬性条件、地点、薪资、新鲜度、风险提示进行排序
import type { JobAnalysis, JobMeta, PendingItem } from './types';

function salaryPriority(job: JobMeta = {}): number {
  const raw = String(job.salary || '').trim();
  // 面议/无薪资：不产生薪资信号（0 分，既不抬升也不压低排序）
  if (!raw || /面议/.test(raw)) return 0;
  // 去掉「13薪/14薪/15薪」等年终奖月数，避免「13」被误当作薪资区间上限
  const cleaned = raw.replace(/[·*＊xX×\s]*1[2-8]\s*薪/g, '').trim();
  // 日薪口径（如 200元/天、300/天、200每天）
  const daily = /\/\s*天|每\s*天|每天|\/\s*日|每\s*日/.test(cleaned);
  const nums = [...cleaned.matchAll(/(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return 0;
  const low = nums[0];
  const high = nums.length >= 2 ? nums[1] : nums[0];
  let midpoint = (low + high) / 2; // 统一折算到「千元/月」口径
  if (daily) midpoint *= 22 / 1000; // 元/天 → 千元/月（按 22 个工作日）
  else if (/万/.test(cleaned)) midpoint *= 10; // 万 → 千元
  else if (/元\s*\/\s*月|元\s*每\s*月/.test(cleaned)) midpoint /= 1000; // 元/月 → 千元
  else if (!/[Kk]/.test(cleaned) && midpoint > 200) midpoint /= 1000; // 纯数字且偏大（如 15000-20000 元）→ 千元
  return Math.max(0, Math.min(180, Math.round(midpoint * 6)));
}

function freshnessPriority(job: JobMeta = {}): number {
  // 只用发布时间字段，不再拼 cardText（整页文本里的「刚刚活跃」等 HR 状态会污染新鲜度判断）
  const source = String(job.publishTime || '').trim();
  if (!source) return 0;
  if (/刚刚|最新|今日|今天|分钟前|小时前|小时内/.test(source)) return 120;
  if (/昨天|昨日|1天前/.test(source)) return 80;
  const days = Number(source.match(/(\d+)\s*天前/)?.[1] || 0);
  if (days > 0) return Math.max(0, 70 - days * 8);
  if (/本周|这周/.test(source)) return 60;
  if (/本月|这个月/.test(source)) return 30;
  // 明确的日期形态（如 08-10、8月10日）视为较旧
  if (/\d{1,2}[-/月]\d{1,2}/.test(source)) return 20;
  return 0;
}

export function computeJobPriority(item: { analysis?: JobAnalysis; job?: JobMeta; retryCount?: number } = {}): number {
  const analysis: Partial<JobAnalysis> = item.analysis || {};
  const job: Partial<JobMeta> = item.job || {};
  const hardBlocks = Array.isArray(analysis.hardBlocks) ? analysis.hardBlocks.length : 0;
  const risks = Array.isArray(analysis.risks) ? analysis.risks.length : 0;
  const gaps = Array.isArray(analysis.gaps) ? analysis.gaps.length : 0;
  const score = Math.max(0, Math.min(100, Number(analysis.score || 0)));
  let priority = score * 100;
  if (analysis.decision === 'recommend') priority += 900;
  if (analysis.decision === 'cautious') priority -= 350;
  if (analysis.decision === 'reject') priority -= 5000;
  priority -= hardBlocks * 2400;
  priority -= risks * 90;
  priority -= gaps * 45;
  priority += salaryPriority(job);
  priority += freshnessPriority(job);
  if (/外部网申|立即网申|去网申/.test(`${job.applicationMode || ''} ${job.cardText || ''}`)) priority -= 6000;
  priority -= Number(item.retryCount || 0) * 120;
  return Math.round(priority);
}

function pendingStatusRank(status: string): number {
  // 对齐 job-claw-main\source\src\lib\job-priority.js 的 pendingStatusRank；
  // 扩展引入 'opened' 状态——工作台「点击立即沟通」打开聊天窗后置为 opened，
  // 排序位置：approved(0) → approved_queue(1) → pending(2) → failed(3) →
  //           opened(3.5)（已开沟通窗但未发送文字 / 未跑自动沟通，置于失败与发送之间，
  //                          优先级高于「失败重试」、低于「待处理 / 投递中」——避免抢在用户处理之前被引擎再次打开） →
  //           sent(4) → skipped(5) → rejected(6) → ignored(7)
  // opened 不计入 priorityRank（参考实现 rerankPending：仅 approved/approved_queue/pending 计入 queueRank）。
  return (
    {
      approved: 0,
      approved_queue: 1,
      pending: 2,
      failed: 3,
      opened: 3.5,
      sent: 4,
      skipped: 5,
      rejected: 6,
      ignored: 7,
    }[status] ?? 8
  );
}

export function rerankPending(items: PendingItem[] = []): PendingItem[] {
  const enriched = items.map((entry) => ({
    ...entry,
    priorityScore: computeJobPriority(entry),
  }));
  enriched.sort((a, b) => {
    const statusDiff = pendingStatusRank(a.status) - pendingStatusRank(b.status);
    if (statusDiff) return statusDiff;
    const priorityDiff = Number(b.priorityScore || 0) - Number(a.priorityScore || 0);
    if (priorityDiff) return priorityDiff;
    const scoreDiff = Number(b.analysis?.score || 0) - Number(a.analysis?.score || 0);
    if (scoreDiff) return scoreDiff;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
  let queueRank = 0;
  return enriched.map((entry) => {
    if (['approved', 'approved_queue', 'pending'].includes(entry.status)) queueRank += 1;
    return {
      ...entry,
      priorityRank: ['approved', 'approved_queue', 'pending'].includes(entry.status) ? queueRank : null,
    };
  });
}

// 把「已批准 / 等待投递」(approved) 的岗位提升为「投递队列 / 投递中」(approved_queue)，
// 返回新数组与本次提升数量。引擎只认 approved_queue 进行实际投递，
// 因此「批准」只进等待态、「一键投递」才把等待态批量提升为可投递态。
export function promoteApprovedToQueue(items: PendingItem[] = []): { next: PendingItem[]; count: number } {
  let count = 0;
  const next = rerankPending(
    items.map((entry) => {
      if (entry.status === 'approved') {
        count += 1;
        return { ...entry, status: 'approved_queue' as const, approvedAt: entry.approvedAt || Date.now() };
      }
      return entry;
    })
  );
  return { next, count };
}
