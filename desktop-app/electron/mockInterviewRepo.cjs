// electron/mockInterviewRepo.cjs —— 模拟面试会话的文件仓储
//
// 为什么不用 localStorage / IndexedDB / 现有备份体系（方案 §7.1）：
//   1. localBackup 的脏检查快路径依赖 zustand persist 写 localStorage 的哨兵，文件数据没有哨兵；
//   2. 整包是单个 JSON，任何一场变化都要重写整包，会话越多写盘越贵；
//   3. 回签语义是「写回 localStorage → reload」，且主进程删不掉渲染进程的 IDB。
// 所以面试记录按「用户产出内容」管理：每次变更即写文件，文件本身就是唯一事实来源。
//
// 目录：
//   <userData>/mock-interview/index.json          会话轻量索引（派生缓存，可重建）
//   <userData>/mock-interview/sessions/<id>.json  单场全量
//
// 写盘策略（评审 P2-1）：
//   · 按 sessionId 串行 + 200ms 合并窗口，避免连点「下一题」与自动保存互相覆盖；
//   · 关键字段（status / finishedAt / report）变更时立即写；
//   · 落盘接口带 seq，拒绝比已落盘更小的写入；
//   · tmp + rename 原子写（与备份写盘同一心智），中途失败不会损坏上一份完好会话。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 200;
const INDEX_DEBOUNCE_MS = 300;

function baseDir() {
  return path.join(app.getPath('userData'), 'mock-interview');
}
function sessionsDir() {
  return path.join(baseDir(), 'sessions');
}
function indexPath() {
  return path.join(baseDir(), 'index.json');
}

function ensureDirs() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

function assertId(id, label) {
  const s = String(id || '');
  if (!ID_RE.test(s)) throw new Error(`${label || 'id'} 非法：只允许 8–64 位字母、数字、下划线与连字符`);
  return s;
}

