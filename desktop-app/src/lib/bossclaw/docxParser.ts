// 纯前端 DOCX 文本解析（零 Node 依赖，可在 Electron 渲染进程 / Vite 中直接运行）
// DOCX 本质是 ZIP 容器：解析 ZIP 定位 word/document.xml，解压后提取 <w:t> 文本。
// 解压使用浏览器原生 DecompressionStream('deflate-raw')（与 pdfExtractor 同方案）。
// 逻辑对齐 F:\job-claw-main 的简历文本口径：段落 <w:p> 换行、<w:t> 提取文本。

const ZIP_LOCAL_HEADER = 0x04034b50; // "PK\x03\x04"
const ZIP_CENTRAL_HEADER = 0x02014b50; // "PK\x01\x02"（用于 zip64 尾部判断）

export interface DocxParseResult {
  text: string;
  method: string;
  pageCount: number;
}

function inflateDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
  return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf));
}

interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number; // 压缩数据在文件中的起始偏移
  encrypted: boolean;
}

// 解析 ZIP 的 local file headers，返回条目（兼容 data descriptor 场景，使用 central directory 补全大小）
function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  // 先找 central directory 位置（END OF CENTRAL DIRECTORY: PK\x05\x06），用于 zip64 / 尾部条目
  let eocd = -1;
  for (let i = Math.max(0, bytes.length - 22 - 65536); i < bytes.length - 21; i += 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      // 校验 EOCD 的 comment 长度是否覆盖到文件尾
      const commentLen = dv.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) { eocd = i; break; }
    }
  }
  const centralOffset = eocd >= 0 ? dv.getUint32(eocd + 16, true) : -1;

  // 读取 central directory 条目，建立 name -> sizes 映射（避免 data descriptor 大小未知的问题）
  const centralSizes = new Map<string, { method: number; compressedSize: number; uncompressedSize: number }>();
  if (centralOffset >= 0) {
    let p = centralOffset;
    while (p + 46 <= bytes.length && dv.getUint32(p, true) === ZIP_CENTRAL_HEADER) {
      const method = dv.getUint16(p + 10, true);
      const compressedSize = dv.getUint32(p + 20, true);
      const uncompressedSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const nameBytes = bytes.slice(p + 46, p + 46 + nameLen);
      const name = decodeZipName(nameBytes);
      centralSizes.set(name, { method, compressedSize, uncompressedSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  // 读取 local file headers
  while (offset + 30 <= bytes.length) {
    if (dv.getUint32(offset, true) !== ZIP_LOCAL_HEADER) break;
    const method = dv.getUint16(offset + 8, true);
    const flag = dv.getUint16(offset + 6, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const nameBytes = bytes.slice(offset + 30, offset + 30 + nameLen);
    const name = decodeZipName(nameBytes);
    const encrypted = (flag & 0x1) !== 0;
    const dataOffset = offset + 30 + nameLen + extraLen;
    const central = centralSizes.get(name);
    const compressedSize = central?.compressedSize ?? dv.getUint32(offset + 18, true);
    const uncompressedSize = central?.uncompressedSize ?? dv.getUint32(offset + 22, true);
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset, encrypted });
    offset = dataOffset + compressedSize;
  }
  return entries;
}

function decodeZipName(bytes: Uint8Array): string {
  // ZIP 文件名可能是 UTF-8（有 EFS 标志位时），此处统一按 UTF-8 尝试，失败退回 latin1
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function normalizeDocxText(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<DocxParseResult> {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 4 || new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== ZIP_LOCAL_HEADER) {
    throw new Error('不是有效的 DOCX 文件（ZIP 头缺失），请改用 TXT 或 PDF');
  }

  const entries = parseZipEntries(bytes);
  // 兼容不同打包器：优先 document.xml，其次 main document（docProps/app.xml 忽略）
  const documentEntry =
    entries.find((e) => e.name === 'word/document.xml') ||
    entries.find((e) => /^word\/document\d*\.xml$/.test(e.name));
  if (!documentEntry) throw new Error('DOCX 中未找到 word/document.xml，请改用 TXT 或 PDF');

  if (documentEntry.encrypted) throw new Error('该 DOCX 已加密，无法直接解析，请另存为未加密版本或 TXT');
  if (documentEntry.method !== 0 && documentEntry.method !== 8) {
    throw new Error(`暂不支持该 DOCX 的压缩方式（method=${documentEntry.method}），请改用 TXT`);
  }

  const raw = bytes.slice(
    documentEntry.dataOffset,
    documentEntry.dataOffset + documentEntry.compressedSize
  );
  const decoded = documentEntry.method === 0 ? raw : await inflateDeflate(raw);

  // 解析 XML，提取 <w:t> 文本；<w:p> 段落结束换行
  const xmlText = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
  const parts: string[] = [];
  for (const p of paragraphs) {
    const runs = Array.from(p.getElementsByTagName('w:t'));
    const line = runs.map((t) => t.textContent || '').join('');
    const trimmed = line.replace(/[ \t]+/g, ' ').trim();
    if (trimmed) parts.push(trimmed);
  }
  // 若 w:p 解析为空（如老式 DOCX 命名空间差异），退化为全文 <w:t> 拼接
  let text = parts.join('\n');
  if (!text) {
    const all = Array.from(doc.getElementsByTagName('w:t')).map((t) => t.textContent || '').join('');
    text = all;
  }
  const normalized = normalizeDocxText(text);
  if (normalized.length < 20) {
    throw new Error('DOCX 文本提取为空（可能是纯图片/扫描版），请改用 PDF 或直接粘贴正文');
  }
  return { text: normalized, method: 'docx-local', pageCount: 1 };
}
