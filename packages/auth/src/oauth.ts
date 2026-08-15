// Single responsibility: the OAuth2/OIDC handshake. PKCE is mandatory rather than
// provider-dependent — an authorization code with no proof-of-possession is stealable from a
// redirect, and "this provider does not need it" is how that becomes a real incident. Provider
// configs are pure data: importing this file performs no network I/O and reads no env.

import { oauthStateInvalid } from './errors';
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
  readonly scopes: readonly string[];
  /**
   * The literal `true`, not `boolean`. A provider config saying `usesPkce: false` was always
   * invalid — an authorization code with no proof-of-possession is stealable from a redirect —
   * and a comment saying so is not a build error. This is, and it deletes every downstream
   * `if (provider.usesPkce)` branch along with the state it could ever have been false in.
   */
  readonly usesPkce: true;
  /** OIDC providers echo `nonce` in the id token; it binds the token to this browser. */
  readonly usesNonce: boolean;
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;
}

export const OAUTH_PROVIDERS = {
  github: {
    id: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    // GitHub omits a private address from the profile; the identity is still incomplete
    // without it, so the flow asks for the verified list rather than guessing.
    userEmailsUrl: 'https://api.github.com/user/emails',
    issuers: [],
    scopes: ['read:user', 'user:email'],
    usesPkce: true,
    usesNonce: false,
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Reached only when a narrowed `scopes` leaves the id token without an email claim.
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    userEmailsUrl: null,
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scopes: ['openid', 'email', 'profile'],
    usesPkce: true,
    usesNonce: true,
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  apple: {
    id: 'apple',
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    // Apple returns claims in the id token only; there is no userinfo endpoint to call.
    userInfoUrl: null,
    userEmailsUrl: null,
    issuers: ['https://appleid.apple.com'],
    scopes: ['name', 'email'],
    usesPkce: true,
    usesNonce: true,
    clientIdEnv: 'APPLE_CLIENT_ID',
    // Apple alone does not accept a static secret: `APPLE_CLIENT_SECRET` must hold the ES256
    // client-secret JWT signed with the .p8 key, which Apple expires every six months.
    clientSecretEnv: 'APPLE_CLIENT_SECRET',
  },
} as const satisfies Readonly<Record<string, OAuthProvider>>;

export type OAuthProviderId = keyof typeof OAUTH_PROVIDERS;

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = Object.freeze(
  Object.keys(OAUTH_PROVIDERS) as OAuthProviderId[],
);

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
  const provider = OAUTH_PROVIDERS[input.provider];
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
  const provider = OAUTH_PROVIDERS[handshake.provider];
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
