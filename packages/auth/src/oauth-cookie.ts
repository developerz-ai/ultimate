// Single responsibility: where the handshake lives between the redirect and the callback. The
// two legs of an authorization-code login are separate HTTP requests, so `beginOAuth`'s state,
// nonce and PKCE verifier have to survive the round trip — and a framework that leaves that to
// the app gets one hand-rolled store per app, which is exactly where PKCE quietly stops proving
// anything. Sealed here and opened here, so the cookie below and a server-side store share one
// format at one trust level.

import type { Clock } from '@ultimat3/core';
import { EnvMissingError, systemClock } from '@ultimat3/core';
import { oauthStateInvalid } from './errors';
import { OAUTH_PROVIDERS, type OAuthHandshake, type OAuthProviderId } from './oauth';
import { type RequestLike, readCookie } from './session';
import { base64Url, timingSafeEqual } from './tokens';

/** `__Host-` for the same reason the session cookie carries it: no subdomain can plant one. */
export const OAUTH_HANDSHAKE_COOKIE_PREFIX = '__Host-x_oauth';

/**
 * One cookie per provider, because a browser is one cookie jar and a user is allowed two tabs.
 * Under a single shared name, starting a `google` login while a `github` one is mid-flight
 * overwrites the github handshake — and the github callback then opens google's, fails
 * `X_OAUTH_STATE_INVALID` and tells the user to restart the flow that just collided again.
 * Scoping the name makes the two handshakes independent instead of the last writer's.
 */
export function handshakeCookieName(provider: OAuthProviderId): string {
  return `${OAUTH_HANDSHAKE_COOKIE_PREFIX}_${provider}`;
}

/** Long enough to read a consent screen, short enough that a lifted cookie is already stale. */
export const DEFAULT_HANDSHAKE_TTL_MS = 10 * 60 * 1000;

/** `wiki/Configuration.md` requires it at >=32 chars for the `web` role; this is that gate. */
const MIN_SECRET_LENGTH = 32;

/**
 * The app secret, read at call time rather than module scope so importing this file still reads
 * no env — the same rule `oauthCredentials()` follows for the client id and secret.
 */
export function handshakeSecret(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const secret = env['SESSION_SECRET']?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new EnvMissingError({
      cause:
        secret === ''
          ? 'SESSION_SECRET is not set, so an oauth handshake cannot be signed'
          : `SESSION_SECRET is ${secret.length} characters and at least ${MIN_SECRET_LENGTH} are required`,
      fix: 'export SESSION_SECRET="$(openssl rand -hex 32)"',
      meta: { key: 'SESSION_SECRET', minLength: MIN_SECRET_LENGTH },
    });
  }
  return secret;
}

export interface HandshakeSealOptions {
  /** Defaults to `SESSION_SECRET`. */
  readonly secret?: string | undefined;
  /** No `Date.now()` in this package: the handshake's age is measured against this. */
  readonly clock?: Clock | undefined;
  readonly ttlMs?: number | undefined;
}

export interface HandshakeCookieOptions extends HandshakeSealOptions {
  /**
   * Defaults to `handshakeCookieName(provider)`. Overriding it opts out of the per-provider
   * scoping, so both legs have to pass the same one — a name set on the redirect and defaulted on
   * the callback reads a cookie that is not there.
   */
  readonly name?: string | undefined;
}

/**
 * Signed, not encrypted, for the reason the cursor codec is: every field here is already the
 * browser's own — `state` travelled in the URL it was just sent to, and the verifier and nonce
 * are that browser's halves of this handshake. What the signature buys is that the browser
 * cannot *invent* a handshake, which is what would let an attacker's code land in a victim's
 * session. What secrecy is needed against everyone else is the cookie's `HttpOnly; Secure`.
 */
export function sealHandshake(handshake: OAuthHandshake, options?: HandshakeSealOptions): string {
  const clock = options?.clock ?? systemClock;
  const body = base64Url(
    new TextEncoder().encode(
      JSON.stringify([
        handshake.provider,
        handshake.state,
        handshake.nonce,
        handshake.verifier,
        handshake.redirectUri,
        handshake.authorizeUrl,
        clock.now().getTime(),
      ]),
    ),
  );
  return `${body}.${sign(body, options?.secret ?? handshakeSecret())}`;
}

