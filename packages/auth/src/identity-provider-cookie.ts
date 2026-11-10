// Single responsibility: where an `IdentityRedirect.state` lives between the two legs — HMAC-
// signed with `SESSION_SECRET`, bound to its provider, aged on the server's clock, one cookie per
// provider. SAML answers with a cross-site POST no `SameSite=Lax` cookie rides, so a POST-callback
// provider's cookie is `SameSite=None`; `Secure` and `__Host-` keep it off every other site.

import { type Clock, hmac, readCookie, serializeSetCookie, timingSafeEqual } from '@ultimat3/core';
import type { IdentityProvider } from './identity-provider';
import { DEFAULT_HANDSHAKE_TTL_MS, handshakeSecret } from './oauth-cookie';
import { oauthStateInvalid } from './oauth-errors';
import { assertFiniteAuthCount } from './policy-numbers';
import { base64Url, base64UrlBytes } from './tokens';

/**
 * The ONE name every sign-in state cookie is written and read under — the built-in legs and the
 * exported `handshakeCookie` family alike (`handshakeCookieName` is this function). Two names
 * once let a built-in start leg and a hand-built callback miss each other entirely.
 */
export const IDENTITY_STATE_COOKIE_PREFIX = '__Host-x_sso';

export const identityStateCookieName = (provider: string): string =>
  `${IDENTITY_STATE_COOKIE_PREFIX}_${provider}`;

export interface IdentityStateOptions {
  readonly clock: Clock;
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
  /** Defaults to `DEFAULT_HANDSHAKE_TTL_MS`; the caller screens it. */
  readonly ttlMs?: number | undefined;
}

type CallbackMethod = IdentityProvider['callbackMethod'];

const sign = (body: string, secret: string): string => hmac('sha256', secret, body, 'hex');

const sameSite = (method: CallbackMethod) => (method === 'POST' ? 'None' : 'Lax');

/** `[id, state, issuedAt]`, signed: the value both cookie writers put under the one name. */
export function sealIdentityState(
  id: string,
  state: string,
  options: IdentityStateOptions,
): string {
  const body = base64Url(
    new TextEncoder().encode(JSON.stringify([id, state, options.clock.now().getTime()])),
  );
  return `${body}.${sign(body, options.secret ?? handshakeSecret())}`;
}

/** The state `sealIdentityState` sealed for `id`, or `X_OAUTH_STATE_INVALID` for every failure. */
export function openIdentityState(
  sealed: string,
  id: string,
  options: IdentityStateOptions,
): string {
  const dot = sealed.lastIndexOf('.');
  const body = sealed.slice(0, Math.max(dot, 0));
  if (
    dot <= 0 ||
    !timingSafeEqual(sign(body, options.secret ?? handshakeSecret()), sealed.slice(dot + 1))
  ) {
    throw oauthStateInvalid(id, 'the sign-in state was tampered with, or the secret rotated');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(body) ?? new Uint8Array()));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw oauthStateInvalid(id, 'the sign-in state is not readable');
  }
  const [sealedId, state, issuedAt] = parsed as readonly unknown[];
  if (sealedId !== id || typeof state !== 'string' || typeof issuedAt !== 'number') {
    throw oauthStateInvalid(id, 'the sign-in state belongs to another provider');
  }
  // Screened at the reader: `now - issuedAt > NaN` is false forever, so a NaN deadline never expires.
  const ttlMs = assertFiniteAuthCount(
    'oauth.handshake.ttlMs',
    options.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS,
    'the server-side replay deadline is a comparison that is false for every sign-in state, so a lifted one stays redeemable',
    1,
  );
  if (options.clock.now().getTime() - issuedAt > ttlMs) {
    throw oauthStateInvalid(id, 'the sign-in state expired before the IdP answered');
  }
  return state;
}

/** A sealed value as a `Set-Cookie`; `name` defaults to the one name. */
export const serializeIdentityState = (
  id: string,
  value: string,
  callbackMethod: CallbackMethod,
  maxAge: number,
  name: string = identityStateCookieName(id),
): string => serializeSetCookie(name, value, { maxAge, sameSite: sameSite(callbackMethod) });

export const identityStateCookie = (
  provider: IdentityProvider,
  state: string,
  options: IdentityStateOptions,
): string =>
  serializeIdentityState(
    provider.id,
    sealIdentityState(provider.id, state, options),
    provider.callbackMethod,
    Math.floor(DEFAULT_HANDSHAKE_TTL_MS / 1000),
  );

/**
 * Sent with every callback answer: the state it carried is spent whatever the outcome. Takes the id
 * and method rather than a provider, so a refusal before the provider resolved can still clear it.
 */
export const clearIdentityStateCookie = (
  id: string,
  callbackMethod: CallbackMethod,
  name?: string,
): string => serializeIdentityState(id, '', callbackMethod, 0, name);

/** The state `begin` returned, or `X_OAUTH_STATE_INVALID` — one refusal for every way it fails. */
export function readIdentityState(
  request: Request,
  provider: IdentityProvider,
  options: IdentityStateOptions,
): string {
  const sealed = readCookie(request.headers.get('cookie'), identityStateCookieName(provider.id));
  if (sealed === null) throw oauthStateInvalid(provider.id, 'no sign-in state cookie arrived');
  return openIdentityState(sealed, provider.id, options);
}
