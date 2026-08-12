// What an unauthenticated *browser* gets instead of a problem document. An agent and an RPC
// client want `X_UNAUTHENTICATED` as JSON with a fix line; a person following a link wants the
// sign-in page. One condition, two audiences, decided here so the error stage stays one branch.

import type { RequestContext } from './context';
import { wantsOverlay } from './overlay';
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
  // The same question `wantsOverlay` asks — "does this client render HTML?" — and deliberately
  // the same answer, so a client cannot get the overlay in dev and JSON in production.
  if (!wantsOverlay(request)) return undefined;
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
 * backslash the browser normalises to a slash (`/\evil.test`), and anything not starting `/`.
 */
export function nextAfterSignIn(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = decodeURIComponent(raw);
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
