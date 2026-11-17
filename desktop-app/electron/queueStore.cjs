// electron/queueStore.cjs —— 本地数据文件仓储（主进程）
//
// 为什么要把队列搬出 localStorage（issue #10 / docs/存储迁移方案.md）：
//   localStorage 同步、无事务、写失败无回执；配额写满后写入被静默丢弃，界面照常推进，
//   重启后整份状态回退到「最后一次写成功的快照」。队列占了 bossclaw-data 90% 以上的体积，
//   也是写入频率最高的一项 —— 把它挪到主进程文件后：
//     · 磁盘没有 50MB 同源额度，写失败能拿到明确错误（渲染侧照样红标）；
//     · tmp + rename 原子写，断电/被杀最多丢最后一次防抖窗口（800ms）；
//     · 文件可读、可备份、可手工检查。
//
// P3（2026-11-17）起改为 **per-item 拆分**，写入成本从「整包 25MB stringify」降到「只写变化的条目」：
//   目录：<userData>/queue/
//     index.json                    轻量索引：{ version, seq, updatedAt, ids[], qualifiedExports }
//     index.bak.json                上一份完好索引
//     items/<sha1(id)>.json         单条岗位全量
//     items/<sha1(id)>.bak.json     单条上一份完好数据
//     resume.json                   简历正文 + 图片简历（resumeText / imageResumes，P3 迁出 localStorage）
//     resume.bak.json
//     snapshots/index-<ts>-<seq>.json  索引时间轮转（保留 24 份）
//     queue-store.json              旧版单文件（v1，只读；load 时自动迁移为 per-item 并改名保留）
//     queue-store.bak.json
//     queue-migration-*.json        迁移兜底副本（观察期内不删）
//   条目 id 可能含中文 / 斜杠 / 空格，不能直接做文件名 —— 用 sha1(id) 做稳定文件名，
//   index.ids 保留展示顺序，条目本体里的 id 仍是原值。
//
// 写入口径与旧版一致：渲染侧封送（src/lib/bossclaw/queueRepo.ts）串行发起、带单调递增 seq；
// 主进程拒绝 seq <= 已落盘值的迟到包。P3 新增 savePatch：只提交变化的条目 / 删除的 id，
// 不再每次传输整包；save（全量）保留给导入、备份恢复与旧版迁移。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

/** 数据结构版本：2 = per-item + index（1 = 旧版单文件，仅读取迁移） */
const VERSION = 2;
const LEGACY_VERSION = 1;
/** 单条上限：正常岗位 2~20KB，超过基本是异常数据 */
const MAX_ITEM_BYTES = 25 * 1024 * 1024;
/** 单次增量包上限：只含变化条目，正常远小于 100MB */
const MAX_PATCH_BYTES = 100 * 1024 * 1024;
const MAX_ITEMS = 100_000;
/** 索引时间轮转保留份数（P3） */
const SNAPSHOT_KEEP = 24;

/** 已落盘的最大 seq（进程内缓存；load 时与文件对齐） */
let lastSeq = 0;
/** 索引内存缓存（ids + qualifiedExports）；null = 尚未从磁盘读取 */
let indexCache = null;

/**
 * 主进程侧写串行链（审查 #2）：save/savePatch/clear 全部串行。
 * 「seq 单调守卫」与真正的 writeFile 之间会让出事件循环，两个 IPC 并发到达时
 * （典型：导入与自动保存重叠）若各自判定，较小 seq 后完成会把内容覆盖回旧值。
 */
let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const next = writeChain.then(task, task);
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

