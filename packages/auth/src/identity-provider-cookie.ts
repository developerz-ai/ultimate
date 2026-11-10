// Single responsibility: where an `IdentityRedirect.state` lives between the two legs — HMAC-
// signed with `SESSION_SECRET`, bound to its provider, aged on the server's clock, one cookie per
// provider. SAML answers with a cross-site POST no `SameSite=Lax` cookie rides, so a POST-callback
// provider's cookie is `SameSite=None`; `Secure` and `__Host-` keep it off every other site.

import { type Clock, hmac, readCookie, serializeSetCookie, timingSafeEqual } from '@ultimat3/core';
import type { IdentityProvider } from './identity-provider';
import { DEFAULT_HANDSHAKE_TTL_MS, handshakeSecret } from './oauth-cookie';
import { oauthStateInvalid } from './oauth-errors';
import { base64Url, base64UrlBytes } from './tokens';

export const IDENTITY_STATE_COOKIE_PREFIX = '__Host-x_sso';

export const identityStateCookieName = (provider: string): string =>
  `${IDENTITY_STATE_COOKIE_PREFIX}_${provider}`;

export interface IdentityStateOptions {
  readonly clock: Clock;
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
}

const sign = (body: string, secret: string): string => hmac('sha256', secret, body, 'hex');

export function identityStateCookie(
  provider: IdentityProvider,
  state: string,
  options: IdentityStateOptions,
): string {
  const body = base64Url(
    new TextEncoder().encode(JSON.stringify([provider.id, state, options.clock.now().getTime()])),
  );
  const sealed = `${body}.${sign(body, options.secret ?? handshakeSecret())}`;
  return serializeSetCookie(identityStateCookieName(provider.id), sealed, {
    maxAge: Math.floor(DEFAULT_HANDSHAKE_TTL_MS / 1000),
    sameSite: provider.callbackMethod === 'POST' ? 'None' : 'Lax',
  });
}

/**
 * Sent with every callback answer: the state it carried is spent whatever the outcome. Takes the id
 * and method rather than a provider, so a refusal before the provider resolved can still clear it.
 */
export const clearIdentityStateCookie = (
  id: string,
  callbackMethod: IdentityProvider['callbackMethod'],
): string =>
  serializeSetCookie(identityStateCookieName(id), '', {
    maxAge: 0,
    sameSite: callbackMethod === 'POST' ? 'None' : 'Lax',
  });

/** The state `begin` returned, or `X_OAUTH_STATE_INVALID` — one refusal for every way it fails. */
export function readIdentityState(
  request: Request,
  provider: IdentityProvider,
  options: IdentityStateOptions,
): string {
  const sealed = readCookie(request.headers.get('cookie'), identityStateCookieName(provider.id));
  if (sealed === null) throw oauthStateInvalid(provider.id, 'no sign-in state cookie arrived');
  const dot = sealed.lastIndexOf('.');
  const body = sealed.slice(0, Math.max(dot, 0));
  if (
    dot <= 0 ||
    !timingSafeEqual(sign(body, options.secret ?? handshakeSecret()), sealed.slice(dot + 1))
  ) {
    throw oauthStateInvalid(
      provider.id,
      'the sign-in state was tampered with, or the secret rotated',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(body) ?? new Uint8Array()));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw oauthStateInvalid(provider.id, 'the sign-in state is not readable');
  }
  const [id, state, issuedAt] = parsed as readonly unknown[];
  if (id !== provider.id || typeof state !== 'string' || typeof issuedAt !== 'number') {
    throw oauthStateInvalid(provider.id, 'the sign-in state belongs to another provider');
  }
  if (options.clock.now().getTime() - issuedAt > DEFAULT_HANDSHAKE_TTL_MS) {
    throw oauthStateInvalid(provider.id, 'the sign-in state expired before the IdP answered');
  }
  return state;
}
