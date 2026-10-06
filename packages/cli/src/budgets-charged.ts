// What a route's measured JavaScript was made of, file by file: the clause and the `--json` facts
// `X_BUDGET_EXCEEDED` carries, so a reader can tell a heavier chunk from a byte counted twice
// without re-running the build. Split from `budgets.ts`, which measures and compares.

import type { JsonValue } from './output';

/** One app file a document made the browser fetch, and its bytes on disk. */
export interface ChargedFile {
  readonly url: string;
  readonly bytes: number;
}

/**
 * Named in the cause; the rest are summed. A page carries one or two files in practice, and a
 * sentence listing forty is one nobody reads — `meta.charged` still holds every one of them.
 */
const NAMED_FILES = 5;

/** Heaviest first, then by URL, so the clause and the stats file are reproducible. */
export function heaviestFirst(files: readonly ChargedFile[]): readonly ChargedFile[] {
  return [...files].sort((a, b) =>
    b.bytes !== a.bytes ? b.bytes - a.bytes : a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
  );
}

/**
 * `; charged: /islands/post-form-04f75f18.js 81306 B, inline scripts 855 B` — exact bytes, never
 * `formatBytes`: a 22 kB disagreement between two platforms is the question this answers, and a
 * rounded figure hides the byte a duplicate shows up as. Empty for a row an older build wrote.
 */
export function chargedClause(
  charged: readonly ChargedFile[] | undefined,
  inlineBytes: number | undefined,
): string {
  const files = heaviestFirst(charged ?? []);
  const parts = files.slice(0, NAMED_FILES).map((one) => `${one.url} ${String(one.bytes)} B`);
  const rest = files.slice(NAMED_FILES);
  if (rest.length > 0) {
    const bytes = rest.reduce((sum, one) => sum + one.bytes, 0);
    parts.push(`${String(rest.length)} more files ${String(bytes)} B`);
  }
  if (inlineBytes !== undefined && inlineBytes > 0) {
    parts.push(`inline scripts ${String(inlineBytes)} B`);
  }
  return parts.length === 0 ? '' : `; charged: ${parts.join(', ')}`;
}

/** The same facts as data, or `undefined` when the row predates them — absent is not empty. */
export function chargedMeta(
  jsBytes: number,
  charged: readonly ChargedFile[] | undefined,
  inlineBytes: number | undefined,
): { readonly [key: string]: JsonValue } | undefined {
  if (charged === undefined && inlineBytes === undefined) return undefined;
  return {
    jsBytes,
    charged: heaviestFirst(charged ?? []).map((one) => ({ url: one.url, bytes: one.bytes })),
    inlineJsBytes: inlineBytes ?? 0,
  };
}
