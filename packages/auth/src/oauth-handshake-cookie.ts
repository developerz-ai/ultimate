// Single responsibility: the OAuth handshake as a cookie, for a hand-built leg over `beginOAuth` /
// `completeOAuthLogin`. Same name, same seal, same encoding as `oauthLogin`'s own state cookie
// (`identity-provider-cookie.ts`, `encodeOidcState`), so either leg can be the built-in one: a
// second name once left a built-in start leg and a hand-built callback unable to find each other.

import { readCookie, systemClock } from '@ultimat3/core';
import {
  clearIdentityStateCookie,
  identityStateCookieName,
  openIdentityState,
  sealIdentityState,
  serializeIdentityState,
} from './identity-provider-cookie';
import { decodeOidcState, encodeOidcState } from './identity-provider-oidc';
import type { OAuthHandshake, OAuthProviderId } from './oauth';
import { type HandshakeSealOptions, handshakeTtlMs, openHandshake } from './oauth-cookie';
import { oauthStateInvalid } from './oauth-errors';
import type { RequestLike } from './session';

/**
 * One cookie per provider, because a browser is one cookie jar and a user is allowed two tabs.
 * Under a single shared name, starting a `google` login while a `github` one is mid-flight
 * overwrites the github handshake — and the github callback then opens google's, fails
 * `X_OAUTH_STATE_INVALID` and tells the user to restart the flow that just collided again.
 * The name is the sign-in routes' own: `__Host-x_sso_<provider>`.
 */
export const handshakeCookieName = (provider: OAuthProviderId): string =>
  identityStateCookieName(provider);

/**
 * The name, and the `sealHandshake` format, this family wrote up to 31.1. Read — never written —
 * so a handshake begun on an old pod finishes on a new one during the deploy. Its life is the
 * handshake TTL (10 min by default), so one release of reading it is the whole transition.
 * Delete with the fallback below in 32.0.0.
 */
const LEGACY_HANDSHAKE_COOKIE_PREFIX = '__Host-x_oauth';

export interface HandshakeCookieOptions extends HandshakeSealOptions {
  /**
   * Defaults to `handshakeCookieName(provider)`. Overriding it opts out of the per-provider
   * scoping, so both legs have to pass the same one — a name set on the redirect and defaulted on
   * the callback reads a cookie that is not there.
   */
  readonly name?: string | undefined;
}

/**
 * Set on the redirect. `SameSite=Lax`: the callback is a top-level cross-site GET from the
 * provider, which `Lax` still attaches the cookie to and `Strict` would strip. A provider answering
 * with `response_mode=form_post` POSTs instead, and this cookie would not reach it.
 */
export function handshakeCookie(
  handshake: OAuthHandshake,
  options?: HandshakeCookieOptions,
): string {
  const maxAge = Math.floor(handshakeTtlMs(options) / 1000);
  const clock = options?.clock ?? systemClock;
  const state = encodeOidcState(handshake, clock.now().getTime());
  const sealed = sealIdentityState(handshake.provider, state, { ...options, clock });
  // The handshake already names its provider, so the two legs cannot disagree about the name.
  return serializeIdentityState(handshake.provider, sealed, 'GET', maxAge, options?.name);
}

/**
 * Send this with the callback's response, always — an authorization code is single-use, so the
 * handshake that authorised it must not outlive it. A mismatched attribute set leaves a live twin.
 *
 * `provider` is required: clearing every provider's would cancel a login running in another tab.
 * A legacy `__Host-x_oauth_<p>` cookie is not cleared — one `Set-Cookie` names one cookie; it
 * expires on its own `Max-Age`, and the code it guarded is spent.
 */
export const clearHandshakeCookie = (provider: OAuthProviderId, name?: string): string =>
  clearIdentityStateCookie(provider, 'GET', name);

/** Opens the current format, else the legacy one; the first refusal is the one reported. */
function open(sealed: string, provider: OAuthProviderId, options?: HandshakeSealOptions) {
  const clock = options?.clock ?? systemClock;
  try {
    const ttlMs = handshakeTtlMs(options);
    const state = openIdentityState(sealed, provider, { ...options, clock, ttlMs });
    return decodeOidcState(provider, state).handshake;
  } catch (refusal) {
    try {
      return openHandshake(sealed, provider, options);
    } catch {
      throw refusal;
    }
  }
}

/** Reads the cookie set on the redirect — by either leg — and returns the handshake. */
export function readHandshakeCookie(
  request: RequestLike,
  provider: OAuthProviderId,
  options?: HandshakeCookieOptions,
): OAuthHandshake {
  const header = request.headers.get('cookie');
  const sealed =
    readCookie(header, options?.name ?? handshakeCookieName(provider)) ??
    (options?.name === undefined
      ? readCookie(header, `${LEGACY_HANDSHAKE_COOKIE_PREFIX}_${provider}`)
      : null);
  if (sealed === null) {
    throw oauthStateInvalid(provider, 'no handshake cookie arrived with the callback');
  }
  return open(sealed, provider, options);
}
