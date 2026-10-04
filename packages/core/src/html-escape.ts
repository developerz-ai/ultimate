// The one HTML character table: how an untrusted value becomes inert text or attribute content.
// At tier 0 because every package that writes markup — http, mail, render, seo, the dashboards —
// can reach it, and a second table is one character away from a hole (`bun run flight-copies`).

/** A `Map`, so a lookup never reaches `Object.prototype` (`bun run proto-index`). */
const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

const HTML_SPECIAL = /[&<>"']/g;

/**
 * Text content AND attribute values, in any quoting — one set for both, deliberately. A text-only
 * subset is correct exactly until someone uses it for an attribute, and a no-`'` set until someone
 * writes a single-quoted one. `&#39;` rather than `&apos;`: it is a numeric reference, so it means
 * the same thing in HTML 4, HTML 5 and XML. One pass, so `&` is never escaped twice.
 */
export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIAL, (char) => HTML_ESCAPES.get(char) ?? char);
}
