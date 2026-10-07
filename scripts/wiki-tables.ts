#!/usr/bin/env bun
// Enforce, as a gate step, that every markdown table in `wiki/` still renders as a table. The wiki
// is the only public documentation surface, and nothing read it: a row with one cell too many drops
// its last cell silently on GitHub, and a header with no `|---|` under it renders as a paragraph of
// literal pipes. Runs on `x verify`'s `manifest` step — the step that asks whether the files an
// agent reads still say what they mean.
//
// SPLIT ON UNESCAPED PIPES ONLY. GFM says a `|` inside a cell is escaped as `\|`, INCLUDING inside
// a code span, and `wiki/` carries 36 such rows — mostly TypeScript unions, `` `'a' \| 'b'` ``. A
// naive `awk -F'|'` reports all 36 as broken, and the first thing an author does with a checker
// that fails on good input is "fix" the good row. That is the whole reason this file is 100 lines
// of scanner instead of one line of split.
//
// A run that read NO table (no `wiki/`, a moved glob, a wrong root) is `X_WIKI_TABLE_UNSCANNED`,
// never green: `checkTables([])` answering nothing is a pass over nothing.
//
//   bun run scripts/wiki-tables.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const WIKI_GLOB = 'wiki/**/*.md';

export interface MarkdownFile {
  readonly path: string;
  readonly text: string;
}

/**
 * GFM's own rule: a backslash escapes the character after it, so `\|` is a literal pipe and never a
 * cell boundary. Leading and trailing delimiters are optional and are not cells.
 */
export function splitRow(row: string): readonly string[] {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char === '\\') {
      // Both characters, so `\\|` (an escaped BACKSLASH) still leaves the pipe as a delimiter.
      current += char + (body[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/** `|---|:--:|` — what turns the line above it into a header rather than a paragraph. */
export const isDelimiterRow = (row: string): boolean =>
  splitRow(row).every((cell) => /^\s*:?-+:?\s*$/.test(cell));

const isRow = (line: string): boolean => line.trim().startsWith('|');

/**
 * `row` drops content: GFM truncates a long row and pads a short one, so the cell renders nowhere
 * and nothing says so. `delimiter` and `orphan` are worse — neither renders as a table at all.
 */
export type TableGapKind = 'row' | 'delimiter' | 'orphan';

export interface TableGap {
  readonly kind: TableGapKind;
  readonly path: string;
  /** 1-based, so `path:line` opens the row in an editor. */
  readonly line: number;
  readonly cells: number;
  readonly expected: number;
}

/** Every gap, and how many tables (a header with a delimiter row under it) were read. */
function scanTables(files: readonly MarkdownFile[]): {
  readonly gaps: readonly TableGap[];
  readonly tables: number;
} {
  const gaps: TableGap[] = [];
  let tables = 0;
  for (const file of files) {
    const lines = file.text.split('\n');
    let fenced = false;
    let header: number | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      // A fenced block may hold anything, pipes included — a rendered table it is not.
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        header = undefined;
        continue;
      }
      if (fenced) continue;
      if (!isRow(line)) {
        header = undefined;
        continue;
      }
      const cells = splitRow(line).length;
      const at = { path: file.path, line: index + 1, cells };
      if (header !== undefined) {
        if (cells !== header) gaps.push({ kind: 'row', ...at, expected: header });
        continue;
      }
      const next = lines[index + 1] ?? '';
      if (!isRow(next)) {
        gaps.push({ kind: 'orphan', ...at, expected: cells });
        continue;
      }
      if (!isDelimiterRow(next)) {
        gaps.push({ kind: 'orphan', ...at, expected: cells });
        continue;
      }
      const delimiter = splitRow(next).length;
      if (delimiter !== cells) {
        gaps.push({
          kind: 'delimiter',
          path: file.path,
          line: index + 2,
          cells: delimiter,
          expected: cells,
        });
      }
      header = cells;
      tables += 1;
      index += 1;
    }
  }
  return { gaps, tables };
}

/** Pure, so the negative case is a fixture rather than an edit to a page the wiki publishes. */
export const checkTables = (files: readonly MarkdownFile[]): readonly TableGap[] =>
  scanTables(files).gaps;

const where = (gap: TableGap): string => `${gap.path}:${gap.line}`;

const rowFinding = (gap: TableGap): Finding => ({
  code: 'X_WIKI_TABLE_MALFORMED',
  cause: `${where(gap)} has ${gap.cells} cells and its header has ${gap.expected}, so the wiki renders this row with content dropped or blanks appended`,
  fix: `give the row at ${where(gap)} exactly ${gap.expected} cells, escaping any literal pipe as \\| — then bun run scripts/wiki-tables.ts --json`,
  at: where(gap),
});

const delimiterFinding = (gap: TableGap): Finding => ({
  code: 'X_WIKI_TABLE_MALFORMED',
  cause: `${where(gap)} is a delimiter row with ${gap.cells} cells under a header with ${gap.expected}, and GFM renders neither as a table`,
  fix: `give the delimiter row at ${where(gap)} exactly ${gap.expected} cells: ${'|---'.repeat(gap.expected)}|`,
  at: where(gap),
});

const orphanFinding = (gap: TableGap): Finding => ({
  code: 'X_WIKI_TABLE_MALFORMED',
  cause: `${where(gap)} begins with | and no |---| delimiter row follows it, so the wiki renders it as a paragraph of literal pipes`,
  fix: `add a delimiter row under ${where(gap)} — ${'|---'.repeat(gap.expected)}| — or stop starting that line with |`,
  at: where(gap),
});

const FINDINGS: Readonly<Record<TableGapKind, (gap: TableGap) => Finding>> = {
  row: rowFinding,
  delimiter: delimiterFinding,
  orphan: orphanFinding,
};

export const tableGapFindingFor = (gap: TableGap): Finding => FINDINGS[gap.kind](gap);

export async function readWiki(root: string): Promise<readonly MarkdownFile[]> {
  const glob = new Bun.Glob(WIKI_GLOB);
  const files: MarkdownFile[] = [];
  for await (const path of glob.scan({ cwd: root, absolute: false })) {
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const unscanned = (pages: number): Finding => ({
  code: 'X_WIKI_TABLE_UNSCANNED',
  cause: `${pages} ${WIKI_GLOB} page(s) were read and no table in them was, so this rule reported green over tables it never checked`,
  fix: 'bun run scripts/wiki-tables.ts --json   # from the repo root, where wiki/ is',
  at: 'wiki/',
});

/**
 * The verdict over a set of pages: every gap, or — when neither a table nor a gap was read —
 * the floor. The
 * wiki carries hundreds of tables, so zero means the glob or the root moved, never a clean wiki.
 */
export function wikiTableReport(files: readonly MarkdownFile[]): readonly Finding[] {
  const { gaps, tables } = scanTables(files);
  // A gap is something read, with its own repair: only a scan with neither is unscanned.
  return tables === 0 && gaps.length === 0
    ? [unscanned(files.length)]
    : gaps.map(tableGapFindingFor);
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const wikiTableFindings = async (root: string): Promise<readonly Finding[]> =>
  wikiTableReport(await readWiki(root));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const files = await readWiki(repoRoot());
  const findings = wikiTableReport(files);
  report(
    {
      ok: findings.length === 0,
      script: 'wiki-tables',
      summary:
        findings.length === 0
          ? `${files.length} wiki pages, every table row the cell count its header declares`
          : `${findings.length} table finding(s) across ${files.length} wiki pages`,
      findings,
    },
    args.json,
  );
}
