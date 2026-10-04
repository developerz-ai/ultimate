// The one `Cookie:` request-header reader. At tier 0 because three packages need it — auth and http
// at tier 2 cannot import each other, i18n sits below both — and each copy had to rediscover the
// same thrown `URIError` on its own (`bun run flight-copies` refuses a fourth).

/**
 * A `Cookie:` header is attacker-controlled, and `decodeURIComponent('%')` throws a bare
 * `URIError` — which escapes every coded path that reads through here: an OAuth callback would
 * answer 500 instead of `X_OAUTH_STATE_INVALID`, and `curl -H 'Cookie: x-locale=%'` paged the
 * on-call from the `locale` stage. The raw value is returned instead, so the caller's own
 * rejection stays the readable failure; a raw value is still checked against a signature, a stored
 * hash or a `supported` list, and none of them match a mangled one.
 */
const decodeCookieValue = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * The value of cookie `name` in a `Cookie:` header, or `null` when the header or the cookie is
 * absent. Never throws: the header is client-authored, so an unreadable value is the raw value and
 * a header that is not a string at all is no cookie.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return decodeCookieValue(part.slice(equals + 1).trim());
  }
  return null;
}
