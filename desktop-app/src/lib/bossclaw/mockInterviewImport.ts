// 题库导入：四种格式一套映射（JSON / CSV / Markdown / Word .docx）
//
// 设计口径（方案 §4.6.3）：
//   · **不允许「直接吞进去」**：先解析出预览与校验报告，用户确认字段映射后才写入；
//   · 字段映射的默认表必须包含 `instruction` / `input` / `output`——内置题库的来源数据集就是
//     这套指令微调格式，漏了这三个键连我们自己的库都导不进来；
//   · docx 只做「一个标题一题」的保守切分，切不清就报数让用户确认，不猜；
//   · 所有解析都是纯本地、零新增依赖（docx 复用已有的 mammoth）。

import {
  BANK_DIRECTION_LABELS,
  BANK_DIRECTIONS,
  classifyQuestion,
  findNearDuplicates,
  normalizeQuestionText,
  sha1Hex,
  type BankDirection,
  type BankQuestion,
} from './mockInterviewBank';
import type { MockDifficulty, MockQuestionCategory } from './mockInterviewTypes';

export type ImportFormat = 'json' | 'csv' | 'markdown' | 'docx';

export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  json: 'JSON',
  csv: 'CSV / Excel 导出',
  markdown: 'Markdown',
  docx: 'Word (.docx)',
};

/** 单次导入上限：超过就整批拦住，给拆分建议（方案验收 #11） */
export const MAX_IMPORT_QUESTIONS = 30000;

/** 一条原始记录：键 = 文件里的列名 / 字段名 */
export type RawRecord = Record<string, string>;

export type FieldKey =
  | 'text'
  | 'answer'
  | 'focus'
  | 'keyPoints'
  | 'directions'
  | 'difficulty'
  | 'category'
  | 'tags';

export const FIELD_LABELS: Record<FieldKey, string> = {
  text: '题干（必填）',
  answer: '参考答案',
  focus: '考察点',
  keyPoints: '评分要点',
  directions: '岗位方向',
  difficulty: '难度',
  category: '题型',
  tags: '标签',
};

export type FieldMap = Record<FieldKey, string | null>;

/** 默认映射表：按优先级排列，命中第一个即用（不区分大小写、去空白） */
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  text: ['question', 'instruction', 'title', '题目', '题干', '问题', 'q', 'input'],
  answer: ['answer', 'output', '答案', 'content', 'a', '参考答案'],
  focus: ['focus', '考察点', '考查点', 'focuses'],
  keyPoints: ['keypoints', 'key_points', '要点', '评分要点', 'points'],
  directions: ['directions', 'direction', '方向', '岗位方向', 'category', '分类', '岗位'],
  difficulty: ['difficulty', '难度', 'level'],
  category: ['category', '题型', 'type', '类别'],
  tags: ['tags', 'tag', '标签', '关键词'],
};

