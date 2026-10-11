// A request pathname as the route table reads it: its segments, each one's decoded text, and the
// ONE spelling every pathname the router treats as the same address shares. The router matches on
// these functions and a store keyed by path (`@ultimat3/render`'s `isr`) keys on the same ones, so
// "routes to the same page" and "is the same entry" cannot be decided by two normalisers.

/** The non-empty segments: `/a/b/` and `//a//b` are both `['a', 'b']`. */
export const pathSegments = (path: string): readonly string[] =>
  path.split('/').filter((segment) => segment.length > 0);

/** `/a/b/` and `//a//b` both normalise to `/a/b`; `/` stays `/`. Segments are kept as written. */
export const normalizePath = (path: string): string => {
  const segments = pathSegments(path);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
};

/**
 * `undefined` instead of the bare `URIError` `decodeURIComponent('%ZZ')` throws. A pathname is
 * whatever the client typed, and an exception from the match would leave the pipeline with
 * `X_INTERNAL` — a 500, and a page for the on-call, for a request only the caller can fix.
 */
export const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/** What `encodeURIComponent` escapes and a path segment may carry as written (RFC 3986 `pchar`). */
const SEGMENT_SAFE = /%(?:24|26|2B|2C|3A|3B|3D|40)/g;

/**
 * One segment in its one spelling: decoded as the router decodes it, then every character a path
 * segment may not carry literally percent-encoded, upper-case hex. So `%61bc` is `abc`, `caf%c3%a9`
 * is `caf%C3%A9`, and `a%2fb` is `a%2Fb` — a `/` INSIDE a segment stays encoded, because the router
 * hands it to one param (`a/b`) and never splits on it. `@ : + , ; = $ &` stay as written, which is
 * how `URL.pathname` spells them: an address that needs no escape is its own canonical form.
 *
 * A segment that will not decode (`%ZZ`) is kept as written. The router refuses it for a param
 * (`path-invalid`), so it reaches a page only as a static segment spelled exactly that way.
 */
export const canonicalSegment = (segment: string): string => {
  const decoded = decodeSegment(segment);
  if (decoded === undefined) return segment;
  try {
    return encodeURIComponent(decoded).replace(SEGMENT_SAFE, decodeURIComponent);
  } catch {
    // A lone surrogate: not text a URL can carry, and never what `URL.pathname` hands over.
    return segment;
  }
};

/**
 * A pathname in the one spelling shared by every pathname the router matches identically: no empty
 * segment, no trailing slash, each segment `canonicalSegment`'s. Idempotent. Dot segments are not
 * this function's — `URL` resolved them (`%2e%2e` included) before a pathname existed.
 */
export const canonicalPath = (path: string): string => {
  const segments = pathSegments(path);
  return segments.length === 0 ? '/' : `/${segments.map(canonicalSegment).join('/')}`;
};
