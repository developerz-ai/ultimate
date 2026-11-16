// The one reader of the error-code page set: `wiki/Error-Codes.md` (the index, the never-ships
// sentence and the reserved codes) plus one `wiki/Error-Codes-<owner>.md` per manifest owner, where
// every code's row lives. Every repo-side reader and writer of a code row goes through here, so
// "which file holds a row" is answered once.

// why: Bun ships no path API; the root is joined with the host separator so Windows can open it.
import { join } from 'node:path';
import { splitRow } from '../wiki-tables';

/** The index page: the intro, the never-ships list, the generated index and the reserved codes. */
export const ERROR_CODE_INDEX = 'wiki/Error-Codes.md';

/** `wiki/Error-Codes.md` or `wiki/Error-Codes-<owner>.md`, by file name or by wiki path. */
const PAGE = /^(?:wiki\/)?Error-Codes(?:-([a-z0-9][a-z0-9-]*))?\.md$/;

export const isErrorCodePage = (path: string): boolean => PAGE.test(path.replaceAll('\\', '/'));

/** The page an owner's rows live on: a package directory name, or `scripts`. */
export const ownerPage = (owner: string): string => `wiki/Error-Codes-${owner}.md`;

/** `wiki/Error-Codes-cli.md` → `cli`; the index → `undefined`. */
export const ownerOfPage = (path: string): string | undefined =>
  PAGE.exec(path.replaceAll('\\', '/'))?.[1];

export interface ErrorCodePage {
  readonly path: string;
  readonly text: string;
}

/** Every page of the set, repo-relative and `/`-spelt: the index first, then owner pages by name. */
export async function errorCodePageFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  // Scanned from the root, so a tree with no `wiki/` answers an empty set rather than an ENOENT.
  for await (const file of new Bun.Glob('wiki/Error-Codes*.md').scan({ cwd: root })) {
    const path = file.replaceAll('\\', '/');
    if (isErrorCodePage(path)) found.push(path);
  }
  return found.sort((a, b) =>
    a === ERROR_CODE_INDEX ? -1 : b === ERROR_CODE_INDEX ? 1 : a < b ? -1 : 1,
  );
}

export async function readErrorCodePages(root: string): Promise<readonly ErrorCodePage[]> {
  const files = await errorCodePageFiles(root);
  return Promise.all(
    files.map(async (path) => ({ path, text: await Bun.file(join(root, path)).text() })),
  );
}

export interface CodeRow {
  /** Every code the first cell names: one, or two for a `X_A` / `X_B` row. */
  readonly codes: readonly string[];
  readonly means: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

/** A row's first cell opens on a backticked code; a plain `X_` there is an index line, not a row. */
const ROW = /^\|\s*`X_/;

export function codeRows(markdown: string): readonly CodeRow[] {
  return markdown.split('\n').flatMap((text, index) => {
    if (!ROW.test(text)) return [];
    const [first = '', means = ''] = splitRow(text);
    const codes = [...first.matchAll(/`(X_[A-Z0-9_]+)`/g)].map((match) => match[1] ?? '');
    return [{ codes, means: means.trim(), line: index + 1, text }];
  });
}

/** Code-point order: `X_A_B` after `X_AB` on every host, where `localeCompare` would not agree. */
export const compareCodes = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const CODE_HEADER = /^\|\s*Code\s*\|/;

/**
 * The page with `row` at its sorted place in the first `| Code |` table — before the first row
 * whose code sorts after it, else after the table's last row. The page is returned unchanged in
 * shape otherwise; a page with no code table gains none (the caller refuses that page).
 */
export function insertCodeRow(page: string, row: string): string {
  const lines = page.split('\n');
  const [code = ''] = codeRows(row)[0]?.codes ?? [];
  const header = lines.findIndex((line) => CODE_HEADER.test(line));
  if (header === -1) return page;
  let at = header + 2;
  while (at < lines.length && (lines[at] ?? '').startsWith('|')) {
    const [here = ''] = codeRows(lines[at] ?? '')[0]?.codes ?? [];
    if (compareCodes(here, code) > 0) break;
    at += 1;
  }
  lines.splice(at, 0, row);
  return lines.join('\n');
}

/** Whether the page has a `| Code |` table to insert into. */
export const hasCodeTable = (page: string): boolean =>
  page.split('\n').some((line) => CODE_HEADER.test(line));

const titleOf = (owner: string): string =>
  owner === 'scripts' ? 'repository scripts' : `\`@ultimat3/${owner}\``;

const leadOf = (owner: string): string =>
  owner === 'scripts'
    ? "Part of [Error codes](Error-Codes): the codes this repository's own gate scripts raise. They never ship to an app, so `x errors explain` does not know them; the row is the whole answer."
    : `Part of [Error codes](Error-Codes): every code \`@ultimat3/${owner}\` registers. \`x errors explain <CODE> --json\` prints the same row.`;

/** A new owner page: its title, its one line back to the index, and an empty code table. */
export const ownerPageText = (owner: string): string =>
  [
    `# Error codes: ${titleOf(owner)}`,
    '',
    leadOf(owner),
    '',
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '',
  ].join('\n');
