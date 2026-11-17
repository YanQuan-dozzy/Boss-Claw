// 岗位/简历文件仓储回归（issue #10 / docs/存储迁移方案.md §6、P3）
// ---------------------------------------------------------
// 覆盖三层：
//   1. 主进程 electron/queueStore.cjs：per-item 条目文件 + index 索引 + 24 份索引轮转、
//      seq 迟到包拒绝、条目 .bak 回退、v1 单文件自动迁移、resume 文件、清空、用量；
//   2. 渲染侧 queueRepo：800ms 防抖合批、单飞串行、增量 patch、失败上报 persist 健康、导入/清空；
//   3. 一次性迁移 queueMigrate：队列 + 简历「先写文件验真再剥离 localStorage」；写失败保持原样。
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

const fullPayload = (seq, pending = [], qualifiedExports = {}, resume = null) =>
  JSON.stringify({
    version: 2,
    seq,
    updatedAt: Date.now(),
    pending,
    qualifiedExports,
    ...(resume ? {
      resumeText: resume.resumeText ?? '',
      resumeFileName: resume.resumeFileName ?? '',
      imageResumes: resume.imageResumes ?? [],
    } : {}),
  });
const patchPayload = (seq, upserts = [], deletes = [], extra = {}) =>
  JSON.stringify({ version: 2, seq, updatedAt: Date.now(), upserts, deletes, ...extra });

