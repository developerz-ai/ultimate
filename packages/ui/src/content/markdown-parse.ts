// Markdown blocks, line by line: headings (ATX and setext), fences, indented code, quotes, nested
// and task lists, pipe tables, rules, paragraphs. The working set an agent writes, not full
// CommonMark. Every construct is one pass over its lines; caps turn the rest into plain text.

import { parseInline } from './markdown-inline';
import {
  MARKDOWN_MAX_BLOCK_DEPTH,
  MARKDOWN_MAX_CHARS,
  type MarkdownBlock,
  type MarkdownListItem,
  type TableAlign,
} from './markdown-tree';

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK = /^\[([ xX])\][ \t]+/;
const INDENTED = /^(?: {4}|\t)/;

const isBlank = (line: string): boolean => line.trim() === '';

/** A line that ends a paragraph by starting something else. */
function interrupts(line: string): boolean {
  if (FENCE.test(line) || ATX.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  // Only `1.` or a bullet with content interrupts a paragraph, as CommonMark has it.
  return (
    item !== null &&
    item[4] !== undefined &&
    item[4].trim() !== '' &&
    /^(?:[-+*]|1[.)])$/.test(item[2] ?? '')
  );
}

/** Cells of a pipe-table row, split on unescaped pipes, outer pipes dropped. */
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '\\' && row[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  out.push(cell.trim());
  return out;
}

const alignOf = (cell: string): TableAlign => {
  const start = cell.startsWith(':');
  const end = cell.endsWith(':');
  return start && end ? 'center' : end ? 'end' : start ? 'start' : null;
};

const text = (lines: readonly string[]): MarkdownBlock => ({
  kind: 'text',
  text: lines.join('\n'),
});

