// 有界并发任务队列（供「采集 → AI 分析」聚合突发使用）
//
// 背景：可视化采集对每张岗位卡片 fire-and-forget 调用 ingestJob（void，不等待返回），
// 而单次 analyzeJob 常需 10-45s；采集滚动节奏（默认 1.5s/卡）远快于分析速度，且
// cachedCallModel 只对「完全相同 key」去重、不同岗位并不同 key → 无界并发 LLM 调用。
// 本模块把突发投递改造成受控并发：FIFO、最多 limit 个任务同时在跑，失败不中断后续。
// 纯函数零依赖、无副作用；onChange 可订阅计数供 UI 展示「分析中 / 排队中」。
export interface AnalysisQueueStats {
  /** 正在执行的异步任务数 */
  running: number;
  /** 等待执行的排队任务数 */
  queued: number;
}

export interface AnalysisQueue {
  /** 投递一个异步任务，返回其完成/失败的 Promise（调用方不需要 await 时请 catch 掉，避免 unhandledrejection） */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  getStats(): AnalysisQueueStats;
  /** 订阅统计变化（注册时立刻回调一次当前值），返回取消订阅函数 */
  onChange(listener: (stats: AnalysisQueueStats) => void): () => void;
  /** 停止接受新任务（已入队任务继续跑完） */
  dispose(): void;
}

interface QueueItem {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function createAnalysisQueue(limit: number): AnalysisQueue {
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(limit) || 1)));
  const pending: QueueItem[] = [];
  const listeners = new Set<(s: AnalysisQueueStats) => void>();
  let running = 0;
  let disposed = false;

  const emit = (): void => {
    const stats: AnalysisQueueStats = { running, queued: pending.length };
    for (const listener of listeners) listener(stats);
  };

  /** 尽力拉起可执行任务：有空闲并发位且有排队任务时逐个启动 */
  const pump = (): void => {
    if (disposed) return;
    while (running < concurrency && pending.length) {
      const item = pending.shift() as QueueItem;
      running += 1;
      emit();
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          running -= 1;
          if (disposed) return;
          emit();
          pump();
        });
    }
  };

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error('analysis queue disposed'));
          return;
        }
        pending.push({
          task: task as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        emit();
        pump();
      });
    },
    getStats: () => ({ running, queued: pending.length }),
    onChange(listener) {
      listeners.add(listener);
      listener({ running, queued: pending.length });
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}