// What an unauthenticated *browser* gets instead of a problem document. An agent and an RPC
// client want `X_UNAUTHENTICATED` as JSON with a fix line; a person following a link wants the
// sign-in page. One condition, two audiences, decided here so the error stage stays one branch.

import type { RequestContext } from './context';
import { acceptsHtml } from './html-render';
import type { RedirectIntent } from './response';

/** The query parameter carrying where the visitor was going. One spelling, both halves. */
export const NEXT_PARAM = 'next';

/**
 * Where to send a browser that hit an `auth: 'required'` route with no session, or `undefined`
 * when the problem document is still the right answer.
 *
 * `signInPath` is `null` by default and the redirect is off until an app sets it: a framework
 * that guessed `/signin` would send every unauthenticated visitor of an app that spells it
 * `/login` to a 404, which is strictly worse than the JSON it replaced.
 *
 * 303, not 302: the request that failed authz may have been a form POST, and 303 turns the
 * follow-up into the GET the sign-in page actually is. Same reasoning as `setRedirect`.
 */
export function signInRedirect(input: {
  readonly code: string;
  readonly signInPath: string | null;
  readonly request: Request;
  readonly ctx: Pick<RequestContext, 'url' | 'method'>;
}): RedirectIntent | undefined {
  const { code, signInPath, request, ctx } = input;
  if (code !== 'X_UNAUTHENTICATED' || signInPath === null) return undefined;
  // The same question the overlay and the error page ask — "does this client render HTML?" — and
  // deliberately the same answer, so a client cannot get a page in dev and JSON in production.
  if (!acceptsHtml(request)) return undefined;
  // A sign-in page that declares `auth: 'required'` by mistake would otherwise redirect to
  // itself forever, and a browser reports that as a bare "too many redirects" with no code.
  if (ctx.url.pathname === signInPath) return undefined;
  const next = `${ctx.url.pathname}${ctx.url.search}`;
  return { location: `${signInPath}?${NEXT_PARAM}=${encodeURIComponent(next)}`, status: 303 };
}

/**
 * The other half of the round trip: where to send someone once they HAVE signed in.
 *
 * `raw` is the value a query or form parser already decoded ONCE — `props.query.next`, an action's
 * `next` input, `url.searchParams.get('next')` — so it is screened as it arrived and never
 * decoded again. A second decode changed the destination: `signInRedirect` carried
 * `/search?q=a%26b`, the parser handed back exactly that, and decoding it again landed on
 * `?q=a&b`, a different query; `?label=100%25done` threw and fell back. Normalising (below) removes
 * dot segments only; it never decodes, so `%26` is still `%26`.
 *
 * Everything except a same-origin path is refused and `fallback` is used instead. `?next=`
 * arrives from the URL bar, so it is attacker-controlled by definition — an unchecked value here
 * is an open redirect on a page whose entire job is to hold a session, which is the exact shape
 * phishing wants: a real domain, a real login, a hop to somewhere else.
 *
 * Refused: an absolute URL (`https://evil.test/x`), a scheme-relative one (`//evil.test`), a
 * backslash the browser normalises to a slash (`/\evil.test`), a value carrying any control
 * character, and anything not starting `/`. A percent-encoded `%2F%2F`, `%5C` or `%09` is NOT
 * refused, because it is not decoded: a browser resolves a `Location` without decoding it, so
 * each is an ordinary path segment on this origin — and the final parse below proves it.
 *
 * The control characters are not cosmetic. A browser DELETES tab, CR and LF from a `Location`
 * before it parses one, so `/\t/evil.test` — which starts with a single slash and passes a prefix
 * check — is parsed as `//evil.test`. NUL, ESC and DEL are not stripped, they are refused by
 * `Headers`, which is a 500 on the sign-in page. The URL parser strips the first three the same way
 * a browser does, which is why the last word here is the parse: whatever a client would actually
 * resolve has to still be a path on this origin.
 *
 * The answer is the RESOLVED path, query and fragment — dot segments removed, never the raw
 * string: a value checked by its resolution and returned unresolved let `/.//evil.test` pass as
 * same-origin and reach the client router as `//evil.test`. A resolved pathname starting `//` is
 * refused outright.
 *
 * Before the parse, a code point above U+007F is percent-encoded as UTF-8. The parser hands `/日本`
 * over decoded, `Headers` refuses anything above U+00FF, and a Latin-1 byte in a `Location` is read
 * as UTF-8 by the browser — so the raw form is not a destination any client can follow. A lone
 * surrogate has no UTF-8 encoding and falls back.
 */
export function nextAfterSignIn(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (hasControlCharacter(raw)) return fallback;
  const value = encodeNonAscii(raw);
  if (value === undefined) return fallback;
  // An origin no relative path could reach, so any value that resolves off it left this origin.
  const base = 'http://x.invalid';
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return fallback;
  }
  if (resolved.origin !== base) return fallback;
  // Dot segments can hide a `//`: `/.//evil.test` resolves on this origin with the pathname
  // `//evil.test`, which is another host the moment anything re-reads it without the base.
  if (resolved.pathname.startsWith('//')) return fallback;
  // The CHECKED string is the returned one. Returning `value` after checking its resolution let
  // the two differ, and the router re-resolved the difference off-site.
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** C0 controls and DEL — the bytes a browser strips from a `Location` or a header refuses. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Every run outside printable ASCII as UTF-8 percent-encoding, or `undefined` for a lone surrogate. */
function encodeNonAscii(value: string): string | undefined {
  try {
    // Controls are already refused, so everything this class matches is above U+007E.
    return value.replace(/[^ -~]+/g, (run) => encodeURI(run));
  } catch {
    return undefined;
  }
}
