// Every code the framework registers has a page. The `errors` gate already holds every code to a
// row in `wiki/Error-Codes.md`; this holds every row to a URL, so a split rule that stops matching
// a row shape is a red build, never a code whose `docs:` link 404s.

import { DocsCodePageMissingError } from './errors';
import type { DocsCorpus } from './types';

/** Throws `X_DOCS_CODE_PAGE_MISSING` naming every declared code the corpus built no page for. */
export function assertCodePages(declared: readonly string[], corpus: DocsCorpus): void {
  const built = new Set(corpus.codes.map((piece) => piece.code));
  const missing = declared.filter((code) => !built.has(code));
  if (missing.length > 0) throw new DocsCodePageMissingError({ codes: missing });
}