/**
 * The only way back. `provider` is required rather than read from the payload because a
 * handshake opened without one is a github handshake finishing a google callback — and an
 * optional check is one a call site can forget.
 *
 * Every rejection is `X_OAUTH_STATE_INVALID`, like `assertOAuthCallback`'s: the handshake is one
 * object, and naming which field failed tells an attacker which field to keep guessing at.
 */
export function openHandshake(
  sealed: string,
  provider: OAuthProviderId,
  options?: HandshakeSealOptions,
): OAuthHandshake {
  const dot = sealed.lastIndexOf('.');
  if (dot <= 0) throw oauthStateInvalid(provider, 'the stored handshake is not signed');

  const body = sealed.slice(0, dot);
  const expected = sign(body, options?.secret ?? handshakeSecret());
  if (!timingSafeEqual(expected, sealed.slice(dot + 1))) {
    throw oauthStateInvalid(
      provider,
      'the stored handshake was tampered with, or the secret rotated',
    );
  }

  const parsed = parseBody(body, provider);
  if (!Array.isArray(parsed) || parsed.length !== 7) {
    throw oauthStateInvalid(provider, 'the stored handshake is not a handshake');
  }
  const [sealedProvider, state, nonce, verifier, redirectUri, authorizeUrl, issuedAt] =
    parsed as readonly unknown[];
  if (
    typeof sealedProvider !== 'string' ||
    typeof state !== 'string' ||
    typeof nonce !== 'string' ||
    typeof verifier !== 'string' ||
    typeof redirectUri !== 'string' ||
    typeof authorizeUrl !== 'string' ||
    typeof issuedAt !== 'number' ||
    !Number.isFinite(issuedAt)
  ) {
    throw oauthStateInvalid(provider, 'the stored handshake is not a handshake');
  }
  if (!Object.hasOwn(OAUTH_PROVIDERS, sealedProvider) || sealedProvider !== provider) {
    throw oauthStateInvalid(provider, 'the stored handshake belongs to a different provider');
  }

  // The cookie's own `Max-Age` is the client's copy of this deadline, and a client is free to
  // ignore it — so the age that decides is measured here, against the server's clock.
  const clock = options?.clock ?? systemClock;
  if (clock.now().getTime() - issuedAt > (options?.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS)) {
    throw oauthStateInvalid(provider, 'the stored handshake expired before the callback arrived');
  }

  return { provider, state, nonce, verifier, redirectUri, authorizeUrl };
}

/**
 * Set on the redirect. `SameSite=Lax` is the one attribute that differs in reasoning from the
 * session cookie's: the callback is a top-level cross-site GET from the provider, which `Lax`
 * still attaches the cookie to and `Strict` would strip — leaving every login to fail its state
 * check. A provider answering with `response_mode=form_post` POSTs instead, and this cookie
 * would not reach it; no provider in `OAUTH_PROVIDERS` is configured that way.
 */
export function handshakeCookie(
  handshake: OAuthHandshake,
  options?: HandshakeCookieOptions,
): string {
  const maxAge = Math.floor((options?.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS) / 1000);
  // The handshake already names its provider, so the two legs cannot disagree about the name.
  const name = options?.name ?? handshakeCookieName(handshake.provider);
  return `${name}=${sealHandshake(handshake, options)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Send this with the callback's response, always — an authorization code is single-use, so the
 * handshake that authorised it must not outlive it. A mismatched attribute set leaves a live twin.
 *
 * `provider` is required for the reason `openHandshake`'s is: clearing the unscoped name would
 * clear nothing, and clearing every provider's would cancel a login running in another tab.
 */
export function clearHandshakeCookie(provider: OAuthProviderId, name?: string): string {
  return `${name ?? handshakeCookieName(provider)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Reads the cookie set on the redirect and returns the handshake `completeOAuthLogin` takes. */
export function readHandshakeCookie(
  request: RequestLike,
  provider: OAuthProviderId,
  options?: HandshakeCookieOptions,
): OAuthHandshake {
  const sealed = readCookie(request, options?.name ?? handshakeCookieName(provider));
  if (sealed === null) {
    throw oauthStateInvalid(provider, 'no handshake cookie arrived with the callback');
  }
  return openHandshake(sealed, provider, options);
}

/** Keyed SHA-256. Untruncated, unlike a cursor's: a cookie has room and this authorises a login. */
function sign(body: string, secret: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(body).digest('hex');
}

function parseBody(body: string, provider: OAuthProviderId): unknown {
  const padded = body.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw oauthStateInvalid(provider, 'the stored handshake is not readable');
  }
}
