// 持久化健康回归（issue #10）
//
// 为什么需要它：issue #10 的根因是「写失败被静默丢弃」——localStorage 配额写满后
// writeWithFallback 只打一行限频 console.warn 就返回，界面毫无痕迹，引擎照常跑，
// 重启后整个会话的进度（队列、投递结果，连同 bossclaw-data 里的基础求职条件）回到旧快照。
// 本回归锁死三件事：
//   1) 写失败必须登记成可订阅的健康状态（状态栏/设置页据此告警）；
//   2) 失败期间必须保留「最后一次交出的值」，让 localBackup 能落内存态备份；
//   3) 恢复写入后失败状态必须自动清除（否则告警永远挂着）。
//
// 用法：node scripts/persist-health-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

/** 把 persistSafe 打成临时 CJS（该模块只依赖 zustand 的**类型**，运行时零外部依赖） */
async function loadPersistSafe() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-persist-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: "export * from './src/lib/persistSafe.ts';",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  const mod = require(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 最小 Storage 替身：可切换「配额写满」状态，抛出的错误形状与 Chromium 一致 */
function makeFakeStorage() {
  const map = new Map();
  const state = { quotaFull: false, writes: 0 };
  return {
    state,
    storage: {
      get length() { return map.size; },
      key: (i) => Array.from(map.keys())[i] ?? null,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => {
        if (state.quotaFull) {
          const err = new Error("Failed to execute 'setItem' on 'Storage': Setting the value of '" + k + "' exceeded the quota.");
          err.name = 'QuotaExceededError';
          throw err;
        }
        state.writes += 1;
        map.set(k, String(v));
      },
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
};

const { mod, cleanup } = await loadPersistSafe();
const {
  createSafePersistStorage,
  listPersistFailures,
  hasPersistFailure,
  persistFailureOf,
  getLatestPersistSnapshot,
  onPersistFailure,
  getPersistHealthVersion,
} = mod;

try {
  const fake = makeFakeStorage();
  const storage = createSafePersistStorage({ debounceMs: 0, getStorage: () => fake.storage });

  // ---- 1. 配额写满：写入静默丢弃，但健康状态必须登记 ----
  const notified = [];
  const off = onPersistFailure((info) => notified.push(info));
  fake.state.quotaFull = true;
  const valueA = { state: { pending: [{ id: 'job-1', status: 'sent' }] }, version: 0 };
  storage.setItem('bossclaw-data', valueA);
  await sleep(20);

  ok('写失败后登记健康状态', hasPersistFailure() === true);
  const failure = persistFailureOf('bossclaw-data');
  ok('失败记录带键名', failure?.name === 'bossclaw-data', JSON.stringify(failure));
  ok('配额错误被识别为 quota', failure?.quota === true, JSON.stringify(failure));
  ok('失败计数递增', (failure?.count ?? 0) >= 1, String(failure?.count));
  ok('主存储确实没写进去（模拟配额耗尽）', fake.storage.getItem('bossclaw-data') === null);
  ok('失败事件已通知（用于失败即落备份）', notified.length >= 1, String(notified.length));

  // ---- 2. 失败期间仍能取到「最后一次交出的完整值」——备份据此抢救数据 ----
  const snap = getLatestPersistSnapshot('bossclaw-data');
  ok('失败期间可取内存态快照', typeof snap === 'string' && snap.length > 0);
  let parsed = null;
  try { parsed = JSON.parse(snap); } catch { parsed = null; }
  ok('快照是完整的 {state,version} 结构', parsed?.state?.pending?.[0]?.id === 'job-1', snap?.slice(0, 120));

  // 后续再失败一次：快照必须跟着更新（取最新值，而不是第一次失败的旧值）
  const valueB = { state: { pending: [{ id: 'job-1', status: 'sent' }, { id: 'job-2', status: 'sent' }] }, version: 0 };
  storage.setItem('bossclaw-data', valueB);
  await sleep(20);
  const snap2 = getLatestPersistSnapshot('bossclaw-data');
  ok('快照随最新写入更新', String(snap2).includes('job-2'), String(snap2).slice(0, 160));
  ok('失败计数累加（同一次故障期）', (persistFailureOf('bossclaw-data')?.count ?? 0) >= 2);

  const versionBefore = getPersistHealthVersion();

  // ---- 3. 存储恢复：写入成功即清除失败状态（告警随之消失）----
  fake.state.quotaFull = false;
  storage.setItem('bossclaw-data', valueB);
  await sleep(20);
  ok('写成功后失败状态清除', hasPersistFailure() === false, JSON.stringify(listPersistFailures()));
  ok('健康版本号递增（订阅方会刷新）', getPersistHealthVersion() > versionBefore);
  ok('数据真正落盘', typeof fake.storage.getItem('bossclaw-data') === 'string');

  // ---- 4. 运行时日志键的既有降级策略不受影响（写不进就丢键，且不算业务失败）----
  fake.state.quotaFull = true;
  storage.setItem('bossclaw-runtime-logs', { state: { logs: [{ text: 'x'.repeat(10) }] }, version: 0 });
  await sleep(20);
  ok('日志键仍走「丢弃整个键」降级', fake.storage.getItem('bossclaw-runtime-logs') === null);
  ok('日志键不污染业务健康状态', hasPersistFailure() === false, JSON.stringify(listPersistFailures()));

  off();
} finally {
  cleanup();
}

const total = pass + fails.length;
if (fails.length === 0) {
  console.log(`[持久化健康] 全部通过（${pass}/${total}）`);
  process.exit(0);
}
console.error(`[持久化健康] 失败 ${fails.length}/${total}：`);
for (const f of fails) console.error('  - ' + f);
process.exit(1);