function normKey(k: string): string {
  return String(k || '').replace(/^\ufeff/, '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

/** 自动识别字段映射：返回每一列对应的文件字段（识别不出为 null，交给用户下拉） */
export function autoMap(headers: string[]): FieldMap {
  const map = {} as FieldMap;
  const used = new Set<string>();
  (Object.keys(FIELD_ALIASES) as FieldKey[]).forEach((field) => {
    const aliases = FIELD_ALIASES[field];
    let hit: string | null = null;
    for (const alias of aliases) {
      const a = normKey(alias);
      const found = headers.find((h) => !used.has(h) && normKey(h) === a);
      if (found) {
        hit = found;
        break;
      }
    }
    // 次级匹配：列名包含别名（如「题目内容」→ question / 题）
    if (!hit) {
      for (const alias of aliases) {
        const a = normKey(alias);
        if (a.length < 2) continue;
        const found = headers.find((h) => !used.has(h) && normKey(h).includes(a));
        if (found) {
          hit = found;
          break;
        }
      }
    }
    map[field] = hit;
    if (hit) used.add(hit);
  });
  return map;
}

export function detectFormat(fileName: string): ImportFormat | null {
  const ext = String(fileName || '').toLowerCase().split('.').pop() || '';
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'docx') return 'docx';
  return null;
}

// ===== CSV（BOM + 引号转义 + 跨行单元格）=====

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** 手写 CSV 解析：必须处理 BOM（否则首列表头变成 \ufeff题目）与引号内的逗号/换行 */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  let src = String(text || '').replace(/^\ufeff/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  const sep =
    delimiter ||
    (firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : firstLine.split(',').length >= firstLine.split(';').length ? ',' : ';');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      // 交给 \n 处理（CRLF）；单独的 \r 也当换行
      if (src[i + 1] !== '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      }
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const cleaned = rows.filter((r) => r.some((c) => String(c).trim()));
  if (!cleaned.length) return { headers: [], rows: [] };
  const headers = cleaned[0].map((h) => h.replace(/^\ufeff/, '').trim());
  return { headers, rows: cleaned.slice(1) };
}

/** 表格 → 记录 */
export function csvToRecords(table: CsvTable): RawRecord[] {
  return table.rows.map((row) => {
    const rec: RawRecord = {};
    table.headers.forEach((h, i) => {
      rec[h] = row[i] == null ? '' : String(row[i]);
    });
    return rec;
  });
}

// ===== JSON =====

export interface JsonParseResult {
  records: RawRecord[];
  headers: string[];
  error?: string;
}

/** 接受数组 / { questions: [...] } / { data: [...] }；非对象元素直接丢弃 */
export function parseJsonRecords(text: string): JsonParseResult {
  let data: unknown;
  try {
    data = JSON.parse(String(text || '').replace(/^\ufeff/, ''));
  } catch (e) {
    return { records: [], headers: [], error: `JSON 解析失败：${(e as Error).message}` };
  }
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { questions?: unknown })?.questions)
      ? ((data as { questions: unknown[] }).questions)
      : Array.isArray((data as { data?: unknown })?.data)
        ? ((data as { data: unknown[] }).data)
        : null;
  if (!arr) return { records: [], headers: [], error: '未找到题目数组（支持数组本身，或 { questions: [...] }）' };

  const records: RawRecord[] = [];
  const keys = new Set<string>();
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === 'string') {
      records.push({ question: item });
      keys.add('question');
      continue;
    }
    if (typeof item !== 'object') continue;
    const rec: RawRecord = {};
    Object.entries(item as Record<string, unknown>).forEach(([k, v]) => {
      if (v == null) return;
      if (typeof v === 'object') return;
      rec[k] = String(v);
      keys.add(k);
    });
    if (Object.keys(rec).length) records.push(rec);
  }
  return { records, headers: [...keys] };
}

// ===== Markdown =====

const MD_FIELD_PREFIX: Array<{ key: FieldKey; re: RegExp }> = [
  { key: 'answer', re: /^(?:答案|参考答案|答|a)\s*[:：]\s*/i },
  { key: 'focus', re: /^(?:考察点|考查点|考点|focus)\s*[:：]\s*/i },
  { key: 'keyPoints', re: /^(?:要点|评分要点|key\s*points?)\s*[:：]\s*/i },
  { key: 'tags', re: /^(?:标签|关键词|tags?)\s*[:：]\s*/i },
];

/**
 * Markdown：按 `#`–`####` 标题切块，一个标题一题。
 * 块内识别 `答案：` / `考察点：` / `要点：` / `标签：` 前缀，其余正文并入答案。
 */
