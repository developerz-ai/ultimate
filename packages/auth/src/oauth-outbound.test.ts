// The OAuth legs ride core's `outbound()`: a discovery read that meets a 503 is retried inside its
// deadline instead of failing a boot, and a request whose caller is gone sends nothing at all.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { discoverOAuthProvider } from './oauth-discovery';

const DOCUMENT = {
  issuer: 'https://sso.bigco.test',
  authorization_endpoint: 'https://sso.bigco.test/oauth2/v1/authorize',
  token_endpoint: 'https://sso.bigco.test/oauth2/v1/token',
  userinfo_endpoint: 'https://sso.bigco.test/oauth2/v1/userinfo',
  jwks_uri: 'https://sso.bigco.test/oauth2/v1/keys',
};

describe('unit · OAuth over outbound()', () => {
  test('a discovery read that meets a 503 is retried, and the provider is built', async () => {
    let calls = 0;
    const provider = await discoverOAuthProvider({
      id: 'bigco',
      issuer: 'https://sso.bigco.test',
      fetch: async () => {
        calls += 1;
        return calls === 1 ? new Response('', { status: 503 }) : Response.json(DOCUMENT);
      },
    });
    expect(provider.tokenUrl).toBe(DOCUMENT.token_endpoint);
    expect(calls).toBe(2);
  });

  test('a caller already gone sends no discovery request', async () => {
    let calls = 0;
    const gone = new AbortController();
    gone.abort(new UltimateError({ code: 'X_TIMEOUT', cause: 'deadline', fix: 'raise it' }));
    await runWithContext(ctxOf({ signal: gone.signal }), () =>
      discoverOAuthProvider({
        id: 'bigco',
        issuer: 'https://sso.bigco.test',
        fetch: async () => {
          calls += 1;
          return Response.json(DOCUMENT);
        },
      }).catch(() => undefined),
    );
    expect(calls).toBe(0);
  });
});
