// Single responsibility: the three consumer IdPs Ultimate ships with, as plain data. They live
// apart from `oauth-registry.ts` so the registry can be seeded from them while `oauth.ts` reads
// the registry — the only edge back to `oauth.ts` is the type, and a type is erased, so there is
// no runtime cycle between the three files.

import type { OAuthProvider } from './oauth';

export const GITHUB_PROVIDER: OAuthProvider = {
  id: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userInfoUrl: 'https://api.github.com/user',
  // GitHub omits a private address from the profile; the identity is still incomplete
  // without it, so the flow asks for the verified list rather than guessing.
  userEmailsUrl: 'https://api.github.com/user/emails',
  issuers: [],
  // GitHub is OAuth2 and not OIDC: no id token, therefore no key set to verify one against.
  jwksUri: null,
  scopes: ['read:user', 'user:email'],
  usesPkce: true,
  usesNonce: false,
  clientIdEnv: 'GITHUB_CLIENT_ID',
  clientSecretEnv: 'GITHUB_CLIENT_SECRET',
};

export const GOOGLE_PROVIDER: OAuthProvider = {
  id: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // Reached only when a narrowed `scopes` leaves the id token without an email claim.
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  userEmailsUrl: null,
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,
  usesNonce: true,
  clientIdEnv: 'GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
};

export const APPLE_PROVIDER: OAuthProvider = {
  id: 'apple',
  authorizeUrl: 'https://appleid.apple.com/auth/authorize',
  tokenUrl: 'https://appleid.apple.com/auth/token',
  // Apple returns claims in the id token only; there is no userinfo endpoint to call.
  userInfoUrl: null,
  userEmailsUrl: null,
  issuers: ['https://appleid.apple.com'],
  jwksUri: 'https://appleid.apple.com/auth/keys',
  scopes: ['name', 'email'],
  usesPkce: true,
  usesNonce: true,
  clientIdEnv: 'APPLE_CLIENT_ID',
  // Apple alone does not accept a static secret: `APPLE_CLIENT_SECRET` must hold the ES256
  // client-secret JWT signed with the .p8 key, which Apple expires every six months.
  clientSecretEnv: 'APPLE_CLIENT_SECRET',
};

/** Seeded into the registry at import, through the same call an app registers its own IdP with. */
export const BUILTIN_OAUTH_PROVIDERS: readonly OAuthProvider[] = Object.freeze([
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
  APPLE_PROVIDER,
]);

/**
 * The three ids, and the only list an ANONYMOUS caller is ever shown. It is a framework constant
 * already in the docs, so naming it discloses nothing; the live registry is not, because an app
 * that registered `acme-internal-sso` has put its own vocabulary in there. `oauth-route.ts` is the
 * one reader in this package — every other refusal reaches a developer and gets
 * `oauthProviderIds()` instead. Off `index.ts` too, because an app writing its own login route
 * owes an anonymous caller the same narrow list and must not have to restate the three ids.
 */
export const BUILTIN_OAUTH_PROVIDER_IDS: readonly string[] = Object.freeze(
  BUILTIN_OAUTH_PROVIDERS.map((provider) => provider.id),
);
