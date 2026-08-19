// Which cookies a URL may see — RFC 6265 §5.1.3 (domain-match) and §5.1.4 (path-match), as one
// decision every transport asks.
//
// It is a SECURITY rule and not a formatting one: a session snapshot's jar is `browser.cookies()`,
// i.e. every domain the session ever touched — an SSO hop's included — and the HTTP leg picks from
// it by hand rather than by a browser's own jar. A suffix test with no dot boundary sends a
// `bank.test` session cookie to `evilbank.test`; one with no host-only rule sends it to
// `sub.bank.test`. Both are the same one-line mistake, in opposite directions.

import type { ScrapeCookie } from './target';

/**
 * The dot IS the rule, in both directions.
 *
 * A stored `.bank.test` is DOMAIN-scoped — a browser records the leading dot for a cookie set with
 * a `Domain=` attribute, and that is what CDP's `Network.getAllCookies` hands back — so it reaches
 * `bank.test` and any subdomain of it. A stored `bank.test` is HOST-ONLY and reaches exactly that
 * host. `ScrapeCookie` carries no `hostOnly` flag because the CDP cookie shape has none to carry
 * (`cdp-port.ts`), so the leading dot is the only signal there is, and it is enough.
 */
export function cookieDomainMatches(host: string, domain: string): boolean {
  const requested = host.trim().toLowerCase();
  const stored = domain.trim().toLowerCase();
  const scoped = stored.startsWith('.');
  const bare = scoped ? stored.slice(1) : stored;
  if (bare === '' || requested === '') return false;
  if (requested === bare) return true;
  return scoped && requested.endsWith(`.${bare}`);
}

/**
 * RFC 6265 §5.1.4. `/admin` covers `/admin` and `/admin/users`, and never `/administrators` —
 * the boundary is a `/`, exactly as it is for a domain. An empty stored path is `/`, which is what
 * a jar entry written by hand usually means.
 */
export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  const wanted = requestPath === '' ? '/' : requestPath;
  const stored = cookiePath === '' ? '/' : cookiePath;
  if (wanted === stored) return true;
  if (!wanted.startsWith(stored)) return false;
  return stored.endsWith('/') || wanted.charAt(stored.length) === '/';
}

/**
 * A `secure` cookie over plaintext is the same leak one hop further down: `http:` on a hostile
 * network is readable. `localhost` is the one exception every browser makes, and a fixture host
 * that is not is simply refused the cookie rather than silently downgraded.
 */
const trustworthy = (url: URL): boolean =>
  url.protocol === 'https:' ||
  url.hostname === 'localhost' ||
  url.hostname === '127.0.0.1' ||
  url.hostname === '[::1]';

/**
 * Fails CLOSED, like `hostDecision()`: a URL that will not parse gets no cookies at all. Expiry is
 * deliberately NOT filtered here — `ScrapeCookie.expires` carries no unit (CDP answers seconds,
 * a hand-written jar tends to hold milliseconds) and dropping a live session cookie over a guess
 * is worse than sending one the site will refuse itself.
 */
export function cookiesForUrl(
  cookies: readonly ScrapeCookie[],
  url: string,
): readonly ScrapeCookie[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const secureOk = trustworthy(parsed);
  return cookies.filter(
    (cookie) =>
      cookieDomainMatches(parsed.hostname, cookie.domain) &&
      cookiePathMatches(parsed.pathname, cookie.path) &&
      (!cookie.secure || secureOk),
  );
}

/** An absent path is `/` here too — §5.1.4's rule, so it cannot outrank a real path on length. */
const pathLength = (path: string): number => (path === '' ? 1 : path.length);

/**
 * The `cookie:` header this URL earns, or `undefined` when the jar has nothing for it.
 *
 * ORDERED, RFC 6265 §5.4: longer paths first. Two cookies may share a name — a `sid` at `/` and a
 * `sid` at `/admin` — and a server reading the first occurrence has to see the specific one; jar
 * order is an accident of how the browser filled it. The sort is stable, so a tie keeps jar order,
 * which is the nearest thing this jar has to §5.4's creation-time tiebreak (`ScrapeCookie` carries
 * no creation time, and CDP's cookie shape has none to carry).
 */
export function cookieHeaderFor(cookies: readonly ScrapeCookie[], url: string): string | undefined {
  const jar = [...cookiesForUrl(cookies, url)].sort(
    (left, right) => pathLength(right.path) - pathLength(left.path),
  );
  return jar.length === 0 ? undefined : jar.map((c) => `${c.name}=${c.value}`).join('; ');
}
