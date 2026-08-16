// Whether an unsafe request carrying an AMBIENT credential came from somewhere allowed to make
// it. CORS does not answer this: `application/x-www-form-urlencoded` is a CORS-simple content
// type, so `<form method="post">` on evil.test is SENT and EXECUTED with the session cookie
// attached — `cors.origins: []` only stops the attacker reading the reply, long after the refund
// went through. `setRedirect` exists so those form posts work without JS, which makes them a
// first-class surface here rather than a legacy one.

import type { CorsConfig } from './cors';
import { allowedOrigin } from './cors';

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

/** The complete `Sec-Fetch-Site` vocabulary. Anything else was written by a non-browser. */
const KNOWN_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

export interface CsrfCheckInput {
  readonly method: string;
  /** The origin this app was reached on — scheme from `ctx.https`, host from the request URL. */
  readonly selfOrigin: string;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  /** A bearer token is not ambient: a cross-site page cannot make the browser attach one. */
  readonly hasAuthorizationHeader: boolean;
  /** Anonymous callers have no credential to ride, so nothing to forge. */
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
 */
export const checkCsrf = (input: CsrfCheckInput): CsrfVerdict => {
  if (input.config.mode === 'off') return { ok: true };
  if (SAFE_METHODS.has(input.method)) return { ok: true };
  if (input.anonymous) return { ok: true };
  if (input.hasAuthorizationHeader) return { ok: true };

  const site = input.secFetchSite;
  if (site === 'same-origin' || site === 'none') return { ok: true };
  if (input.origin === input.selfOrigin) return { ok: true };
  if (input.origin !== null && allowedOrigin(input.cors, input.origin) !== null) {
    return { ok: true };
  }
  // Only the four values a browser can send are quoted back. Anything else is a client that
  // wrote the header itself, and echoing what it wrote is how a rejected value reaches the log
  // store and the response body — the same defect the error-map stage's log line had.
  if (site !== null) {
    const known = KNOWN_SITES.has(site) ? site : 'a value no browser sends';
    return { ok: false, reason: `the request reported sec-fetch-site: ${known}` };
  }
  return {
    ok: false,
    reason:
      input.origin === null
        ? 'the request carried neither sec-fetch-site nor origin, so it cannot be shown to be same-origin'
        : 'the origin it declares is not this app and is not listed in http.cors.origins',
  };
};

/** The origin a browser compares against — the PUBLIC one, so a TLS-terminating proxy agrees. */
export const selfOrigin = (url: URL, https: boolean): string =>
  `${https ? 'https' : 'http'}://${url.host}`;
