// 纯前端旧版 DOC 文本解析（零 Node 依赖，可在 Electron 渲染进程 / Vite 中直接运行）
//
// .doc 只是「扩展名」，真实载体有三种，按字节特征嗅探后分别处理：
//   ① OLE2/CFB 二进制 —— 真正的 Word 97-2003：CFB 容器（FAT / 迷你流 / 目录）
//      → WordDocument 流的 FIB → CLX（Piece Table）定位文本片段 → 按片段编码解码；
//   ② RTF —— Word「另存为 RTF」后改名，国内在线简历导出常见：剥离控制字与 \'hh 转义；
//   ③ HTML —— 前端导出的 .doc 实为网页：剥标签取块级文本。
//
// 逻辑对齐 docxParser / pdfExtractor 的口径（纯前端、零新增依赖、失败给可操作下一步）：
// 段落以换行落地、剥净控制符与域指令、正文优先（ccpText 裁剪掉页眉页脚注脚）。

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SECTOR_END = 0xfffffffe; // ENDOFCHAIN
const SECTOR_FREE = 0xffffffff; // FREESECT
const MAX_SECTORS = 1 << 20; // 防 FAT 成环导致死循环

export interface DocParseResult {
  text: string;
  method: string;
  pageCount: number;
}

// ===== 一、编码解码辅助 =====

/** 压缩（8-bit）片段与 RTF \'hh 转义都是「按文档代码页单字节」编码：中文文档为 GBK，西文为 cp1252 */
function decodeAnsiBytes(bytes: Uint8Array): string {
  let high = 0;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] >= 0x80) high += 1;
  const highRatio = bytes.length ? high / bytes.length : 0;
  // 高位字节极少 → 基本是 ASCII（弯引号等用 cp1252 才正确），gb18030 会把相邻字节误配成汉字
  if (highRatio < 0.02) return new TextDecoder('windows-1252').decode(bytes);
  try {
    const text = new TextDecoder('gb18030').decode(bytes);
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad <= Math.max(1, text.length * 0.1)) return text;
  } catch {
    /* 运行环境不支持 gb18030，落到 cp1252 */
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

/** 先严格 UTF-8，失败按中文文档代码页 GB18030，最后 cp1252 兜底（用于 RTF / HTML 伪装的 .doc）
 *  M-24：导出以复用给「按字节读入的 TXT/MD」解码（原实现只按 UTF-8 读 → GBK 简历静默乱码）。 */
export function decodeTextBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* 非 UTF-8 */
  }
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ===== 二、CFB（OLE2 复合文档）容器 =====

interface CfbDirEntry {
  name: string;
  type: number; // 1=storage 2=stream 5=root
  startSector: number;
  size: number;
}

function isCfb(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  for (let i = 0; i < CFB_MAGIC.length; i += 1) if (bytes[i] !== CFB_MAGIC[i]) return false;
  return true;
}

class CompoundFile {
  private readonly dv: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniStreamCutoff: number;
  private readonly fat: number[] = [];
  private readonly miniFat: number[] = [];
  private readonly entries: CfbDirEntry[] = [];
  private miniStream: Uint8Array = new Uint8Array(0);
  private readonly streamCache = new Map<string, Uint8Array | undefined>();

  constructor(private readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = this.dv.getUint16(0x1e, true);
    if (sectorShift < 7 || sectorShift > 14) throw new Error(`DOC 扇区大小异常（sectorShift=${sectorShift}），文件可能已损坏`);
    this.sectorSize = 1 << sectorShift;
    const miniShift = this.dv.getUint16(0x20, true);
    this.miniSectorSize = 1 << (miniShift || 6);
    this.miniStreamCutoff = this.dv.getUint32(0x38, true) || 4096;
    this.readFat();
    this.readMiniFat();
    this.readDirectory();
    const root = this.entries.find((e) => e.type === 5);
    if (root && root.size > 0 && root.startSector !== SECTOR_END && root.startSector !== SECTOR_FREE) {
      this.miniStream = this.readChain(root.startSector, root.size, false);
    }
  }

