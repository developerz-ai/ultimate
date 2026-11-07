// `wiki/Error-Codes.md` split: one page per row of a `| Code | Means | … |` table, and an index
// that keeps every table as `Code | Means` with the code linked to its page. The file is 448 KB as
// one page; split, a code is a URL a search engine and an error's `docs:` can point at.

import type { WikiHeading } from '@ultimat3/manifest';
import { type Draft, type DraftLine, linesOf } from './draft';
import { fencedLines } from './fences';

/** A code row before its links are rewritten: each cell keeps the wiki line it sits on. */
export interface CodeDraft {
  /** Usually one; a row written `\`X_A\` / \`X_B\`` documents both, and each gets the page. */
  readonly codes: readonly string[];
  readonly section: { readonly title: string; readonly anchor: string };
  readonly cells: readonly { readonly label: string; readonly markdown: string }[];
  readonly origin: number;
}

/** A code cell: one backticked `X_*` code, or several joined by `/` or `,`. */
const CODE_CELL = /^`X_[A-Z0-9_]+`(?:\s*[/,]\s*`X_[A-Z0-9_]+`)*$/;

/** Every code a code cell names; empty for a cell that is not one. */
export const codesOf = (cell: string): readonly string[] =>
  CODE_CELL.test(cell)
    ? [...cell.matchAll(/`(X_[A-Z0-9_]+)`/g)].map((match) => match[1] ?? '')
    : [];
const SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;

/** A table row's cells, split on every unescaped `|`, the outer pipes dropped. */
export function cellsOf(row: string): readonly string[] {
  const inner = row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

export const codeUrl = (code: string): string => `/errors/${code}`;

/** Is this header a code table's: its first column `Code`, at least two more after it? */
const isCodeHeader = (cells: readonly string[]): boolean =>
  cells[0] === 'Code' && cells.length >= 3;

/**
 * The index draft and one draft per code row. A row whose first cell names no `X_*` code stays on
 * the index as written; only a code table's rows become pages.
 */
export function splitErrorCodes(
  file: string,
  lines: readonly string[],
  headings: readonly WikiHeading[],
  body: { readonly from: number; readonly title: string },
): { readonly index: Draft; readonly codes: readonly CodeDraft[] } {
  const fenced = fencedLines(lines);
  const out: DraftLine[] = [];
  const codes: CodeDraft[] = [];
  let header: readonly string[] | undefined;
  let section = { title: body.title, anchor: '' };
  for (const line of linesOf(lines, body.from, lines.length)) {
    const heading = headings.find((one) => one.line === line.origin);
    if (heading !== undefined) section = { title: heading.heading, anchor: heading.anchor };
    if (fenced[line.origin] === true || !line.text.startsWith('|')) {
      header = undefined;
      out.push(line);
      continue;
    }
    const cells = cellsOf(line.text);
    if (header === undefined) {
      header = cells;
      out.push(isCodeHeader(cells) ? { ...line, text: `| ${cells[0]} | ${cells[1]} |` } : line);
      continue;
    }
    if (!isCodeHeader(header)) {
      out.push(line);
      continue;
    }
    if (SEPARATOR.test(line.text)) {
      out.push({ ...line, text: '|---|---|' });
      continue;
    }
    const named = codesOf(cells[0] ?? '');
    if (named.length === 0) {
      out.push(line);
      continue;
    }
    const labels = header;
    codes.push({
      codes: named,
      section,
      origin: line.origin,
      cells: cells
        .slice(1)
        .map((markdown, index) => ({ label: labels[index + 1] ?? '', markdown })),
    });
    const linked = named.map((code) => `[\`${code}\`](${codeUrl(code)})`).join(' / ');
    out.push({ ...line, text: `| ${linked} | ${cells[1] ?? ''} |` });
  }
  return { index: { url: '/error-codes', file, title: body.title, lines: out }, codes };
}
