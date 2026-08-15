// 移植自 F:\job-claw-main\source\src\pdf-extractor.js
// 纯前端 PDF 文本解析（支持 Flate/ASCIIHex/ASCII85/RunLength 解码、ToUnicode、CMap）
// 在 Electron 渲染进程（Chromium）中可直接运行。

const latin1Decoder = new TextDecoder('latin1');
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function normalizeLineBreaks(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const attempts = ['deflate', 'deflate-raw'];
  for (const format of attempts) {
    try {
      const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(format as CompressionFormat));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // PDF 生产者对是否带 zlib 头存在差异，尝试下一种格式
    }
  }
  throw new Error('无法解压 PDF 数据流');
}

function asciiHexDecode(bytes: Uint8Array): Uint8Array {
  const text = latin1Decoder.decode(bytes).replace(/\s+/g, '').replace(/>.*$/s, '');
  const clean = text.length % 2 ? `${text}0` : text;
  const output = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) {
    output[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16) || 0;
  }
  return output;
}

function ascii85Decode(bytes: Uint8Array): Uint8Array {
  const source = latin1Decoder.decode(bytes).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const output: number[] = [];
  let group: number[] = [];
  for (const char of source) {
    if (char === 'z' && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) continue;
    group.push(code - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      output.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
      group = [];
    }
  }
  if (group.length) {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const tail = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    output.push(...tail.slice(0, Math.max(0, originalLength - 1)));
  }
  return new Uint8Array(output);
}

function runLengthDecode(bytes: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < bytes.length; ) {
    const length = bytes[index++];
    if (length === 128) break;
    if (length < 128) {
      const count = length + 1;
      for (let offset = 0; offset < count && index < bytes.length; offset += 1) output.push(bytes[index++]);
    } else if (index < bytes.length) {
      const value = bytes[index++];
      for (let offset = 0; offset < 257 - length; offset += 1) output.push(value);
    }
  }
  return new Uint8Array(output);
}

function extractFilters(dictionary: string): string[] {
  const array = dictionary.match(/\/Filter\s*\[([^\]]+)\]/s)?.[1];
  if (array) return [...array.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
  const single = dictionary.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1];
  return single ? [single] : [];
}

async function decodeStream(bytes: Uint8Array, dictionary: string): Promise<Uint8Array> {
  let output = bytes;
  for (const filter of extractFilters(dictionary)) {
    if (filter === 'FlateDecode' || filter === 'Fl') output = await inflateBytes(output);
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') output = asciiHexDecode(output);
    else if (filter === 'ASCII85Decode' || filter === 'A85') output = ascii85Decode(output);
    else if (filter === 'RunLengthDecode' || filter === 'RL') output = runLengthDecode(output);
    else throw new Error(`暂不支持 PDF 过滤器 ${filter}`);
  }
  return output;
}

