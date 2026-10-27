// 岗位队列文件仓储回归（issue #10 / docs/存储迁移方案.md §7）
// ---------------------------------------------------------
// 覆盖三层：
//   1. 主进程 electron/queueStore.cjs：原子写、seq 迟到包拒绝、.bak 轮转、损坏回退、清空、用量、迁移快照；
//   2. 渲染侧 queueRepo：800ms 防抖合批、单飞串行、失败上报 persist 健康、导入/清空；
//   3. 一次性迁移 queueMigrate：先写文件验真再剥离 localStorage；写失败时保持 localStorage 原样。
//
// 离线可跑：主进程模块用 Module._load 替身注入 electron.app；渲染侧模块用 esbuild 打包，
// 注入假的 window / document / localStorage / window.electron（内存版 IPC）。
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 1. 主进程 queueStore.cjs =====
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bossclaw-queue-'));
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => tmpRoot } };
  return origLoad.call(this, request, parent, isMain);
};
const queueStore = require('../electron/queueStore.cjs');
Module._load = origLoad;

const payload = (seq, pending = [], qualifiedExports = {}) =>
  JSON.stringify({ version: 1, seq, updatedAt: Date.now(), pending, qualifiedExports });

console.log('[1] queueStore.cjs（主进程文件仓储）');
{
  const r1 = await queueStore.save(payload(1, [{ id: 'a' }]), 1);
  check('首次写入成功', r1.ok === true, JSON.stringify(r1));
  const loaded = queueStore.load();
  check('读回 seq 与 pending 一致', loaded.ok && loaded.data.seq === 1 && loaded.data.pending.length === 1);

  const stale = await queueStore.save(payload(1, [{ id: 'old' }]), 1);
  check('seq 迟到包被拒绝（stale）', stale.ok === true && stale.stale === true);
  const afterStale = queueStore.load();
  check('迟到包未覆盖文件', afterStale.data.pending[0].id === 'a');

  await queueStore.save(payload(2, [{ id: 'b' }]), 2);
  const bak = JSON.parse(fs.readFileSync(queueStore._paths.bakPath(), 'utf8'));
  check('.bak 轮转为上一份完好数据', bak.pending[0].id === 'a');

  // 主文件损坏 → 退回 .bak（此时 .bak 是 seq=1 的 a）
  fs.writeFileSync(queueStore._paths.storePath(), '{ broken json', 'utf8');
  const recovered = queueStore.load();
  check('主文件损坏时从 .bak 回退', recovered.ok === true && recovered.recovered === true && recovered.data.pending[0].id === 'a');

  const bad = await queueStore.save(JSON.stringify({ version: 1, pending: 'x' }), 9);
  check('非法载荷被拒绝', bad.ok === false);
  const overVersion = await queueStore.save(JSON.stringify({ version: 9, pending: [], qualifiedExports: {} }), 9);
  check('未知版本被拒绝', overVersion.ok === false);

  const snap = await queueStore.save(payload(10, [{ id: 'm' }]), 10, { migrationSnapshot: true });
  const snaps = fs.readdirSync(queueStore._paths.baseDir()).filter((f) => f.startsWith('queue-migration-'));
  check('迁移快照写入成功', snap.ok && snaps.length === 1);

  const usage = queueStore.usage();
  check('用量统计为正数', usage.ok && usage.totalBytes > 0, JSON.stringify(usage));

  await queueStore.clear();
  const cleared = queueStore.load();
  check('清空后读回为空', cleared.ok && cleared.data === null);
}

