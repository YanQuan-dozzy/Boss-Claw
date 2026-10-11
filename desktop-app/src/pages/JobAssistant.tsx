/**
 * 【主模块：定制简历】导航 key = 'assistant'
 * 子模块：
 * - 岗位信息卡（岗位多选下拉：选 1 个带入单岗，选多个进入批量定制 / 岗位名称 / 岗位要求 + 「AI 生成定制简历」）
 * - 经历补充材料卡（tailor-materials-card：PDF/DOCX/DOC/MD/TXT 导入真实经历，仅参与定制与要点判定）
 * - 定制结果（TailorResultView：七模块 doc + 匹配评分 + 要点对照 + 求职信，可导出 PDF / 存打招呼语）
 * - 历史定制记录（本地最近 HISTORY_MAX 条，可载入/删除）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Avatar, Button, Card, Checkbox, Divider, Form, Input, List, Modal, Progress, Radio, Select, Space, Tag, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  RobotOutlined, FileTextOutlined, LoadingOutlined,
  DeleteOutlined, HistoryOutlined, ExclamationCircleOutlined,
  DownloadOutlined, CameraOutlined, UploadOutlined, ArrowUpOutlined, ArrowDownOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { appendTailorSupplement, tailorForJob, writeTailorPointSupplement, type TailorJdPoint, type TailorResult } from '@/lib/bossclaw/jobAssistant';
import { computeMatchScore, extractJdKeywords } from '@/lib/bossclaw/resumeMatch';
import { stableProfileView } from '@/lib/bossclaw/matching';
import { cleanJobDescription, jdLooksNoisy } from '@/lib/bossclaw/jdCleaner';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import { buildResumeHtml, defaultPdfFileName, RESUME_TEMPLATES, isKnownTemplate } from '@/lib/bossclaw/resumePdf';
import { buildResumeDocData, extractContactInfo, RESUME_SECTION_META } from '@/lib/bossclaw/resumeContact';
import { parseResumeFile } from '@/lib/bossclaw/resumeParser';
import { bridgeParseResume } from '@/lib/bridgeClient';
import { markPersistDirty } from '@/lib/persistSafe';
import { TailorResultView } from '@/components/TailorResultView';
import { buildTailorJobInput, listTailorJobs, tailorJobLabel } from '@/lib/bossclaw/tailorJob';
import type { JobMeta, PendingItem } from '@/lib/bossclaw/types';
import { batchPdfFileName, createTailorBatch, runTailorBatch, TAILOR_HISTORY_MAX, upsertTailorHistory, type TailorBatchItem, type TailorHistoryItem } from '@/lib/bossclaw/tailorBatch';

const { Text } = Typography;

// ===== 经历补充材料：解析兜底（DOCX/PDF/DOC 本地失败时走桥接 mammoth / pdftotext / 转档） =====
const materialBridgeFallback = async (file: File, name: string) => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  const r = await bridgeParseResume(dataUrl, name);
  if (!r.ok || !r.text) throw new Error(r.error || '桥接解析失败');
  return { text: r.text, method: r.method || 'bridge' };
};

// ===== 历史定制记录（本地持久化，最近 200 条） =====
const HISTORY_KEY = 'bossclaw-tailor-history-v1';
const HISTORY_MAX = TAILOR_HISTORY_MAX;

function loadHistory(): TailorHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as TailorHistoryItem[];
    }
  } catch {
    /* 数据损坏则重建 */
  }
  return [];
}

function saveHistory(list: TailorHistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    markPersistDirty(HISTORY_KEY);
  } catch {
    message.warning('历史记录未能写入本地存储，请先导出已生成的简历');
  }
}

// ===== 内容模块顺序（用户可上下移动，持久化） =====
const MODULE_ORDER_KEY = 'bossclaw-resume-module-order-v1';

/** 读取模块顺序并做健壮化：补齐缺失 id、剔除未知 id（模板升级后不会错位） */
function loadModuleOrder(): string[] {
  const defaults = RESUME_SECTION_META.map((m) => m.id);
  try {
    const raw = localStorage.getItem(MODULE_ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const known = parsed.map(String).filter((id) => defaults.includes(id));
        const missing = defaults.filter((id) => !known.includes(id));
        const merged = [...known, ...missing];
        if (merged.length === defaults.length) return merged;
      }
    }
  } catch {
    /* 数据损坏则回落默认顺序 */
  }
  return defaults;
}