console.log('[1] queueStore.cjs（per-item + index + 轮转 + resume）');
{
  const r1 = await queueStore.save(fullPayload(1, [{ id: 'a', v: 1 }]), 1);
  check('首次全量写入成功', r1.ok === true, JSON.stringify(r1));
  const loaded = queueStore.load();
  check('读回 seq 与 pending 一致', loaded.ok && loaded.data.seq === 1 && loaded.data.pending.length === 1);
  check('per-item：条目文件已落盘', fs.existsSync(queueStore._paths.itemPath('a')));
  check('per-item：索引文件已落盘', fs.existsSync(queueStore._paths.indexPath()));
  check('索引不含全量条目（只存 ids）', !fs.readFileSync(queueStore._paths.indexPath(), 'utf8').includes('"v":1'));

  const stale = await queueStore.savePatch(patchPayload(1, [{ id: 'old' }]), 1);
  check('seq 迟到包被拒绝（stale）', stale.ok === true && stale.stale === true);
  const afterStale = queueStore.load();
  check('迟到包未覆盖数据', afterStale.data.pending[0].id === 'a');

  const added = await queueStore.savePatch(patchPayload(2, [{ id: 'b', v: 2 }], [], { order: ['b', 'a'] }), 2);
  check('增量新增条目成功', added.ok === true, JSON.stringify(added));
  const afterAdd = queueStore.load();
  check('增量后顺序按 order 生效', afterAdd.data.pending.map((p) => p.id).join(',') === 'b,a');

  await queueStore.savePatch(patchPayload(3, [{ id: 'a', v: 9 }]), 3);
  const afterUpdate = queueStore.load();
  check('只更新变化的条目', afterUpdate.data.pending.find((p) => p.id === 'a').v === 9 && afterUpdate.data.pending.find((p) => p.id === 'b').v === 2);
  check('条目 .bak 保留上一份完好数据', JSON.parse(fs.readFileSync(queueStore._paths.itemBakPath('a'), 'utf8')).v === 1);

  await queueStore.savePatch(patchPayload(4, [], ['b']), 4);
  const afterDelete = queueStore.load();
  check('删除条目后索引与文件同步', afterDelete.data.pending.length === 1 && !fs.existsSync(queueStore._paths.itemPath('b')));

  // 条目文件损坏 → 从 .bak 回退
  fs.writeFileSync(queueStore._paths.itemPath('a'), '{ broken', 'utf8');
  const recItem = queueStore.load();
  check('条目损坏时从 .bak 回退', recItem.ok && recItem.recovered === true && recItem.data.pending[0].v === 1);

  // 索引损坏 → index.bak
  fs.writeFileSync(queueStore._paths.indexPath(), '{ broken', 'utf8');
  const recIndex = queueStore.load();
  check('索引损坏时从 index.bak 回退', recIndex.ok && recIndex.recovered === true && recIndex.data.pending.length === 1);

  // resume（P3）
  await queueStore.save(fullPayload(5, [{ id: 'a', v: 1 }], {}, { resumeText: '我的简历', resumeFileName: 'cv.pdf', imageResumes: [{ id: 'img1' }] }), 5);
  const withResume = queueStore.load();
  check('resume 随全量写入并可读回', withResume.data.resumeText === '我的简历' && withResume.data.imageResumes.length === 1);
  await queueStore.savePatch(patchPayload(6, [], [], { resume: { resumeText: '新简历', resumeFileName: 'cv2.pdf', imageResumes: [] } }), 6);
  const resume2 = queueStore.load();
  check('resume 可单独增量更新', resume2.data.resumeText === '新简历' && resume2.data.resumeFileName === 'cv2.pdf');
  check('resume .bak 保留上一份', JSON.parse(fs.readFileSync(queueStore._paths.resumeBakPath(), 'utf8')).resumeText === '我的简历');

  // 索引轮转：连续写 30 次，快照最多保留 24 份
  for (let i = 0; i < 30; i += 1) {
    await queueStore.savePatch(patchPayload(100 + i), 100 + i);
  }
  const snaps = fs.readdirSync(queueStore._paths.snapshotsDir()).filter((f) => /^index-.*\.json$/.test(f));
  check('索引时间轮转保留 24 份', snaps.length === queueStore.SNAPSHOT_KEEP, `实际 ${snaps.length}`);

  const bad = await queueStore.savePatch(JSON.stringify({ version: 2, seq: 200, upserts: [{ id: '' }] }), 200);
  check('非法增量载荷被拒绝', bad.ok === false);
  const overVersion = await queueStore.save(JSON.stringify({ version: 9, pending: [], qualifiedExports: {} }), 201);
  check('未知版本全量包被拒绝', overVersion.ok === false);

  const usage = queueStore.usage();
  check('用量统计包含队列与简历明细', usage.ok && usage.queueBytes > 0 && usage.resumeBytes > 0 && usage.items >= 1, JSON.stringify(usage));

  // 清空：条目 / 索引 / 快照 / resume 全删；迁移兜底副本保留
  await queueStore.clear();
  const cleared = queueStore.load();
  check('清空后读回为空', cleared.ok && cleared.data === null);
  check('清空后条目与索引目录已删除', !fs.existsSync(queueStore._paths.itemsDir()));

  // v1 单文件自动迁移
  fs.mkdirSync(queueStore._paths.baseDir(), { recursive: true });
  fs.writeFileSync(
    queueStore._paths.legacyPath(),
    JSON.stringify({ version: 1, seq: 7, updatedAt: Date.now(), pending: [{ id: 'l1' }, { id: 'l2' }], qualifiedExports: {} }),
    'utf8'
  );
  const migrated = queueStore.load();
  check('v1 单文件自动迁移为 per-item', migrated.ok && migrated.migrated === true && migrated.data.pending.length === 2);
  check('迁移后旧文件改名保留', !fs.existsSync(queueStore._paths.legacyPath())
    && fs.readdirSync(queueStore._paths.baseDir()).some((f) => /^queue-store\.v1-.*\.json$/.test(f)));

  // 并发串行化：清空与在途写并发，最终必须为空
  const inFlight = queueStore.save(fullPayload(300, [{ id: 'late' }]), 300);
  const clearedAgain = queueStore.clear();
  await Promise.all([inFlight, clearedAgain]);
  const afterRace = queueStore.load();
  check('清空与在途写并发：最终状态为空', afterRace.ok && afterRace.data === null);
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

/** 内存版本地数据文件 + 可注入延迟/失败，模拟主进程 IPC */
function makeFakeFile() {
  return {
    seq: 0,
    pending: [],
    qualifiedExports: {},
    resumeText: '',
    resumeFileName: '',
    imageResumes: [],
    saves: [],
    patches: [],
    delay: 0,
    failNext: 0,
  };
}
const fakeFile = makeFakeFile();
function fakeSnapshot() {
  const hasAny = fakeFile.seq > 0;
  return hasAny
    ? {
        version: 2,
        seq: fakeFile.seq,
        updatedAt: Date.now(),
        pending: fakeFile.pending,
        qualifiedExports: fakeFile.qualifiedExports,
        resumeText: fakeFile.resumeText,
        resumeFileName: fakeFile.resumeFileName,
        imageResumes: fakeFile.imageResumes,
      }
    : null;
}
const fakeElectron = {
  queueStoreMode: 'file',
  queueLoad: async () => {
    if (fakeFile.delay) await sleep(fakeFile.delay);
    return { ok: true, data: fakeSnapshot(), source: 'main' };
  },
  queueSave: async (text, seq) => {
    fakeFile.saves.push({ seq, text, at: Date.now() });
    if (fakeFile.delay) await sleep(fakeFile.delay);
    if (fakeFile.failNext > 0) {
      fakeFile.failNext -= 1;
      return { ok: false, error: '模拟磁盘写入失败' };
    }
    if (seq <= fakeFile.seq) return { ok: true, stale: true };
    const data = JSON.parse(text);
    fakeFile.seq = seq;
    fakeFile.pending = Array.isArray(data.pending) ? data.pending : [];
    fakeFile.qualifiedExports = data.qualifiedExports && typeof data.qualifiedExports === 'object' ? data.qualifiedExports : {};
    fakeFile.resumeText = typeof data.resumeText === 'string' ? data.resumeText : '';
    fakeFile.resumeFileName = typeof data.resumeFileName === 'string' ? data.resumeFileName : '';
    fakeFile.imageResumes = Array.isArray(data.imageResumes) ? data.imageResumes : [];
    return { ok: true, seq };
  },
  queueSavePatch: async (text, seq) => {
    fakeFile.patches.push({ seq, text, at: Date.now() });
    if (fakeFile.delay) await sleep(fakeFile.delay);
    if (fakeFile.failNext > 0) {
      fakeFile.failNext -= 1;
      return { ok: false, error: '模拟磁盘写入失败' };
    }
    if (seq <= fakeFile.seq) return { ok: true, stale: true };
    const p = JSON.parse(text);
    const byId = new Map(fakeFile.pending.map((x) => [String(x.id), x]));
    for (const item of p.upserts || []) byId.set(String(item.id), item);
    for (const id of p.deletes || []) byId.delete(String(id));
    let order;
    if (Array.isArray(p.order)) {
      order = p.order.map(String).filter((id) => byId.has(id));
      for (const id of byId.keys()) if (!order.includes(id)) order.push(id);
    } else {
      order = fakeFile.pending.map((x) => String(x.id)).filter((id) => byId.has(id));
      for (const id of byId.keys()) if (!order.includes(id)) order.push(id);
    }
    fakeFile.seq = seq;
    fakeFile.pending = order.map((id) => byId.get(id));
    if (p.qualifiedExports !== undefined) fakeFile.qualifiedExports = p.qualifiedExports;
    if (p.resume) {
      fakeFile.resumeText = p.resume.resumeText ?? '';
      fakeFile.resumeFileName = p.resume.resumeFileName ?? '';
      fakeFile.imageResumes = p.resume.imageResumes ?? [];
    }
    return { ok: true, seq };
  },
  queueClear: async () => {
    Object.assign(fakeFile, makeFakeFile());
    return { ok: true };
  },
  queueUsage: async () => {
    const bytes = fakeFile.pending.length * 100 + fakeFile.resumeText.length;
    return { ok: true, bytes, totalBytes: bytes, queueBytes: fakeFile.pending.length * 100, resumeBytes: fakeFile.resumeText.length, items: fakeFile.pending.length };
  },
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
  migrateResumeFromLocalStorageIfNeeded,
  useDataStore,
  listPersistFailures,
  setQueueFileMode,
} = mod;

console.log('[2] queueRepo.ts（渲染侧增量封送）');
{
  // 起始：文件有 1 条 + 简历，水合后 store 应与之对齐
  Object.assign(fakeFile, makeFakeFile(), {
    seq: 3,
    pending: [{ id: 'q1', status: 'pending' }],
    resumeText: '旧简历',
  });
  const h = await hydrateQueue();
  check('水合读回文件队列与简历', h.ok && h.pending.length === 1 && h.pending[0].id === 'q1' && h.resumeText === '旧简历');
  useDataStore.getState().hydrateFromFile(h.pending, h.qualifiedExports, {
    resumeText: h.resumeText,
    resumeFileName: h.resumeFileName,
    imageResumes: h.imageResumes,
  });
  startQueueAutoSave();

  // 防抖：短窗口内连续 5 次 set 只落 1 个增量包
  const before = fakeFile.patches.length;
  for (let i = 0; i < 5; i += 1) {
    useDataStore.getState().addPendingItem({ id: `d${i}`, status: 'pending' });
  }
  await sleep(1200);
  check('800ms 防抖内多次变更合并为一次写盘', fakeFile.patches.length - before === 1, `实际 ${fakeFile.patches.length - before} 次`);
  const firstPatch = JSON.parse(fakeFile.patches[before].text);
  check('增量包只含变化的条目（不是整包）', firstPatch.upserts.length === 5 && !('pending' in firstPatch));

  // 未变化时 flush 零写入（引用比较，不做深比较）
  const beforeNoop = fakeFile.patches.length;
  await flushQueueNow();
  check('无变化时 flush 不产生写入', fakeFile.patches.length === beforeNoop);

  // 单飞：写盘在途期间的新变更，等上一笔完成后用最新状态补写一次（不丢最新）
  fakeFile.delay = 250;
  const beforeSingle = fakeFile.patches.length;
  useDataStore.getState().addPendingItem({ id: 's1', status: 'pending' });
  await sleep(900); // 第一笔在途
  useDataStore.getState().addPendingItem({ id: 's2', status: 'pending' });
  await sleep(1600);
  fakeFile.delay = 0;
  check('单飞补写后文件包含最新条目', fakeFile.pending.some((p) => p.id === 's2'));
  check('写序号单调递增', fakeFile.patches.slice(beforeSingle).every((s, i, arr) => i === 0 || s.seq > arr[i - 1].seq));

  // 简历变更只提交 resume，不重传队列
  const beforeResume = fakeFile.patches.length;
  useDataStore.getState().setResumeText('新的简历正文', 'cv.pdf');
  await flushQueueNow();
  const resumePatch = JSON.parse(fakeFile.patches[beforeResume].text);
  check('简历变更走独立字段', resumePatch.resume.resumeText === '新的简历正文' && resumePatch.upserts.length === 0);
  check('简历已写入文件', fakeFile.resumeText === '新的简历正文');

  // 失败上报：写入失败 → persist 失败列表出现队列键；恢复后自动清除
  fakeFile.failNext = 1;
  useDataStore.getState().addPendingItem({ id: 'f1', status: 'pending' });
  await flushQueueNow();
  check('写入失败进入 persist 健康列表', listPersistFailures().some((f) => f.name === QUEUE_STORE_KEY));
  await flushQueueNow();
  check('后续写入成功后清除失败标记', !listPersistFailures().some((f) => f.name === QUEUE_STORE_KEY));

  // 导入：外部 JSON → 文件（全量替换）
  const imp = await importQueueData(JSON.stringify({
    version: 2, seq: 1, updatedAt: Date.now(), pending: [{ id: 'imp' }], qualifiedExports: {}, resumeText: '导入简历',
  }));
  check('导入队列写入文件成功', imp.ok === true);
  check('导入后队列与简历已更新', fakeFile.pending.length === 1 && fakeFile.pending[0].id === 'imp' && fakeFile.resumeText === '导入简历');

  const snapText = JSON.parse(getQueueSnapshotText());
  check(
    '同步快照结构合法且包含队列与简历字段',
    snapText.version === 2 && Array.isArray(snapText.pending) && typeof snapText.qualifiedExports === 'object'
    && typeof snapText.resumeText === 'string' && Array.isArray(snapText.imageResumes)
  );

  await clearQueueStore();
  check('清空后文件为空', fakeFile.seq === 0 && fakeFile.pending.length === 0 && fakeFile.resumeText === '');
}

console.log('[3] queueMigrate.ts（队列 + 简历一次性迁移）');
function resetForMigration() {
  localStorageMap.clear();
  Object.assign(fakeFile, makeFakeFile());
  setQueueFileMode(true);
}
{
  // 成功路径：localStorage 有队列 + 简历 → 写文件 → 读回校验 → 剥离
  resetForMigration();
  localStorageMap.set(
    'bossclaw-data',
    JSON.stringify({
      state: {
        pending: [{ id: 'm1' }, { id: 'm2' }],
        qualifiedExports: { '2026-10-27': [{ id: 'x' }] },
        resumeText: '迁移简历',
        resumeFileName: 'cv.pdf',
        imageResumes: [{ id: 'img1' }],
        profile: 'keep',
      },
      version: 2,
    })
  );
  const r = await migrateQueueFromLocalStorageIfNeeded();
  check('队列迁移执行成功', r.migrated === true, JSON.stringify(r));
  check('队列已写入文件', fakeFile.pending.length === 2);
  check('简历同批写入文件', fakeFile.resumeText === '迁移简历' && fakeFile.imageResumes.length === 1);
  const legacy = JSON.parse(localStorageMap.get('bossclaw-data'));
  check('localStorage 已剥离队列与简历字段',
    !('pending' in legacy.state) && !('qualifiedExports' in legacy.state)
    && !('resumeText' in legacy.state) && !('imageResumes' in legacy.state));
  check('localStorage 其余字段保留', legacy.state.profile === 'keep');
  check('队列/简历迁移标记已写入', localStorageMap.has('bossclaw-queue-migration-v1') && localStorageMap.has('bossclaw-resume-migration-v1'));

  const again = await migrateQueueFromLocalStorageIfNeeded();
  check('重复调用被跳过', again.migrated === false && again.skipped === true);
}
{
  // 老用户：队列已迁（v1 标记），简历仍在 localStorage → 单独迁移
  resetForMigration();
  fakeFile.seq = 5;
  fakeFile.pending = [{ id: 'old-q1' }];
  localStorageMap.set('bossclaw-queue-migration-v1', String(Date.now()));
  localStorageMap.set('bossclaw-data', JSON.stringify({
    state: { resumeText: '遗留简历', imageResumes: [{ id: 'old-img' }], profile: 'keep' },
    version: 2,
  }));
  const r = await migrateResumeFromLocalStorageIfNeeded();
  check('老用户简历单独迁移成功', r.migrated === true, JSON.stringify(r));
  check('队列保持不变、简历写入文件', fakeFile.pending.length === 1 && fakeFile.resumeText === '遗留简历');
  check('迁移后简历字段已剥离', !('resumeText' in JSON.parse(localStorageMap.get('bossclaw-data')).state));
  check('简历迁移标记已写入', localStorageMap.has('bossclaw-resume-migration-v1'));
}
{
  // 真实体量：800 条队列 → 迁移后 localStorage 体积应骤降
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
  check('800 条队列迁移成功', bulk.migrated === true && fakeFile.pending.length === 800);
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
