// electron/mockInterviewBankRepo.cjs —— 模拟面试题库的文件仓储（主进程）
//
// 目录（方案 §7.1 / §8）：
//   <userData>/mock-interview/bank/banks.json         题库注册表（名称 / 类型 / 启用 / 来源 / 许可 / 条数 / mtime）
//   <userData>/mock-interview/bank/<bankId>.json      用户题库（imported / custom）
//   <userData>/mock-interview/bank/index.cache.json   BM25 索引缓存（派生，可删）
//
// 内置题库**不复制**到 userData，直接读 <appPath>/resources/bank/zh-interview-small.json：
// 11MB 复制一份没有意义，「恢复默认」也只是重新登记注册表。asar:false 时它就是一个普通文件。
//
// 所有写操作都走 tmp + rename（与面试记录同一心智）：中途失败不会留下半份题库。
// 题库编辑（改题 / 删题 / 导题）在渲染层做「有进行中会话就置灰」，主进程不感知会话，
// 但会校验内置库只读——这是数据完整性的最后一道。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const BUILTIN_ID = 'builtin-zh-interview';
const BUILTIN_FILE = 'zh-interview-small.json';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_QUESTIONS_PER_BANK = 30000;
const MAX_QUESTION_CHARS = 400;
const MAX_ANSWER_CHARS = 4000;

