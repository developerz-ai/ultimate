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
 * Everything except a same-origin path is refused and `fallback` is used instead. `?next=`
 * arrives from the URL bar, so it is attacker-controlled by definition — an unchecked value here
 * is an open redirect on a page whose entire job is to hold a session, which is the exact shape
 * phishing wants: a real domain, a real login, a hop to somewhere else.
 *
 * Refused: an absolute URL (`https://evil.test/x`), a scheme-relative one (`//evil.test`), a
 * backslash the browser normalises to a slash (`/\evil.test`), a value carrying a TAB, CR or LF,
 * and anything not starting `/`.
 *
 * The control characters are not cosmetic. A browser DELETES tab, CR and LF from a `Location`
 * before it parses one, so `/%09/evil.test` decodes to `/\t/evil.test` — which starts with a
 * single slash, passes a prefix check, and is then parsed as `//evil.test`. The URL parser
 * strips them the same way, which is why the last word here is the parse: whatever a client
 * would actually resolve has to still be a path on this origin.
 */
export function nextAfterSignIn(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined || raw === '') return fallback;
  // `?next=%` is a bare `URIError`, and this runs while the pipeline is already rendering a 401.
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\t\r\n]/.test(value)) return fallback;
  // An origin no relative path could reach, so any value that resolves off it left this origin.
  const base = 'http://x.invalid';
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return fallback;
  }
  if (resolved.origin !== base) return fallback;
  return value;
}