function findObjectRanges(source: string) {
  const starts = [...source.matchAll(/(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g)];
  const ranges: { id: number; generation: number; objectStart: number; bodyStart: number; bodyEnd: number }[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const objectStart = match.index + match[0].lastIndexOf(match[1]);
    const bodyStart = match.index + match[0].length;
    const nextStart = starts[index + 1]?.index ?? source.length;
    const endObject = source.lastIndexOf('endobj', nextStart);
    if (endObject < bodyStart) continue;
    ranges.push({ id: Number(match[1]), generation: Number(match[2]), objectStart, bodyStart, bodyEnd: endObject });
  }
  return ranges;
}

function numberFromDictionary(dictionary: string, name: string): number | null {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(dictionary || '').match(new RegExp(`/${escaped}\\s+(\\d+)\\b`));
  return match ? Number(match[1]) : null;
}

function expandObjectStreams(objects: Map<number, any>) {
  const compressed = [...objects.values()].filter(
    (object) => /\/Type\s*\/ObjStm\b/.test(object.dictionary || object.body || '') && object.decodedBytes?.length
  );
  for (const object of compressed) {
    const count = numberFromDictionary(object.dictionary, 'N');
    const first = numberFromDictionary(object.dictionary, 'First');
    if (count == null || first == null) continue;
    if (!Number.isInteger(count) || count <= 0 || count > 20000 || !Number.isInteger(first) || first < 0 || first >= object.decodedBytes.length) continue;
    const header = latin1Decoder.decode(object.decodedBytes.slice(0, first));
    const values = [...header.matchAll(/\d+/g)].map((m) => Number(m[0]));
    if (values.length < count * 2) continue;
    for (let index = 0; index < count; index += 1) {
      const id = values[index * 2];
      const offset = values[index * 2 + 1];
      const nextOffset = index + 1 < count ? values[(index + 1) * 2 + 1] : object.decodedBytes.length - first;
      const start = first + offset;
      const end = first + nextOffset;
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < first || end <= start || end > object.decodedBytes.length) continue;
      const bodyBytes = object.decodedBytes.slice(start, end);
      const body = latin1Decoder.decode(bodyBytes).trim();
      if (!body || objects.has(id)) continue;
      objects.set(id, {
        id,
        generation: 0,
        body,
        dictionary: body,
        decodedBytes: null,
        decodedText: '',
        compressedIn: object.id,
      });
    }
  }
}

async function parseObjects(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const source = latin1Decoder.decode(bytes);
  const objects = new Map<number, any>();
  for (const range of findObjectRanges(source)) {
    const body = source.slice(range.bodyStart, range.bodyEnd);
    const streamMatch = /stream(?:\r\n|\n|\r)/.exec(body);
    let dictionary = body;
    let decodedBytes: Uint8Array | null = null;
    let decodedText = '';
    if (streamMatch) {
      dictionary = body.slice(0, streamMatch.index);
      const absoluteStart = range.bodyStart + streamMatch.index + streamMatch[0].length;
      let absoluteEnd = source.indexOf('endstream', absoluteStart);
      if (absoluteEnd > absoluteStart) {
        while (absoluteEnd > absoluteStart && (bytes[absoluteEnd - 1] === 10 || bytes[absoluteEnd - 1] === 13)) absoluteEnd -= 1;
        const raw = bytes.slice(absoluteStart, absoluteEnd);
        try {
          decodedBytes = await decodeStream(raw, dictionary);
          decodedText = latin1Decoder.decode(decodedBytes);
        } catch {
          decodedBytes = raw;
          decodedText = latin1Decoder.decode(raw);
        }
      }
    }
    objects.set(range.id, { id: range.id, generation: range.generation, body, dictionary, decodedBytes, decodedText });
  }
  expandObjectStreams(objects);
  return { bytes, source, objects };
}

function decodeUtf16Hex(hex: string): string {
  const normalized = String(hex || '').replace(/\s+/g, '');
  if (!normalized) return '';
  const padded = normalized.length % 2 ? `${normalized}0` : normalized;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) bytes[index / 2] = Number.parseInt(padded.slice(index, index + 2), 16) || 0;
  let start = 0;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) start = 2;
  if ((bytes.length - start) >= 2 && (bytes.length - start) % 2 === 0) {
    let text = '';
    for (let index = start; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return text;
  }
  return utf8Decoder.decode(bytes);
}

function incrementHex(hex: string, offset: number): string {
  const width = hex.length;
  const value = BigInt(`0x${hex || '0'}`) + BigInt(offset);
  return value.toString(16).toUpperCase().padStart(width, '0');
}