function baseDir() {
  return path.join(app.getPath('userData'), 'mock-interview', 'bank');
}
function registryPath() {
  return path.join(baseDir(), 'banks.json');
}
function bankFile(id) {
  return path.join(baseDir(), `${assertId(id, 'bankId')}.json`);
}
function builtinPath() {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'bank', BUILTIN_FILE),
    path.join(__dirname, '..', 'resources', 'bank', BUILTIN_FILE),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function assertId(id, label) {
  const s = String(id || '');
  if (!ID_RE.test(s)) throw new Error(`${label || 'id'} 非法：只允许 8–64 位字母、数字、下划线与连字符`);
  return s;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function uniqueTmp(file) {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function atomicWrite(file, text) {
  const tmp = uniqueTmp(file);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw e;
  }
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { bytes: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return { bytes: 0, mtime: 0 };
  }
}

// ===== 内置库（只读，进程内缓存一次） =====
let builtinCache = null;

function loadBuiltin() {
  const file = builtinPath();
  const st = statOf(file);
  if (builtinCache && builtinCache.file === file && builtinCache.mtime === st.mtime) return builtinCache;
  const data = readJson(file, null);
  if (!data || !Array.isArray(data.questions)) {
    builtinCache = { file, mtime: st.mtime, bytes: st.bytes, data: null };
    return builtinCache;
  }
  builtinCache = { file, mtime: st.mtime, bytes: st.bytes, data };
  return builtinCache;
}

function builtinMeta() {
  const { data, bytes } = loadBuiltin();
  if (!data) return null;
  return {
    id: BUILTIN_ID,
    name: String(data.name || '中文面试题库（内置）'),
    type: 'builtin',
    enabled: true,
    license: String(data.license || 'Apache-2.0'),
    source: String(data.source || ''),
    count: Array.isArray(data.questions) ? data.questions.length : 0,
    bytes,
    mtime: Number(data.builtAt ? Date.parse(data.builtAt) : 0) || 0,
    version: String(data.sourceVersion || ''),
    file: BUILTIN_FILE,
  };
}

// ===== 注册表 =====
function emptyRegistry() {
  return { schema: 1, version: 1, banks: [] };
}

function readRegistry() {
  const reg = readJson(registryPath(), null);
  if (!reg || !Array.isArray(reg.banks)) return emptyRegistry();
  return reg;
}

function writeRegistry(reg) {
  fs.mkdirSync(baseDir(), { recursive: true });
  atomicWrite(registryPath(), JSON.stringify({ ...reg, schema: 1, version: 1 }, null, 1));
}

function ensureInit() {
  fs.mkdirSync(baseDir(), { recursive: true });
  const reg = readRegistry();
  const bm = builtinMeta();
  let changed = false;
  const idx = reg.banks.findIndex((b) => b.id === BUILTIN_ID);
  const entry = bm
    ? {
        id: BUILTIN_ID,
        name: bm.name,
        type: 'builtin',
        enabled: idx >= 0 ? Boolean(reg.banks[idx].enabled) : true,
        license: bm.license,
        source: bm.source,
        count: bm.count,
        bytes: bm.bytes,
        mtime: bm.mtime,
        version: bm.version,
      }
    : null;

  if (entry && idx < 0) {
    reg.banks.unshift(entry);
    changed = true;
  } else if (entry) {
    const merged = { ...reg.banks[idx], ...entry };
    if (JSON.stringify(merged) !== JSON.stringify(reg.banks[idx])) {
      reg.banks[idx] = merged;
      changed = true;
    }
  }

  // 用户题库：以文件为准修正条数与 mtime（手工删文件后注册表不会留下幽灵条目）
  const before = reg.banks.length;
  reg.banks = reg.banks.filter((b) => {
    if (b.type === 'builtin') return true;
    if (!fs.existsSync(bankFile(b.id))) return false;
    const st = statOf(bankFile(b.id));
    if (b.bytes !== st.bytes || b.mtime !== st.mtime) changed = true;
    b.bytes = st.bytes;
    b.mtime = st.mtime;
    return true;
  });
  if (reg.banks.length !== before) changed = true;
  if (changed) writeRegistry(reg);
  return reg;
}

function metaOf(bank, withBytes = false) {
  const file = bank.type === 'builtin' ? builtinPath() : bankFile(bank.id);
  const st = withBytes ? statOf(file) : { bytes: bank.bytes || 0, mtime: bank.mtime || 0 };
  return {
    id: bank.id,
    name: bank.name,
    type: bank.type,
    enabled: Boolean(bank.enabled),
    license: bank.license || (bank.type === 'builtin' ? 'Apache-2.0' : '用户导入'),
    source: bank.source || '',
    count: Number(bank.count || 0),
    bytes: st.bytes,
    mtime: st.mtime,
    version: bank.version || '',
    file: bank.type === 'builtin' ? BUILTIN_FILE : `${bank.id}.json`,
    editable: bank.type !== 'builtin',
  };
}

function list() {
  const reg = ensureInit();
  return { ok: true, banks: reg.banks.map((b) => metaOf(b)) };
}

/** 读一个题库的全部题目（内置库带 bankId） */
function read(bankId) {
  const id = assertId(bankId, 'bankId');
  if (id === BUILTIN_ID) {
    const { data } = loadBuiltin();
    if (!data) return { ok: false, error: '内置题库文件缺失或损坏，可在题库页点「恢复默认」重试' };
    return {
      ok: true,
      questions: data.questions.map((q) => ({ ...q, bankId: BUILTIN_ID })),
      meta: { ...builtinMeta(), editable: false },
    };
  }
  const reg = ensureInit();
  const bank = reg.banks.find((b) => b.id === id);
  if (!bank) return { ok: false, error: '题库不存在' };
  const data = readJson(bankFile(id), null);
  if (!data || !Array.isArray(data.questions)) return { ok: false, error: '题库文件损坏' };
  return {
    ok: true,
    questions: data.questions.map((q) => ({ ...q, bankId: id })),
    meta: metaOf(bank),
  };
}

function touchBank(bankId, questions) {
  const reg = ensureInit();
  const i = reg.banks.findIndex((b) => b.id === bankId);
  if (i < 0) throw new Error('题库不存在');
  const file = bankFile(bankId);
  atomicWrite(
    file,
    JSON.stringify({
      schema: 1,
      id: bankId,
      name: reg.banks[i].name,
      type: reg.banks[i].type,
      questions,
      updatedAt: Date.now(),
    }),
  );
  const st = statOf(file);
  reg.banks[i] = { ...reg.banks[i], count: questions.length, bytes: st.bytes, mtime: st.mtime };
  writeRegistry(reg);
}

function sanitizeQuestion(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const text = String(q.text || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (text.length < 4) throw new Error('题干过短');
  return {
    id: String(q.id || `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    text,
    answer: String(q.answer || '').trim().slice(0, MAX_ANSWER_CHARS),
    directions: Array.isArray(q.directions) ? q.directions.slice(0, 3).map(String) : ['general'],
    difficulty: ['basic', 'standard', 'stress'].includes(q.difficulty) ? q.difficulty : 'standard',
    category: ['icebreak', 'fundamental', 'project', 'behavior', 'closing'].includes(q.category)
      ? q.category
      : 'fundamental',
    tags: Array.isArray(q.tags) ? q.tags.slice(0, 8).map((x) => String(x).slice(0, 24)) : [],
    focus: Array.isArray(q.focus) ? q.focus.slice(0, 5).map((x) => String(x).slice(0, 80)) : [],
    keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints.slice(0, 6).map((x) => String(x).slice(0, 120)) : [],
    createdAt: Number(q.createdAt) || Date.now(),
  };
}

function assertWritable(bankId) {
  if (String(bankId) === BUILTIN_ID) throw new Error('内置题库只读：可停用，但不能编辑；如需增删请新建题库');
}

function createBank(name, type = 'custom') {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('题库名称不能为空');
  const reg = ensureInit();
  if (reg.banks.some((b) => b.name === clean)) throw new Error('同名题库已存在');
  const id = `${type === 'imported' ? 'imp' : 'cus'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const bank = {
    id,
    name: clean,
    type,
    enabled: true,
    license: '用户自建',
    source: '',
    count: 0,
    bytes: 0,
    mtime: Date.now(),
  };
  reg.banks.push(bank);
  writeRegistry(reg);
  atomicWrite(
    bankFile(id),
    JSON.stringify({ schema: 1, id, name: clean, type, questions: [], updatedAt: Date.now() }),
  );
  return { ok: true, bank: metaOf(bank, true) };
}

function renameBank(bankId, name) {
  assertWritable(bankId);
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('题库名称不能为空');
  const reg = ensureInit();
  const bank = reg.banks.find((b) => b.id === bankId);
  if (!bank) throw new Error('题库不存在');
  bank.name = clean;
  writeRegistry(reg);
  const data = readJson(bankFile(bankId), null);
  if (data) atomicWrite(bankFile(bankId), JSON.stringify({ ...data, name: clean }));
  return { ok: true };
}

function deleteBank(bankId) {
  assertWritable(bankId);
  const reg = ensureInit();
  if (!reg.banks.some((b) => b.id === bankId)) throw new Error('题库不存在');
  try { fs.unlinkSync(bankFile(bankId)); } catch { /* 文件已不在 */ }
  reg.banks = reg.banks.filter((b) => b.id !== bankId);
  writeRegistry(reg);
  return { ok: true };
}

function setEnabled(bankId, enabled) {
  const reg = ensureInit();
  const bank = reg.banks.find((b) => b.id === bankId);
  if (!bank) throw new Error('题库不存在');
  bank.enabled = Boolean(enabled);
  writeRegistry(reg);
  return { ok: true, enabled: bank.enabled };
}

/** 内置题库「恢复默认」：文件在包内，重新登记即可；文件确实缺失时明确报错 */
function restoreBuiltin() {
  const bm = builtinMeta();
  if (!bm) return { ok: false, error: '安装包内缺少内置题库文件（resources/bank/zh-interview-small.json）' };
  const reg = ensureInit();
  const i = reg.banks.findIndex((b) => b.id === BUILTIN_ID);
  const entry = { ...bm, enabled: true };
  delete entry.file;
  if (i < 0) reg.banks.unshift(entry);
  else reg.banks[i] = entry;
  writeRegistry(reg);
  return { ok: true, bank: metaOf(reg.banks.find((b) => b.id === BUILTIN_ID), true) };
}

function addQuestion(bankId, question) {
  assertWritable(bankId);
  const data = readJson(bankFile(bankId), null);
  if (!data) throw new Error('题库不存在');
  if (data.questions.length >= MAX_QUESTIONS_PER_BANK) {
    throw new Error(`单库上限 ${MAX_QUESTIONS_PER_BANK} 条，请拆成多个题库`);
  }
  const q = sanitizeQuestion(question);
  data.questions.push(q);
  touchBank(bankId, data.questions);
  return { ok: true, question: q, count: data.questions.length };
}

function updateQuestion(bankId, questionId, patch) {
  assertWritable(bankId);
  const data = readJson(bankFile(bankId), null);
  if (!data) throw new Error('题库不存在');
  const i = data.questions.findIndex((q) => q.id === questionId);
  if (i < 0) throw new Error('题目不存在');
  const merged = sanitizeQuestion({ ...data.questions[i], ...patch, id: questionId });
  data.questions[i] = merged;
  touchBank(bankId, data.questions);
  return { ok: true, question: merged };
}

function deleteQuestion(bankId, questionId) {
  assertWritable(bankId);
  const data = readJson(bankFile(bankId), null);
  if (!data) throw new Error('题库不存在');
  const before = data.questions.length;
  data.questions = data.questions.filter((q) => q.id !== questionId);
  if (data.questions.length === before) throw new Error('题目不存在');
  touchBank(bankId, data.questions);
  return { ok: true, count: data.questions.length };
}

/**
 * 批量写入（导入向导第 5 步）。渲染层已完成字段校验与去重，这里只做容量与形状兜底：
 * 超上限整批拒绝并给出拆分建议，不写入半份数据。
 */
function importQuestions(bankId, questions, opts = {}) {
  assertWritable(bankId);
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return { ok: false, error: '没有可写入的题目' };
  const mode = opts.mode === 'replace' ? 'replace' : 'append';
  const data = readJson(bankFile(bankId), null);
  if (!data) throw new Error('题库不存在');
  const base = mode === 'replace' ? [] : data.questions;
  const total = base.length + list.length;
  if (total > MAX_QUESTIONS_PER_BANK) {
    return {
      ok: false,
      error: `写入后共 ${total} 条，超过单库上限 ${MAX_QUESTIONS_PER_BANK} 条。请拆成多个题库后分批导入（例如按方向或年份拆分）。`,
    };
  }
  const clean = list.map(sanitizeQuestion);
  if (mode === 'replace') data.questions = clean;
  else data.questions = [...data.questions, ...clean];
  touchBank(bankId, data.questions);
  return { ok: true, count: data.questions.length, added: clean.length };
}

// ===== 索引缓存（派生文件，可删） =====
function cachePath() {
  return path.join(baseDir(), 'index.cache.json');
}

function readIndexCache() {
  try {
    const st = fs.statSync(cachePath());
    if (st.size > 96 * 1024 * 1024) return { ok: false, error: '索引缓存异常（超大），请点「重建索引」' };
    const raw = fs.readFileSync(cachePath(), 'utf8');
    return { ok: true, data: raw, bytes: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return { ok: false };
  }
}

function writeIndexCache(payload) {
  const text = String(payload || '');
  if (!text) return { ok: false, error: '空缓存' };
  // 缓存只是加速手段：写不进去（磁盘满 / 权限）不该影响面试
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    atomicWrite(cachePath(), text);
    return { ok: true, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function clearIndexCache() {
  try {
    const st = statOf(cachePath());
    fs.unlinkSync(cachePath());
    return { ok: true, freedBytes: st.bytes };
  } catch {
    return { ok: true, freedBytes: 0 };
  }
}

function dirBytes(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* 文件已删 */ }
      }
    }
  }
  return total;
}

function usage() {
  const reg = ensureInit();
  const userBanks = reg.banks.filter((b) => b.type !== 'builtin');
  return {
    ok: true,
    count: userBanks.length,
    bytes: dirBytes(baseDir()),
    builtinCount: (builtinMeta() || {}).count || 0,
  };
}

module.exports = {
  BUILTIN_ID,
  list,
  read,
  createBank,
  renameBank,
  deleteBank,
  setEnabled,
  restoreBuiltin,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  importQuestions,
  readIndexCache,
  writeIndexCache,
  clearIndexCache,
  usage,
  _paths: { baseDir, registryPath, bankFile, builtinPath, cachePath },
};
