// Whether an unsafe request a BROWSER sent — with the session cookie, or to obtain one — came
// from somewhere allowed to make it. CORS does not answer this: `application/x-www-form-urlencoded` is a CORS-simple content
// type, so `<form method="post">` on evil.test is SENT and EXECUTED with the session cookie
// attached — `cors.origins: []` only stops the attacker reading the reply, long after the refund
// went through. `setRedirect` exists so those form posts work without JS, which makes them a
// first-class surface here rather than a legacy one.

import { classifyAddress, proveSameOrigin } from '@ultimat3/core';
import type { CorsConfig } from './cors';
import { originListed } from './cors';
import { HttpError } from './errors';

export type CsrfMode = 'origin' | 'off';

export interface CsrfConfig {
  /**
   * `'origin'` — an unsafe method from a credentialed browser must prove same-origin, through
   * `sec-fetch-site` or an `Origin` the app already allows. Costs a client nothing.
   * `'off'` — for an API with no cookie session at all; say so, do not discover it.
   */
  readonly mode: CsrfMode;
}

export const DEFAULT_CSRF: CsrfConfig = { mode: 'origin' };

/** Methods with no side effects, per RFC 9110. A CSRF check on these is a check on nothing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export interface CsrfCheckInput {
  readonly method: string;
  /** The origin this app was reached on — scheme from `ctx.https`, host from the request URL. */
  readonly selfOrigin: string;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  /** A bearer token is not ambient: a cross-site page cannot make the browser attach one. */
  readonly hasAuthorizationHeader: boolean;
  /**
   * No session resolved. NOT an exemption: a sign-in form is forgeable too (login CSRF — the
   * visitor ends up in the attacker's account), so an anonymous write that carries browser
   * evidence is judged exactly as a credentialed one. See `checkCsrf` for the one thing it buys.
   */
  readonly anonymous: boolean;
  readonly cors: CorsConfig;
  readonly config: CsrfConfig;
}

export type CsrfVerdict =
  | { readonly ok: true }
  /** Why it was refused, in terms the caller can act on. Never echoes a header verbatim. */
  | { readonly ok: false; readonly reason: string };

/**
 * `sec-fetch-site` first because it is the browser's own answer and cannot be set by script;
 * `Origin` second, so an app that lists a sibling origin in `cors.origins` keeps working. A
 * request with neither — a non-browser client with a cookie, or a browser too old to send
 * either — is refused: "we could not tell" is the case this exists for.
 *
 * An ANONYMOUS request carrying neither is the one case let through: there is no ambient
 * credential to ride and no browser evidence to judge, which is an inbound webhook or a
 * server-to-server call, never a page a hostile site can drive — every browser that can submit a
 * cross-site form sends `Origin` on it. Either header present, and it is judged like any other.
 */
export const checkCsrf = (input: CsrfCheckInput): CsrfVerdict => {
  if (input.config.mode === 'off') return { ok: true };
  if (SAFE_METHODS.has(input.method)) return { ok: true };
  if (input.hasAuthorizationHeader) return { ok: true };
  if (input.anonymous && input.origin === null && input.secFetchSite === null) return { ok: true };

  // The rule itself is core's, shared with the sync node's upgrade: one answer to "did this
  // come from this app?" on every surface an ambient credential reaches.
  //
  // `originListed`, never `allowedOrigin`: that one answers the RESPONSE header, and for
  // `origins: ['*'], credentials: false` — the only wildcard `assertCorsConfig` admits — its
  // answer is `'*'`, which is not null and so read as "this origin is one we allow". A
  // credentialed cross-site POST from evil.test was therefore accepted by the check that exists
  // to refuse exactly it. An exact match is the only allowance a write may be built on.
  return proveSameOrigin({
    selfOrigins: [input.selfOrigin],
    origin: input.origin,
    secFetchSite: input.secFetchSite,
    listed: (origin) => originListed(input.cors, origin),
    listName: 'http.cors.origins',
  });
};

/** The origin a browser compares against — the PUBLIC one, so a TLS-terminating proxy agrees. */
export const selfOrigin = (url: URL, https: boolean): string =>
  `${https ? 'https' : 'http'}://${url.host}`;

/**
 * A write a browser sent — with its ambient credential, or anonymously to obtain one — that could
 * not be shown to come from this app. Never a 401: who is calling was never the question.
 *
 * From a LOOPBACK `ip` the caller is `curl` against `x dev`: it sends neither
 * header, and the remedies below name a token or a config change dev does not need. The header a
 * browser would send is the whole repair there, and it is safe to hand out: CSRF defends a BROWSER
 * from a hostile page, and a client that can set headers is not one a page can drive.
 */
export const csrfBlocked = (
  pathname: string,
  reason: string,
  ip: string | null = null,
): HttpError =>
  ip !== null && classifyAddress(ip) === 'loopback'
    ? new HttpError({
        code: 'X_CSRF_BLOCKED',
        cause: `${pathname} refused a write it could not show came from this app: ${reason}`,
        fix: "curl -H 'sec-fetch-site: same-origin' -X POST http://localhost:3000/the-path-above   # a local client proves same-origin the way a browser does; the session cookie still decides who is calling",
      })
    : new HttpError({
        code: 'X_CSRF_BLOCKED',
        cause: `${pathname} refused a write it could not show came from this app: ${reason}`,
        fix: "call it with an Authorization header instead of the session cookie, add the calling origin to configureHttp({ cors: { origins } }), or configureHttp({ csrf: { mode: 'off' } }) if this app has no cookie session at all",
      });
