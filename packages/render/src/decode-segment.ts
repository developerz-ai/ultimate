// Whether one URL path segment decodes: the answer to a malformed percent-escape on this side of
// the wire. Split from `registry.ts`, which re-exports it.

/**
 * `undefined` for a malformed percent-escape: `decodeURIComponent('%zz')` throws a bare `URIError`
 * where a router already has an answer, "no match". The one answer on this side of the wire to
 * "is this segment decodable?" (`@ultimat3/http`'s trie serves requests, `stages.ts`).
 */
export function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