function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function uniqueTmp(file) {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function sessionFile(id) {
  return path.join(sessionsDir(), `${assertId(id, 'sessionId')}.json`);
}

/** 索引条目：只存列表页需要的字段，避免列表页读全量会话 */
function indexEntryOf(s) {
  const questions = Array.isArray(s.questions) ? s.questions : [];
  const attempts = Array.isArray(s.attempts) ? s.attempts : [];
  // startedAt：优先用户真正开始作答的时间，其次创建时间
  const startedAt = Number(s.startedAt || s.createdAt || 0);
  const finishedAt = Number(s.finishedAt || 0);
  const report = s.report || null;
  return {
    id: s.id,
    jobId: s.job && s.job.jobId ? String(s.job.jobId) : null,
    jobTitle: String((s.job && s.job.jobTitle) || '未命名岗位'),
    company: String((s.job && s.job.company) || ''),
    role: (s.config && s.config.role) || 'general',
    difficulty: (s.config && s.config.difficulty) || 'standard',
    startedAt,
    finishedAt,
    status: s.status || 'draft',
    score: report && Number.isFinite(Number(report.total)) ? Number(report.total) : null,
    band: report && report.band && report.band.key ? String(report.band.key) : null,
    rubricVersion: report && Number(report.rubricVersion) ? Number(report.rubricVersion) : 0,
    phase1Count: questions.filter((q) => q.phase === 1 && q.kind !== 'injected').length,
    phase2Count: questions.filter((q) => q.phase === 2 && q.kind !== 'injected').length,
    injectedCount: questions.filter((q) => q.kind === 'injected').length,
    reverseAsked: Boolean(s.reverse && s.reverse.question),
    updatedAt: Number(s.updatedAt || Date.now()),
    // 排序用：未完成的场次排在前面（按更新时间倒序），已完成按结束时间倒序
    _attemptCount: attempts.length,
  };
}

// ===== 索引（内存缓存 + 派生重建）=====
let indexCache = null;

function listSessionFiles() {
  try {
    return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/** 扫 sessions/ 重建索引（幂等；index.json 损坏或缺失时自动走这里） */
function rebuildIndex() {
  const out = [];
  for (const f of listSessionFiles()) {
    const s = readJsonFile(path.join(sessionsDir(), f), null);
    if (s && s.id) out.push(indexEntryOf(s));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  indexCache = out;
  flushIndexNow();
  return out;
}

function readIndex() {
  if (indexCache) return indexCache;
  const parsed = readJsonFile(indexPath(), null);
  if (Array.isArray(parsed)) {
    indexCache = parsed;
    return indexCache;
  }
  return rebuildIndex();
}

let indexTimer = null;
function scheduleIndexFlush() {
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    flushIndexNow();
  }, INDEX_DEBOUNCE_MS);
}

function flushIndexNow() {
  if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
  if (!indexCache) return;
  try {
    ensureDirs();
    atomicWriteSync(indexPath(), JSON.stringify(indexCache));
  } catch {
    // 索引只是缓存：写失败不影响会话文件本身，下次读会重建
  }
}

function upsertIndex(entry) {
  const list = readIndex();
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  scheduleIndexFlush();
}

function removeFromIndex(id) {
  if (!indexCache) return;
  indexCache = indexCache.filter((e) => e.id !== id);
  scheduleIndexFlush();
}

// ===== 写盘队列 =====
// 每个 session 一个槽：最新一次写入覆盖尚未落盘的旧值（合并窗口），
// 立即写（关键字段）会打断合并窗口并马上落盘。
const writeSlots = new Map(); // id -> { latest, timer, flushing, waiters: [] }
const lastWrittenSeq = new Map(); // id -> seq

function keyFieldsChanged(prev, next) {
  if (!prev) return true;
  return prev.status !== next.status
    || Boolean(prev.finishedAt) !== Boolean(next.finishedAt)
    || Boolean(prev.report) !== Boolean(next.report)
    || Boolean(prev.reverse) !== Boolean(next.reverse);
}

function performWrite(session) {
  const id = assertId(session.id, 'sessionId');
  const text = JSON.stringify(session);
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_BYTES) {
    throw new Error('会话数据超过 20MB，疑似异常（请联系开发者）');
  }
  ensureDirs();
  atomicWriteSync(sessionFile(id), text);
  lastWrittenSeq.set(id, Number(session.seq) || 0);
  upsertIndex(indexEntryOf(session));
  return { ok: true };
}

/**
 * 入队写入。
 * @param {object} session 会话全量
 * @param {{immediate?: boolean}} opts immediate=true 立即写（状态变更/报告落盘）
 */
function enqueueWrite(session, opts) {
  const id = assertId(session && session.id, 'sessionId');
  const seq = Number(session.seq) || 0;
  const written = lastWrittenSeq.get(id);
  // 拒绝「比已落盘更旧」的写入（并发保存的迟到包）
  if (written != null && seq > 0 && seq < written) {
    return Promise.resolve({ ok: true, stale: true });
  }

  let slot = writeSlots.get(id);
  if (!slot) {
    slot = { latest: null, timer: null, flushing: false, waiters: [] };
    writeSlots.set(id, slot);
  }
  const prev = slot.latest;
  slot.latest = session;
  const immediate = Boolean(opts && opts.immediate) || keyFieldsChanged(prev, session);

  return new Promise((resolve) => {
    slot.waiters.push(resolve);
    if (immediate) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      void flushSlot(id, slot);
      return;
    }
    if (slot.timer) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void flushSlot(id, slot);
    }, WRITE_DEBOUNCE_MS);
  });
}

async function flushSlot(id, slot) {
  if (slot.flushing) return; // 由正在执行的那次循环继续取最新值
  slot.flushing = true;
  try {
    while (slot.latest) {
      const payload = slot.latest;
      slot.latest = null;
      let result = { ok: true };
      try {
        result = performWrite(payload);
      } catch (e) {
        result = { ok: false, error: String((e && e.message) || e) };
      }
      // 一次 flush 只结算当前批次的等待者；循环继续处理期间新入队的值
      const waiters = slot.waiters.splice(0);
      waiters.forEach((w) => w(result));
    }
  } finally {
    slot.flushing = false;
    if (!slot.latest) writeSlots.delete(id);
  }
}