// ===== 2/3. 渲染侧（esbuild 打包 + 假环境）=====
const entry = path.join(tmpRoot, 'entry.ts');
const outfile = path.join(tmpRoot, 'bundle.mjs');
fs.writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(path.join(ROOT, 'src/lib/bossclaw/queueRepo.ts').replace(/\\/g, '/'))};`,
    `export * from ${JSON.stringify(path.join(ROOT, 'src/lib/bossclaw/queueMigrate.ts').replace(/\\/g, '/'))};`,
    `export { useDataStore } from ${JSON.stringify(path.join(ROOT, 'src/store/useDataStore.ts').replace(/\\/g, '/'))};`,
    `export { listPersistFailures, clearExternalFailure } from ${JSON.stringify(path.join(ROOT, 'src/lib/persistSafe.ts').replace(/\\/g, '/'))};`,
    `export { setQueueFileMode, isQueueFileMode } from ${JSON.stringify(path.join(ROOT, 'src/lib/bossclaw/queueMode.ts').replace(/\\/g, '/'))};`,
  ].join('\n'),
  'utf8'
);

const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  alias: { '@': path.join(ROOT, 'src') },
});

// 假 localStorage / window / document（在动态 import 之前注入）
const localStorageMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
  setItem: (k, v) => localStorageMap.set(k, String(v)),
  removeItem: (k) => localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
  key: (i) => Array.from(localStorageMap.keys())[i] ?? null,
  get length() {
    return localStorageMap.size;
  },
};

/** 内存版队列文件 + 可注入延迟/失败，模拟主进程 IPC */
function makeFakeFile() {
  return { text: null, seq: 0, delay: 0, failNext: 0, saves: [] };
}
const fakeFile = makeFakeFile();
const fakeElectron = {
  queueStoreMode: 'file',
  queueLoad: async () => {
    if (fakeFile.delay) await sleep(fakeFile.delay);
    return { ok: true, data: fakeFile.text ? JSON.parse(fakeFile.text) : null, source: 'main' };
  },
  queueSave: async (text, seq) => {
    fakeFile.saves.push({ seq, text, at: Date.now() });
    if (fakeFile.delay) await sleep(fakeFile.delay);
    if (fakeFile.failNext > 0) {
      fakeFile.failNext -= 1;
      return { ok: false, error: '模拟磁盘写入失败' };
    }
    if (seq <= fakeFile.seq) return { ok: true, stale: true };
    fakeFile.seq = seq;
    fakeFile.text = text;
    return { ok: true, seq };
  },
  queueClear: async () => {
    fakeFile.text = null;
    fakeFile.seq = 0;
    return { ok: true };
  },
  queueUsage: async () => ({ ok: true, bytes: fakeFile.text ? fakeFile.text.length : 0, totalBytes: fakeFile.text ? fakeFile.text.length : 0 }),
  backupRead: async () => ({ ok: true, bundle: { updatedAt: Date.now(), keys: {} } }),
};
globalThis.window = {
  electron: fakeElectron,
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };

const mod = await import(pathToFileURL(outfile).href);
const {
  QUEUE_STORE_KEY,
  hydrateQueue,
  startQueueAutoSave,
  flushQueueNow,
  importQueueData,
  clearQueueStore,
  getQueueSnapshotText,
  migrateQueueFromLocalStorageIfNeeded,
  useDataStore,
  listPersistFailures,
  setQueueFileMode,
} = mod;

console.log('[2] queueRepo.ts（渲染侧封送）');
{
  // 起始：文件有 1 条，水合后 store 应与之对齐
  fakeFile.text = JSON.stringify({ version: 1, seq: 3, updatedAt: Date.now(), pending: [{ id: 'q1' }], qualifiedExports: {} });
  fakeFile.seq = 3;
  const h = await hydrateQueue();
  check('水合读回文件队列', h.ok && h.pending.length === 1 && h.pending[0].id === 'q1');
  useDataStore.getState().hydrateFromFile(h.pending, h.qualifiedExports);
  startQueueAutoSave();

  // 防抖：短窗口内连续 5 次 set 只落 1 次盘
  const before = fakeFile.saves.length;
  for (let i = 0; i < 5; i += 1) {
    useDataStore.getState().addPendingItem({ id: `d${i}`, status: 'pending' });
  }
  await sleep(1200);
  check('800ms 防抖内多次变更合并为一次写盘', fakeFile.saves.length - before === 1, `实际 ${fakeFile.saves.length - before} 次`);

  // 单飞：写盘在途期间的新变更，等上一笔完成后用最新状态补写一次（不丢最新）
  fakeFile.delay = 250;
  const beforeSingle = fakeFile.saves.length;
  useDataStore.getState().addPendingItem({ id: 's1', status: 'pending' });
  await sleep(900); // 第一笔在途
  useDataStore.getState().addPendingItem({ id: 's2', status: 'pending' });
  await sleep(1600);
  fakeFile.delay = 0;
  const lastSaved = JSON.parse(fakeFile.text || '{}');
  check('单飞补写后文件包含最新条目', Array.isArray(lastSaved.pending) && lastSaved.pending.some((p) => p.id === 's2'));
  check('写序号单调递增', fakeFile.saves.slice(beforeSingle).every((s, i, arr) => i === 0 || s.seq > arr[i - 1].seq));

  // 失败上报：写入失败 → persist 失败列表出现队列键；恢复后自动清除
  fakeFile.failNext = 1;
  useDataStore.getState().addPendingItem({ id: 'f1', status: 'pending' });
  await flushQueueNow();
  check('队列写入失败进入 persist 健康列表', listPersistFailures().some((f) => f.name === QUEUE_STORE_KEY));
  await flushQueueNow();
  check('后续写入成功后清除失败标记', !listPersistFailures().some((f) => f.name === QUEUE_STORE_KEY));

  // 导入：外部 JSON → 文件
  const imp = await importQueueData(JSON.stringify({ version: 1, seq: 1, updatedAt: Date.now(), pending: [{ id: 'imp' }], qualifiedExports: {} }));
  check('导入队列写入文件成功', imp.ok === true);
  check('导入后文件内容已更新', JSON.parse(fakeFile.text).pending[0].id === 'imp');

  const snapText = JSON.parse(getQueueSnapshotText());
  check('同步快照结构合法且反映 store 当前队列', snapText.version === 1 && Array.isArray(snapText.pending) && typeof snapText.qualifiedExports === 'object');

  await clearQueueStore();
  check('清空后文件为空', fakeFile.text === null);
}

console.log('[3] queueMigrate.ts（一次性迁移）');
function resetForMigration() {
  localStorageMap.clear();
  fakeFile.text = null;
  fakeFile.seq = 0;
  fakeFile.failNext = 0;
  setQueueFileMode(true);
}
{
  // 成功路径：localStorage 有队列 → 写文件 → 读回校验 → 剥离
  resetForMigration();
  localStorageMap.set(
    'bossclaw-data',
    JSON.stringify({ state: { pending: [{ id: 'm1' }, { id: 'm2' }], qualifiedExports: { '2026-10-27': [{ id: 'x' }] }, resumeText: 'keep' }, version: 2 })
  );
  const r = await migrateQueueFromLocalStorageIfNeeded();
  check('迁移执行成功', r.migrated === true, JSON.stringify(r));
  const migrated = JSON.parse(fakeFile.text);
  check('队列已写入文件', migrated.pending.length === 2 && migrated.migratedFrom === 'localstorage');
  const legacy = JSON.parse(localStorageMap.get('bossclaw-data'));
  check('localStorage 已剥离队列字段', !('pending' in legacy.state) && !('qualifiedExports' in legacy.state));
  check('localStorage 其余字段保留', legacy.state.resumeText === 'keep');
  check('迁移标记已写入', localStorageMap.has('bossclaw-queue-migration-v1'));

  const again = await migrateQueueFromLocalStorageIfNeeded();
  check('重复调用被跳过', again.migrated === false && again.skipped === true);
}
{
  // 真实体量：800 条队列（约 2~7K 字符/条）→ 迁移后 localStorage 体积应骤降
  resetForMigration();
  const items = Array.from({ length: 800 }, (_, i) => ({
    id: `bulk-${i}`,
    status: 'pending',
    job: { title: `岗位${i}`, jd: 'x'.repeat(2000) },
  }));
  const before = JSON.stringify({
    state: { pending: items, qualifiedExports: {}, resumeText: 'r'.repeat(1000) },
    version: 2,
  });
  localStorageMap.set('bossclaw-data', before);
  const t0 = Date.now();
  const bulk = await migrateQueueFromLocalStorageIfNeeded();
  const cost = Date.now() - t0;
  const after = localStorageMap.get('bossclaw-data') || '';
  check('800 条队列迁移成功', bulk.migrated === true && JSON.parse(fakeFile.text).pending.length === 800);
  check('迁移后 bossclaw-data 体积骤降', after.length < before.length / 2, `${before.length} → ${after.length}`);
  console.log(`    迁移 800 条耗时 ${cost}ms，bossclaw-data ${(before.length / 1024).toFixed(0)}KB → ${(after.length / 1024).toFixed(0)}KB`);
}
{
  // 失败路径：写文件失败 → 不剥离 localStorage、退回旧路径
  resetForMigration();
  localStorageMap.set('bossclaw-data', JSON.stringify({ state: { pending: [{ id: 'k1' }], qualifiedExports: {} }, version: 2 }));
  fakeFile.failNext = 1;
  const r = await migrateQueueFromLocalStorageIfNeeded();
  check('迁移失败时不报告 migrated', r.migrated === false);
  const legacy = JSON.parse(localStorageMap.get('bossclaw-data'));
  check('失败时 localStorage 队列保持原样', Array.isArray(legacy.state.pending) && legacy.state.pending[0].id === 'k1');
  check('失败时未写迁移标记', !localStorageMap.has('bossclaw-queue-migration-v1'));
  check('失败时退回 localStorage 模式', mod.isQueueFileMode() === false);
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败忽略 */
}

console.log('');
if (failures > 0) {
  console.error(`[queue-store 回归] 失败 ${failures} 项`);
  process.exit(1);
}
console.log('[queue-store 回归] 全部通过');
