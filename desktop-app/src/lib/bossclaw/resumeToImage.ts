// 原简历「解析文字 → <canvas> 直接绘制成图」（渲染层，零 IPC、零截屏，任何环境稳定出图）。
// 输出：无敏感信息的整页 PNG dataURL + 缩小的 JPEG dataURL（投递附件用）。
// 不依赖 Electron capturePage / 隐藏窗口，规避「页面捕获结果为空」等截屏问题。

export interface ResumeImageResult {
  pngDataUrl: string;
  jpegDataUrl: string;
  width: number;
  height: number;
}

const PAGE_W = 794;
/** M-25：画布高度上限（Chromium 单边上限约 16384px；留安全余量） */
const MAX_CANVAS_H = 16000;
const PAD_X = 56;
const CONTENT_W = PAGE_W - PAD_X * 2;
const PAD_TOP = 46;
const COLORS = {
  text: '#1f2937',
  heading: '#1f3a63',
  accent: '#2b5a9e',
  line: '#e5e7eb',
};
const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';

// 常见分节标题关键词：整行就是标题（可带冒号），用 $ 锚点避免误把「项目名称：xxx」当标题
const SECTION_START_RE =
  /^(教育背景|教育经历|学历|教育|工作经历|实习经历|工作经验|实习|工作|项目经历|项目|相关技能|核心技能|专业技能|技能特长|技能|证书|荣誉证书|荣誉|获奖|个人总结|自我评价|个人评价|关于我|基本信息|求职意向|求职方向)\s*[:：]?$/i;

interface Section { title: string | null; paragraphs: string[]; }

function isSectionTitleLine(line: string): boolean {
  const s = String(line || '').trim();
  return s.length >= 2 && s.length <= 24 && SECTION_START_RE.test(s);
}

function parseSections(text: string): Section[] {
  const trimmed = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return [];
  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const para of paragraphs) {
    const firstLine = para.split('\n')[0].trim();
    if (isSectionTitleLine(firstLine)) {
      // 每个分节标题都单独成节、突出显示（不再因前面已建带标题分节而吞掉后续标题）
      if (cur) sections.push(cur);
      const rest = para.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
      cur = { title: firstLine.replace(/[:：]$/, '').trim(), paragraphs: rest.length ? [rest.join('\n')] : [] };
      continue;
    }
    if (!cur) cur = { title: null, paragraphs: [] };
    cur.paragraphs.push(para);
  }
  if (cur) sections.push(cur);
  return sections;
}

/** 逐字符换行（CJK 友好，兼顾长英文按字符断） */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of String(text)) {
    const test = cur + ch;
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      if (cur) out.push(cur);
      cur = ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface Item {
  type: 'title' | 'line';
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  accent: boolean;
}

/** 先按 A4 宽排布出全部文本行（两次 measure 定位），再绘制到 canvas */
export function drawResumeImage(maskedText: string): ResumeImageResult {
  const sections = parseSections(maskedText);
  const probe = document.createElement('canvas').getContext('2d')!;

  const BODY_SIZE = 13;
  const BODY_LH = 23;
  const TITLE_SIZE = 15;
  const TITLE_LH = 26;
  const HEADER_SIZE = 26;

  const items: Item[] = [];
  // 头部「个人简历」
  probe.font = `700 ${HEADER_SIZE}px ${FONT}`;
  const headerH = HEADER_SIZE + 10;
  // 排布分节
  for (const sec of sections) {
    if (sec.title) items.push({ type: 'title', text: sec.title, fontSize: TITLE_SIZE, bold: true, color: COLORS.heading, accent: true });
    probe.font = `${BODY_SIZE}px ${FONT}`;
    for (const para of sec.paragraphs) {
      for (const rawLine of para.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        for (const wrapped of wrap(probe, line, CONTENT_W)) {
          items.push({ type: 'line', text: wrapped, fontSize: BODY_SIZE, bold: false, color: COLORS.text, accent: false });
        }
      }
    }
  }

  // 计算总高度
  let y = PAD_TOP + headerH + 16; // header 后
  const layout: number[] = []; // 每项 top
  for (const it of items) {
    layout.push(it.type === 'title' ? y : y);
    y += it.type === 'title' ? TITLE_LH : BODY_LH;
  }
  if (items.length === 0) {
    items.push({ type: 'line', text: '（暂无简历正文）', fontSize: BODY_SIZE, bold: false, color: COLORS.text, accent: false });
    layout.push(PAD_TOP + headerH + 16);
    y = PAD_TOP + headerH + 16 + BODY_LH;
  }
  const totalH = y + 40;

  // 绘制
  // M-25：Chromium 画布有尺寸上限，超长简历会产生超限画布 → toDataURL 抛错或输出空白图。
  // 这里在超限时**按比例整体缩放绘制**（内容全保留，只是整体变小），并在 toDataURL 处加异常兜底。
  const rawHeight = Math.max(120, Math.round(totalH));
  const canvasScale = rawHeight > MAX_CANVAS_H ? MAX_CANVAS_H / rawHeight : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(PAGE_W * canvasScale));
  canvas.height = Math.max(1, Math.round(rawHeight * canvasScale));
  const ctx = canvas.getContext('2d')!;
  if (canvasScale !== 1) ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
  ctx.fillStyle = '#ffffff';
  // 背景按**逻辑尺寸**填充（画布已缩放，用 canvas.width 会溢出逻辑坐标系）
  ctx.fillRect(0, 0, PAGE_W, rawHeight);

  // 顶部标题 + 分隔线
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.heading;
  ctx.font = `700 ${HEADER_SIZE}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('个人简历', PAGE_W / 2, PAD_TOP + HEADER_SIZE);
  ctx.textAlign = 'left';
  const dividerY = PAD_TOP + headerH;
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(PAD_X, dividerY, CONTENT_W, 2);

  // 分节
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const top = layout[i];
    if (it.type === 'title') {
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(PAD_X, top, 4, TITLE_SIZE + 2);
      ctx.fillStyle = it.color;
      ctx.font = `700 ${TITLE_SIZE}px ${FONT}`;
      ctx.fillText(it.text, PAD_X + 12, top + TITLE_SIZE);
    } else {
      ctx.fillStyle = it.color;
      ctx.font = `${BODY_SIZE}px ${FONT}`;
      // 用一个合理行顶估，正文基线在行内居中
      ctx.fillText(it.text, PAD_X, top + BODY_SIZE + 4);
    }
  }

  let pngDataUrl = '';
  let jpegDataUrl = '';
  try {
    pngDataUrl = canvas.toDataURL('image/png');
    jpegDataUrl = toJpeg(canvas);
  } catch (e) {
    // M-25：画布超限等异常不再让调用方拿到「空白图」或未捕获异常
    throw new Error(`简历图片生成失败（可能内容过长超出画布上限）：${(e as Error).message}`);
  }
  return { pngDataUrl, jpegDataUrl, width: canvas.width, height: canvas.height };
}

function toJpeg(canvas: HTMLCanvasElement, maxWidth = 794): string {
  let c = canvas;
  if (canvas.width > maxWidth) {
    c = document.createElement('canvas');
    const ratio = maxWidth / canvas.width;
    c.width = maxWidth;
    c.height = Math.round(canvas.height * ratio);
    c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return c.toDataURL('image/jpeg', 0.88);
}