// electron/queueStore.cjs —— 岗位队列的文件仓储（主进程）
//
// 为什么要把队列搬出 localStorage（issue #10 / docs/存储迁移方案.md）：
//   localStorage 同步、无事务、写失败无回执；配额写满后写入被静默丢弃，界面照常推进，
//   重启后整份状态回退到「最后一次写成功的快照」。队列（pending + qualifiedExports）
//   占了 bossclaw-data 90% 以上的体积，也是写入频率最高的一项 —— 把它挪到主进程文件后：
//     · 磁盘没有 50MB 同源额度，写失败能拿到明确错误（渲染侧照样红标）；
//     · tmp + rename 原子写，断电/被杀最多丢最后一次防抖窗口（800ms）；
//     · 文件可读、可备份、可手工检查；
//     · 留一份 queue-store.bak.json：主文件损坏时仍能读回上一份完好数据。
//
// 目录：<userData>/queue/queue-store.json（主）/ queue-store.bak.json（上一份完好）/ queue-migration-*.json（迁移兜底副本）
// 写入由渲染侧封送（src/lib/bossclaw/queueRepo.ts）串行发起，带单调递增 seq：
// 主进程拒绝 seq <= 已落盘值的迟到包，避免「写 A 慢、写 B 快」把旧值覆盖回去。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/** 数据结构版本（未来改结构时可据此再迁一次） */
const VERSION = 1;
/** 上限保护：正常队列约 25MB，超过这个数基本是异常数据（避免把磁盘写满） */
const MAX_BYTES = 100 * 1024 * 1024;

/** 已落盘的最大 seq（进程内缓存；load 时与文件对齐） */
let lastSeq = 0;

function baseDir() {
  return path.join(app.getPath('userData'), 'queue');
}
function storePath() {
  return path.join(baseDir(), 'queue-store.json');
}
function bakPath() {
  return path.join(baseDir(), 'queue-store.bak.json');
}

function ensureDir() {
  fs.mkdirSync(baseDir(), { recursive: true });
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

/**
 * 读取队列。
 * 主文件完好 → 直接用；主文件缺失/损坏 → 退到 .bak（recovered=true）；
 * 两份都损坏 → ok:false（渲染侧红标 + 引导从本地备份恢复），绝不返回半截数据。
 */
function load() {
  const main = readJsonFile(storePath());
  if (main.status === 'ok') {
    lastSeq = Math.max(lastSeq, seqOf(main.data));
    return { ok: true, data: main.data, source: 'main' };
  }
  if (main.status === 'corrupt') {
    const bak = readJsonFile(bakPath());
    if (bak.status === 'ok') {
      lastSeq = Math.max(lastSeq, seqOf(bak.data));
      return { ok: true, data: bak.data, source: 'bak', recovered: true };
    }
    return { ok: false, corrupt: true, error: '队列主文件损坏，且没有可用的 .bak 备份' };
  }
  // 主文件不存在：可能是首次使用，也可能是用户手工删了，仍尝试 .bak
  const bak = readJsonFile(bakPath());
  if (bak.status === 'ok') {
    lastSeq = Math.max(lastSeq, seqOf(bak.data));
    return { ok: true, data: bak.data, source: 'bak', recovered: true };
  }
  return { ok: true, data: null, source: 'none' };
}

/** 校验渲染侧交来的文本：必须是本模块定义的载荷结构 */
function parsePayload(text) {
  if (typeof text !== 'string' || !text) return { ok: false, error: '队列数据为空' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, error: '队列数据超过 100MB，疑似异常' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '队列数据不是合法 JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '队列数据结构非法' };
  if (Number(data.version) !== VERSION) return { ok: false, error: `队列数据版本不支持：${data.version}` };
  if (!Array.isArray(data.pending)) return { ok: false, error: '队列数据缺少 pending 数组' };
  if (!data.qualifiedExports || typeof data.qualifiedExports !== 'object' || Array.isArray(data.qualifiedExports)) {
    return { ok: false, error: '队列数据缺少 qualifiedExports 对象' };
  }
  return { ok: true, data };
}

function stampForFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 写入队列（异步原子写）。
 * @param {string} text 已序列化的载荷（渲染侧 stringify，避免大对象结构化克隆）
 * @param {number} seq 渲染侧单调递增序号
 * @param {{migrationSnapshot?: boolean}} opts migrationSnapshot=true 时额外留一份迁移兜底副本
 */
async function save(text, seq, opts) {
  const parsed = parsePayload(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const n = Math.max(0, Number(seq) || 0);
  if (n <= lastSeq) {
    // 迟到包：旧值不得覆盖新值。对渲染侧不算失败（它的新值早已落盘）
    return { ok: true, stale: true, seq: lastSeq };
  }
  try {
    ensureDir();
    const mainFile = storePath();
    // 轮转：写新值前把「当前完好主文件」拷成 .bak。主文件损坏时不拷贝（避免把坏文件升级成唯一备份）。
    const cur = readJsonFile(mainFile);
    if (cur.status === 'ok') {
      try { await fs.promises.copyFile(mainFile, bakPath()); } catch { /* .bak 失败不阻断主写入 */ }
    }
    await atomicWrite(mainFile, text);
    lastSeq = n;
    if (opts && opts.migrationSnapshot) {
      const snap = path.join(baseDir(), `queue-migration-${stampForFile()}.json`);
      try { await fs.promises.writeFile(snap, text, 'utf8'); } catch { /* 兜底副本失败不影响主流程 */ }
    }
    return { ok: true, seq: lastSeq, bytes: Buffer.byteLength(text, 'utf8'), at: Date.now() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 清空队列（主文件 + .bak；迁移兜底副本保留，供观察期内人工核对） */
async function clear() {
  lastSeq = 0;
  for (const f of [storePath(), bakPath()]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* 忽略单个文件删除失败 */ }
  }
  return { ok: true };
}

/** 文件占用（设置页用量面板） */
function usage() {
  let bytes = 0;
  let bakBytes = 0;
  try { bytes = fs.statSync(storePath()).size; } catch { bytes = 0; }
  try { bakBytes = fs.statSync(bakPath()).size; } catch { bakBytes = 0; }
  return { ok: true, bytes, bakBytes, totalBytes: bytes + bakBytes };
}

/** 退出前兜底：渲染侧已按防抖写入，这里只做状态观测（保留接口给后续主进程侧排队用） */
function flushPending() {
  return { ok: true, seq: lastSeq };
}

module.exports = {
  VERSION,
  load,
  save,
  clear,
  usage,
  flushPending,
  // 供测试/诊断
  _paths: { baseDir, storePath, bakPath },
};
