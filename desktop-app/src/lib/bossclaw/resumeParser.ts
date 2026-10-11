// 统一简历解析入口（纯前端优先，桥接兜底）
// 对齐 job-claw-main 的解析口径，并借鉴 AI-BossJob 的「多重解析 + 明确降级提示」策略：
//   PDF  → 本地 pdfExtractor（Flate/ASCIIHex/ASCII85/RunLength + ToUnicode/CMap）
//   DOCX → 本地 docxParser（ZIP + XML，零依赖）；失败可尝试桥接 mammoth
//   DOC  → 本地 docParser（OLE2/CFB + FIB/CLX 分片；兼容 RTF / HTML 伪装的 .doc）→ 可尝试桥接
//   MD   → 本地 markdownToPlainText（标题/列表/表格/粗斜体等语法清洗为规整纯文本）
//   TXT  → 直接读取
// 所有路径在失败时都给出可操作的下一步建议，避免用户停在“解析失败”死胡同。

import { extractPdfText, isReadableResumeText } from './pdfExtractor';
import { extractDocxText } from './docxParser';
import { extractDocText } from './docParser';
import { decodeTextBytes } from './docParser';
import { markdownToPlainText } from './mdParser';

export interface ResumeParseResult {
  text: string;
  method: string;
  warnings: string[];
}

export interface BridgeFallback {
  (file: File, name: string): Promise<{ text: string; method: string }>;
}

export function resumeFileKind(name: string): 'pdf' | 'docx' | 'doc' | 'md' | 'text' | 'unsupported' {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.doc')) return 'doc';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text';
  return 'unsupported';
}

export async function parseResumeFile(file: File, bridgeFallback?: BridgeFallback): Promise<ResumeParseResult> {
  const kind = resumeFileKind(file.name);
  const warnings: string[] = [];

  if (kind === 'md') {
    // M-24：按字节读入并做编码兜底（原 file.text() 只按 UTF-8 解 → GBK 简历静默乱码）
    const raw = decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
    const cleaned = markdownToPlainText(raw);
    const text = (cleaned || raw).trim();
    if (!text) {
      warnings.push('Markdown 文件未提取到有效文本。可打开文件复制正文粘贴到文本框，或转为 TXT 后重新导入。');
      throw new Error('Markdown 解析结果为空');
    }
    return { text, method: 'markdown', warnings };
  }

  if (kind === 'text') {
    // M-24：同上，按字节解码（UTF-8 → GB18030 → cp1252 兜底）；并补「可读正文」提示
    const text = decodeTextBytes(new Uint8Array(await file.arrayBuffer())).trim();
    if (text && !isReadableResumeText(text)) {
      warnings.push('未识别到可靠的简历正文（可能是乱码或非文本内容），请检查文件编码，或直接复制正文粘贴。');
    }
    return { text, method: 'text', warnings };
  }

  if (kind === 'pdf') {
    const buf = await file.arrayBuffer();
    try {
      const res = await extractPdfText(buf);
      if (!res.text.trim()) throw new Error('PDF 中未提取到文本');
      if (!isReadableResumeText(res.text)) {
        warnings.push('PDF 文本可读度偏低：可能是扫描件或使用了特殊字体编码。建议改用 DOCX/TXT，或打开 PDF 后全选复制粘贴到文本框。');
      }
      return { text: res.text, method: res.method, warnings };
    } catch (err: any) {
      // 本地解析失败：尝试桥接（pdftotext / OCR）兜底
      if (bridgeFallback) {
        try {
          const r = await bridgeFallback(file, file.name);
          if (r.text && r.text.trim()) {
            warnings.push(`本地 PDF 解析未成功（${err?.message || '未知原因'}），已通过桥接解析（${r.method}）。`);
            return { text: r.text, method: r.method, warnings };
          }
        } catch {
          /* 桥接也不可用，落到下方提示 */
        }
      }
      warnings.push(
        `PDF 解析失败（${err?.message || '未知原因'}）。可直接打开 PDF 全选复制粘贴到文本框，或转换为 DOCX/TXT 后重新导入。`
      );
      throw new Error(`PDF 解析失败：${err?.message || '未知原因'}`);
    }
  }

  if (kind === 'docx') {
    const buf = await file.arrayBuffer();
    // 优先 mammoth（官方浏览器版，表格/文本框/页眉页脚提取更完整），失败回退自写 ZIP+XML 解析
    try {
      const mammoth = await import('mammoth/mammoth.browser.js');
      const extract = (mammoth as any)?.default?.extractRawText || (mammoth as any)?.extractRawText;
      if (typeof extract === 'function') {
        const { value } = await extract({ arrayBuffer: buf });
        const text = String(value || '');
        if (text.trim()) {
          if (!isReadableResumeText(text)) {
            warnings.push('DOCX 文本可读度偏低，请检查文件是否为纯图片排版，或直接粘贴正文。');
          }
          return { text: text.trim(), method: 'mammoth', warnings };
        }
      }
    } catch {
      /* 回退本地解析 */
    }
    try {
      const res = await extractDocxText(buf);
      if (!isReadableResumeText(res.text)) {
        warnings.push('DOCX 文本可读度偏低，请检查文件是否为纯图片排版，或直接粘贴正文。');
      }
      return { text: res.text, method: res.method, warnings };
    } catch (err: any) {
      if (bridgeFallback) {
        try {
          const r = await bridgeFallback(file, file.name);
          if (r.text && r.text.trim()) {
            warnings.push(`本地 DOCX 解析未成功（${err?.message || '未知原因'}），已通过桥接解析（${r.method}）。`);
            return { text: r.text, method: r.method, warnings };
          }
        } catch {
          /* 桥接不可用 */
        }
      }
      warnings.push('DOCX 解析失败。可打开 Word 全选复制粘贴到文本框；或使用“另存为 PDF / TXT”后重新导入。');
      throw new Error(`DOCX 解析失败：${err?.message || '未知原因'}`);
    }
  }

  if (kind === 'doc') {
    // 旧版 .doc：本地解析（OLE2 二进制 / RTF / HTML 三种真实载体都能识别），失败再走桥接转换
    const buf = await file.arrayBuffer();
    try {
      const res = await extractDocText(buf);
      if (!isReadableResumeText(res.text)) {
        warnings.push('DOC 文本可读度偏低：可能是纯图片排版或扫描件。建议改用 DOCX/PDF，或打开 Word 全选复制粘贴到文本框。');
      }
      return { text: res.text, method: res.method, warnings };
    } catch (err: any) {
      if (bridgeFallback) {
        try {
          const r = await bridgeFallback(file, file.name);
          if (r.text && r.text.trim()) {
            warnings.push(`本地 DOC 解析未成功（${err?.message || '未知原因'}），已通过桥接解析（${r.method}）。`);
            return { text: r.text, method: r.method, warnings };
          }
        } catch {
          /* 桥接也不可用，落到下方提示 */
        }
      }
      warnings.push(
        `DOC 解析失败（${err?.message || '未知原因'}）。可在 Word 中「另存为」DOCX / PDF / TXT 后重新导入，或直接全选复制粘贴到文本框。`
      );
      throw new Error(`DOC 解析失败：${err?.message || '未知原因'}`);
    }
  }

  throw new Error('仅支持 PDF / DOCX / DOC / MD / TXT 文件');
}