  /** 扇区 N 在文件中的字节偏移：扇区号从 1 起算（0 号被 512 字节头占用） */
  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  private chain(start: number, useMini: boolean): number[] {
    const table = useMini ? this.miniFat : this.fat;
    const out: number[] = [];
    const seen = new Set<number>();
    let sector = start;
    let guard = 0;
    while (
      sector >= 0 &&
      sector < table.length &&
      sector !== SECTOR_END &&
      sector !== SECTOR_FREE &&
      guard < MAX_SECTORS &&
      !seen.has(sector)
    ) {
      seen.add(sector);
      out.push(sector);
      sector = table[sector];
      guard += 1;
    }
    return out;
  }

  private readFat(): void {
    const perSector = this.sectorSize / 4;
    const sectorCount = Math.max(0, Math.floor(this.bytes.length / this.sectorSize) - 1);
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i += 1) {
      const s = this.dv.getUint32(0x4c + i * 4, true);
      if (s === SECTOR_FREE || s === SECTOR_END) break;
      fatSectors.push(s);
    }
    // 头里 109 项不够时（大文件）沿 DIFAT 扇区续读
    let difat = this.dv.getUint32(0x44, true);
    const difatCount = this.dv.getUint32(0x48, true);
    let guard = 0;
    // L-14：`guard <= difatCount` 是 off-by-one（会多走一轮）；改为严格小于
    while (difat !== SECTOR_END && difat !== SECTOR_FREE && guard < difatCount && guard < MAX_SECTORS) {
      const base = this.sectorOffset(difat);
      if (base + this.sectorSize > this.bytes.length) break;
      for (let i = 0; i < perSector - 1; i += 1) {
        const s = this.dv.getUint32(base + i * 4, true);
        if (s === SECTOR_FREE) continue;
        fatSectors.push(s);
      }
      difat = this.dv.getUint32(base + (perSector - 1) * 4, true);
      guard += 1;
    }
    for (const fs of fatSectors) {
      if (fs >= sectorCount + 1) continue;
      const base = this.sectorOffset(fs);
      if (base + this.sectorSize > this.bytes.length) continue;
      for (let i = 0; i < perSector; i += 1) this.fat.push(this.dv.getUint32(base + i * 4, true));
    }
  }

  private readMiniFat(): void {
    const first = this.dv.getUint32(0x3c, true);
    const count = this.dv.getUint32(0x40, true);
    if (!count || first === SECTOR_END || first === SECTOR_FREE) return;
    for (const s of this.chain(first, false)) {
      const base = this.sectorOffset(s);
      if (base + this.sectorSize > this.bytes.length) break;
      for (let i = 0; i < this.sectorSize / 4; i += 1) this.miniFat.push(this.dv.getUint32(base + i * 4, true));
    }
  }

  private readDirectory(): void {
    const first = this.dv.getUint32(0x30, true);
    for (const sector of this.chain(first, false)) {
      const base = this.sectorOffset(sector);
      if (base + this.sectorSize > this.bytes.length) break;
      for (let off = 0; off + 128 <= this.sectorSize; off += 128) {
        const p = base + off;
        const type = this.bytes[p + 0x42];
        if (type !== 1 && type !== 2 && type !== 5) continue;
        const nameLen = this.dv.getUint16(p + 0x40, true);
        const len = Math.max(0, Math.min(64, nameLen - 2));
        const name = len
          ? new TextDecoder('utf-16le').decode(this.bytes.subarray(p, p + len))
          : '';
        this.entries.push({
          name,
          type,
          startSector: this.dv.getUint32(p + 0x74, true),
          size: this.dv.getUint32(p + 0x78, true),
        });
      }
    }
  }

  /** 按链读满 size 字节：mini=true 时数据源是迷你流（小流走的独立地址空间） */
  private readChain(start: number, size: number, useMini: boolean): Uint8Array {
    const unit = useMini ? this.miniSectorSize : this.sectorSize;
    const source = useMini ? this.miniStream : this.bytes;
    const offsetOf = useMini
      ? (sector: number) => sector * this.miniSectorSize
      : (sector: number) => this.sectorOffset(sector);
    const out = new Uint8Array(Math.max(0, size));
    let filled = 0;
    for (const sector of this.chain(start, useMini)) {
      if (filled >= size) break;
      const count = Math.min(unit, size - filled);
      const from = offsetOf(sector);
      if (from < 0 || from + count > source.length) break;
      out.set(source.subarray(from, from + count), filled);
      filled += count;
    }
    return filled === size ? out : out.subarray(0, filled);
  }

  stream(name: string): Uint8Array | undefined {
    const key = name.toLowerCase();
    if (this.streamCache.has(key)) return this.streamCache.get(key);
    const entry = this.entries.find((e) => e.type === 2 && e.name.toLowerCase() === key);
    let data: Uint8Array | undefined;
    if (entry && entry.size > 0 && entry.startSector !== SECTOR_END && entry.startSector !== SECTOR_FREE) {
      data = this.readChain(entry.startSector, entry.size, entry.size < this.miniStreamCutoff);
    }
    this.streamCache.set(key, data);
    return data;
  }
}

