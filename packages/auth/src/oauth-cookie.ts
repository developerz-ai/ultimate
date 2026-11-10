// Single responsibility: the handshake's server-side codec (`sealHandshake` / `openHandshake`), its
// secret and its deadline. The two legs of an authorization-code login are separate HTTP requests,
// so `beginOAuth`'s state, nonce and PKCE verifier have to survive the round trip — and a framework
// that leaves that to the app gets one hand-rolled store per app, which is exactly where PKCE
// quietly stops proving anything. The cookie is `oauth-handshake-cookie.ts`.

import type { Clock } from '@ultimat3/core';
import { EnvMissingError, hmac, systemClock, timingSafeEqual } from '@ultimat3/core';
import type { OAuthHandshake, OAuthProviderId } from './oauth';
import { oauthStateInvalid } from './oauth-errors';
import { hasOAuthProvider } from './oauth-registry';
import { assertFiniteAuthCount } from './policy-numbers';
import { base64Url } from './tokens';

/** Long enough to read a consent screen, short enough that a lifted cookie is already stale. */
export const DEFAULT_HANDSHAKE_TTL_MS = 10 * 60 * 1000;

/**
 * One screen for both ends of the deadline, because it is one number bounding two things: the
 * server comparison in `openHandshake` and the `Max-Age` the browser is asked to honour. `NaN`
 * switches off both at once and neither says anything — `now - issuedAt > NaN` is false forever,
 * and `Max-Age=NaN` is not `delta-seconds`, so a browser drops the attribute and keeps the cookie
 * until the tab closes. What survives is the state, nonce and PKCE verifier that are the CSRF
 * defence of the callback leg, replayable a year later.
 *
 * Screened at every reader rather than once at seal time: the two legs are two HTTP requests and
 * two calls, so a check on the way out is one the way back never runs.
 */
export function handshakeTtlMs(options: HandshakeSealOptions | undefined): number {
  return assertFiniteAuthCount(
    'oauth.handshake.ttlMs',
    options?.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS,
    'the server-side replay deadline is a comparison that is false for every handshake and the cookie carries a Max-Age no browser keeps, so a lifted handshake stays redeemable',
    1,
  );
}

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
          : // Never its length: how long the configured secret is narrows a guess at it.
            `SESSION_SECRET is shorter than the ${MIN_SECRET_LENGTH} characters required`,
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
  if (!hasOAuthProvider(sealedProvider) || sealedProvider !== provider) {
    throw oauthStateInvalid(provider, 'the stored handshake belongs to a different provider');
  }

  // The cookie's own `Max-Age` is the client's copy of this deadline, and a client is free to
  // ignore it — so the age that decides is measured here, against the server's clock.
  const clock = options?.clock ?? systemClock;
  if (clock.now().getTime() - issuedAt > handshakeTtlMs(options)) {
    throw oauthStateInvalid(provider, 'the stored handshake expired before the callback arrived');
  }

  return { provider, state, nonce, verifier, redirectUri, authorizeUrl };
}

/** Keyed SHA-256. Untruncated, unlike a cursor's: a cookie has room and this authorises a login. */
function sign(body: string, secret: string): string {
  return hmac('sha256', secret, body, 'hex');
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
