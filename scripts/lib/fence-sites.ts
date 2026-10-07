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