// ===== 三、Word 97-2003 正文提取（FIB → CLX → Piece Table）=====

interface Piece {
  cpStart: number;
  cpEnd: number;
  fc: number; // 已换算为 WordDocument 流内字节偏移
  compressed: boolean; // true = 单字节代码页，false = UTF-16LE
}

/**
 * 解析 CLX（0x02 前缀的 Pcdt）：PlcPcd = (n+1) 个 CP + n 个 8 字节 PCD。
 * PCD 的 fc 最高位（0x40000000）表示该片段是压缩的单字节文本，此时 fc 是「字节偏移 × 2」。
 */
function readPieces(table: Uint8Array, fcClx: number, lcbClx: number): Piece[] {
  if (!lcbClx || fcClx <= 0 || fcClx + lcbClx > table.length) return [];
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const end = fcClx + lcbClx;
  let p = fcClx;
  let plcOffset = -1;
  let plcLen = 0;
  while (p < end) {
    const kind = table[p];
    if (kind === 0x01) {
      if (p + 3 > end) break;
      p += 3 + dv.getUint16(p + 1, true); // Prc：跳过 grpprl
    } else if (kind === 0x02) {
      // L-13：缺边界检查（损坏文件会读越界抛 RangeError）
      if (p + 5 > end) break;
      plcLen = dv.getUint32(p + 1, true);
      plcOffset = p + 5;
      break;
    } else {
      break;
    }
  }
  if (plcOffset < 0 || plcLen < 4 || plcOffset + plcLen > table.length) return [];
  const count = Math.floor((plcLen - 4) / 12);
  if (count <= 0) return [];
  const pcdBase = plcOffset + (count + 1) * 4;
  const pieces: Piece[] = [];
  for (let i = 0; i < count; i += 1) {
    const cpStart = dv.getUint32(plcOffset + i * 4, true);
    const cpEnd = dv.getUint32(plcOffset + (i + 1) * 4, true);
    if (cpEnd <= cpStart) continue;
    const fcRaw = dv.getUint32(pcdBase + i * 8 + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    pieces.push({ cpStart, cpEnd, fc: compressed ? Math.floor(fc / 2) : fc, compressed });
  }
  return pieces;
}

/** 按 CP 位置解码片段；limit 用于只取主文档（ccpText）而排除页眉/脚注 */
function decodePieces(wd: Uint8Array, pieces: Piece[], limit: number): string {
  const parts: string[] = [];
  for (const piece of pieces) {
    const cpStart = Math.min(piece.cpStart, limit);
    const cpEnd = Math.min(piece.cpEnd, limit);
    if (cpEnd <= cpStart) continue;
    const chars = cpEnd - cpStart;
    const skip = cpStart - piece.cpStart;
    const startByte = piece.fc + (piece.compressed ? skip : skip * 2);
    const byteLen = piece.compressed ? chars : chars * 2;
    if (startByte < 0 || startByte + byteLen > wd.length) continue;
    const slice = wd.subarray(startByte, startByte + byteLen);
    parts.push(piece.compressed ? decodeAnsiBytes(slice) : new TextDecoder('utf-16le').decode(slice));
  }
  return parts.join('');
}

/**
 * 剥净 Word 控制符：
 *   0x0D 段落 / 0x07 单元格与行 / 0x0B 手动换行 / 0x0C 分页 → 换行；
 *   域结构 0x13 指令区 … 0x14 结果区 … 0x15 结束 → 只保留结果（嵌套用栈跟踪）；
 *   其余 C0 控制符、图片与批注占位符、私有区符号（项目符号等）一律丢弃。
 */
function sanitizeWordText(raw: string): string {
  let out = '';
  const instrStack: boolean[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 0x13) {
      instrStack.push(true);
      continue;
    }
    if (code === 0x14) {
      if (instrStack.length) instrStack[instrStack.length - 1] = false;
      continue;
    }
    if (code === 0x15) {
      instrStack.pop();
      continue;
    }
    if (instrStack.length && instrStack[instrStack.length - 1]) continue;
    if (code === 0x0d || code === 0x07 || code === 0x0b || code === 0x0c || code === 0x0a) {
      out += '\n';
      continue;
    }
    if (code === 0x09) {
      out += '\t';
      continue;
    }
    if (code === 0x1e) {
      out += '-';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0xe000 && code <= 0xf8ff) continue;
    out += raw[i];
  }
  return out;
}