function parseToUnicodeCMap(text: string) {
  if (!/begincmap/.test(text)) return null;
  const map = new Map<string, string>();
  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(pair[1].toUpperCase(), decodeUtf16Hex(pair[2]));
    }
  }
  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = section[1];
    const rangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]+)\])/g;
    for (const range of body.matchAll(rangePattern)) {
      const start = Number.parseInt(range[1], 16);
      const end = Number.parseInt(range[2], 16);
      const width = range[1].length;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 8192) continue;
      if (range[3]) {
        const destination = range[3].toUpperCase();
        for (let code = start; code <= end; code += 1) {
          map.set(code.toString(16).toUpperCase().padStart(width, '0'), decodeUtf16Hex(incrementHex(destination, code - start)));
        }
      } else {
        const values = [...String(range[4] || '').matchAll(/<([0-9A-Fa-f]+)>/g)].map((item) => item[1]);
        for (let code = start; code <= end; code += 1) {
          const value = values[code - start];
          if (value) map.set(code.toString(16).toUpperCase().padStart(width, '0'), decodeUtf16Hex(value));
        }
      }
    }
  }
  if (!map.size) return null;
  const lengths = [...new Set([...map.keys()].map((key) => key.length / 2))].sort((a, b) => b - a);
  return { map, lengths };
}

function findBalancedDictionary(text: string, markerIndex: number): string {
  const start = text.indexOf('<<', markerIndex);
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index + 1 < text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '<<') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '>>') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 2, index);
      index += 1;
    }
  }
  return '';
}

function collectFontResources(object: any, objects: Map<number, any>): Map<string, number> {
  const mappings = new Map<string, number>();
  const source = `${object.dictionary || ''}\n${object.body || ''}`;
  let cursor = 0;
  while ((cursor = source.indexOf('/Font', cursor)) >= 0) {
    const dictionary = findBalancedDictionary(source, cursor);
    if (dictionary) {
      for (const match of dictionary.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
        if (objects.has(Number(match[2]))) mappings.set(match[1], Number(match[2]));
      }
    }
    cursor += 5;
  }
  return mappings;
}

function decodeLiteralBytes(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index) & 255;
    if (code !== 92) {
      output.push(code);
      continue;
    }
    const next = value[index + 1];
    if (next == null) break;
    if (next === '\r' || next === '\n') {
      if (next === '\r' && value[index + 2] === '\n') index += 1;
      index += 1;
      continue;
    }
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (Object.prototype.hasOwnProperty.call(simple, next)) {
      output.push(simple[next]);
      index += 1;
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      let consumed = 1;
      while (consumed < 3 && /[0-7]/.test(value[index + 1 + consumed] || '')) {
        octal += value[index + 1 + consumed];
        consumed += 1;
      }
      output.push(Number.parseInt(octal, 8) & 255);
      index += consumed;
      continue;
    }
    output.push(next.charCodeAt(0) & 255);
    index += 1;
  }
  return new Uint8Array(output);
}

function hexToBytes(value: string): Uint8Array {
  const normalized = String(value || '').replace(/\s+/g, '');
  const padded = normalized.length % 2 ? `${normalized}0` : normalized;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) bytes[index / 2] = Number.parseInt(padded.slice(index, index + 2), 16) || 0;
  return bytes;
}

function bytesToHex(bytes: Uint8Array, start: number, length: number): string {
  let value = '';
  for (let index = start; index < start + length; index += 1) value += bytes[index].toString(16).toUpperCase().padStart(2, '0');
  return value;
}

function decodeWithCMap(bytes: Uint8Array, cmap: { map: Map<string, string>; lengths: number[] } | null): string {
  if (!cmap?.map?.size) return '';
  let output = '';
  for (let index = 0; index < bytes.length; ) {
    let found = false;
    for (const length of cmap.lengths) {
      if (index + length > bytes.length) continue;
      const key = bytesToHex(bytes, index, length);
      if (cmap.map.has(key)) {
        output += cmap.map.get(key);
        index += length;
        found = true;
        break;
      }
    }
    if (!found) {
      const byte = bytes[index++];
      if (byte >= 32 && byte !== 127) output += String.fromCharCode(byte);
    }
  }
  return output;
}

function candidateQuality(text: string): number {
  const compact = String(text || '').replace(/\s/g, '');
  if (!compact) return -1;
  const readable = (compact.match(/[\u3400-\u9fffA-Za-z0-9@+._/|:：，、·-]/g) || []).length;
  const bad = (compact.match(/[\x00-\x08\x0b\x0c\x0e-\x1f�]/g) || []).length;
  return (readable - bad * 2) / compact.length;
}

