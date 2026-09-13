// 导出落盘编排（唯一的 IO 层）—— 纯序列化在 statsExport.ts / statsReport.ts，这里只负责「写到哪」。
//
// 硬契约（需求明确要求）：
//   **每次导出都必须弹出系统保存对话框，由用户自己选择保存位置**。
//   因此这里不做「记住目录后静默写盘」，也没有任何默认落盘路径；
//   用户取消 → 返回 { canceled: true }，此时不产生文件、不报错、页面不弹失败提示。
//
// 环境降级：
//   - CSV 是纯文本，在纯浏览器（Vite dev / 无 electronApi）下退化为 Blob 下载，开发时可验证；
//   - PDF 依赖主进程 printToPDF，无 Electron 时明确提示「仅桌面端可用」，不假装成功。

import { electronApi } from '../electronApi';
import type { ExportKind } from './statsExport';

export type ExportOutcome =
  | { ok: true; kind: ExportKind; filePath: string; viaDownload?: boolean }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string };

/** 浏览器兜底：Blob 下载（文本已含 BOM） */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 保存 CSV：优先走系统保存对话框；无 Electron 时退化为浏览器下载 */
export async function saveCsvFile(filename: string, csvText: string, kind: ExportKind): Promise<ExportOutcome> {
  const fn = typeof window !== 'undefined' ? window.electron?.saveFile : undefined;
  if (!fn) {
    try {
      downloadText(filename, csvText, 'text/csv');
      return { ok: true, kind, filePath: filename, viaDownload: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  const r = await electronApi.saveFile(filename, csvText);
  if (r.canceled) return { ok: false, canceled: true };
  if (!r.ok || !r.filePath) return { ok: false, error: r.error || '保存失败' };
  return { ok: true, kind, filePath: r.filePath };
}

/** 保存 PDF 报表：仅桌面端可用（依赖主进程 printToPDF） */
export async function saveReportPdf(filename: string, html: string): Promise<ExportOutcome> {
  if (!electronApi.isReady()) {
    return { ok: false, error: 'PDF 报表仅桌面端可用' };
  }
  const r = await electronApi.saveReportPdf(filename, html);
  if (r.canceled) return { ok: false, canceled: true };
  if (!r.ok || !r.filePath) return { ok: false, error: r.error || 'PDF 生成失败' };
  return { ok: true, kind: 'report', filePath: r.filePath };
}

/** 在系统文件管理器中定位到刚导出的文件（供「打开所在文件夹」按钮使用） */
export async function revealFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
  return electronApi.showItem(filePath);
}