// ===== 对外能力 =====
function list() {
  const items = readIndex().map((e) => {
    const { _attemptCount, ...rest } = e;
    return rest;
  });
  return { ok: true, sessions: items };
}

function read(id) {
  const file = sessionFile(id);
  const s = readJsonFile(file, null);
  if (!s || !s.id) return { ok: false, error: '会话不存在' };
  return { ok: true, session: s };
}

async function write(session, opts) {
  if (!session || typeof session !== 'object') return { ok: false, error: '无效的会话数据' };
  if (!ID_RE.test(String(session.id || ''))) return { ok: false, error: '会话 id 非法' };
  // 只接受受控字段：多余字段一律丢弃，避免渲染层把任意大对象写进文件
  const cleaned = {
    id: session.id,
    version: 1,
    job: session.job || {},
    config: session.config || {},
    status: session.status,
    phase: session.phase,
    questions: Array.isArray(session.questions) ? session.questions : [],
    attempts: Array.isArray(session.attempts) ? session.attempts : [],
    currentQuestionId: session.currentQuestionId ?? null,
    pendingProbe: session.pendingProbe ?? null,
    reverse: session.reverse ?? null,
    report: session.report ?? null,
    retry: session.retry ?? null,
    flags: session.flags || undefined,
    seq: Number(session.seq) || 0,
    createdAt: Number(session.createdAt) || Date.now(),
    updatedAt: Number(session.updatedAt) || Date.now(),
    startedAt: Number(session.startedAt) || 0,
    finishedAt: Number(session.finishedAt) || 0,
  };
  return enqueueWrite(cleaned, opts);
}

async function remove(id) {
  const file = sessionFile(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  removeFromIndex(id);
  return { ok: true };
}

async function clear() {
  // 面试记录 + 语音模型/音色/缓存一并删除（P2 起 speech 目录才存在；这里统一清理）
  for (const dir of [baseDir(), path.join(app.getPath('userData'), 'speech')]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 目录不存在或占用中，忽略 */ }
  }
  indexCache = null;
  writeSlots.clear();
  lastWrittenSeq.clear();
  return { ok: true };
}

function usage() {
  let count = 0;
  let bytes = 0;
  for (const f of listSessionFiles()) {
    count += 1;
    try { bytes += fs.statSync(path.join(sessionsDir(), f)).size; } catch { /* ignore */ }
  }
  try { bytes += fs.statSync(indexPath()).size; } catch { /* ignore */ }
  return { ok: true, count, bytes };
}

/** 删除全部面试记录（保留题库与语音，P3 起题库有独立入口） */
async function clearSessions() {
  try { fs.rmSync(sessionsDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(indexPath(), { force: true }); } catch { /* ignore */ }
  indexCache = null;
  writeSlots.clear();
  lastWrittenSeq.clear();
  return { ok: true };
}

async function exportAll(win) {
  const sessions = [];
  for (const f of listSessionFiles()) {
    const s = readJsonFile(path.join(sessionsDir(), f), null);
    if (s && s.id) sessions.push(s);
  }
  sessions.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const r = await dialog.showSaveDialog(win, {
    title: '导出面试记录',
    defaultPath: path.join(app.getPath('documents'), `面试记录-${stamp}.json`),
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const payload = {
    kind: 'bossclaw-mock-interview',
    version: 1,
    exportedAt: Date.now(),
    count: sessions.length,
    sessions,
  };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: r.filePath, count: sessions.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  list,
  read,
  write,
  remove,
  clear,
  clearSessions,
  usage,
  exportAll,
  // 供测试/诊断
  _baseDir: baseDir,
};
