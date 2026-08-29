// Markdown 简历清洗器：把 Markdown 语法转成规整纯文本，供画像生成 / 岗位匹配等下游分析使用。
// 零依赖、纯浏览器环境可运行（对齐 pdfExtractor / docxParser 的「前端自足」策略）。
// 处理范围：
//   - YAML frontmatter（文档开头 --- 块）整体跳过
//   - 代码块（``` / ~~~ 围栏）保留内容、去掉围栏
//   - 标题 # → 保留正文；引用 > → 去掉符号
//   - 列表 - / * / + → 去符号；任务列表 [ ] / [x] → 去勾选标记；有序列表保留序号
//   - 表格 | a | b | → 单元格以空格连接；分隔行（|---|）跳过
//   - 行内：图片/链接 → 保留文字；粗体/斜体/删除线/行内代码 → 去语法记号
//   - 基础 HTML 标签与实体 → 清理

/** 将 Markdown 文本转换为规整纯文本；输入为空或转换后为空时返回空字符串 */
export function markdownToPlainText(md: string): string {
  const raw = String(md ?? '');
  if (!raw.trim()) return '';

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  let inCodeBlock = false;
  let inFrontmatter = false;
  let sawContent = false; // 是否出现过正文内容（用于识别开头的 YAML frontmatter）

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 代码块围栏：进入/退出
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      sawContent = true;
      continue; // 围栏本身丢弃
    }
    if (inCodeBlock) {
      out.push(line); // 代码块内容原样保留（简历中通常为技能列表 / 项目片段）
      continue;
    }

    // YAML frontmatter：仅在文档开头（尚未出现正文内容）且首行是 --- 时进入
    if (!sawContent && !inFrontmatter && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (/^---\s*$/.test(line)) inFrontmatter = false;
      continue;
    }

    // 去除 HTML 注释
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push(''); // 保留单个空行做段落分隔
      continue;
    }
    sawContent = true;

    const trimmed = line.trim();

    // 表格：分隔行（仅含 - : | 空格）跳过；数据行单元格用空格连接
    if (trimmed.startsWith('|')) {
      const cellsOnly = trimmed.replace(/^\||\|$/g, ''); // 去首尾竖线
      if (/^\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*$/.test(cellsOnly)) continue; // 表头分隔行
      const cells = cellsOnly
        .split('|')
        .map((c) => inlineClean(c).trim())
        .filter(Boolean);
      if (cells.length) out.push(cells.join('  '));
      continue;
    }

    // 引用：去掉 > 前缀（可多级）
    line = line.replace(/^(\s*)>{1,}\s*/, '$1');

    // 任务列表：- [ ] / - [x] → 去掉勾选标记
    line = line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1');

    // 无序列表：- / * / + → 去符号；有序列表（1. / 1)）保留序号
    line = line.replace(/^(\s*)[-*+]\s+/, '$1');

    // 水平线（独立 --- / *** / ___）→ 跳过
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;

    // 标题：# 前缀去掉，保留正文
    line = line.replace(/^\s*#{1,6}\s+/, '');

    out.push(inlineClean(line).trim());
  }

  // 清理：去除多余空行、每行尾随空格
  let result = out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/** 行内语法清理：图片/链接/粗斜体/行内代码/HTML 标签/实体 */
function inlineClean(line: string): string {
  let s = line;

  // 图片 ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 链接 [text](url "title") → text；text 为空时保留 url
  s = s.replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_, t: string, u: string) => {
    const text = (t || '').trim();
    return text || (u || '').trim();
  });
  // 自动链接 <https://...> → 保留 url
  s = s.replace(/<([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^>]+)>/g, '$1');

  // 行内代码 `code` → code（先处理，避免被斜体规则误伤）
  s = s.replace(/`([^`]*)`/g, '$1');

  // 删除线 ~~text~~
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // 粗体 **text** / __text__ → text
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');

  // 斜体 *text* / _text_ → text（避免匹配普通标点：要求成对且不跨空白）
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=$|[^*\w])/g, '$1$2');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=$|[^_\w])/g, '$1$2');

  // 清理残留的孤立记号
  s = s.replace(/[*_]{1,}/g, '');

  // 基础 HTML 标签 → 去掉（<br> 换行、其余标签移除）
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  // 基础实体解码
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return s;
}
