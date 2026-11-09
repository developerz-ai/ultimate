// How a failing fence is keyed in `README_FENCE_BACKLOG` / `WIKI_FENCE_BACKLOG`, and how `--pin`
// writes a row back. Per SITE — `<package or page>: <the fence's first code line>` — because a
// per-page count let one fixed example be swapped for a new broken one at an equal count. The first
// code line is the fence's own text, so prose edited around it leaves the key alone; editing the
// example itself re-keys it, which is the moment it should be looked at again.

import type { Fence } from './readme-fences';

/** The first non-blank code line, trimmed — what a reader sees first and what names the fence. */
export const fenceSite = (fence: Pick<Fence, 'pkg' | 'code'>): string =>
  `${fence.pkg}: ${(fence.code.find((line) => line.trim() !== '') ?? '').trim()}`;

/** The package or page half of a site key. `: ` occurs in neither a package nor a page name. */
export const pageOfSite = (site: string): string => {
  const cut = site.indexOf(': ');
  return cut === -1 ? site : site.slice(0, cut);
};

/**
 * A key as Biome writes it: bare when it is an identifier, else quoted with the quote that needs
 * fewer escapes — single unless the text holds more single quotes than double — so `--pin` output
 * passes `bunx biome check` unchanged.
 */
export function pinKey(key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return key;
  const singles = key.split("'").length - 1;
  const doubles = key.split('"').length - 1;
  const quote = singles > doubles ? '"' : "'";
  const body = key.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
  return `${quote}${body}${quote}`;
}

/** Sites per key, in the order the failures arrived. */
export function siteTally(failures: readonly { readonly site: string }[]): Record<string, number> {
  const tally = new Map<string, number>();
  for (const one of failures) tally.set(one.site, (tally.get(one.site) ?? 0) + 1);
  return Object.fromEntries(tally);
}

/**
 * `--pin`: every row lowered to what is measured, a row at zero dropped, none raised — raising is
 * a reviewed hand edit. Rows are re-sorted so two runs on one tree write one file.
 */
export function loweredRows(
  measured: Readonly<Record<string, number>>,
  backlog: Readonly<Record<string, number>>,
): string {
  return Object.entries(backlog)
    .map(
      ([site, count]) =>
        [site, Math.min(count, Object.hasOwn(measured, site) ? (measured[site] ?? 0) : 0)] as const,
    )
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([site, count]) => `  ${pinKey(site)}: ${count},`)
    .join('\n');
}

const ROW_LINE = /^ {2}(.+): \d+,$/;

/**
 * `--pin` over a backlog table's BODY, edited in place: each row lowered as `loweredRows` would
 * write it, a row at zero dropped with the `// why:` comments directly above it, every other line
 * — comments, row order — kept. A re-sorted, comment-stripped table turned a one-row removal into a
 * diff nobody could review. Shared by `readme-fences.ts` and `wiki-fences.ts`.
 */
export function lowerRowsInPlace(
  measured: Readonly<Record<string, number>>,
  backlog: Readonly<Record<string, number>>,
  body: string,
): string {
  // One rendering per row, through the same `loweredRows` the table was first written with.
  const lowered = new Map<string, string>();
  for (const site of Object.keys(backlog)) {
    lowered.set(pinKey(site), loweredRows(measured, { [site]: backlog[site] ?? 0 }));
  }
  const out: string[] = [];
  let comments: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('//')) {
      comments.push(line);
      continue;
    }
    const key = ROW_LINE.exec(line)?.[1];
    const row = key === undefined ? line : (lowered.get(key) ?? line);
    if (row !== '') out.push(...comments, row);
    comments = [];
  }
  out.push(...comments);
  return out.join('\n');
}

/** `--pin` over a whole backlog FILE: the body of `export const <name> … = {` … `};` lowered in place. */
export function pinnedBacklogSource(
  name: string,
  measured: Readonly<Record<string, number>>,
  backlog: Readonly<Record<string, number>>,
  source: string,
): string {
  const table = new RegExp(
    `(export const ${name}: Readonly<Record<string, number>> = \\{\\n)([\\s\\S]*?)(\\n\\};)`,
  );
  return source.replace(
    table,
    (_whole, open: string, body: string, close: string) =>
      `${open}${lowerRowsInPlace(measured, backlog, body)}${close}`,
  );
}