function decodePlainBytes(bytes: Uint8Array): string {
  const candidates: string[] = [];
  const utf8 = utf8Decoder.decode(bytes);
  candidates.push(utf8);
  candidates.push(latin1Decoder.decode(bytes));
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let utf16 = '';
    const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
    for (let index = start; index + 1 < bytes.length; index += 2) {
      utf16 += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    candidates.push(utf16);
  }
  candidates.sort((a, b) => candidateQuality(b) - candidateQuality(a));
  return candidates[0] || '';
}

function decodePdfString(token: string, cmap: { map: Map<string, string>; lengths: number[] } | null): string {
  const bytes = token.startsWith('<') ? hexToBytes(token.slice(1, -1)) : decodeLiteralBytes(token.slice(1, -1));
  return decodeWithCMap(bytes, cmap) || decodePlainBytes(bytes);
}

function tokenizeTextBlock(body: string): string[] {
  const pattern =
    /\/([^\s/<>\[\]()]+)\s+[-+]?\d*\.?\d+\s+Tf|\[(?:[^\]\\]|\\.|\((?:\\.|[^\\)])*\)|<[^>]*>)*\]\s*TJ|\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|<[0-9A-Fa-f\s]+>\s*(?:Tj|'|")|(?:T\*|[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+(?:Td|TD)|(?:[-+]?\d*\.?\d+\s+){6}Tm)/g;
  return [...body.matchAll(pattern)].map((m) => m[0]);
}

function extractMarkedContentText(content: string): string {
  const values: string[] = [];
  const pattern = /\/(?:ActualText|Alt)\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)/g;
  for (const match of String(content || '').matchAll(pattern)) {
    const decoded = decodePdfString(match[1], null).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
    if (decoded) values.push(decoded);
  }
  return normalizeLineBreaks(values.join('\n'));
}

