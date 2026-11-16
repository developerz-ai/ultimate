// The generated index of `wiki/Error-Codes.md`: one row per owner page and one line per code, read
// off the owner pages and nothing else. Text in, text out — `scripts/error-code-pages.ts` holds the
// committed index to it, and `bun run new-error-code` regenerates it in the same write as the row.

import type { ErrorCodePage } from './error-code-pages';
import { codeRows, compareCodes, ownerOfPage } from './error-code-pages';

/** The command that rewrites the block, and the fix a stale one names. */
export const INDEX_WRITE = 'bun run scripts/error-code-pages.ts --write';
export const INDEX_OPEN = '<!-- error-codes:index -->';
export const INDEX_CLOSE = '<!-- /error-codes:index -->';
export const ownerName = (owner: string): string =>
  owner === 'scripts' ? 'repository scripts' : `\`@ultimat3/${owner}\``;

/** The generated block's lines: a table of owner pages, then one line per code and page. */
export function renderIndex(pages: readonly ErrorCodePage[]): readonly string[] {
  const owned = pages.flatMap((page) => {
    const owner = ownerOfPage(page.path);
    return owner === undefined ? [] : [{ owner, rows: codeRows(page.text) }];
  });
  owned.sort((a, b) => compareCodes(a.owner, b.owner));
  const perPage = owned.map(({ owner, rows }) => {
    const seen = new Set(rows.flatMap((row) => row.codes));
    return { owner, seen };
  });
  const lines = perPage.flatMap(({ owner, seen }) => [...seen].map((code) => ({ code, owner })));
  lines.sort((a, b) => compareCodes(a.code, b.code) || compareCodes(a.owner, b.owner));
  return [
    `Generated from the owner pages by \`${INDEX_WRITE}\`; \`--check\` refuses drift (\`X_ERROR_CODE_INDEX_STALE\`). A code's row, with its cause and fix, is on the page it links to.`,
    '',
    '## By package',
    '',
    '| Package | Page | Codes |',
    '|---|---|---|',
    ...perPage.map(
      ({ owner, seen }) =>
        `| ${ownerName(owner)} | [Error-Codes-${owner}](Error-Codes-${owner}) | ${seen.size} |`,
    ),
    '',
    '## Every code',
    '',
    // Code → page only: the title lives on the owner page with its cause and fix. Repeating every
    // title here made the index 174 KB, the size the split was asked to end (owner, 2026-11-16).
    '| Code | Page |',
    '|---|---|',
    ...lines.map(({ code, owner }) => `| ${code} | [${owner}](Error-Codes-${owner}) |`),
  ];
}

/** The index with its generated block replaced, or `undefined` when either marker is missing. */
export function withIndex(index: string, body: readonly string[]): string | undefined {
  const lines = index.split('\n');
  const start = lines.indexOf(INDEX_OPEN);
  const end = start === -1 ? -1 : lines.indexOf(INDEX_CLOSE, start + 1);
  if (end === -1) return undefined;
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}
