// The markdown renderer: inline spans and the block grammar the pages use — headings, lists,
// tables, fences, callouts, blockquotes and raw HTML — plus the h2 list the table of contents
// is built from.

import { renderCode } from './highlight';
import { escapeHtml, slugify } from './text';

export function inline(src: string): string {
  return src
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    })
    .join('');
}

const cells = (row: string): string[] =>
  row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export interface Rendered {
  readonly html: string;
  readonly headings: readonly { id: string; text: string }[];
}

/** Block-level markdown: headings, lists, tables, fences, callouts, raw HTML. */
export function markdown(src: string): Rendered {
  const lines = src.split('\n');
  const headings: { id: string; text: string }[] = [];
  const out: string[] = [];
  let i = 0;

  const paragraph = (buffer: string[]): void => {
    if (buffer.length > 0) out.push(`<p>${inline(buffer.join(' '))}</p>`);
    buffer.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // fenced code
    const fence = /^```(\S*)(?:\s+title="([^"]*)")?\s*$/.exec(line);
    if (fence !== null) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(renderCode(fence[1] ?? '', fence[2], buffer.join('\n')));
      continue;
    }

    // ::: callout … :::
    const callout = /^:::\s*(ok|warn|info)(?:\s+(.*))?$/.exec(line);
    if (callout !== null) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] ?? '').trim() !== ':::') {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      const label = callout[2] ?? callout[1] ?? 'note';
      const inner = markdown(buffer.join('\n')).html;
      out.push(
        `<aside class="callout callout--${callout[1]}"><span class="callout__label">${escapeHtml(label)}</span>${inner}</aside>`,
      );
      continue;
    }

    // raw HTML block — passed through untouched, so the pitch can use the grid components
    if (line.startsWith('<')) {
      const buffer: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      out.push(buffer.join('\n'));
      continue;
    }

    // heading
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '##').length;
      const text = heading[2] ?? '';
      const id = slugify(text);
      if (level === 2) headings.push({ id, text });
      out.push(
        `<h${level} id="${id}">${inline(text)}` +
          `<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
      );
      i += 1;
      continue;
    }

    // table
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      const thead = head.map((c) => `<th scope="col">${inline(c)}</th>`).join('');
      const tbody = rows
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="table-scroll" tabindex="0"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    // lists
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null || ordered !== null) {
      const tag = bullet !== null ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(current);
        if (item !== null) {
          items.push(item[1] ?? '');
        } else if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        i += 1;
      }
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // blockquote
    if (line.startsWith('> ')) {
      const buffer: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        buffer.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdown(buffer.join('\n')).html}</blockquote>`);
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // paragraph
    const buffer: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        current.startsWith('#') ||
        current.startsWith('|') ||
        current.startsWith('```') ||
        current.startsWith(':::') ||
        current.startsWith('<') ||
        current.startsWith('> ') ||
        /^(?:[-*]|\d+\.)\s/.test(current)
      ) {
        break;
      }
      buffer.push(current.trim());
      i += 1;
    }
    paragraph(buffer);
  }

  return { html: out.join('\n'), headings };
}