function parseLines(lines: readonly string[], depth: number): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null && !(fence[1]?.startsWith('`') && fence[2]?.includes('`'))) {
      const mark = fence[1] ?? '```';
      const body: string[] = [];
      let j = i + 1;
      let open = true;
      for (; j < lines.length; j += 1) {
        const closing = lines[j]?.trim() ?? '';
        if (
          closing.startsWith(mark[0] ?? '`') &&
          closing.length >= mark.length &&
          /^(`+|~+)$/.test(closing)
        ) {
          open = false;
          break;
        }
        body.push(lines[j] ?? '');
      }
      out.push({ kind: 'code', info: (fence[2] ?? '').trim(), text: body.join('\n'), open });
      i = open ? j : j + 1;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      const level = (atx[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ kind: 'heading', level, children: parseInline(atx[2] ?? '') });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (INDENTED.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (INDENTED.test(lines[i] ?? '') || isBlank(lines[i] ?? ''))) {
        body.push((lines[i] ?? '').replace(INDENTED, ''));
        i += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1] ?? '')) body.pop();
      out.push({ kind: 'code', info: '', text: body.join('\n'), open: false });
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(QUOTE, ''));
        i += 1;
      }
      out.push(
        depth + 1 >= MARKDOWN_MAX_BLOCK_DEPTH
          ? text(inner)
          : { kind: 'quote', children: parseLines(inner, depth + 1) },
      );
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      i = parseList(lines, i, depth, out);
      continue;
    }
    // A table: a header row, then a delimiter row with as many cells.
    const next = lines[i + 1] ?? '';
    if (line.includes('|') && DELIMITER_ROW.test(next) && next.includes('-')) {
      const head = cells(line);
      const delimiters = cells(next);
      if (head.length === delimiters.length) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && !isBlank(lines[j] ?? '') && (lines[j] ?? '').includes('|')) {
          const row = cells(lines[j] ?? '');
          rows.push(head.map((_, c) => row[c] ?? ''));
          j += 1;
        }
        out.push({
          kind: 'table',
          align: delimiters.map(alignOf),
          head: head.map((cell) => parseInline(cell)),
          rows: rows.map((row) => row.map((cell) => parseInline(cell))),
        });
        i = j;
        continue;
      }
    }
    // A paragraph, unless a setext underline turns it into a heading. Every line loses its leading
    // whitespace, and only the LAST its trailing: two spaces before a newline are a hard break.
    const para: string[] = [line.replace(/^[ \t]+/, '')];
    let j = i + 1;
    let level: 1 | 2 | null = null;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j] ?? '';
      if (isBlank(candidate)) break;
      const underline = SETEXT.exec(candidate);
      if (underline !== null) {
        level = underline[1]?.startsWith('=') ? 1 : 2;
        j += 1;
        break;
      }
      if (interrupts(candidate)) break;
      para.push(candidate.replace(/^[ \t]+/, ''));
    }
    const children = parseInline(para.join('\n').trimEnd());
    out.push(
      level === null ? { kind: 'paragraph', children } : { kind: 'heading', level, children },
    );
    i = j;
  }
  return out;
}

/** One list from `start`, its items and their nested blocks; answers the line after it. */
function parseList(
  lines: readonly string[],
  start: number,
  depth: number,
  out: MarkdownBlock[],
): number {
  const first = ITEM.exec(lines[start] ?? '');
  const marker = first?.[2] ?? '-';
  const ordered = /\d/.test(marker);
  const kind = ordered ? marker.slice(-1) : marker;
  const items: MarkdownListItem[] = [];
  const nested = depth + 1 < MARKDOWN_MAX_BLOCK_DEPTH;
  const flat: string[] = [];
  let i = start;
  while (i < lines.length) {
    const head = ITEM.exec(lines[i] ?? '');
    if (head === null) break;
    const sameKind = ordered
      ? /\d/.test(head[2] ?? '') && head[2]?.endsWith(kind)
      : head[2] === kind;
    if (!sameKind) break;
    const pad = (head[3] ?? ' ').length;
    const indent = (head[1] ?? '').length + (head[2] ?? '').length + (pad > 4 ? 1 : pad);
    const body: string[] = [head[4] ?? ''];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j] ?? '';
      const leading = candidate.length - candidate.trimStart().length;
      if (isBlank(candidate)) {
        // A blank line stays in the item only when the next line is still indented into it.
        const after = lines[j + 1] ?? '';
        if (isBlank(after) || after.length - after.trimStart().length < indent) break;
        body.push('');
        continue;
      }
      if (leading >= indent) body.push(candidate.slice(indent));
      else if (
        !interrupts(candidate) &&
        !ITEM.test(candidate) &&
        !isBlank(body[body.length - 1] ?? '')
      ) {
        body.push(candidate.trimStart());
      } else break;
    }
    flat.push(...body);
    const task = TASK.exec(body[0] ?? '');
    if (task !== null) body[0] = (body[0] ?? '').slice(task[0].length);
    items.push({
      checked: task === null ? null : task[1] !== ' ',
      children: nested ? parseLines(body, depth + 1) : [text(body)],
    });
    i = j;
    if (isBlank(lines[i] ?? 'x')) {
      const after = ITEM.exec(lines[i + 1] ?? '');
      if (after === null) break;
      i += 1;
    }
  }
  out.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(marker, 10) : 1, items });
  return i;
}

/**
 * The block tree of a body. Never throws on content: over `MARKDOWN_MAX_CHARS` the parse stops at
 * the last line break before the cap and the remainder is one plain-text block.
 */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const normal = source.replace(/\r\n?/g, '\n');
  if (normal.length <= MARKDOWN_MAX_CHARS) return parseLines(normal.split('\n'), 0);
  const cut = normal.lastIndexOf('\n', MARKDOWN_MAX_CHARS);
  const at = cut <= 0 ? MARKDOWN_MAX_CHARS : cut;
  return [
    ...parseLines(normal.slice(0, at).split('\n'), 0),
    { kind: 'text', text: normal.slice(at).replace(/^\n/, '') },
  ];
}