function saveModuleOrder(order: string[]): void {
  try {
    localStorage.setItem(MODULE_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* 存储不可用时静默降级 */
  }
}

const scoreColor = (s: number) => (s >= 80 ? 'green' : s >= 60 ? 'orange' : 'red');

const formatTime = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function JobAssistant() {
  const pending = useDataStore(useShallow((s) => s.pending));
  const profile = useDataStore((s) => s.profile);
  const resumeText = useDataStore((s) => s.resumeText);
  const setGreetings = useDataStore((s) => s.setGreetings);
  const config = useSettingsStore(useShallow((s) => s.config));

  const [jobTitle, setJobTitle] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  // 岗位选择：0 个 = 手填；1 个 = 单岗带入；≥2 个 = 同时把所选岗位填入批量定制列表
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const importId = selectedJobIds.length === 1 ? selectedJobIds[0] : undefined;
  const [importedJob, setImportedJob] = useState<JobMeta | null>(null);
  const [importedSource, setImportedSource] = useState<'description' | 'card' | 'metadata' | null>(null);
  const importableJobs = useMemo(() => listTailorJobs(pending, selectedJobIds), [pending, selectedJobIds]);
  // 从工作台导入的岗位分析分（AI 优先），用于匹配分数展示；AI 未配置时回退本地计算
  const [importedScore, setImportedScore] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [tailor, setTailor] = useState<TailorResult | null>(null);
  const [supplementDraft, setSupplementDraft] = useState('');
  const [batchResultId, setBatchResultId] = useState<string | undefined>();
  const [historyJobId, setHistoryJobId] = useState<string | undefined>();
  const [history, setHistory] = useState<TailorHistoryItem[]>(() => loadHistory());
  const historyRef = useRef(history);
  const generationLock = useRef(false);
  const batchStop = useRef(false);
  const [batchItems, setBatchItems] = useState<TailorBatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStopping, setBatchStopping] = useState(false);

  const recordHistory = (job: { jobId?: string; company?: string; job?: JobMeta; jobTitle: string; jobDesc: string }, result: TailorResult) => {
    const item: TailorHistoryItem = { ...job, result, id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() };
    const next = upsertTailorHistory(historyRef.current, item);
    historyRef.current = next;
    setHistory(next);
    saveHistory(next);
  };

  const applyImportedJob = useCallback((p: PendingItem, selection: string[] = [p.id]) => {
    const input = buildTailorJobInput(p.job);
    setSelectedJobIds(selection);
    setImportedJob(input.job);
    setImportedSource(input.source);
    setImportedScore(p.analysis?.scoreSource === 'local' ? null : p.analysis?.score ?? null);
    setJobTitle(input.jobTitle);
    setJobDesc(input.jobDesc);
    setTailor(null);
    setSupplementDraft('');
    setBatchResultId(undefined);
    setHistoryJobId(undefined);
  }, []);

  /** 岗位下拉（多选）：1 个 = 单岗带入；≥2 个 = 同时把所选岗位填入批量定制列表。 */
  const onSelectJobs = (ids: string[]) => {
    const next = [...new Set(ids)];
    const current = useDataStore.getState().pending;
    if (!next.length) {
      setSelectedJobIds([]);
      setImportedJob(null);
      setImportedSource(null);
      setImportedScore(null);
      setJobTitle('');
      setJobDesc('');
      setTailor(null);
      setSupplementDraft('');
      setBatchResultId(undefined);
      setHistoryJobId(undefined);
      setBatchItems([]);
      return;
    }
    const first = current.find((p) => p.id === next[0]);
    if (first) applyImportedJob(first, next);
    if (next.length > 1) {
      const items = createTailorBatch(current, next);
      setBatchItems(items);
      setBatchStopping(false);
      if (items.length < next.length) message.warning('已跳过已移除的岗位');
    } else {
      setBatchItems([]);
    }
  };

  // ===== 导出定制简历 PDF =====
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportTailor, setExportTailor] = useState<TailorResult | null>(null);
  const [exportBatch, setExportBatch] = useState<TailorBatchItem[]>([]);
  const exportRequestId = useRef('');
  const [exportProgress, setExportProgress] = useState({ completed: 0, total: 0 });
  const [exportStopping, setExportStopping] = useState(false);
  const [exportReport, setExportReport] = useState<{ written: number; failed: number; stopped: boolean; firstPath?: string; errors: string[] } | null>(null);
  useEffect(() => window.electron?.onPdfBatchProgress?.((progress) => {
    if (progress.requestId === exportRequestId.current) setExportProgress(progress);
  }), []);
  const [exportSections, setExportSections] = useState<string[]>(RESUME_SECTION_META.filter((m) => m.default).map((m) => m.id));
  const [exportForm] = Form.useForm();

  // 内容模块顺序（可上下移动，持久化到 localStorage）：导出时按此顺序输出模块
  const [moduleOrder, setModuleOrder] = useState<string[]>(() => loadModuleOrder());
  const moveModule = (idx: number, dir: -1 | 1) => {
    setModuleOrder((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      saveModuleOrder(next);
      return next;
    });
  };

  // ===== 经历补充材料（简历里没写、但本人真实具备的经历文件）=====
  // 口径：只记文件绝对路径（会话内存态，不持久化）；正文**每次调用 AI 前现读磁盘并重新解析**，
  // 所以用户在外部改了素材文件即时生效，应用内不保存任何素材内容副本。
  const materials = useDataStore(useShallow((s) => s.experienceMaterials));
  const addExperienceMaterial = useDataStore((s) => s.addExperienceMaterial);
  const removeExperienceMaterial = useDataStore((s) => s.removeExperienceMaterial);
  const [materialBusy, setMaterialBusy] = useState(false);

  /** 现读一份补充材料：从磁盘读 → 复用既有解析链路（PDF 文本层 / DOCX / 纯文本） */
  const readMaterialText = async (m: { name: string; path: string }): Promise<string> => {
    const api = (window as any).electron as any;
    if (!api?.materialRead) throw new Error('当前环境不支持按路径读取文件');
    const r = await api.materialRead(m.path);
    if (!r?.ok || !r?.dataUrl) throw new Error(r?.error || '读取失败');
    const blob = await (await fetch(r.dataUrl)).blob();
    const file = new File([blob], r.name || m.name);
    const parsed = await parseResumeFile(file, materialBridgeFallback);
    return String(parsed.text || '').trim();
  };

  /** 现读全部补充材料并拼成注入文本（每次调用都重新读，不缓存） */
  const resolveMaterialsText = async (): Promise<string> => {
    if (!materials.length) return '';
    const parts: string[] = [];
    for (const m of materials) {
      try {
        const text = await readMaterialText(m);
        if (text) parts.push(`【补充材料：${m.name}】\n${text}`);
      } catch (e: any) {
        message.warning(`补充材料「${m.name}」读取失败：${getErrorMessage(e)}`);
      }
    }
    return parts.join('\n\n');
  };

  /** 选择补充经历文件（系统对话框，可多选；仅记路径，不读内容） */
  const onPickMaterial = async () => {
    const api = (window as any).electron as any;
    if (!api?.materialPick) {
      message.warning('当前环境不支持系统文件选择，请在桌面应用中使用');
      return;
    }
    setMaterialBusy(true);
    try {
      const r = await api.materialPick();
      if (!r?.ok) {
        if (!r?.canceled) message.error(r?.error || '选择文件失败');
        return;
      }
      const paths = r.paths || [];
      const before = useDataStore.getState().experienceMaterials.length;
      for (const p of paths) addExperienceMaterial({ name: p.name, path: p.path });
      const added = useDataStore.getState().experienceMaterials.length - before;
      message.success(
        added > 0
          ? `已添加 ${added} 份经历补充材料（调用 AI 时才读取内容，文件改动即时生效）`
          : '所选文件已在列表中'
      );
    } finally {
      setMaterialBusy(false);
    }
  };

  // 模板选择（持久化到 localStorage，下次打开沿用）
  const TEMPLATE_KEY = 'bossclaw-resume-template-v1';
  const [templateId, setTemplateId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TEMPLATE_KEY);
      if (saved && isKnownTemplate(saved)) return saved;
    } catch { /* 忽略存储异常 */ }
    return 'classic';
  });
  const setTemplate = (id: string) => {
    setTemplateId(id);
    try { localStorage.setItem(TEMPLATE_KEY, id); } catch { /* 忽略 */ }
  };
  const batchJobIncluded = (item: TailorBatchItem) =>
    !!useDataStore.getState().pending.find((p) => p.id === item.id);

  // ===== 个人照片（选填，压缩后持久化；未上传时不渲染照片框） =====
  const PHOTO_KEY = 'bossclaw-resume-photo-v1';
  const [photo, setPhoto] = useState<string>(() => {
    try { return localStorage.getItem(PHOTO_KEY) || ''; } catch { return ''; }
  });
  const setPhotoPersist = (dataUrl: string) => {
    setPhoto(dataUrl);
    try {
      if (dataUrl) localStorage.setItem(PHOTO_KEY, dataUrl);
      else localStorage.removeItem(PHOTO_KEY);
    } catch { /* localStorage 满则忽略（本次仍生效） */ }
  };

  /** 照片压缩：等比缩到最长边 360px，JPEG 0.85，控制体积（证件照足够清晰） */
  const compressPhoto = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 360;
          let { width, height } = img;
          if (width > max || height > max) {
            const scale = max / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('Canvas 不可用')); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = String(reader.result);
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

  /** 打开导出对话框：以提取的联系信息为初值（须用户确认），章节默认勾选 */
  const openExport = (result: TailorResult, title: string) => {
    setExportBatch([]);
    setExportReport(null);
    setExportTailor(result);
    const c = extractContactInfo(resumeText, title);
    exportForm.setFieldsValue({
      name: c.name,
      phone: c.phone,
      email: c.email,
      targetTitle: c.targetTitle || title,
    });
    setExportSections(RESUME_SECTION_META.filter((m) => m.default).map((m) => m.id));
    setExportOpen(true);
  };

  const openBatchExport = () => {
    const completed = batchItems.filter((item) => item.result && batchJobIncluded(item));
    if (!completed.length) return;
    openExport(completed[0].result!, completed[0].jobTitle);
    setExportBatch(completed);
    exportForm.setFieldValue('targetTitle', '各自对应的岗位名称');
  };

  /** 渲染 A4 HTML → 经主进程 printToPDF 保存（无 Electron 时降级下载 HTML 自行打印） */
  const onExportPdf = async () => {
    if (!exportTailor) return;
    let values: { name: string; phone: string; email: string; targetTitle: string };
    try {
      values = await exportForm.validateFields();
    } catch {
      return; // 校验失败（必填缺失），antd 已展示错误
    }
    setExporting(true);
    try {
      // 模块顺序 = 用户在弹窗里调整的顺序（先按顺序过滤，再按勾选过滤）
      const orderedIds = moduleOrder.filter((id) => exportSections.includes(id));
      const api = window.electron;
      if (exportBatch.length) {
        if (!api?.savePdfBatch) { message.warning('批量 PDF 导出需要在桌面版中使用'); return; }
        if (!orderedIds.length) { message.warning('请至少勾选一个有内容的模块'); return; }
        const files: Array<{ fileName: string; html: string }> = [];
        const empty: string[] = [];
        exportBatch.forEach((item, index) => {
          if (!batchJobIncluded(item)) return;
          const data = buildResumeDocData(resumeText, profile, item.result!, { ...values, targetTitle: item.jobTitle }, orderedIds);
          if (!data.modules.length) { empty.push(item.jobTitle); return; }
          if (photo) data.photo = photo;
          files.push({ fileName: batchPdfFileName(values.name, item.jobTitle, item.job.company || '', index), html: buildResumeHtml(data, templateId) });
        });
        if (!files.length) { message.warning('所选模块没有可导出的内容'); return; }
        if (empty.length) message.warning(`已跳过 ${empty.length} 份没有所选模块内容的结果`);
        exportRequestId.current = `resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setExportProgress({ completed: 0, total: files.length });
        setExportStopping(false);
        setExportReport(null);
        const r = await api.savePdfBatch(files, exportRequestId.current);
        const results = r.results || [];
        if (r.canceled && !results.length) return;
        if (r.error && !results.length) { message.error(r.error); return; }
        const written = results.filter((item) => item.ok);
        const failed = results.filter((item) => !item.ok);
        setExportReport({ written: written.length, failed: failed.length, stopped: Boolean(r.canceled),
          firstPath: written[0]?.filePath, errors: [...failed.map((item) => `${item.fileName}：${item.error}`), ...(r.error ? [r.error] : [])] });
        if (r.ok) message.success(`已保存 ${written.length} 份简历到 ${r.directory}`);
        else message.warning(`已保存 ${written.length} 份${failed.length ? `，${failed.length} 份失败` : ''}${r.canceled ? '，剩余文件已停止导出' : ''}`);
        return;
      }
      const data = buildResumeDocData(resumeText, profile, exportTailor, values, orderedIds);
      if (!data.modules.length) {
        message.warning('没有可导出的模块内容，请至少勾选一个有内容的模块');
        return;
      }
      if (photo) data.photo = photo;
      const html = buildResumeHtml(data, templateId);
      const fileName = defaultPdfFileName(data.contact);
      if (api?.savePdf) {
        const r = await api.savePdf(fileName, html);
        if (r?.canceled) return;
        if (r?.ok) message.success(`已保存：${r.filePath}`);
        else message.error(`保存失败：${r?.error || '未知原因'}`);
      } else {
        // 浏览器降级：下载 HTML，提示用浏览器「打印 → 另存为 PDF」
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName.replace(/\.pdf$/i, '.html');
        a.click();
        URL.revokeObjectURL(url);
        message.info(`已生成 ${fileName.replace(/\.pdf$/i, '.html')}，请用浏览器打开后「打印 → 另存为 PDF」`);
      }
    } catch (e: any) {
      message.error('导出失败：' + getErrorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const hasResume = Boolean(resumeText && resumeText.trim().length > 0);
  const canGenerate = Boolean(jobTitle.trim() && jobDesc.trim() && hasResume);

  // 实时匹配度预览：优先 AI（工作台导入分）；AI 未配置时回退本地确定性计算（不调用 AI）
  const aiConfigured = Boolean(config.model?.apiKey);
  const liveMatch = useMemo(() => {
    if (!jobDesc.trim() || !hasResume) return null;
    const { keywords, weights } = extractJdKeywords(jobDesc, profile);
    const profileBlob = profile ? JSON.stringify(stableProfileView(profile)) : '';
    return computeMatchScore(keywords, weights, `${resumeText}\n${profileBlob}`);
  }, [jobDesc, resumeText, hasResume, profile]);
  // 匹配分数取值：AI 已配置且有工作台导入分 → 用 AI 分；否则用本地计算分兜底
  const currentMatchScore = useMemo(() => {
    if (aiConfigured && importedScore != null) return importedScore;
    return liveMatch ? liveMatch.score : null;
  }, [aiConfigured, importedScore, liveMatch]);
  const scoreSource: 'ai' | 'local' = aiConfigured && importedScore != null ? 'ai' : 'local';

  const onEditJob = (field: 'title' | 'description', value: string) => {
    if (field === 'title') setJobTitle(value);
    else {
      setJobDesc(value);
      // 用户修改公司/薪资/地点等标签后，以输入内容为准，避免原结构化字段覆盖编辑。
      setImportedJob(null);
      setImportedSource(null);
    }
    // 修改要求后不能继续把原岗位的分析分当作当前分数，也不能展示上一次定制结果。
    setImportedScore(null);
    setTailor(null);
    setSupplementDraft('');
    setBatchResultId(undefined);
    setHistoryJobId(undefined);
  };

  const onGenerate = async (supplement?: string, clearMainDraft = true): Promise<boolean> => {
    if (generationLock.current || exporting) return false;
    if (supplement !== undefined && !supplement.trim()) { message.warning('请先填写要补充的内容'); return false; }
    if (importId) {
      const current = useDataStore.getState().pending.find((p) => p.id === importId);
      if (!current) { message.warning('该岗位已从工作台移除，请重新选择'); return false; }
    }
    if (!canGenerate) {
      message.warning(!hasResume ? '请先在「简历中心」上传/粘贴简历并生成职业画像' : '请填写岗位名称与岗位要求');
      return false;
    }
    generationLock.current = true;
    setGenerating(true);
    try {
      const job: JobMeta = { ...importedJob, title: jobTitle.trim(), description: jobDesc.trim() };
      // 经历补充材料每次调用前现读磁盘（不缓存内容），随定制与要点判定一并送入 AI
      const extraText = await resolveMaterialsText();
      const supplements = appendTailorSupplement(tailor?.supplements, supplement || '');
      const r = await tailorForJob(
        job,
        resumeText,
        profile,
        config.model,
        useDataStore.getState().greetingPrompt || undefined,
        extraText || undefined,
        { supplements, previousResult: tailor || undefined }
      );
      // 迭代失败保留上一版和待提交文本，用户可以直接重试。
      if (tailor && r.method === 'local') {
        message.warning(`${r.warning || 'AI 未能完成重新生成'} 上一版与本轮补充已保留，请重试。`);
        return false;
      }
      setTailor(r);
      if (supplement !== undefined && clearMainDraft) setSupplementDraft('');
      if (batchResultId) setBatchItems((items) => items.map((item) => item.id === batchResultId
        ? { ...item, result: r, status: r.method === 'ai' ? 'done' : 'local', error: undefined } : item));
      recordHistory({ jobId: importId || historyJobId, company: job.company, job, jobTitle: jobTitle.trim(), jobDesc: jobDesc.trim() }, r);
      if (supplement !== undefined) message.success('已结合全部补充重新生成，可继续补充或导出 PDF');
      if (r.method === 'local' && r.warning) message.info(r.warning);
      return true;
    } catch (e: any) {
      message.error('定制失败：' + getErrorMessage(e));
      return false;
    } finally {
      generationLock.current = false;
      setGenerating(false);
    }
  };

  const onHelpWritePoint = async (point: TailorJdPoint, text: string) => {
    if (generationLock.current || exporting) throw new Error('请等待当前操作完成');
    generationLock.current = true;
    setGenerating(true);
    try {
      const extraMaterials = await resolveMaterialsText();
      return await writeTailorPointSupplement({
        point, text, job: { ...importedJob, title: jobTitle.trim(), description: jobDesc.trim() },
        resumeText, profile, model: config.model, extraMaterials, supplements: tailor?.supplements,
      });
    } finally {
      generationLock.current = false;
      setGenerating(false);
    }
  };

  const onGenerateBatch = async () => {
    if (generationLock.current || exporting) return;
    if (!hasResume) { message.warning('请先在简历中心上传简历并生成职业画像'); return; }
    if (!batchItems.some((item) => !item.result)) return;
    generationLock.current = true;
    batchStop.current = false;
    setBatchStopping(false);
    setBatchRunning(true);
    setGenerating(true);
    try {
      await runTailorBatch(batchItems, async (item) => {
        const extra = await resolveMaterialsText();
        return tailorForJob(item.job, resumeText, profile, config.model, useDataStore.getState().greetingPrompt || undefined, extra || undefined);
      }, {
        shouldStop: () => batchStop.current,
        shouldSkip: (item) => batchJobIncluded(item) ? undefined : '该岗位已从工作台移除',
        onUpdate: (next) => setBatchItems((previous) => previous.map((item) => item.id === next.id ? next : item)),
        onResult: (item) => recordHistory({ jobId: item.id, company: item.job.company, job: item.job, jobTitle: item.jobTitle, jobDesc: item.jobDesc }, item.result),
      });
    } catch (error) { message.error('批量定制失败：' + getErrorMessage(error)); }
    finally {
      generationLock.current = false;
      setGenerating(false);
      setBatchRunning(false);
    }
  };

  const showBatchResult = (item: TailorBatchItem) => {
    if (generating || !item.result) return;
    setSelectedJobIds([item.id]);
    setImportedJob(item.job);
    setImportedSource(item.source);
    setImportedScore(null);
    setJobTitle(item.jobTitle);
    setJobDesc(item.jobDesc);
    setTailor(item.result);
    setSupplementDraft('');
    setBatchResultId(item.id);
    setHistoryJobId(undefined);
  };

  const onLoadHistory = (h: TailorHistoryItem) => {
    if (generating) return;
    setSelectedJobIds([]);
    setImportedJob(h.job || { title: h.jobTitle, description: h.jobDesc, company: h.company });
    setImportedSource(null);
    setImportedScore(null);
    setJobTitle(h.jobTitle);
    setJobDesc(h.jobDesc);
    setTailor(h.result);
    setSupplementDraft('');
    setBatchResultId(batchItems.find((item) => item.id === h.jobId && item.jobTitle === h.jobTitle && item.jobDesc === h.jobDesc)?.id);
    setHistoryJobId(h.jobId);
    message.success('已载入历史定制结果');
  };

  const onRemoveHistory = (id: string) => {
    const next = historyRef.current.filter((h) => h.id !== id);
    historyRef.current = next;
    setHistory(next);
    saveHistory(next);
  };

  const onSaveCoverLetter = () => {
    if (!tailor?.coverLetter) return;
    setGreetings([tailor.coverLetter, ...(useDataStore.getState().greetings || [])]);
    message.success('已存入打招呼语列表（可在「自动沟通」中选用）');
  };

  const batchReady = batchItems.filter((item) => item.result && batchJobIncluded(item)).length;
  const batchFailed = batchItems.filter((item) => item.status === 'failed').length;
  const batchLocal = batchItems.filter((item) => item.status === 'local').length;
  const currentBatchItem = batchItems.find((item) => item.status === 'running');
  const batchLabels = { queued: '待生成', running: '生成中', done: 'AI 已生成', local: '本地结果', failed: '失败', stopped: '已停止', filtered: '已筛除' };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <RobotOutlined className="page-title-icon" />定制简历
          </h1>
          <p className="page-sub">
            直接选择工作台筛选的岗位，AI 基于简历生成定制内容：匹配评分、要点对照、重点经历、
            求职打招呼语与优化建议，并可一键导出适配的简历 PDF。
          </p>
        </div>
      </div>

      {batchItems.length > 0 && (
        <Card className="tailor-batch-card" size="small" style={{ marginBottom: 16 }} title={<Space><RobotOutlined />批量定制简历<Tag>{batchItems.length} 个岗位</Tag><Tooltip title="逐岗串行生成并保存历史；单岗失败不影响后续岗位，可随时停止或续跑，完成后可一次导出 PDF。"><QuestionCircleOutlined style={{ fontSize: 13, opacity: 0.65 }} /></Tooltip></Space>}>
          <div style={{ margin: '12px 0' }}>
            <Progress percent={Math.round(batchReady / batchItems.length * 100)} status={batchRunning ? 'active' : batchFailed ? 'exception' : undefined} />
            <Text>已生成 {batchReady}/{batchItems.length}{batchLocal ? `（其中 ${batchLocal} 份本地结果）` : ''}{batchFailed ? `，失败 ${batchFailed} 个` : ''}</Text>
            {currentBatchItem && <div><Text type="secondary">正在处理：{currentBatchItem.jobTitle} · {currentBatchItem.job.company || '未知公司'}</Text></div>}
          </div>
          <Space wrap style={{ marginBottom: 10 }}>
            <Button type="primary" onClick={onGenerateBatch} disabled={generating || exporting || !hasResume || batchReady === batchItems.length}>
              {batchReady || batchFailed || batchStopping ? '继续或重试未完成岗位' : '开始批量生成'}
            </Button>
            {batchRunning && <Button disabled={batchStopping} onClick={() => { batchStop.current = true; setBatchStopping(true); }}>
              {batchStopping ? '等待当前岗位完成' : '当前完成后停止'}
            </Button>}
            <Button icon={<DownloadOutlined />} onClick={openBatchExport} disabled={!batchReady || generating || exporting}>批量导出 PDF（{batchReady}）</Button>
            <Button type="text" disabled={generating || exporting} onClick={() => setBatchItems([])}>关闭批量列表</Button>
          </Space>
          {!hasResume && <Alert type="warning" message="请先在简历中心上传简历并生成职业画像" />}
          {!config.model?.apiKey && <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>未配置 AI，当前会生成本地结果。配置 AI 后可从工作台重新选择岗位生成。</Text>}
          <List size="small" dataSource={batchItems} pagination={batchItems.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            renderItem={(item) => (
              <List.Item actions={[
                <Button key="view" size="small" disabled={!item.result || generating} onClick={() => showBatchResult(item)}>查看结果</Button>,
                <Button key="pdf" size="small" disabled={!item.result || generating} onClick={() => openExport(item.result!, item.jobTitle)}>导出 PDF</Button>,
              ]}>
                <List.Item.Meta title={<Space wrap><span>{item.jobTitle || '未命名岗位'} · {item.job.company || '未知公司'}</span><Tag color={item.status === 'done' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'local' ? 'orange' : undefined}>{batchLabels[item.status]}</Tag></Space>}
                  description={item.error || item.result?.warning || (item.source !== 'description' ? '仅保存岗位摘要或基本信息，采集完整要求后适配更准确' : undefined)} />
              </List.Item>
            )} />
        </Card>
      )}

      <Card size="small" style={{ marginBottom: 16 }} title={<Space><FileTextOutlined style={{ color: 'var(--brand)' }} />岗位信息<Tooltip title="待确认、待投递、已投递等岗位均可选择：选 1 个自动带入岗位名称与要求；选多个可直接批量定制并批量导出 PDF。"><QuestionCircleOutlined style={{ fontSize: 13, opacity: 0.65 }} /></Tooltip></Space>}>
        <Space size={12} wrap style={{ marginBottom: 12, width: '100%' }}>
          <Select
            data-testid="tailor-job-select"
            mode="multiple"
            placeholder={importableJobs.length ? '选择岗位：选 1 个=带入单岗，选多个=批量定制' : '暂无岗位，请先到工作台采集或加入任务'}
            style={{ minWidth: 400, maxWidth: '100%', flex: '1 1 400px' }}
            value={selectedJobIds}
            onChange={onSelectJobs}
            disabled={generating}
            allowClear
            showSearch
            optionFilterProp="label"
            notFoundContent="暂无匹配的岗位"
            options={importableJobs.map((p) => ({
              value: p.id,
              label: tailorJobLabel(p),
            }))}
          />
        </Space>
        {importedSource && importedSource !== 'description' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={importedSource === 'card'
              ? '该岗位尚无完整岗位描述，已带入保存的岗位摘要，可基于现有信息适配。'
              : '该岗位仅保存了基本信息，定制结果会参考这些信息；采集完整岗位描述后适配会更准确。'}
          />
        )}
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>岗位名称 <Text type="danger">*</Text></Text>
            <Input
              placeholder="如：前端开发工程师（实习）"
              value={jobTitle}
              onChange={(e) => onEditJob('title', e.target.value)}
              disabled={generating}
              maxLength={60}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>岗位要求 <Text type="danger">*</Text></Text>
            <Input.TextArea
              placeholder="选择工作台岗位后自动填入，也可手动补充岗位职责与任职要求…"
              value={jobDesc}
              onChange={(e) => onEditJob('description', e.target.value)}
              disabled={generating}
              rows={7}
              maxLength={6000}
              showCount
            />
            {jdLooksNoisy(jobDesc) && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag color="orange" icon={<ExclamationCircleOutlined />}>检测到无关内容</Tag>
                <Button size="small" icon={<DeleteOutlined />} disabled={generating} onClick={() => onEditJob('description', cleanJobDescription(jobDesc))}>
                  一键清理
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  去除「去App 与BOSS随时沟通 / 热门职位推荐区」等无关内容
                </Text>
              </div>
            )}
          </div>
        </Space>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <Space size={12}>
            <Button
              type="primary"
              className="btn-uniform"
              icon={generating ? <LoadingOutlined /> : <RobotOutlined />}
              onClick={() => void onGenerate()}
              loading={generating}
              disabled={!canGenerate}
            >
              AI 生成定制简历
            </Button>
            {!hasResume && (
              <Text type="warning" style={{ fontSize: 12 }}>未解析简历：请先到「简历中心」上传并生成职业画像</Text>
            )}
          </Space>
          {!config.model?.apiKey && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未配置 AI 时将按本地模板生成（摘要 + 打招呼语占位），建议在「设置 → AI」中填写密钥。
            </Text>
          )}
        </div>

        {/* 实时匹配度预览（AI 优先：工作台导入分；AI 未配置时本地确定性计算） */}
        {liveMatch && currentMatchScore != null && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13 }}>当前简历匹配度：</Text>
            <Tag color={scoreColor(currentMatchScore)} style={{ fontSize: 13, padding: '1px 10px' }}>
              {currentMatchScore} 分
            </Tag>
            {scoreSource === 'ai' ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <Tag color="green" style={{ fontSize: 11, marginRight: 6 }}>AI 分</Tag>
                工作台分析导入（{importedScore} 分）· 生成定制后按需对比提升
              </Text>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {!aiConfigured && <Tag style={{ fontSize: 11, marginRight: 6 }}>本地分</Tag>}
                简历覆盖岗位要点 {liveMatch.coverage}/{liveMatch.total}（{liveMatch.coverageRatio}%）· 生成后对比提升
              </Text>
            )}
          </div>
        )}
      </Card>

      {/* 经历补充材料：简历里没写的真实经历，可导入后参与定制与要点判定 */}
      <Card
        size="small"
        className="tailor-materials-card"
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <UploadOutlined style={{ color: 'var(--brand)' }} />
            经历补充材料
            {materials.length > 0 && <Tag color="blue">{materials.length} 份</Tag>}
          </Space>
        }
        extra={
          <Space size={8}>
            <Button size="small" icon={<UploadOutlined />} loading={materialBusy} disabled={generating} onClick={onPickMaterial}>
              经历信息导入
            </Button>
          </Space>
        }
      >
        <p className="tailor-materials-hint">
          简历里漏写的实习 / 项目 / 论文 / 获奖等真实经历，可导入 PDF、DOCX、DOC、MD、TXT 作为补充材料：
          <b>定制简历与「岗位要点对照」会参考它补齐缺失内容</b>。
          应用内只记录文件路径、不保存内容，每次生成时从磁盘现读——你在外部改了素材文件即时生效；
          它<b>只作用在本页的定制简历</b>，不会改动「简历中心」的简历原文与职业画像，也不影响工作台评分口径。
        </p>
        {materials.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            暂无补充材料。当「岗位要点对照」出现「可补充」的要点时，可把对应经历整理成文件后从这里导入。
          </Text>
        ) : (
          <List
            size="small"
            dataSource={materials}
            renderItem={(m) => (
              <List.Item
                actions={[
                  <Button key="del" size="small" type="text" danger disabled={generating} icon={<DeleteOutlined />} onClick={() => removeExperienceMaterial(m.id)}>
                    移除
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={<Space size={8}><FileTextOutlined />{m.name}</Space>}
                  description={`${m.path} · 添加于 ${formatTime(m.addedAt)}`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {tailor && (
        <TailorResultView
          key={importId || historyJobId || `${jobTitle}\n${jobDesc}\n${importedJob?.company || ''}`}
          tailor={tailor}
          jobTitle={jobTitle.trim() || '定制简历'}
          onExportPdf={() => openExport(tailor, jobTitle.trim() || '定制简历')}
          onSaveCoverLetter={onSaveCoverLetter}
          onImportMaterials={onPickMaterial}
          supplementText={supplementDraft}
          onSupplementChange={setSupplementDraft}
          onRegenerate={() => void onGenerate(supplementDraft)}
          onHelpWritePoint={onHelpWritePoint}
          onSupplementPoint={(point, text) => onGenerate(`【岗位要点：${point.point}】\n${text}`, false)}
          regenerating={generating}
          regenerateDisabled={exporting}
        />
      )}

      {/* 历史定制记录 */}
      <Card
        size="small"
        title={<Space><HistoryOutlined style={{ color: 'var(--brand)' }} />历史定制记录</Space>}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>本地保存最近 {HISTORY_MAX} 条</Text>}
      >
        {history.length === 0 ? (
          <Text type="secondary">暂无记录，生成定制结果后自动保存。</Text>
        ) : (
          <List
            size="small"
            dataSource={history}
            pagination={history.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            renderItem={(h) => (
              <List.Item
                actions={[
                  <Button key="export" size="small" icon={<DownloadOutlined />} onClick={() => openExport(h.result, h.jobTitle)}>
                    导出 PDF
                  </Button>,
                  <Button key="view" size="small" onClick={() => onLoadHistory(h)}>查看</Button>,
                  <Button key="del" size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onRemoveHistory(h.id)} />,
                ]}
              >
                <List.Item.Meta
                  title={<Space size={8}>{h.jobTitle}{h.company ? ` · ${h.company}` : ''}{h.result.method === 'ai' ? <Tag color="green" style={{ fontSize: 11 }}>AI</Tag> : <Tag style={{ fontSize: 11 }}>本地</Tag>}</Space>}
                  description={`${formatTime(h.createdAt)} · ${
                    h.result.aiMatch
                      ? `匹配 ${h.result.aiMatch.after} 分（定制前 ${h.result.aiMatch.before} 分）`
                      : `本地估算 ${h.result.match?.before?.score ?? '-'} 分`
                  }`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 导出定制简历 PDF：联系信息人工确认 + 分节勾选
          滚动策略：整块内容区（body）一条主滑动条，标题与底部按钮固定不动；
          内部不再做嵌套滚动（嵌套滚动会出现两条滚动条、滚轮归属混乱） */}
      <Modal
        title={<Space><DownloadOutlined style={{ color: 'var(--brand)' }} />{exportBatch.length ? `批量导出 ${exportBatch.length} 份简历 PDF` : '导出定制简历 PDF'}</Space>}
        open={exportOpen}
        onCancel={() => { if (!exporting) setExportOpen(false); }}
        width={620}
        style={{ top: 24 }}
        className="resume-export-modal"
        okText={exportBatch.length ? '选择目录并批量保存' : '生成并保存'}
        cancelText="取消"
        confirmLoading={exporting}
        cancelButtonProps={{ disabled: exporting }}
        onOk={onExportPdf}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="所有内容均来自你的简历与定制结果，不会编造任何能力与数据。"
          description={exportBatch.length ? '请核对共用的联系信息和模板；每份简历使用对应岗位名称，选择一次目录后逐份保存，同名文件自动加序号。' : '请核对下方联系信息（已从简历自动提取，可修改）；选择模板后生成 A4 PDF，可直接投递。'}
        />
        {exporting && exportBatch.length > 0 && <div style={{ marginBottom: 12 }}>
          <Progress percent={exportProgress.total ? Math.round(exportProgress.completed / exportProgress.total * 100) : 0} status="active" />
          <Space wrap><Text>已处理 {exportProgress.completed}/{exportProgress.total} 份</Text>
            <Button size="small" disabled={exportStopping} onClick={() => {
              setExportStopping(true);
              void window.electron?.cancelPdfBatch?.(exportRequestId.current);
            }}>{exportStopping ? '等待当前文件完成' : '当前完成后停止导出'}</Button>
          </Space>
        </div>}
        {exportReport && <Alert showIcon type={exportReport.failed || exportReport.stopped ? 'warning' : 'success'} style={{ marginBottom: 12 }}
          message={`已保存 ${exportReport.written} 份${exportReport.failed ? `，失败 ${exportReport.failed} 份` : ''}${exportReport.stopped ? '，剩余文件已停止' : ''}`}
          description={<div>{[...new Set(exportReport.errors)].slice(0, 5).map((error) => <div key={error}>{error}</div>)}
            {exportReport.firstPath && <Button size="small" type="link" onClick={() => void window.electron?.showItem?.(exportReport.firstPath!)}>查看导出文件</Button>}
          </div>} />}

        {/* 模板选择（两列等高卡片；选择持久化）——全部展开，由弹窗主滑动条统一滚动 */}
        <div style={{ margin: '4px 0 12px' }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            简历模板 <Text type="secondary" style={{ fontWeight: 400 }}>（{RESUME_TEMPLATES.length} 套 · 点击选用）</Text>
          </Text>
          <Radio.Group
            value={templateId}
            onChange={(e) => setTemplate(e.target.value)}
            className="resume-tpl-grid"
          >
              {RESUME_TEMPLATES.map((t) => (
                <Radio.Button key={t.id} value={t.id} className="resume-tpl-card">
                  <span className="resume-tpl-swatch" style={{ background: t.color }} />
                  <span className="resume-tpl-text">
                    <span className="resume-tpl-name">{t.name}</span>
                    <span className="resume-tpl-desc">{t.desc}</span>
                  </span>
                </Radio.Button>
              ))}
          </Radio.Group>
        </div>

        {/* 个人照片（选填；不传则 PDF 中不出现照片框） */}
        <div style={{ margin: '4px 0 12px' }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>个人照片 <Text type="secondary" style={{ fontWeight: 400 }}>（选填 · 不上传则 PDF 中不出现照片框）</Text></Text>
          <Upload
            accept="image/*"
            showUploadList={false}
            beforeUpload={(file) => {
              compressPhoto(file)
                .then((dataUrl) => { setPhotoPersist(dataUrl); message.success('照片已添加'); })
                .catch((e) => message.error('照片处理失败：' + getErrorMessage(e)));
              return false; // 阻止 antd 自动上传
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar
                size={56}
                shape="square"
                src={photo || undefined}
                icon={!photo ? <CameraOutlined /> : undefined}
                style={{ background: photo ? 'transparent' : '#eef1f5', border: '1px dashed #c3ccd6', color: '#8a94a6' }}
              />
              <Space size={6} wrap>
                <Button size="small" icon={<CameraOutlined />}>上传照片</Button>
                {photo && (
                  <Button size="small" type="text" danger onClick={() => { setPhotoPersist(''); message.info('已移除照片'); }}>
                    移除
                  </Button>
                )}
                <Text type="secondary" style={{ fontSize: 12, display: 'block', width: 200 }}>
                  支持 JPG/PNG，自动压缩后本地保存
                </Text>
              </Space>
            </div>
          </Upload>
        </div>

        <Form form={exportForm} layout="vertical" size="small" style={{ marginTop: 8 }}>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item
              label="姓名"
              name="name"
              rules={[{ required: true, message: '请填写姓名' }]}
              style={{ flex: 1, minWidth: 120 }}
            >
              <Input placeholder="用于简历头部展示" maxLength={20} />
            </Form.Item>
            <Form.Item
              label="电话"
              name="phone"
              rules={[{ pattern: /^1[3-9]\d{9}$/, message: '请填写 11 位手机号' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="选填，建议填写" maxLength={11} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item
              label="邮箱"
              name="email"
              rules={[{ type: 'email', message: '邮箱格式不正确' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="选填" maxLength={60} />
            </Form.Item>
            <Form.Item
              label="求职意向岗位"
              name="targetTitle"
              rules={[{ required: !exportBatch.length, message: '请填写求职意向岗位' }]}
              style={{ flex: 1, minWidth: 150 }}
            >
              <Input placeholder="如：前端开发工程师" maxLength={30} disabled={exportBatch.length > 0} />
            </Form.Item>
          </Space>
        </Form>

        <Divider orientation="left" plain style={{ margin: '4px 0 10px' }}>
          内容模块（按需勾选 · 右侧按钮调整顺序 · 空模块不会输出）
        </Divider>
        <div className="resume-mod-list">
          {moduleOrder.map((id, idx) => {
            const m = RESUME_SECTION_META.find((x) => x.id === id);
            if (!m) return null;
            const checked = exportSections.includes(id);
            return (
              <div className={`resume-mod-row${checked ? '' : ' is-off'}`} key={id}>
                <Checkbox
                  checked={checked}
                  onChange={(e) =>
                    setExportSections((prev) =>
                      e.target.checked ? [...prev, id] : prev.filter((x) => x !== id)
                    )
                  }
                >
                  <Space size={4}>
                    <span className="resume-mod-name">{m.title}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>{m.hint}</Text>
                  </Space>
                </Checkbox>
                <Space size={2} className="resume-mod-actions">
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    disabled={idx === 0}
                    title="上移一位"
                    onClick={() => moveModule(idx, -1)}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    disabled={idx === moduleOrder.length - 1}
                    title="下移一位"
                    onClick={() => moveModule(idx, 1)}
                  />
                </Space>
              </div>
            );
          })}
        </div>
        {exportTailor && exportTailor.skillGaps.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Text type="warning" style={{ fontSize: 12 }}>
              提示：岗位要求但简历未体现的技能未写入（{exportTailor.skillGaps.join('、')}）。若确实具备，可补齐真实经历后再导出。
            </Text>
          </div>
        )}
      </Modal>
    </div>
  );
}
