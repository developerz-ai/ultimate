// Every link the manual sends a reader off this site with: the one thing the static build cannot
// hold, because it never touches the network. Pure, so the job that probes them owns the I/O.

import { rewriteLinks } from './links';
import type { DocsCorpus } from './types';

/** One external URL, with the site pages that print it: what a fix has to edit. */
export interface OutboundLink {
  readonly url: string;
  readonly pages: readonly string[];
}

/** RFC 2606 and RFC 6761 names: the wiki's illustrations, which no probe can say anything about. */
const RESERVED_HOST = /(^|\.)(example|test|invalid|localhost)$|^example\.(com|net|org)$/;

/** The target as one comparable URL, or `undefined` when it is nothing a probe can reach. */
function probeable(target: string): string | undefined {
  if (!URL.canParse(target)) return undefined;
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (RESERVED_HOST.test(url.hostname)) return undefined;
  url.hash = '';
  return url.href;
}

/** Sorted by URL, because each becomes a named job step and a retry must replay the same names. */
export function outboundLinks(corpus: DocsCorpus): readonly OutboundLink[] {
  const found = new Map<string, Set<string>>();
  const read = (page: string, markdown: string): void => {
    rewriteLinks(markdown, ({ target }) => {
      const url = probeable(target);
      if (url !== undefined) found.set(url, (found.get(url) ?? new Set()).add(page));
      return undefined;
    });
  };
  for (const piece of [...corpus.pages, ...corpus.majors]) read(piece.url, piece.markdown);
  for (const code of corpus.codes) {
    for (const cell of code.rows.flatMap((row) => row.cells)) read(code.url, cell.markdown);
  }
  return [...found]
    .map(([url, pages]) => ({ url, pages: [...pages].sort() }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
}