function baseDir() {
  return path.join(app.getPath('userData'), 'queue');
}
function indexPath() {
  return path.join(baseDir(), 'index.json');
}
function indexBakPath() {
  return path.join(baseDir(), 'index.bak.json');
}
function itemsDir() {
  return path.join(baseDir(), 'items');
}
function snapshotsDir() {
  return path.join(baseDir(), 'snapshots');
}
function resumePath() {
  return path.join(baseDir(), 'resume.json');
}
function resumeBakPath() {
  return path.join(baseDir(), 'resume.bak.json');
}
function legacyPath() {
  return path.join(baseDir(), 'queue-store.json');
}
function legacyBakPath() {
  return path.join(baseDir(), 'queue-store.bak.json');
}

/** 条目 id → 稳定、安全的文件名（id 可能含中文 / 斜杠 / 空格） */
function itemHash(id) {
  return crypto.createHash('sha1').update(String(id), 'utf8').digest('hex');
}
function itemPath(id) {
  return path.join(itemsDir(), `${itemHash(id)}.json`);
}
function itemBakPath(id) {
  return path.join(itemsDir(), `${itemHash(id)}.bak.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uniqueTmp(file) {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function atomicWrite(file, text) {
  const tmp = uniqueTmp(file);
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch { /* 清理失败忽略 */ }
    throw e;
  }
}

function atomicWriteSync(file, text) {
  const tmp = uniqueTmp(file);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw e;
  }
}

/**
 * 读一份 JSON 文件：区分「不存在 / 损坏 / 正常」，三者处置完全不同。
 * @returns {{ status: 'missing'|'corrupt'|'ok', data?: object }}
 */
function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  if (!raw || !raw.trim()) return { status: 'missing' };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'corrupt' };
    return { status: 'ok', data };
  } catch {
    return { status: 'corrupt' };
  }
}

function seqOf(data) {
  return Math.max(0, Number(data && data.seq) || 0);
}

function safeId(v) {
  const s = String(v ?? '');
  return s && s.length <= 512 ? s : '';
}

/** 读取索引：主文件 → index.bak；两者都坏返回 corrupt，缺失返回 missing */
function readIndexFromDisk() {
  const main = readJsonFile(indexPath());
  if (main.status === 'ok' && Array.isArray(main.data.ids)) {
    return { status: 'ok', data: main.data, source: 'main' };
  }
  if (main.status === 'corrupt') {
    const bak = readJsonFile(indexBakPath());
    if (bak.status === 'ok' && Array.isArray(bak.data.ids)) {
      return { status: 'ok', data: bak.data, source: 'bak', recovered: true };
    }
    return { status: 'corrupt' };
  }
  const bak = readJsonFile(indexBakPath());
  if (bak.status === 'ok' && Array.isArray(bak.data.ids)) {
    return { status: 'ok', data: bak.data, source: 'bak', recovered: true };
  }
  return { status: 'missing' };
}

/** 索引损坏时的重建：扫 items/ 重新生成（顺序退回按 createdAt 倒序） */
function rebuildIndexFromItems() {
  let files = [];
  try {
    files = fs.readdirSync(itemsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.bak.json'));
  } catch {
    return null;
  }
  const items = [];
  for (const f of files) {
    const r = readJsonFile(path.join(itemsDir(), f));
    if (r.status === 'ok' && r.data && safeId(r.data.id)) items.push(r.data);
  }
  if (!items.length) return null;
  items.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const data = {
    version: VERSION,
    seq: lastSeq,
    updatedAt: Date.now(),
    ids: items.map((p) => String(p.id)),
    qualifiedExports: {},
  };
  indexCache = data;
  return { status: 'ok', data, source: 'rebuilt', recovered: true };
}

function readResumeFromDisk() {
  const main = readJsonFile(resumePath());
  if (main.status === 'ok') return { data: main.data, recovered: false };
  const bak = readJsonFile(resumeBakPath());
  if (bak.status === 'ok') return { data: bak.data, recovered: true };
  return { data: null, recovered: false };
}

function isResumePayload(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && typeof v.resumeText === 'string'
    && (v.resumeFileName == null || typeof v.resumeFileName === 'string')
    && (v.imageResumes == null || Array.isArray(v.imageResumes));
}

/** 组装对外载荷：索引 + 各条目文件 + resume */
function assemble(index, source, recovered) {
  const ids = Array.isArray(index.ids) ? index.ids.map(safeId).filter(Boolean) : [];
  const pending = [];
  let corruptItems = 0;
  let missingItems = 0;
  let itemRecovered = false;
  for (const id of ids) {
    if (indexCache === null) indexCache = index;
    const main = readJsonFile(itemPath(id));
    if (main.status === 'ok' && main.data && safeId(main.data.id)) {
      pending.push(main.data);
      continue;
    }
    const bak = readJsonFile(itemBakPath(id));
    if (bak.status === 'ok' && bak.data && safeId(bak.data.id)) {
      pending.push(bak.data);
      itemRecovered = true;
      continue;
    }
    if (main.status === 'corrupt') corruptItems += 1;
    else missingItems += 1;
  }
  const resume = readResumeFromDisk();
  const data = {
    version: VERSION,
    seq: Math.max(seqOf(index), seqOf(resume.data)),
    updatedAt: Number(index.updatedAt) || Date.now(),
    pending,
    qualifiedExports: index.qualifiedExports && typeof index.qualifiedExports === 'object' ? index.qualifiedExports : {},
  };
  if (resume.data && isResumePayload(resume.data)) {
    data.resumeText = resume.data.resumeText;
    data.resumeFileName = typeof resume.data.resumeFileName === 'string' ? resume.data.resumeFileName : '';
    data.imageResumes = Array.isArray(resume.data.imageResumes) ? resume.data.imageResumes : [];
    data.resumeUpdatedAt = Number(resume.data.updatedAt) || 0;
  }
  return {
    ok: true,
    data,
    source,
    recovered: Boolean(recovered || itemRecovered || resume.recovered),
    corruptItems,
    missingItems,
  };
}

/** 把旧版单文件（v1）迁移为 per-item；同步执行，保证 load() 仍是同步接口 */
function migrateLegacy(legacy) {
  const pending = Array.isArray(legacy.pending) ? legacy.pending : [];
  const qualifiedExports = legacy.qualifiedExports && typeof legacy.qualifiedExports === 'object' ? legacy.qualifiedExports : {};
  ensureDir(itemsDir());
  const ids = [];
  for (const item of pending) {
    const id = safeId(item && item.id);
    if (!id) continue;
    const text = JSON.stringify(item);
    if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_BYTES) continue;
    atomicWriteSync(itemPath(id), text);
    ids.push(id);
  }
  const index = {
    version: VERSION,
    seq: Math.max(1, seqOf(legacy)),
    updatedAt: Date.now(),
    ids,
    qualifiedExports,
  };
  indexCache = index;
  ensureDir(baseDir());
  atomicWriteSync(indexPath(), JSON.stringify(index));
  lastSeq = Math.max(lastSeq, index.seq);
  // 旧文件改名保留（观察期内可人工核对），不直接删除
  const stamp = stampForFile();
  try { if (fs.existsSync(legacyPath())) fs.renameSync(legacyPath(), path.join(baseDir(), `queue-store.v1-${stamp}.json`)); } catch { /* 保留失败不阻断 */ }
  try { if (fs.existsSync(legacyBakPath())) fs.renameSync(legacyBakPath(), path.join(baseDir(), `queue-store.v1-${stamp}.bak.json`)); } catch { /* 同上 */ }
  return { ...assemble(index, 'legacy-migrated', false), migrated: true };
}

/**
 * 读取本地数据。
 * 索引主文件完好 → per-item 组装；索引损坏 → index.bak → items 重建；
 * 无索引但有 v1 单文件 → 自动迁移；全无 → data:null。
 */
function load() {
  const idx = readIndexFromDisk();
  if (idx.status === 'ok') {
    indexCache = idx.data;
    lastSeq = Math.max(lastSeq, seqOf(idx.data));
    return assemble(idx.data, idx.source, idx.recovered);
  }
  if (idx.status === 'corrupt') {
    const rebuilt = rebuildIndexFromItems();
    if (rebuilt) return assemble(rebuilt.data, rebuilt.source, true);
  }
  // 旧版单文件迁移
  const legacyMain = readJsonFile(legacyPath());
  if (legacyMain.status === 'ok' && Array.isArray(legacyMain.data.pending)) {
    return migrateLegacy(legacyMain.data);
  }
  const legacyBak = readJsonFile(legacyBakPath());
  if (legacyBak.status === 'ok' && Array.isArray(legacyBak.data.pending)) {
    return { ...migrateLegacy(legacyBak.data), recovered: true };
  }
  if (idx.status === 'corrupt' && legacyMain.status === 'corrupt' && legacyBak.status === 'corrupt') {
    return { ok: false, corrupt: true, error: '本地数据索引与迁移副本均损坏' };
  }
  // 没索引也不一定有数据：resume 文件可能单独存在
  const resume = readResumeFromDisk();
  if (resume.data && isResumePayload(resume.data)) {
    return {
      ok: true,
      data: {
        version: VERSION,
        seq: seqOf(resume.data),
        updatedAt: Number(resume.data.updatedAt) || Date.now(),
        pending: [],
        qualifiedExports: {},
        resumeText: resume.data.resumeText,
        resumeFileName: typeof resume.data.resumeFileName === 'string' ? resume.data.resumeFileName : '',
        imageResumes: Array.isArray(resume.data.imageResumes) ? resume.data.imageResumes : [],
        resumeUpdatedAt: Number(resume.data.updatedAt) || 0,
      },
      source: 'resume-only',
      recovered: Boolean(resume.recovered),
    };
  }
  return { ok: true, data: null, source: 'none' };
}

function stampForFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 索引时间轮转：写新索引前，把当前完好索引留一份快照，最多保留 SNAPSHOT_KEEP 份 */
function rotateIndexSnapshot() {
  const cur = readJsonFile(indexPath());
  if (cur.status !== 'ok') return;
  ensureDir(snapshotsDir());
  const name = `index-${stampForFile()}-${Date.now().toString(36)}.json`;
  try { fs.copyFileSync(indexPath(), path.join(snapshotsDir(), name)); } catch { /* 快照失败不阻断主流程 */ }
  try {
    const files = fs.readdirSync(snapshotsDir())
      .filter((f) => /^index-.*\.json$/.test(f))
      .sort();
    while (files.length > SNAPSHOT_KEEP) {
      const drop = files.shift();
      try { fs.unlinkSync(path.join(snapshotsDir(), drop)); } catch { /* 忽略 */ }
    }
  } catch { /* 轮转清理失败不阻断 */ }
}

/** 校验增量包结构 */
function parsePatch(text) {
  if (typeof text !== 'string' || !text) return { ok: false, error: '增量数据为空' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES) return { ok: false, error: '增量数据超过 100MB，疑似异常' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '增量数据不是合法 JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '增量数据结构非法' };
  if (Number(data.version) !== VERSION) return { ok: false, error: `增量数据版本不支持：${data.version}` };
  const upserts = data.upserts == null ? [] : data.upserts;
  const deletes = data.deletes == null ? [] : data.deletes;
  if (!Array.isArray(upserts)) return { ok: false, error: 'upserts 必须是数组' };
  if (!Array.isArray(deletes)) return { ok: false, error: 'deletes 必须是数组' };
  if (upserts.length + deletes.length > MAX_ITEMS) return { ok: false, error: '单次变更条目过多' };
  for (const item of upserts) {
    if (!item || typeof item !== 'object' || !safeId(item.id)) return { ok: false, error: '变更条目缺少合法 id' };
  }
  if (data.order != null && (!Array.isArray(data.order) || data.order.some((id) => !safeId(id)))) {
    return { ok: false, error: 'order 必须是由合法的岗位 id 组成的数组' };
  }
  if (data.qualifiedExports != null && (typeof data.qualifiedExports !== 'object' || Array.isArray(data.qualifiedExports))) {
    return { ok: false, error: 'qualifiedExports 必须是对象' };
  }
  if (data.resume != null && !isResumePayload(data.resume)) {
    return { ok: false, error: 'resume 结构非法' };
  }
  return { ok: true, patch: data };
}

/** 确保写盘前索引已在内存（必要时触发一次 load/迁移） */
function ensureIndexForWrite() {
  if (indexCache) return indexCache;
  const idx = readIndexFromDisk();
  if (idx.status === 'ok') {
    indexCache = idx.data;
    lastSeq = Math.max(lastSeq, seqOf(idx.data));
    return indexCache;
  }
  const legacyMain = readJsonFile(legacyPath());
  if (legacyMain.status === 'ok' && Array.isArray(legacyMain.data.pending)) {
    migrateLegacy(legacyMain.data);
    return indexCache;
  }
  indexCache = { version: VERSION, seq: lastSeq, updatedAt: 0, ids: [], qualifiedExports: {} };
  return indexCache;
}

async function writeItem(item) {
  const id = safeId(item.id);
  const text = JSON.stringify(item);
  if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_BYTES) throw new Error(`岗位 ${id} 数据超过 25MB，疑似异常`);
  ensureDir(itemsDir());
  // 写前把上一份完好条目拷成 .bak；坏文件不升级为唯一备份
  const cur = readJsonFile(itemPath(id));
  if (cur.status === 'ok') {
    try { await fs.promises.copyFile(itemPath(id), itemBakPath(id)); } catch { /* .bak 失败不阻断 */ }
  }
  await atomicWrite(itemPath(id), text);
}

async function writeResume(resume, seq) {
  const payload = {
    version: VERSION,
    seq,
    updatedAt: Date.now(),
    resumeText: String(resume.resumeText ?? ''),
    resumeFileName: String(resume.resumeFileName ?? ''),
    imageResumes: Array.isArray(resume.imageResumes) ? resume.imageResumes : [],
  };
  const text = JSON.stringify(payload);
  ensureDir(baseDir());
  const cur = readJsonFile(resumePath());
  if (cur.status === 'ok') {
    try { await fs.promises.copyFile(resumePath(), resumeBakPath()); } catch { /* .bak 失败不阻断 */ }
  }
  await atomicWrite(resumePath(), text);
  return Buffer.byteLength(text, 'utf8');
}

async function removeItemFile(id) {
  for (const f of [itemPath(id), itemBakPath(id)]) {
    try { if (fs.existsSync(f)) await fs.promises.unlink(f); } catch { /* 忽略单个删除失败 */ }
  }
}

/** 串行链内执行的实际增量写盘 */
async function savePatchNow(patch, n, opts) {
  if (n <= lastSeq) {
    return { ok: true, stale: true, seq: lastSeq };
  }
  try {
    ensureDir(baseDir());
    const index = ensureIndexForWrite();
    const prevIds = Array.isArray(index.ids) ? index.ids.slice() : [];
    const deletes = (patch.deletes || []).map(safeId).filter(Boolean);
    const deleteSet = new Set(deletes);
    let written = 0;
    let bytes = 0;

    for (const item of patch.upserts || []) {
      await writeItem(item);
      written += 1;
    }
    for (const id of deletes) {
      await removeItemFile(id);
    }

    // reset（导入/恢复）：清掉不在新集合里的条目文件。
    // ⚠️ 必须排除本次 upserts/order 里的 id —— 它们刚被重写，按「旧索引」全删会把新值删掉。
    if (patch.reset) {
      const keep = new Set();
      for (const id of (patch.order || []).map(safeId).filter(Boolean)) keep.add(id);
      for (const item of patch.upserts || []) keep.add(safeId(item.id));
      for (const id of prevIds) {
        if (!keep.has(id) && !deleteSet.has(id)) await removeItemFile(id);
      }
    }

    if (patch.resume != null) {
      bytes += await writeResume(patch.resume, n);
    }

    /** 新索引顺序：显式 order 优先；否则保留旧顺序 + 追加新条目 */
    let nextIds;
    if (Array.isArray(patch.order)) {
      nextIds = [];
      const seen = new Set();
      for (const id of patch.order) {
        const s = safeId(id);
        if (!s || seen.has(s)) continue;
        seen.add(s);
        nextIds.push(s);
      }
      // 防御：upserts 里的条目必须出现在 order 中（否则会写了文件却不在索引里）
      for (const item of patch.upserts || []) {
        const id = safeId(item.id);
        if (id && !seen.has(id)) { seen.add(id); nextIds.push(id); }
      }
    } else {
      nextIds = prevIds.filter((id) => !deleteSet.has(id));
      const seen = new Set(nextIds);
      for (const item of patch.upserts || []) {
        const id = safeId(item.id);
        if (id && !seen.has(id)) { seen.add(id); nextIds.push(id); }
      }
    }

    const nextIndex = {
      version: VERSION,
      seq: n,
      updatedAt: Date.now(),
      ids: nextIds,
      qualifiedExports: patch.qualifiedExports != null ? patch.qualifiedExports : (index.qualifiedExports || {}),
    };

    // 索引轮转：index.bak = 上一份；snapshots/ 保留最近 24 份
    const curIndex = readJsonFile(indexPath());
    if (curIndex.status === 'ok') {
      try { await fs.promises.copyFile(indexPath(), indexBakPath()); } catch { /* 不阻断 */ }
      rotateIndexSnapshot();
    }
    await atomicWrite(indexPath(), JSON.stringify(nextIndex));
    indexCache = nextIndex;
    lastSeq = n;

    if (opts && opts.migrationSnapshot && typeof opts.migrationText === 'string') {
      const snap = path.join(baseDir(), `queue-migration-${stampForFile()}.json`);
      try { await fs.promises.writeFile(snap, opts.migrationText, 'utf8'); } catch { /* 兜底副本失败不影响主流程 */ }
    }

    return { ok: true, seq: lastSeq, bytes, written, deleted: deletes.length, at: Date.now() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 增量写入（P3 主路径）。
 * @param {string} text 已序列化的增量包：{ version, seq, upserts[], deletes[], order?, qualifiedExports?, resume? }
 * @param {number} seq 渲染侧单调递增序号
 */
async function savePatch(text, seq) {
  const parsed = parsePatch(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const n = Math.max(0, Number(seq) || 0);
  return enqueueWrite(() => savePatchNow(parsed.patch, n));
}

/**
 * 全量写入（导入 / 恢复备份 / 旧版迁移）。载荷仍为旧格式：
 * { version: 1|2, seq, pending[], qualifiedExports, resumeText?, resumeFileName?, imageResumes? }
 */
async function save(text, seq, opts) {
  if (typeof text !== 'string' || !text) return { ok: false, error: '队列数据为空' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES) return { ok: false, error: '队列数据超过 100MB，疑似异常' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '队列数据不是合法 JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '队列数据结构非法' };
  const version = Number(data.version);
  if (version !== LEGACY_VERSION && version !== VERSION) return { ok: false, error: `队列数据版本不支持：${data.version}` };
  if (!Array.isArray(data.pending)) return { ok: false, error: '队列数据缺少 pending 数组' };
  if (data.pending.length > MAX_ITEMS) return { ok: false, error: '队列条目过多' };
  if (!data.qualifiedExports || typeof data.qualifiedExports !== 'object' || Array.isArray(data.qualifiedExports)) {
    return { ok: false, error: '队列数据缺少 qualifiedExports 对象' };
  }
  const upserts = [];
  for (const item of data.pending) {
    if (!item || typeof item !== 'object' || !safeId(item.id)) return { ok: false, error: '队列条目缺少合法 id' };
    upserts.push(item);
  }
  const hasResume = isResumePayload(data);
  const patch = {
    version: VERSION,
    seq: Math.max(0, Number(seq) || 0),
    upserts,
    deletes: [],
    order: upserts.map((p) => String(p.id)),
    qualifiedExports: data.qualifiedExports,
    reset: true,
  };
  if (hasResume) {
    patch.resume = {
      resumeText: data.resumeText,
      resumeFileName: data.resumeFileName,
      imageResumes: data.imageResumes,
    };
  }
  const n = patch.seq;
  return enqueueWrite(() => savePatchNow(patch, n, {
    migrationSnapshot: Boolean(opts && opts.migrationSnapshot),
    migrationText: text,
  }));
}

/** 清空本地数据（队列 / 索引 / 快照 / resume；迁移兜底副本保留供观察期人工核对） */
async function clear() {
  return enqueueWrite(async () => {
    lastSeq = 0;
    indexCache = null;
    try { fs.rmSync(itemsDir(), { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(snapshotsDir(), { recursive: true, force: true }); } catch { /* 忽略 */ }
    for (const f of [indexPath(), indexBakPath(), resumePath(), resumeBakPath()]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* 忽略单个文件删除失败 */ }
    }
    return { ok: true };
  });
}

function sumFiles(dir) {
  let bytes = 0;
  let count = 0;
  let bakBytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { size = 0; }
      if (/\.bak\.json$/.test(f)) bakBytes += size;
      else if (/\.json$/.test(f)) { bytes += size; count += 1; }
      else bytes += size;
    }
  } catch { /* 目录不存在 */ }
  return { bytes, bakBytes, count };
}

/** 文件占用（设置页用量面板） */
function usage() {
  const idx = (() => { try { return fs.statSync(indexPath()).size; } catch { return 0; } })();
  const idxBak = (() => { try { return fs.statSync(indexBakPath()).size; } catch { return 0; } })();
  const items = sumFiles(itemsDir());
  const snaps = sumFiles(snapshotsDir());
  const resume = (() => { try { return fs.statSync(resumePath()).size; } catch { return 0; } })();
  const resumeBak = (() => { try { return fs.statSync(resumeBakPath()).size; } catch { return 0; } })();
  const legacy = (() => { try { return fs.statSync(legacyPath()).size; } catch { return 0; } })();
  const legacyBak = (() => { try { return fs.statSync(legacyBakPath()).size; } catch { return 0; } })();
  const queueBytes = idx + items.bytes + legacy;
  const queueBakBytes = idxBak + items.bakBytes + legacyBak;
  const resumeBytes = resume;
  const resumeBakBytes = resumeBak;
  return {
    ok: true,
    items: items.count,
    bytes: queueBytes + resumeBytes,
    bakBytes: queueBakBytes + resumeBakBytes,
    totalBytes: queueBytes + queueBakBytes + resumeBytes + resumeBakBytes + snaps.bytes,
    queueBytes,
    queueBakBytes,
    resumeBytes,
    resumeBakBytes,
    snapshotBytes: snaps.bytes,
    snapshotCount: snaps.count,
  };
}

/** 退出前兜底：渲染侧已按防抖写入，这里只做状态观测（保留接口给后续主进程侧排队用） */
function flushPending() {
  return { ok: true, seq: lastSeq };
}

module.exports = {
  VERSION,
  SNAPSHOT_KEEP,
  load,
  save,
  savePatch,
  clear,
  usage,
  flushPending,
  // 供测试/诊断
  _paths: { baseDir, indexPath, indexBakPath, itemsDir, snapshotsDir, resumePath, resumeBakPath, itemPath, itemBakPath, legacyPath, legacyBakPath },
};
