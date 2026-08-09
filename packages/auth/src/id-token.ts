// Single responsibility: turning a provider's id token into claims this handshake is allowed to
// believe. Signature verification is deliberately absent: this token is read only where it was
// fetched over TLS directly from the provider's token endpoint, which is the one case OIDC Core
// 3.1.3.7 exempts — a token that reaches the browser instead must never be parsed here.

import type { Clock } from '@ultimat3/core';
import { oauthStateInvalid, oauthTokenInvalid } from './errors';
import { OAUTH_PROVIDERS, type OAuthProvider, type OAuthProviderId } from './oauth';
import { timingSafeEqual } from './tokens';

/** The subset of OIDC claims this package acts on. Provider-specific extras are ignored. */
export interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly exp: number;
  readonly iat?: number | undefined;
  readonly nonce?: string | undefined;
  readonly email?: string | undefined;
  /** Google sends a boolean, Apple a `"true"` string. Both mean the same thing. */
  readonly email_verified?: boolean | string | undefined;
  readonly name?: string | undefined;
}

/** Two servers rarely agree on the second. Anything wider hides a genuinely expired token. */
export const ID_TOKEN_CLOCK_SKEW_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function decodeSegment(provider: string, segment: string, fix: string): Record<string, unknown> {
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  let parsed: unknown;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw oauthTokenInvalid(provider, 'the payload segment is not base64url-encoded JSON', fix);
  }
  if (!isRecord(parsed)) throw oauthTokenInvalid(provider, 'the payload is not an object', fix);
  return parsed;
}

/**
 * Structure only — no issuer, audience, expiry or nonce check. `verifyIdToken` is the entry
 * point every flow uses; this one exists because the two halves are worth reading apart.
 */
export function decodeIdToken(provider: OAuthProviderId, idToken: string): IdTokenClaims {
  const fix = `check that ${OAUTH_PROVIDERS[provider].clientIdEnv} names an app whose id token is a JWT`;
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments[1] === undefined || segments[1] === '') {
    throw oauthTokenInvalid(provider, 'the token is not a three-segment JWT', fix);
  }
  const payload = decodeSegment(provider, segments[1], fix);
  const iss = stringOrUndefined(payload['iss']);
  const sub = stringOrUndefined(payload['sub']);
  const aud = payload['aud'];
  const exp = payload['exp'];
  if (iss === undefined || sub === undefined) {
    throw oauthTokenInvalid(provider, 'the payload has no iss or sub claim', fix);
  }
  if (typeof exp !== 'number') {
    throw oauthTokenInvalid(provider, 'the payload has no numeric exp claim', fix);
  }
  const audience = Array.isArray(aud) ? aud.filter((one) => typeof one === 'string') : aud;
  if (typeof audience !== 'string' && !Array.isArray(audience)) {
    throw oauthTokenInvalid(provider, 'the payload has no aud claim', fix);
  }
  // `exactOptionalPropertyTypes`: an absent claim must be absent, not present-and-undefined.
  const iat = payload['iat'];
  const verified = payload['email_verified'];
  const nonce = stringOrUndefined(payload['nonce']);
  const email = stringOrUndefined(payload['email']);
  const name = stringOrUndefined(payload['name']);
  return {
    iss,
    aud: audience,
    sub,
    exp,
    ...(typeof iat === 'number' ? { iat } : {}),
    ...(nonce === undefined ? {} : { nonce }),
    ...(email === undefined ? {} : { email }),
    ...(typeof verified === 'boolean' || typeof verified === 'string'
      ? { email_verified: verified }
      : {}),
    ...(name === undefined ? {} : { name }),
  };
}

/** `"true"` and `true` both count; anything else — absent, `"false"`, a number — does not. */
export function idTokenEmailVerified(claims: IdTokenClaims): boolean {
  return claims.email_verified === true || claims.email_verified === 'true';
}

export interface VerifyIdTokenInput {
  readonly provider: OAuthProviderId;
  readonly idToken: string;
  /** The client id the authorize URL was built with. The token must be addressed to it. */
  readonly clientId: string;
  /** `OAuthHandshake.nonce`. Checked whenever the provider was asked for one. */
  readonly nonce: string;
  readonly clock: Clock;
}

/**
 * Issuer, audience, expiry and nonce, in that order. A nonce mismatch is
 * `X_OAUTH_STATE_INVALID` rather than a token error on purpose: it is the same class of event
 * as a forged `state` — a token minted for another browser being replayed into this one.
 */
export function verifyIdToken(input: VerifyIdTokenInput): IdTokenClaims {
  // Widened on purpose: `issuers` is a literal `readonly []` for a provider that issues no id
  // token, and `[].includes(string)` does not typecheck against `never`.
  const provider: OAuthProvider = OAUTH_PROVIDERS[input.provider];
  const claims = decodeIdToken(input.provider, input.idToken);

  if (!provider.issuers.includes(claims.iss)) {
    throw oauthTokenInvalid(
      provider.id,
      `iss was "${claims.iss}", expected one of ${provider.issuers.join(', ')}`,
      `confirm the token came from ${provider.tokenUrl} and not from a proxy that re-signs it`,
    );
  }

  const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!audience.includes(input.clientId)) {
    throw oauthTokenInvalid(
      provider.id,
      'aud does not include the client id this handshake was started with',
      `set ${provider.clientIdEnv} to the same client id beginOAuth() was called with`,
    );
  }

  if (claims.exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS <= input.clock.now().getTime()) {
    throw oauthTokenInvalid(
      provider.id,
      'the token is already expired',
      "sync this host's clock (`timedatectl status`), then restart the flow",
    );
  }

  if (provider.usesNonce && !timingSafeEqual(input.nonce, claims.nonce ?? '')) {
    throw oauthStateInvalid(provider.id, 'the id token nonce did not match the stored handshake');
  }

  return claims;
}
