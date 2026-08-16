// Single responsibility: turning a provider's id token into claims this handshake is allowed to
// believe. Every caller must say where its trust comes from: `keys: 'token-endpoint-tls'` is the
// one channel OIDC Core 3.1.3.7 exempts from a signature check, and anything else — IdP-initiated
// login, `response_mode=form_post`, back-channel logout, token exchange — passes a `JwksKeySource`
// and gets the signature verified. The argument is required rather than defaulted because a
// default is what silently makes the second door as trusting as the first.

import type { Clock } from '@ultimat3/core';
import { renderCauseValue } from '@ultimat3/core';
import { oauthStateInvalid, oauthTokenInvalid, restartAt } from './errors';
import { type IdTokenKeys, verifyJwtSignature } from './jwks';
import type { OAuthProvider, OAuthProviderId } from './oauth';
import { providerFor } from './oauth-registry';
import { base64UrlBytes, timingSafeEqual } from './tokens';

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
  const bytes = base64UrlBytes(segment);
  let parsed: unknown;
  try {
    if (bytes === null) throw new TypeError('not base64url');
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
  const fix = `check that ${providerFor(provider).clientIdEnv} names an app whose id token is a JWT`;
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
  // The filter can empty a non-empty array (`aud: [1, 2]`), and an empty audience addresses
  // nobody — `verifyIdToken` would then check the client id against nothing and pass.
  const audience = Array.isArray(aud) ? aud.filter((one) => typeof one === 'string') : aud;
  if (typeof audience !== 'string' && !(Array.isArray(audience) && audience.length > 0)) {
    throw oauthTokenInvalid(provider, 'the payload has no aud claim naming a string audience', fix);
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

/**
 * `"true"` and `true` both count; anything else — absent, `"false"`, a number — does not. Lives
 * here rather than at each call site because userinfo spells the same flag the same two ways, and
 * two copies of the rule is two places for one of them to start rounding a login up to verified.
 */
export const isVerifiedFlag = (value: unknown): boolean => value === true || value === 'true';

export function idTokenEmailVerified(claims: IdTokenClaims): boolean {
  return isVerifiedFlag(claims.email_verified);
}

export interface VerifyIdTokenInput {
  readonly provider: OAuthProviderId;
  readonly idToken: string;
  /** The client id the authorize URL was built with. The token must be addressed to it. */
  readonly clientId: string;
  /** `OAuthHandshake.nonce`. Checked whenever the provider was asked for one. */
  readonly nonce: string;
  readonly clock: Clock;
  /**
   * Required, and there is deliberately no default. `'token-endpoint-tls'` asserts this token was
   * read off a TLS response from the provider's own token endpoint — the OIDC Core 3.1.3.7 case,
   * and the only one where an unverified JWT is safe. Every other channel passes a key source:
   * `providerJwks(providerFor(id))`, or a `createJwksClient({ jwksUri })` of its own.
   */
  readonly keys: IdTokenKeys;
}

/**
 * Signature, issuer, audience, expiry and nonce, in that order — signature first, because every
 * claim below it is only worth reading once something proved who wrote them. A nonce mismatch is
 * `X_OAUTH_STATE_INVALID` rather than a token error on purpose: it is the same class of event
 * as a forged `state` — a token minted for another browser being replayed into this one.
 */
export async function verifyIdToken(input: VerifyIdTokenInput): Promise<IdTokenClaims> {
  // Widened on purpose: `issuers` is a literal `readonly []` for a provider that issues no id
  // token, and `[].includes(string)` does not typecheck against `never`.
  const provider: OAuthProvider = providerFor(input.provider);
  const claims = decodeIdToken(input.provider, input.idToken);

  if (
    input.keys !== 'token-endpoint-tls' &&
    !(await verifyJwtSignature(input.idToken, input.keys))
  ) {
    throw oauthTokenInvalid(
      provider.id,
      'the signature does not verify against the published key set for this issuer',
      `confirm the token came from ${provider.tokenUrl} and was not minted by whoever posted it here`,
    );
  }

  if (!provider.issuers.includes(claims.iss)) {
    throw oauthTokenInvalid(
      provider.id,
      // `claims.iss` is a field of the JWT the caller just presented — whatever they put in it,
      // newlines and quotes included. Hand-written quotes around it did not escape either, so a
      // forged `iss` could close the sentence and write a second log line an operator reads as
      // genuine. `renderCauseValue` renders it as a JSON string literal, quotes included, which
      // is why the manual pair is gone. `issuers` is registered config and needs no rendering.
      `iss was ${renderCauseValue(claims.iss)}, expected one of ${provider.issuers.join(', ')}`,
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
      `sync this host's clock (\`timedatectl status\`), then ${restartAt(provider.id)}`,
    );
  }

  if (provider.usesNonce && !timingSafeEqual(input.nonce, claims.nonce ?? '')) {
    throw oauthStateInvalid(provider.id, 'the id token nonce did not match the stored handshake');
  }

  return claims;
}