export function parseMarkdownRecords(text: string): JsonParseResult {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (m) {
      if (current) blocks.push(current);
      current = { title: m[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (line.trim()) {
      // 没有标题的文件：整篇当一条（宁少不猜）
      current = { title: '', body: [line] };
    }
  }
  if (current) blocks.push(current);

  const records: RawRecord[] = [];
  for (const block of blocks) {
    const rec: RawRecord = {};
    const answer: string[] = [];
    const body = block.body.map((x) => x.trim()).filter(Boolean);
    let i = 0;
    while (i < body.length) {
      const line = body[i];
      const hit = MD_FIELD_PREFIX.find((f) => f.re.test(line));
      if (hit) {
        rec[hit.key] = line.replace(hit.re, '').trim();
      } else {
        answer.push(line);
      }
      i += 1;
    }
    if (block.title) rec.question = block.title;
    else if (answer.length) rec.question = answer.shift() as string;
    const ans = [rec.answer, ...answer].filter(Boolean).join('\n').trim();
    if (ans) rec.answer = ans;
    if (Object.keys(rec).length) records.push(rec);
  }

  const keys = new Set<string>();
  records.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  if (!records.length) return { records: [], headers: [], error: '没有识别到任何标题块' };
  return { records, headers: [...keys] };
}

// ===== Word .docx（复用 mammoth → HTML → 按标题切块）=====

export async function parseDocxRecords(file: File): Promise<JsonParseResult> {
  try {
    const mod = await import('mammoth/mammoth.browser.js');
    const mammoth = (mod as unknown as { default?: unknown })?.default || mod;
    const convert = (mammoth as { convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }> })
      .convertToHtml;
    if (!convert) return { records: [], headers: [], error: 'docx 解析器不可用（mammoth 未加载）' };
    const buf = await file.arrayBuffer();
    const { value: html } = await convert({ arrayBuffer: buf });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4'));
    if (!headings.length) {
      return {
        records: [],
        headers: [],
        error: '文档里没有标题（H1–H4），无法按「一个标题一题」切分。请先用 Word 的标题样式组织题目，或导出为 Markdown 再导入。',
      };
    }

    const records: RawRecord[] = [];
    for (const h of headings) {
      const rec: RawRecord = { question: (h.textContent || '').trim() };
      let el = h.nextElementSibling;
      const lines: string[] = [];
      while (el && !/^H[1-4]$/.test(el.tagName)) {
        const t = (el.textContent || '').trim();
        if (t) lines.push(t);
        el = el.nextElementSibling;
      }
      const answer: string[] = [];
      for (const line of lines) {
        const hit = MD_FIELD_PREFIX.find((f) => f.re.test(line));
        if (hit) rec[hit.key] = line.replace(hit.re, '').trim();
        else answer.push(line);
      }
      if (answer.length) rec.answer = answer.join('\n');
      if (rec.question) records.push(rec);
    }
    const keys = new Set<string>();
    records.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
    return { records, headers: [...keys] };
  } catch (e) {
    return { records: [], headers: [], error: `docx 解析失败：${(e as Error).message}` };
  }
}

// ===== 映射 → 题目 + 校验报告 =====

export interface MappedQuestion {
  text: string;
  answer: string;
  focus: string[];
  keyPoints: string[];
  directions: BankDirection[];
  difficulty: MockDifficulty;
  category: MockQuestionCategory;
  tags: string[];
  /** 源文件行号（1 起，含表头），用于校验报告定位 */
  row: number;
}

export const MIN_QUESTION_CHARS = 6;
export const MAX_QUESTION_CHARS = 200;
export const MAX_ANSWER_CHARS = 4000;

function splitList(v: string): string[] {
  return String(v || '')
    .split(/[;；,，|、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseDirections(v: string): BankDirection[] {
  const raw = splitList(v);
  const out: BankDirection[] = [];
  for (const item of raw) {
    const hit = (Object.keys(BANK_DIRECTION_LABELS) as BankDirection[]).find(
      (k) => BANK_DIRECTION_LABELS[k] === item || k === item.toLowerCase(),
    );
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

function parseDifficulty(v: string): MockDifficulty | null {
  const s = String(v || '').trim().toLowerCase();
  if (['基础', 'basic', '简单', '初级'].includes(s)) return 'basic';
  if (['标准', 'standard', '中等', '中级'].includes(s)) return 'standard';
  if (['压力', 'stress', '困难', '高级', '高难度'].includes(s)) return 'stress';
  return null;
}

function parseCategory(v: string): MockQuestionCategory | null {
  const s = String(v || '').trim().toLowerCase();
  if (['破冰', 'icebreak', 'ice'].includes(s)) return 'icebreak';
  if (['专业基础', '基础', 'fundamental', '专业'].includes(s)) return 'fundamental';
  if (['项目深挖', '项目', 'project'].includes(s)) return 'project';
  if (['行为', 'behavior', '行为面'].includes(s)) return 'behavior';
  if (['收尾', 'closing', '结束'].includes(s)) return 'closing';
  return null;
}

/**
 * 应用字段映射。缺方向/难度/题型时用关键词分类兜底（可被用户在编辑弹窗里改），
 * 但**不猜题干**：没有题干的记录直接记入「缺题干」，不进有效集。
 */
export function applyFieldMap(records: RawRecord[], map: FieldMap): MappedQuestion[] {
  return records.map((rec, i) => {
    const pick = (k: FieldKey): string => {
      const col = map[k];
      return col ? String(rec[col] ?? '').trim() : '';
    };
    const text = pick('text').replace(/\s+/g, ' ').trim();
    const answer = pick('answer').slice(0, MAX_ANSWER_CHARS);
    const focus = splitList(pick('focus')).slice(0, 5);
    const keyPoints = splitList(pick('keyPoints')).slice(0, 6);
    const directions = parseDirections(pick('directions'));
    const difficulty = parseDifficulty(pick('difficulty'));
    const category = parseCategory(pick('category'));
    const tags = splitList(pick('tags')).slice(0, 8);
    const cls = text ? classifyQuestion(text) : null;
    return {
      text,
      answer,
      focus,
      keyPoints,
      directions: directions.length ? directions : cls?.directions || ['general'],
      difficulty: difficulty || cls?.difficulty || 'standard',
      category: category || cls?.category || 'fundamental',
      tags: tags.length ? tags : cls?.tags || [],
      row: i + 2,
    };
  });
}

export interface ValidationReport {
  total: number;
  valid: number;
  noText: number;
  tooShort: number;
  tooLong: number;
  noAnswer: number;
  exactDuplicates: number;
  /** 疑似重复（Jaccard > 0.85）：只提示不自动删 */
  nearDuplicates: Array<{ row: number; text: string; similarTo: string; similarity: number }>;
  /** 超过单次导入上限时的拆分建议 */
  overflow?: { count: number; limit: number; message: string };
}

export interface PreparedImport {
  report: ValidationReport;
  /** 可直接写入的题目（已去精确重复、已生成 id） */
  questions: BankQuestion[];
  /** 预览用前 5 条（含被判重复的，便于用户理解为什么少了） */
  preview: Array<MappedQuestion & { duplicate?: boolean }>;
}

/**
 * 校验 + 去重 + 生成可写入题目。
 * 精确去重：归一化后 SHA-1 相同 → 跳过（返回条数差）；近似重复只进报告，不删。
 */
export function prepareImport(
  mapped: MappedQuestion[],
  existing: Array<{ id: string; text: string }> = [],
  opts: { bankId?: string } = {},
): PreparedImport {
  const report: ValidationReport = {
    total: mapped.length,
    valid: 0,
    noText: 0,
    tooShort: 0,
    tooLong: 0,
    noAnswer: 0,
    exactDuplicates: 0,
    nearDuplicates: [],
  };

  if (mapped.length > MAX_IMPORT_QUESTIONS) {
    report.overflow = {
      count: mapped.length,
      limit: MAX_IMPORT_QUESTIONS,
      message: `本次 ${mapped.length} 条超过单次导入上限 ${MAX_IMPORT_QUESTIONS} 条。请按方向或年份拆成多个文件分批导入——一次性解析这么大的库会让界面长时间无响应。`,
    };
  }

  const seen = new Map<string, string>();
  existing.forEach((q) => seen.set(sha1Hex(normalizeQuestionText(q.text)), q.id));

  const questions: BankQuestion[] = [];
  const preview: PreparedImport['preview'] = [];
  const accepted: MappedQuestion[] = [];

  mapped.forEach((q) => {
    if (!q.text) {
      report.noText += 1;
      return;
    }
    const len = [...q.text].length;
    if (len < MIN_QUESTION_CHARS) {
      report.tooShort += 1;
      return;
    }
    if (len > MAX_QUESTION_CHARS) {
      report.tooLong += 1;
      return;
    }
    if (!q.answer.trim()) report.noAnswer += 1; // 不拦，只报：题干本身仍可出题

    const hash = sha1Hex(normalizeQuestionText(q.text));
    if (seen.has(hash)) {
      report.exactDuplicates += 1;
      if (preview.length < 5) preview.push({ ...q, duplicate: true });
      return;
    }
    seen.set(hash, `new-${questions.length}`);

    const bankQuestion: BankQuestion = {
      id: `q-${hash.slice(0, 12)}`,
      text: q.text,
      answer: q.answer,
      directions: q.directions,
      difficulty: q.difficulty,
      category: q.category,
      tags: q.tags,
      focus: q.focus,
      keyPoints: q.keyPoints,
      createdAt: Date.now(),
    };
    void opts.bankId;
    questions.push(bankQuestion);
    if (preview.length < 5) preview.push(q);
    accepted.push(q);
    report.valid += 1;
  });

  // 超限批次不写盘，没必要再做近似去重（3 万条 Jaccard 候选是纯浪费）
  if (report.overflow) return { report, questions, preview };

  // 近似重复：倒排候选 + Jaccard（与 findDuplicates 同一实现，避免两套口径）
  findNearDuplicates(accepted.map((x) => x.text), existing).forEach((n) => {
    const item = accepted[n.index];
    if (!item) return;
    report.nearDuplicates.push({
      row: item.row,
      text: item.text,
      similarTo: n.similarTo,
      similarity: n.similarity,
    });
  });

  return { report, questions, preview };
}

/** 空题目模板（新增弹窗用） */
export function emptyBankQuestion(): Partial<BankQuestion> {
  return {
    text: '',
    answer: '',
    directions: ['general'],
    difficulty: 'standard',
    category: 'fundamental',
    tags: [],
    focus: [],
    keyPoints: [],
  };
}

export { BANK_DIRECTIONS };
