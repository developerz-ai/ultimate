// The failure case first: a discovery document that publishes no `jwks_uri` must not become a
// provider. Without a key set there is nothing to check an id token's signature against, and the
// only remaining trust is the TLS channel to the token endpoint — which is an exemption a caller
// has to name, not a property a provider gets to inherit by omission.

import { describe, expect, test } from 'bun:test';
import { AuthError } from './errors';
import { discoverOAuthProvider, discoveryUrl } from './oauth-discovery';

const DOCUMENT: Readonly<Record<string, unknown>> = {
  issuer: 'https://sso.bigco.test',
  authorization_endpoint: 'https://sso.bigco.test/oauth2/v1/authorize',
  token_endpoint: 'https://sso.bigco.test/oauth2/v1/token',
  userinfo_endpoint: 'https://sso.bigco.test/oauth2/v1/userinfo',
  jwks_uri: 'https://sso.bigco.test/oauth2/v1/keys',
};

const serving = (body: unknown, status = 200) => {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (url: string): Promise<Response> => {
      seen.push(url);
      return new Response(JSON.stringify(body), { status });
    },
  };
};

const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

describe('discoverOAuthProvider', () => {
  test('a document with no jwks_uri never becomes a provider', async () => {
    const rest = { ...DOCUMENT };
    delete (rest as Record<string, unknown>)['jwks_uri'];
    const served = serving(rest);
    expect(
      await codeOf(() =>
        discoverOAuthProvider({
          id: 'bigco',
          issuer: 'https://sso.bigco.test',
          fetch: served.fetch,
        }),
      ),
    ).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('one fetch of the well-known path yields a registrable provider', async () => {
    const served = serving(DOCUMENT);
    const provider = await discoverOAuthProvider({
      id: 'bigco',
      // A trailing slash on the issuer must not double up in the path.
      issuer: 'https://sso.bigco.test/',
      fetch: served.fetch,
    });
    expect(served.seen).toEqual(['https://sso.bigco.test/.well-known/openid-configuration']);
    expect(provider.authorizeUrl).toBe('https://sso.bigco.test/oauth2/v1/authorize');
    expect(provider.jwksUri).toBe('https://sso.bigco.test/oauth2/v1/keys');
    // PKCE is not negotiable, whatever the document says about it.
    expect(provider.usesPkce).toBe(true);
    expect(provider.clientIdEnv).toBe('BIGCO_CLIENT_ID');
    expect(provider.clientSecretEnv).toBe('BIGCO_CLIENT_SECRET');
  });

  test('issuers is pinned to what the document declares, not to the URL that was asked for', async () => {
    const served = serving({ ...DOCUMENT, issuer: 'https://tenant-42.bigco.test' });
    const provider = await discoverOAuthProvider({
      id: 'bigco-42',
      issuer: 'https://sso.bigco.test',
      fetch: served.fetch,
    });
    expect(provider.issuers).toEqual(['https://tenant-42.bigco.test']);
  });

  test('a 404 at the well-known path is coded, and its fix is the curl that reproduces it', async () => {
    const served = serving({}, 404);
    const thrown = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      fetch: served.fetch,
    }).catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.fix).toContain(discoveryUrl('https://sso.bigco.test'));
  });
});