function normalizeDocText(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBinaryDoc(bytes: Uint8Array): string {
  const cfb = new CompoundFile(bytes);
  const wd = cfb.stream('WordDocument');
  if (!wd || wd.length < 0x200) throw new Error('DOC 中未找到 WordDocument 数据流，可能不是 Word 文档或文件已损坏');
  const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);

  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('该 DOC 已加密（设有打开密码），无法直接解析，请取消密码后另存为 DOCX');
  if (dv.getUint16(0x00, true) !== 0xa5ec) throw new Error('DOC 的 WordDocument 流头异常，文件可能已损坏');

  const useOneTable = (flags & 0x0200) !== 0; // fWhichTblStm
  let table = cfb.stream(useOneTable ? '1Table' : '0Table');
  if (!table || !table.length) table = cfb.stream(useOneTable ? '0Table' : '1Table');

  let text = '';
  if (table && table.length) {
    // FibRgFcLcb97 中 fcClx 是第 33 项：0x9A + 33 × 8 = 0x1A2
    const fcClx = dv.getUint32(0x01a2, true);
    const lcbClx = dv.getUint32(0x01a6, true);
    const pieces = readPieces(table, fcClx, lcbClx);
    if (pieces.length) {
      const full = decodePieces(wd, pieces, Number.MAX_SAFE_INTEGER);
      const ccpText = dv.getUint32(0x40, true); // 主文档字符数（其后为脚注/页眉等）
      text = full;
      if (ccpText > 0) {
        const clipped = decodePieces(wd, pieces, ccpText);
        // 唯有 ccpText 明显不可靠（正文被裁得只剩零头）才回退全量，避免把正文裁掉；
        // 短简历（全量本身只有几十字）也必须按 ccpText 裁掉页眉脚注。
        const clippedLen = clipped.replace(/\s/g, '').length;
        if (clippedLen >= Math.max(3, full.replace(/\s/g, '').length * 0.2)) text = clipped;
      }
    }
  }
  if (!text.trim()) {
    // 无 piece table（极老的 Word 6/95 或表流缺失）：退化为 fcMin..fcMac 区间直读
    const fcMin = dv.getUint32(0x18, true);
    const fcMac = dv.getUint32(0x1c, true);
    if (fcMac > fcMin && fcMac <= wd.length) {
      text = decodeAnsiBytes(wd.subarray(fcMin, fcMac));
    }
  }
  return sanitizeWordText(text);
}

// ===== 四、RTF / HTML 伪装的 .doc =====

/** RTF：跳过字体表/颜色表等非正文组，剥离控制字，还原 \'hh 转义与 \uN 字符 */
const RTF_SKIP_GROUPS = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'themedata', 'latentstyles', 'listtable', 'datastore', 'xmlnstbl'];

function skipRtfGroup(input: string, start: number): number {
  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth <= 0) return i + 1;
    }
  }
  return input.length;
}

