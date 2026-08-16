// The failure case first: before the registry, an engineer with a company OIDC IdP could not
// express it at all. `OAuthProviderId` was `keyof typeof OAUTH_PROVIDERS` over three consumer
// providers, so `beginOAuth({ provider: 'bigco-sso' })` did not typecheck, and the descriptor path
// answered `X_OAUTH_PROVIDER_UNKNOWN` for any segment outside the frozen record. The constraint was
// a type, so there was no runtime escape — fork the package, or lose PKCE, the sealed handshake,
// issuer pinning and account linking together.

import { describe, expect, test } from 'bun:test';
import { AuthError } from './errors';
import { beginOAuth, type OAuthProvider } from './oauth';
import {
  hasOAuthProvider,
  oauthProviderIds,
  providerFor,
  registerOAuthProvider,
} from './oauth-registry';

const bigco: OAuthProvider = {
  id: 'bigco-sso',
  authorizeUrl: 'https://sso.bigco.test/oauth2/v1/authorize',
  tokenUrl: 'https://sso.bigco.test/oauth2/v1/token',
  userInfoUrl: 'https://sso.bigco.test/oauth2/v1/userinfo',
  userEmailsUrl: null,
  issuers: ['https://sso.bigco.test'],
  jwksUri: 'https://sso.bigco.test/oauth2/v1/keys',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,
  usesNonce: true,
  clientIdEnv: 'BIGCO_SSO_CLIENT_ID',
  clientSecretEnv: 'BIGCO_SSO_CLIENT_SECRET',
};

const codeOf = (call: () => unknown): string => {
  try {
    call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

describe('the oauth provider registry', () => {
  test('an enterprise IdP reaches a real handshake, PKCE and all', () => {
    registerOAuthProvider(bigco);
    const handshake = beginOAuth({
      provider: 'bigco-sso',
      clientId: 'client-id',
      redirectUri: 'https://app.test/auth/oauth/bigco-sso/callback',
    });
    const url = new URL(handshake.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://sso.bigco.test/oauth2/v1/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length).toBe(43);
    // The OP said it echoes a nonce, so one goes out — the same rule Google gets.
    expect(url.searchParams.get('nonce')).toBe(handshake.nonce);
    expect(handshake.verifier.length).toBeGreaterThanOrEqual(43);
  });

  test('the three built-ins are registered through the same call an app uses', () => {
    for (const id of ['github', 'google', 'apple']) {
      expect(hasOAuthProvider(id)).toBe(true);
      expect(providerFor(id).id).toBe(id);
    }
    expect(oauthProviderIds()).toContain('bigco-sso');
  });

  test('a second registration under one id refuses rather than replacing the first', () => {
    const evil: OAuthProvider = { ...bigco, tokenUrl: 'https://attacker.test/token' };
    expect(codeOf(() => registerOAuthProvider(evil))).toBe('X_OAUTH_PROVIDER_DUPLICATE');
    // The first registration is still the one that answers.
    expect(providerFor('bigco-sso').tokenUrl).toBe('https://sso.bigco.test/oauth2/v1/token');
  });

  test('an unregistered id throws the code the route already answered with', () => {
    expect(codeOf(() => providerFor('never-registered'))).toBe('X_OAUTH_PROVIDER_UNKNOWN');
    expect(hasOAuthProvider('never-registered')).toBe(false);
  });

  test('a registered provider cannot be repointed after boot', () => {
    const registered = providerFor('bigco-sso');
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.issuers)).toBe(true);
    // The object the caller passed is not the object the registry serves, so keeping a reference
    // to it is not a way to widen `issuers` once logins are flowing.
    expect(registered).not.toBe(bigco);
  });
});
