// How the client authenticates at the token endpoint (`tokenEndpointAuth`): a PUBLIC client
// (`'none'`) needs no secret and sends none, `'client_secret_basic'` sends it in the header, and
// the default stays `client_secret_post`. PKCE travels in every case.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { beginOAuth, type OAuthProvider } from './oauth';
import { exchangeOAuthCode, type OAuthFetch, oauthCredentials } from './oauth-exchange';
import { registerOAuthProvider } from './oauth-registry';

const clock = frozenClock(new Date('2026-10-18T12:00:00.000Z'));

const provider = (id: string, auth?: OAuthProvider['tokenEndpointAuth']): OAuthProvider => ({
  id,
  authorizeUrl: `https://${id}.test/authorize`,
  tokenUrl: `https://${id}.test/token`,
  userInfoUrl: null,
  userEmailsUrl: null,
  issuers: [],
  jwksUri: null,
  scopes: ['email'],
  usesPkce: true,
  usesNonce: false,
  clientIdEnv: `${id.toUpperCase()}_CLIENT_ID`,
  clientSecretEnv: `${id.toUpperCase()}_CLIENT_SECRET`,
  ...(auth === undefined ? {} : { tokenEndpointAuth: auth }),
});

registerOAuthProvider(provider('pubop', 'none'));
registerOAuthProvider(provider('basicop', 'client_secret_basic'));

const exchange = async (id: string, credentials: { clientId: string; clientSecret: string }) => {
  const calls: RequestInit[] = [];
  const fetch: OAuthFetch = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
  };
  const handshake = beginOAuth({ provider: id, clientId: 'cid', redirectUri: 'https://a.test/cb' });
  await exchangeOAuthCode(
    handshake,
    { state: handshake.state, code: 'c' },
    { credentials, clock, fetch },
  );
  const init = calls[0];
  return {
    body: new URLSearchParams(String(init?.body)),
    headers: (init?.headers ?? {}) as Record<string, string>,
    verifier: handshake.verifier,
  };
};

describe("tokenEndpointAuth: 'none' — a public client", () => {
  test('needs no client secret in the env', () => {
    expect(oauthCredentials('pubop', { PUBOP_CLIENT_ID: 'cid' })).toEqual({
      clientId: 'cid',
      clientSecret: '',
      tokenEndpointAuth: 'none',
    });
  });

  test('still refuses a missing client id', () => {
    let code = 'did-not-throw';
    try {
      oauthCredentials('pubop', {});
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not-coded';
    }
    expect(code).toBe('X_ENV_MISSING');
  });

  test('omits client_secret from the token POST and keeps PKCE', async () => {
    const sent = await exchange('pubop', { clientId: 'cid', clientSecret: '' });
    expect(sent.body.has('client_secret')).toBe(false);
    expect(sent.body.get('client_id')).toBe('cid');
    expect(sent.body.get('code_verifier')).toBe(sent.verifier);
    expect(sent.headers['Authorization']).toBeUndefined();
  });

  test('a secret the env happens to hold is never sent', async () => {
    const credentials = oauthCredentials('pubop', {
      PUBOP_CLIENT_ID: 'cid',
      PUBOP_CLIENT_SECRET: 'leftover',
    });
    expect(credentials.clientSecret).toBe('');
    const sent = await exchange('pubop', credentials);
    expect(sent.body.has('client_secret')).toBe(false);
  });

  test('credentials may declare it for a provider that does not', async () => {
    const sent = await exchange('github', {
      clientId: 'cid',
      clientSecret: '',
      tokenEndpointAuth: 'none',
    } as { clientId: string; clientSecret: string });
    expect(sent.body.has('client_secret')).toBe(false);
  });
});

describe("tokenEndpointAuth: 'client_secret_basic'", () => {
  test('sends the credentials in the Authorization header, form-encoded first, and not in the body', async () => {
    const sent = await exchange('basicop', { clientId: 'c id', clientSecret: 's:ecret' });
    expect(sent.body.has('client_secret')).toBe(false);
    expect(sent.headers['Authorization']).toBe(`Basic ${btoa('c+id:s%3Aecret')}`);
    expect(sent.body.get('code_verifier')).toBe(sent.verifier);
  });
});

describe('default — client_secret_post, unchanged', () => {
  test('a provider that declares nothing posts the secret in the body', async () => {
    const sent = await exchange('github', { clientId: 'cid', clientSecret: 'sec' });
    expect(sent.body.get('client_secret')).toBe('sec');
    expect(sent.headers['Authorization']).toBeUndefined();
  });
});
