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

describe('every way the document can fail to describe an OP', () => {
  const causeOf = async (body: unknown, status = 200): Promise<string> => {
    const served = serving(body, status);
    try {
      await discoverOAuthProvider({
        id: 'bigco',
        issuer: 'https://sso.bigco.test',
        fetch: served.fetch,
      });
    } catch (error) {
      return error instanceof AuthError ? error.cause : `not-an-AuthError: ${String(error)}`;
    }
    return 'did-not-throw';
  };

  test('a body that is not a JSON object is refused before any field is read', async () => {
    expect(await causeOf([DOCUMENT])).toContain('not a JSON object');
    expect(await causeOf('a login page')).toContain('not a JSON object');
    expect(await causeOf(null)).toContain('not a JSON object');
  });

  test('a body that is not JSON at all is the same refusal, never a bare SyntaxError', async () => {
    const thrown = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      // What an SSO portal actually serves at a path it does not recognise.
      fetch: async () =>
        new Response('<!doctype html><title>Sign in</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    }).catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.cause).toContain('not a JSON object');
    expect(error?.fix).toContain('not a login page');
  });

  test.each(['issuer', 'authorization_endpoint', 'token_endpoint'])(
    'a document missing %s builds no handshake',
    async (field) => {
      const partial = { ...DOCUMENT };
      delete (partial as Record<string, unknown>)[field];
      const cause = await causeOf(partial);
      expect(cause).toContain('missing issuer, authorization_endpoint or token_endpoint');
    },
  );

  test.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
    'an empty string at %s counts as absent, not as a value',
    async (field) => {
      // `''` is what a template that rendered nothing publishes; it is not an endpoint.
      const cause = await causeOf({ ...DOCUMENT, [field]: '' });
      expect(cause).not.toBe('did-not-throw');
      expect(cause).toContain(field === 'jwks_uri' ? 'no jwks_uri' : 'missing issuer');
    },
  );

  test('a non-string endpoint counts as absent too', async () => {
    expect(await causeOf({ ...DOCUMENT, token_endpoint: 42 })).toContain('missing issuer');
  });
});

describe('an issuer the process cannot reach', () => {
  // Distinct from a 404: `fetch` REJECTS on DNS failure, a refused connection or the timeout
  // abort, so there is no status to read and the naked rejection would escape every coded path.
  test('a rejected fetch is coded, carries the runtime message and the reproducing curl', async () => {
    const thrown = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      timeoutMs: 50,
      fetch: async () => {
        throw new Error('The operation timed out.');
      },
    }).catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.cause).toContain('The operation timed out.');
    expect(error?.fix).toContain(discoveryUrl('https://sso.bigco.test'));
  });

  test('a rejection that is not an Error still gets a sentence', async () => {
    const thrown = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      fetch: async () => {
        throw { name: 'AbortError' } as unknown as Error;
      },
    }).catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    // `renderThrowable` renders the value it was handed; the canned sentence it replaced said
    // less and hid which value arrived.
    expect(error?.cause).toContain('AbortError');
    expect(error?.cause).not.toContain('[object Object]');
  });
});

describe('what the caller may override, and what it may not', () => {
  test('scopes and both env var names are the caller’s, and default when absent', async () => {
    const custom = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      scopes: ['openid', 'groups'],
      clientIdEnv: 'SSO_ID',
      clientSecretEnv: 'SSO_SECRET',
      fetch: serving(DOCUMENT).fetch,
    });
    expect(custom.scopes).toEqual(['openid', 'groups']);
    expect(custom.clientIdEnv).toBe('SSO_ID');
    expect(custom.clientSecretEnv).toBe('SSO_SECRET');

    const defaults = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      fetch: serving(DOCUMENT).fetch,
    });
    expect(defaults.scopes).toEqual(['openid', 'email', 'profile']);
  });

  test('an id with punctuation still yields one legal env var prefix', async () => {
    const provider = await discoverOAuthProvider({
      id: 'big-co.sso',
      issuer: 'https://sso.bigco.test',
      fetch: serving(DOCUMENT).fetch,
    });
    expect(provider.clientIdEnv).toBe('BIG_CO_SSO_CLIENT_ID');
    expect(provider.clientSecretEnv).toBe('BIG_CO_SSO_CLIENT_SECRET');
  });

  test('a document with no userinfo_endpoint yields null rather than an empty string', async () => {
    const partial = { ...DOCUMENT };
    delete (partial as Record<string, unknown>)['userinfo_endpoint'];
    const provider = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      fetch: serving(partial).fetch,
    });
    expect(provider.userInfoUrl).toBe(null);
    // GitHub's second call has no equivalent in OIDC discovery, so it is always null here.
    expect(provider.userEmailsUrl).toBe(null);
  });
});