function extractTextFromContent(content: string, fontMaps: Map<number, any>, resourceFonts: Map<string, number>): string {
  const lines: string[] = [];
  let currentLine = '';
  let currentFont: any = null;
  const pushLine = () => {
    const cleaned = currentLine.replace(/[ \t]+/g, ' ').trim();
    if (cleaned) lines.push(cleaned);
    currentLine = '';
  };
  for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
    for (const token of tokenizeTextBlock(block[1])) {
      const fontMatch = token.match(/^\/([^\s/<>\[\]()]+)\s+[-+]?\d*\.?\d+\s+Tf$/);
      if (fontMatch) {
        const fontObject = resourceFonts.get(fontMatch[1]);
        currentFont = fontObject ? fontMaps.get(fontObject) || null : null;
        continue;
      }
      if (/^(?:T\*|[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+(?:Td|TD)|(?:[-+]?\d*\.?\d+\s+){6}Tm)$/.test(token)) {
        pushLine();
        continue;
      }
      if (token.startsWith('[')) {
        const arrayBody = token.slice(1, token.lastIndexOf(']'));
        for (const item of arrayBody.matchAll(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>|[-+]?\d*\.?\d+/g)) {
          const value = item[0];
          if (value.startsWith('(') || value.startsWith('<')) currentLine += decodePdfString(value, currentFont);
          else if (Number(value) < -180) currentLine += ' ';
        }
      } else {
        const literal = token.match(/^(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)/)?.[1];
        if (literal) currentLine += decodePdfString(literal, currentFont);
        if (/\s(?:'|")$/.test(token)) pushLine();
      }
    }
    pushLine();
  }
  const operatorText = lines.join('\n');
  const markedText = extractMarkedContentText(content);
  if (markedText && (candidateQuality(markedText) > candidateQuality(operatorText) + 0.08 || operatorText.replace(/\s/g, '').length < 40)) {
    return markedText;
  }
  return operatorText;
}

function pageContentReferences(object: any) {
  const single = object.body.match(/\/Contents\s+(\d+)\s+\d+\s+R/)?.[1];
  if (single) return [Number(single)];
  const array = object.body.match(/\/Contents\s*\[([^\]]+)\]/s)?.[1];
  return array ? [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [];
}

function resolveResources(object: any, objects: Map<number, any>, depth = 0): Map<string, number> {
  if (!object || depth > 8) return new Map();
  const direct = collectFontResources(object, objects);
  if (direct.size) return direct;
  const resourceRef = object.body.match(/\/Resources\s+(\d+)\s+\d+\s+R/)?.[1];
  if (resourceRef && objects.has(Number(resourceRef))) {
    const referenced = collectFontResources(objects.get(Number(resourceRef)), objects);
    if (referenced.size) return referenced;
  }
  const parentRef = object.body.match(/\/Parent\s+(\d+)\s+\d+\s+R/)?.[1];
  return parentRef && objects.has(Number(parentRef))
    ? resolveResources(objects.get(Number(parentRef)), objects, depth + 1)
    : new Map();
}

function readableScore(text: string): number {
  const compact = String(text || '').replace(/\s/g, '');
  if (!compact) return 0;
  const readable = (compact.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  const controls = (compact.match(/[\x00-\x08\x0b\x0c\x0e-\x1f�]/g) || []).length;
  return Math.max(0, Math.min(1, readable / compact.length - controls / compact.length));
}

export interface PdfExtractResult {
  text: string;
  method: string;
  confidence: number;
  pageCount: number;
  fontMapCount: number;
}

export async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<PdfExtractResult> {
  const { objects } = await parseObjects(arrayBuffer);
  if (!objects.size) throw new Error('PDF 结构无法读取');

  const cmapByObject = new Map<number, any>();
  for (const object of objects.values()) {
    const cmap = parseToUnicodeCMap(object.decodedText || '');
    if (cmap) cmapByObject.set(object.id, cmap);
  }

  const fontMaps = new Map<number, any>();
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Font\b/.test(object.body) && !/\/Subtype\s*\/(?:Type0|TrueType|Type1|CIDFont)/.test(object.body)) continue;
    const toUnicode = object.body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1];
    if (toUnicode && cmapByObject.has(Number(toUnicode))) fontMaps.set(object.id, cmapByObject.get(Number(toUnicode)));
  }

  const pages = [...objects.values()]
    .filter((object) => /\/Type\s*\/Page\b/.test(object.body) && !/\/Type\s*\/Pages\b/.test(object.body))
    .sort((a, b) => a.id - b.id);
  const results: string[] = [];
  const processedStreams = new Set<number>();

  for (const page of pages) {
    const resourceFonts = resolveResources(page, objects);
    for (const reference of pageContentReferences(page)) {
      const stream = objects.get(reference);
      if (!stream?.decodedText) continue;
      processedStreams.add(reference);
      const text = extractTextFromContent(stream.decodedText, fontMaps, resourceFonts);
      if (text) results.push(text);
    }
  }

  if (!results.length) {
    const globalFonts = new Map<string, number>();
    for (const object of objects.values()) {
      for (const [name, reference] of collectFontResources(object, objects)) globalFonts.set(name, reference);
    }
    for (const object of objects.values()) {
      if (processedStreams.has(object.id) || !/\bBT\b/.test(object.decodedText || '')) continue;
      const text = extractTextFromContent(object.decodedText, fontMaps, globalFonts);
      if (text) results.push(text);
    }
  }

  const text = normalizeLineBreaks(results.join('\n'));
  return {
    text,
    method: fontMaps.size ? 'pdf-unicode-map' : 'pdf-content-stream',
    confidence: readableScore(text),
    pageCount: pages.length,
    fontMapCount: fontMaps.size,
  };
}

export function isReadableResumeText(text: string): boolean {
  const compact = String(text || '').replace(/\s/g, '');
  if (compact.length < 40) return false;
  const score = readableScore(text);
  const semanticHints = (String(text).match(/简历|教育|经历|项目|技能|电话|邮箱|GitHub|工作|实习|resume|education|experience|skills/gi) || []).length;
  return score >= 0.54 && (semanticHints >= 1 || compact.length >= 220);
}
