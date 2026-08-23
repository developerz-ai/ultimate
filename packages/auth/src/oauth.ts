// Single responsibility: the OAuth2/OIDC handshake. PKCE is mandatory rather than
// provider-dependent — an authorization code with no proof-of-possession is stealable from a
// redirect, and "this provider does not need it" is how that becomes a real incident. Provider
// configs are pure data and live in `oauth-registry.ts`: importing this file performs no network
// I/O and reads no env.

import { oauthStateInvalid } from './oauth-errors';
import { providerFor } from './oauth-registry';
import { base64Url, randomToken, sha256Bytes, timingSafeEqual } from './tokens';

export interface OAuthProvider {
  readonly id: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly userInfoUrl: string | null;
  /** A second call, only where the primary address is not on the profile (GitHub). */
  readonly userEmailsUrl: string | null;
  /**
   * Every `iss` this provider is allowed to claim. Empty for a provider that issues no id
   * token. A list rather than one string because Google has issued both forms for years.
   */
  readonly issuers: readonly string[];
  /**
   * Where this provider publishes the keys its id tokens are signed with. `null` for a provider
   * that issues no id token (GitHub). A provider with a key set can have a token from it verified
   * on a channel that is not the token endpoint — IdP-initiated login, `form_post`, back-channel
   * logout — which is what `jwks.ts` and `verifyIdToken({ keys })` exist for.
   */
  readonly jwksUri: string | null;
  readonly scopes: readonly string[];
  /**
   * The literal `true`, not `boolean`. A provider config saying `usesPkce: false` was always
   * invalid — an authorization code with no proof-of-possession is stealable from a redirect —
   * and a comment saying so is not a build error. This is, and it deletes every downstream
   * `if (provider.usesPkce)` branch along with the state it could ever have been false in.
   *
   * It stays the literal now that `registerOAuthProvider` is open to any app: the mechanism this
   * package exists to own has to survive the opening, so an app cannot register a PKCE-less IdP.
   */
  readonly usesPkce: true;
  /** OIDC providers echo `nonce` in the id token; it binds the token to this browser. */
  readonly usesNonce: boolean;
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;
}

/**
 * Any registered provider's id — `string`, not a closed union, since 1.3.0. The union of three
 * consumer IdPs made an enterprise OP unrepresentable at the type level, which is a constraint no
 * configuration can escape. `providerFor(id)` is the runtime check that replaces it, and it
 * throws the same `X_OAUTH_PROVIDER_UNKNOWN` the route already answered with.
 */
export type OAuthProviderId = string;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/** RFC 7636 S256: `BASE64URL(SHA256(ASCII(verifier)))`. `plain` is not offered, ever. */
export function pkceChallenge(verifier: string): string {
  return base64Url(sha256Bytes(verifier));
}

export function createPkce(): PkcePair {
  // 32 random bytes -> 43 base64url chars, the RFC's minimum verifier length.
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

/** Everything the server must remember between the redirect and the callback. */
export interface OAuthHandshake {
  readonly provider: OAuthProviderId;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
}

export interface BeginOAuthInput {
  readonly provider: OAuthProviderId;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[] | undefined;
}

export function beginOAuth(input: BeginOAuthInput): OAuthHandshake {
  const provider = providerFor(input.provider);
  const pkce = createPkce();
  const state = randomToken(16);
  const nonce = randomToken(16);
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', (input.scopes ?? provider.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  if (provider.usesNonce) url.searchParams.set('nonce', nonce);
  return {
    provider: input.provider,
    state,
    nonce,
    verifier: pkce.verifier,
    redirectUri: input.redirectUri,
    authorizeUrl: url.toString(),
  };
}

export interface OAuthCallback {
  readonly state: string;
  readonly code: string;
  /**
   * Only a `form_post` response carries a nonce back on the redirect itself. In the plain code
   * flow the nonce is a claim inside the id token, and `verifyIdToken` is what checks it — so
   * this is verified when present and never required, or an OIDC login could not complete.
   */
  readonly nonce?: string | undefined;
}

/**
 * The only gate between a redirect and a token exchange. Every rejection is
 * `X_OAUTH_STATE_INVALID` — the callback is one handshake, and naming which half failed
 * tells an attacker which half to keep guessing at.
 */
export function assertOAuthCallback(handshake: OAuthHandshake, callback: OAuthCallback): void {
  const provider = providerFor(handshake.provider);
  if (!timingSafeEqual(handshake.state, callback.state)) {
    throw oauthStateInvalid(provider.id, 'state did not match the stored handshake');
  }
  // Unconditional: `usesPkce` is the literal `true`, so there is no provider to exempt.
  if (handshake.verifier.length < 43) {
    throw oauthStateInvalid(provider.id, 'no PKCE verifier was stored for this handshake');
  }
  if (callback.nonce !== undefined && !timingSafeEqual(handshake.nonce, callback.nonce)) {
    throw oauthStateInvalid(provider.id, 'nonce did not match the stored handshake');
  }
}
