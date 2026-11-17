// Single responsibility: a route's LITERAL segment as the one regex source every matcher tests a
// pathname with — `@ultimat3/render`'s `compilePattern` and `@ultimat3/pwa`'s worker rules. Tier 0
// beside `routeRank` because both readers are tier 4 and may not import each other. Pure, no I/O.

/** What `encodeURIComponent` leaves as written; the WHATWG path serializer escapes a subset of the rest. */
const UNRESERVED = /^[A-Za-z0-9\-_.!~*'()]$/;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hexDigit = (digit: string): string =>
  /[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit;

/** `é` as `%[Cc]3%[Aa]9`: its UTF-8 bytes, each escape in either hex case. */
const escaped = (char: string): string =>
  [...new TextEncoder().encode(char)]
    .map((byte) => {
      const hex = byte.toString(16).toUpperCase().padStart(2, '0');
      return `%${hexDigit(hex.charAt(0))}${hexDigit(hex.charAt(1))}`;
    })
    .join('');

/**
 * The regex source (no anchors) for every spelling of a literal segment that the request router
 * (`@ultimat3/http`'s trie: the raw segment, or its percent-decoding) routes to it AND that a writer
 * produces: `canonicalPath` writes `|` as `%7C`, `URL.pathname` writes `é` as `%C3%A9` and `%` as
 * itself, a hand-typed link may use lower-case hex. Each character a writer escapes is matched raw
 * or escaped; one no writer escapes (`p`, `.`) only raw. A `%` matches raw only in the literal's
 * own spelling, because a raw `%` beside an escape does not decode — the router 404s `50%x%7C`.
 */
export function literalSegmentPattern(segment: string): string {
  const chars = [...segment];
  if (chars.every((char) => UNRESERVED.test(char))) return escapeRegex(segment);
  const decoded = chars
    .map((char) => {
      if (UNRESERVED.test(char)) return escapeRegex(char);
      if (char === '%') return escaped(char);
      return `(?:${escapeRegex(char)}|${escaped(char)})`;
    })
    .join('');
  return segment.includes('%') ? `(?:${escapeRegex(segment)}|${decoded})` : decoded;
}
