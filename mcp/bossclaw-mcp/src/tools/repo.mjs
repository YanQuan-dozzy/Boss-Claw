// src/tools/repo.mjs —— 应用认知工具组（只读）
// ---------------------------------------------------------------------------
// 让 agent 动手前建立对已安装 BossClaw 应用（如 <安装目录>）的认知：约束手册、
// 目录与文件、正则检索。定位边界：agent 只能控制/读取已安装应用，不涉及测试与开发。
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  REPO_ROOT,
  MODE,
  resolveInRepo,
  walkFiles,
  readTextSafe,
  statSafe,
  humanBytes,
  relToRepo,
  ok,
  fail,
  DEFAULT_IGNORES,
} from '../context.mjs';
import { obj, str, num, bool, arr, READ_ONLY } from '../schema.mjs';
import { CONVENTIONS, REQUIRED_READING, REFERENCE_PROJECTS, OPERATING_LOOP } from '../knowledge.mjs';

const MAX_SEARCH_RESULTS = 400;

export const repoTools = [
  {
    name: 'bossclaw_guidelines',
    title: '读取项目约束与操作手册',
    description:
      '返回 AGENTS.md 全文（项目约束唯一入口）+ 必读文档索引 + 安全不变量 + 工程约定（命令、沙箱陷阱、主题、持久化键、关键文件）。' +
      '任何实现/修改前应先读它，避免违反项目红线。',
    annotations: READ_ONLY,
    inputSchema: obj({
      includeFullText: bool('是否返回 AGENTS.md 全文（默认 true；设 false 只返回手册与索引）', { default: true }),
      extraFiles: arr('额外要一并读取的仓库内文件（相对路径）'),
    }),
    handler: async (args = {}) => {
      const includeFull = args.includeFullText !== false;
      const parts = [];
      const data = { conventions: CONVENTIONS, requiredReading: REQUIRED_READING, referenceProjects: REFERENCE_PROJECTS, operatingLoop: OPERATING_LOOP };

      parts.push('# 项目约束与操作手册', '');
      parts.push('## 安全不变量（违反即视为错误，永不绕过）');
      for (const i of CONVENTIONS.invariants) parts.push(`- ${i}`);
      parts.push('', '## 布局不变量');
      parts.push(`- ${CONVENTIONS.layoutInvariant}`);
      parts.push('', '## 常用命令');
      for (const [k, v] of Object.entries(CONVENTIONS.commands)) parts.push(`- ${k}: ${v}`);
      parts.push('', '## 沙箱/环境陷阱');
      for (const t of CONVENTIONS.sandboxTraps) parts.push(`- ${t}`);
      parts.push('', '## 持久化键');
      for (const [k, v] of Object.entries(CONVENTIONS.persistence)) parts.push(`- ${k}: ${v}`);
      parts.push('', '## 主题与视觉约定');
      for (const t of CONVENTIONS.theme) parts.push(`- ${t}`);
      parts.push(`- ${CONVENTIONS.platformColors}`);
      parts.push('', '## 关键文件地图');
      for (const [k, v] of Object.entries(CONVENTIONS.keyFiles)) parts.push(`- ${k}: ${v}`);
      parts.push('', '## 推荐操作循环');
      for (const l of OPERATING_LOOP) parts.push(`- ${l}`);

      parts.push('', '## 必读文档索引');
      const isInstalled = MODE === 'installed';
      if (isInstalled) {
        parts.push(
          `- 当前为「已安装打包版」模式（${REPO_ROOT}），不含开发仓库的 AGENTS.md / docs 文档，故不返回其全文。`,
          '  以下开发文档仅在开发仓库（BOSSCLAW_REPO 显式指定）下可见：'
        );
      }
      for (const r of REQUIRED_READING) {
        const st = await statSafe(path.join(REPO_ROOT, r.path));
        parts.push(`- ${st.exists ? '✓' : '✗'} ${r.path}（${humanBytes(st.size)}，${st.mtime || '-'}）—— ${r.why}`);
      }
      parts.push('', '## 逻辑对齐参考项目（禁止重新发明）');
      for (const r of REFERENCE_PROJECTS) {
        const st = await statSafe(r.path);
        parts.push(`- ${st.exists ? '✓' : '✗'} ${r.path} —— ${r.why}`);
      }

      if (includeFull && !isInstalled) {
        const agents = await readTextSafe(path.join(REPO_ROOT, 'AGENTS.md'), 256 * 1024).catch(() => ({ text: '', truncated: false }));
        parts.push('', '---', '', '# AGENTS.md 全文', '', agents.text || '(未找到 AGENTS.md)');
        data.agentsMd = agents.text;
      }
      for (const extra of args.extraFiles || []) {
        const abs = resolveInRepo(extra);
        const t = await readTextSafe(abs, 256 * 1024).catch(() => null);
        if (!t) {
          parts.push('', `---`, '', `# ${extra}（读取失败）`);
          continue;
        }
        parts.push('', '---', '', `# ${extra}`, '', t.text);
      }
      return ok(parts.join('\n'), data);
    },
  },

  {
    name: 'bossclaw_list_dir',
    title: '列出目录',
    description: '列出仓库内目录的文件树（默认跳过 node_modules / dist / release / .git 等）。用于快速掌握某个模块的文件构成。',
    annotations: READ_ONLY,
    inputSchema: obj(
      {
        path: str('相对仓库根的目录路径，默认 "."', { default: '.' }),
        depth: num('递归深度（默认 3，最大 8）', { default: 3 }),
        includeIgnored: bool('是否包含 node_modules 等被忽略目录（默认 false）', { default: false }),
        extensions: arr('只保留这些扩展名（如 ["ts","tsx"]），留空表示全部'),
        maxEntries: num('最多返回条目数（默认 400）', { default: 400 }),
      },
      [],
      {}
    ),
    handler: async (args = {}) => {
      const abs = resolveInRepo(args.path || '.');
      const st = await statSafe(abs);
      if (!st.exists) return fail(`目录不存在：${relToRepo(abs)}`);
      if (!st.isDir) return fail(`不是目录：${relToRepo(abs)}（请用 bossclaw_read_file）`);
      const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 8);
      const maxEntries = Math.min(Math.max(Number(args.maxEntries) || 400, 1), 5000);
      const exts = (args.extensions || []).map((e) => String(e).replace(/^\./, '').toLowerCase());
      const ignores = args.includeIgnored ? new Set(['.git']) : DEFAULT_IGNORES;

      const rows = [];
      const walk = async (dir, level) => {
        if (rows.length >= maxEntries || level > depth) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const ent of entries) {
          if (rows.length >= maxEntries) return;
          if (ignores.has(ent.name)) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            rows.push({ type: 'dir', level, rel: relToRepo(full) });
            await walk(full, level + 1);
          } else if (ent.isFile()) {
            if (exts.length) {
              const ext = path.extname(ent.name).replace('.', '').toLowerCase();
              if (!exts.includes(ext)) continue;
            }
            const s = await statSafe(full);
            rows.push({ type: 'file', level, rel: relToRepo(full), size: s.size, sizeText: humanBytes(s.size) });
          }
        }
      };
      await walk(abs, 1);

      const lines = [`${relToRepo(abs)}/（${rows.filter((r) => r.type === 'file').length} 个文件，深度 ≤ ${depth}）`, ''];
      for (const r of rows) {
        const indent = '  '.repeat(r.level - 1);
        lines.push(r.type === 'dir' ? `${indent}${path.basename(r.rel)}/` : `${indent}${path.basename(r.rel)}  ${r.sizeText}`);
      }
      if (rows.length >= maxEntries) lines.push('', `... 已达上限 ${maxEntries} 条，请缩小 path 或提高 depth 精度`);
      return ok(lines.join('\n'), { dir: relToRepo(abs), entries: rows });
    },
  },

  {
    name: 'bossclaw_read_file',
    title: '读取文件',
    description: '读取仓库内某个文件（支持行区间）。返回带行号的文本，便于直接定位与引用。',
    annotations: READ_ONLY,
    inputSchema: obj(
      {
        path: str('相对仓库根的文件路径'),
        offset: num('起始行号（1 起，默认 1）', { default: 1 }),
        limit: num('最多读取行数（默认 400，最大 4000）', { default: 400 }),
        withLineNumbers: bool('是否输出行号（默认 true）', { default: true }),
      },
      ['path']
    ),
    handler: async (args) => {
      const abs = resolveInRepo(args.path);
      const st = await statSafe(abs);
      if (!st.exists) return fail(`文件不存在：${args.path}`);
      if (st.isDir) return fail(`${args.path} 是目录，请用 bossclaw_list_dir`);
      const limit = Math.min(Math.max(Number(args.limit) || 400, 1), 4000);
      const offset = Math.max(Number(args.offset) || 1, 1);
      const { text, truncated } = await readTextSafe(abs, 4 * 1024 * 1024);
      const all = text.split(/\r?\n/);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      const numbered = args.withLineNumbers !== false;
      const body = slice.map((l, i) => (numbered ? `${String(offset + i).padStart(5)}  ${l}` : l)).join('\n');
      const header = `${relToRepo(abs)}（共 ${all.length} 行，显示 ${offset}-${offset + slice.length - 1}${truncated ? '，文件超大已截断' : ''}）`;
      return ok(`${header}\n\n${body}`, { path: relToRepo(abs), totalLines: all.length, offset, shown: slice.length, truncated });
    },
  },

  {
    name: 'bossclaw_search',
    title: '正则检索源码',
    description:
      '在仓库内按正则检索文本（跳过 node_modules / dist / release 等）。用于定位实现位置。' +
      '返回「文件:行号: 内容」，并给出每文件命中数汇总。',
    annotations: READ_ONLY,
    inputSchema: obj(
      {
        pattern: str('正则表达式（JS 语法）。例如 "SAFETY_LIMITS\\." 或 "ipcMain\\.handle"'),
        glob: str('只搜索这些扩展名，逗号分隔（如 "ts,tsx,cjs"）；留空=全部文本文件'),
        subdir: str('限定子目录（相对仓库根，如 "desktop-app/src"）'),
        maxResults: num(`最多返回命中行数（默认 ${MAX_SEARCH_RESULTS}）`, { default: MAX_SEARCH_RESULTS }),
        caseSensitive: bool('区分大小写（默认 true）', { default: true }),
        filesOnly: bool('只返回命中的文件路径与计数（默认 false）', { default: false }),
      },
      ['pattern']
    ),
    handler: async (args) => {
      let re;
      try {
        re = new RegExp(args.pattern, args.caseSensitive === false ? 'gi' : 'g');
      } catch (e) {
        return fail(`正则无效：${e?.message || e}`);
      }
      const root = args.subdir ? resolveInRepo(args.subdir) : REPO_ROOT;
      const exts = String(args.glob || '')
        .split(',')
        .map((s) => s.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      const maxResults = Math.min(Math.max(Number(args.maxResults) || MAX_SEARCH_RESULTS, 1), 3000);

      const hits = [];
      const perFile = new Map();
      let scanned = 0;
      outer: for await (const file of walkFiles(root, { maxFiles: 60000 })) {
        if (exts.length) {
          const ext = path.extname(file).replace('.', '').toLowerCase();
          if (!exts.includes(ext)) continue;
        }
        let buf;
        try {
          const st = await fsp.stat(file);
          if (st.size > 3 * 1024 * 1024) continue;
          buf = await fsp.readFile(file);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue;
        scanned += 1;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          const rel = relToRepo(file);
          perFile.set(rel, (perFile.get(rel) || 0) + 1);
          if (hits.length < maxResults) hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 400) });
          if (perFile.get(rel) > 2000) break;
        }
        if (hits.length >= maxResults && perFile.size > 0) {
          // 结果已满，但仍想统计全量文件数时会很慢 —— 直接收敛，保证响应速度
          break outer;
        }
      }

      const fileSummary = [...perFile.entries()].sort((a, b) => b[1] - a[1]).map(([file, count]) => ({ file, count }));
      const lines = [
        `正则 /${args.pattern}/ 命中 ${hits.length}${hits.length >= maxResults ? '+' : ''} 行，涉及 ${fileSummary.length} 个文件（扫描 ${scanned} 个文件）`,
        '',
        '命中文件：',
        ...fileSummary.slice(0, 40).map((f) => `  ${f.count.toString().padStart(4)}  ${f.file}`),
      ];
      if (!args.filesOnly) {
        lines.push('', '命中行：');
        for (const h of hits) lines.push(`${h.file}:${h.line}: ${h.text}`);
      }
      return ok(lines.join('\n'), { hits, files: fileSummary, scanned, truncated: hits.length >= maxResults });
    },
  },
];
