// MarkdownView.tsx —— 极简 Markdown 渲染（仅覆盖「使用前必读」文档用到的语法）
// 支持：标题(#/##/###)、分隔线、表格、无序列表(含 - [ ] 勾选)、有序列表、
// 引用块、代码块(```)、行内加粗(**)、行内代码(`)、外链([text](https://...))。
// 纯 React 节点渲染（无 dangerouslySetInnerHTML），天然防注入。
import React from 'react';
import { electronApi } from '@/lib/electronApi';

function renderInline(text: string, keySeed: string | number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**') && tok.endsWith('**')) {
      nodes.push(<strong key={`${keySeed}-${i}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      nodes.push(<code key={`${keySeed}-${i}`}>{tok.slice(1, -1)}</code>);
    } else {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) {
        const [, label, url] = mm;
        if (/^https?:/i.test(url)) {
          nodes.push(
            <a
              key={`${keySeed}-${i}`}
              href={url}
              onClick={(e) => {
                e.preventDefault();
                electronApi.external.open(url);
              }}
            >
              {label}
            </a>
          );
        } else {
          // 相对链接（如 ./Quick-Start）在应用内不可直达，仅显示文本
          nodes.push(<span key={`${keySeed}-${i}`}>{label}</span>);
        }
      } else {
        nodes.push(tok);
      }
    }
    i += 1;
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlocks(md: string): React.ReactNode[] {
  const lines = md.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  const push = (node: React.ReactNode) => out.push(<React.Fragment key={key++}>{node}</React.Fragment>);

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束 ```（若存在）
      push(<pre className="md-code"><code>{buf.join('\n')}</code></pre>);
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      push(<hr />);
      i += 1;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length as 1 | 2 | 3;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
      push(<Tag className={`md-h${level}`}>{renderInline(h[2], key)}</Tag>);
      i += 1;
      continue;
    }

    // 引用块（连续 > 行）
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      push(<blockquote className="md-blockquote">{renderInline(buf.join('\n'), key)}</blockquote>);
      continue;
    }

    // 表格（连续以 | 开头行；第二行是 |---| 分隔行）
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.replace(/^\s*\||\|\s*$/g, '').split('|').map((s) => s.trim());
      i += 2; // 跳过表头与分隔行
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].replace(/^\s*\||\|\s*$/g, '').split('|').map((s) => s.trim()));
        i += 1;
      }
      push(
        <table className="md-table">
          <thead>
            <tr>{header.map((c, ci) => <th key={ci}>{renderInline(c, ci)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => <td key={ci}>{renderInline(c, `${ri}-${ci}`)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    // 无序列表（连续 - 行）
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Array<{ text: string; checked: boolean }> = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let body = lines[i].replace(/^\s*[-*]\s+/, '');
        const m = body.match(/^\[( |x|X)\]\s+/);
        let checked = false;
        if (m) {
          checked = m[1] !== ' ';
          body = body.slice(m[0].length);
        }
        items.push({ text: body, checked });
        i += 1;
      }
      push(
        <ul className="md-ul">
          {items.map((it, ii) => (
            <li key={ii} className={it.checked ? 'md-li-checked' : undefined}>
              {it.checked && <span className="md-check">☑</span>}
              {renderInline(it.text, ii)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表（连续 N. 行）
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      push(
        <ol className="md-ol">
          {items.map((it, ii) => <li key={ii}>{renderInline(it, ii)}</li>)}
        </ol>
      );
      continue;
    }

    // 普通段落（连续非空行合并）
    if (line.trim() !== '') {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^\s*(#|\||>|-{3,}|\s*[-*]\s|\s*\d+\.\s|```)/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      push(<p className="md-p">{renderInline(buf.join('\n'), key)}</p>);
      continue;
    }

    i += 1; // 空行
  }

  return out;
}

export default function MarkdownView({ text }: { text: string }) {
  return <div className="md-view">{renderBlocks(text)}</div>;
}