function extractRtfText(input: string): string {
  const out: string[] = [];
  let pendingBytes: number[] = [];
  const flush = () => {
    if (pendingBytes.length) {
      out.push(decodeAnsiBytes(Uint8Array.from(pendingBytes)));
      pendingBytes = [];
    }
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '{' || ch === '}') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      i += 1;
      continue;
    }
    if (ch !== '\\') {
      flush();
      out.push(ch);
      i += 1;
      continue;
    }
    const next = input[i + 1];
    // 转义的字面量字符
    if (next === '\\' || next === '{' || next === '}') {
      flush();
      out.push(next);
      i += 2;
      continue;
    }
    // \'hh：单字节（按代码页）
    if (next === "'") {
      const hex = input.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        pendingBytes.push(parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    // {\*\...}：可忽略目标组（生成器信息等），整组丢弃
    if (next === '*') {
      flush();
      const groupStart = input.lastIndexOf('{', i);
      i = groupStart >= 0 ? skipRtfGroup(input, groupStart) : i + 2;
      continue;
    }
    // 控制字：\word[-]N[空格]
    let j = i + 1;
    while (j < input.length && /[a-zA-Z]/.test(input[j])) j += 1;
    const word = input.slice(i + 1, j).toLowerCase();
    let negative = false;
    if (input[j] === '-') {
      negative = true;
      j += 1;
    }
    let num = 0;
    let hasNum = false;
    while (j < input.length && /[0-9]/.test(input[j])) {
      num = num * 10 + (input.charCodeAt(j) - 48);
      hasNum = true;
      j += 1;
    }
    if (input[j] === ' ') j += 1;
    flush();
    if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row' || word === 'cell') {
      out.push('\n');
    } else if (word === 'tab') {
      out.push('\t');
    } else if (word === 'u' && hasNum) {
      out.push(String.fromCharCode(negative ? num + 65536 : num));
      i = j;
      // \uN 后常跟一个替代字符（\'hh 或 ?），跳过它避免重复
      if (input[j] === '\\' && input[j + 1] === "'") i = j + 4;
      else if (input[j] !== undefined && input[j] !== '\\' && input[j] !== '{' && input[j] !== '}') i = j + 1;
      continue;
    } else if (RTF_SKIP_GROUPS.includes(word)) {
      // 字体表 / 颜色表 / 样式表等非正文组：整组丢弃，否则会把字体名当简历正文
      const groupStart = input.lastIndexOf('{', i);
      i = groupStart >= 0 ? skipRtfGroup(input, groupStart) : j;
      continue;
    }
    i = j;
  }
  flush();
  return out.join('');
}

/** HTML 伪装的 .doc：去脚本样式 → 块级标签断行 → 剥标签 → 反转义实体 */
function extractHtmlText(input: string): string {
  const withBreaks = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote|pre|td|th)\s*>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)\b[^>]*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// ===== 五、统一入口 =====

function sniffDocVariant(bytes: Uint8Array): 'cfb' | 'rtf' | 'html' | 'unknown' {
  if (isCfb(bytes)) return 'cfb';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(4096, bytes.length))).toLowerCase();
  const trimmed = head.replace(/^\uFEFF/, '').replace(/^[\s\u0000]+/, '');
  if (trimmed.startsWith('{\\rtf')) return 'rtf';
  if (/^<(!doctype\s+html|html|body|\?xml)/.test(trimmed) || /<html[\s>]|<body[\s>]/.test(trimmed)) return 'html';
  return 'unknown';
}

export async function extractDocText(arrayBuffer: ArrayBuffer): Promise<DocParseResult> {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 8) throw new Error('.doc 文件内容为空或已损坏');

  const variant = sniffDocVariant(bytes);
  let raw = '';
  let method = 'doc-local';
  if (variant === 'cfb') {
    raw = extractBinaryDoc(bytes);
  } else if (variant === 'rtf') {
    raw = extractRtfText(decodeTextBytes(bytes));
    method = 'doc-rtf';
  } else if (variant === 'html') {
    raw = extractHtmlText(decodeTextBytes(bytes));
    method = 'doc-html';
  } else {
    throw new Error('无法识别的 .doc 内容（既不是 Word 二进制、也不是 RTF/HTML），请用 Word 另存为 DOCX 或 PDF');
  }

  const text = normalizeDocText(raw);
  if (text.replace(/\s/g, '').length < 20) {
    throw new Error('DOC 文本提取为空（可能是纯图片 / 扫描版或加密文档），请改用 PDF、DOCX 或直接粘贴正文');
  }
  return { text, method, pageCount: 1 };
}
