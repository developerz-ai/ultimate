// What a sign-out RESPONSE carries, beside ending the session row (`logout`): the session cookie
// expired, and `Clear-Site-Data`, so the browser drops everything the previous principal left on
// the origin — the page store's IndexedDB, local storage, the service worker and its cached pages.

import type { SessionPolicy } from './session';
import { clearSessionCookie } from './session';

/**
 * `"cache", "storage"` and never `"cookies"`: the response itself sets the cookie that marks the
 * browser signed out, and `"cookies"` would clear that too. `"storage"` unregisters the service
 * worker and empties Cache Storage — which is the point, since a cached private page is the previous
 * principal's data — so the next load reinstalls the worker and re-precaches. That cost is paid once
 * per sign-out, and it is the trade the framework makes: a PWA's offline cache does not outlive the
 * person it was cached for.
 */
export const SIGN_OUT_CLEAR_SITE_DATA = '"cache", "storage"';

export interface SignOutHeadersOptions {
  /**
   * The framework session's policy, when the app signs out of `@ultimat3/auth`'s own session: the
   * cookie is then expired here. Absent for an app with its own cookie (it sets that itself).
   */
  readonly session?: SessionPolicy | undefined;
  readonly cookieName?: string | undefined;
}

/**
 * The headers a sign-out response appends, in order: `for (const [name, value] of
 * signOutHeaders()) ctx.headers.append(name, value)`. The browser acts on them only for a secure
 * context (HTTPS, or localhost) — which is every deployed app and every `x dev`.
 */
export function signOutHeaders(options: SignOutHeadersOptions = {}): readonly [string, string][] {
  return [
    ...(options.session === undefined
      ? []
      : [
          ['set-cookie', clearSessionCookie(options.session, options.cookieName)] as [
            string,
            string,
          ],
        ]),
    ['clear-site-data', SIGN_OUT_CLEAR_SITE_DATA],
  ];
}
