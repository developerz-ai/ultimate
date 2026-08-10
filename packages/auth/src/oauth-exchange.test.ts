import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { unsignedJwt } from './id-token-fixture';
import { beginOAuth, type OAuthHandshake } from './oauth';
import { exchangeOAuthCode, type OAuthFetch, oauthCredentials } from './oauth-exchange';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

const idTokenFor = (handshake: OAuthHandshake): string =>
  unsignedJwt({
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    sub: 'google-sub',
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    nonce: handshake.nonce,
    email: 'ada@example.com',
    email_verified: true,
  });

const handshakeFor = (provider: 'github' | 'google'): OAuthHandshake =>
  beginOAuth({ provider, clientId: 'client-id', redirectUri: 'https://app.test/auth/callback' });

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const recorder = (
  respond: (call: Call) => Response | Promise<Response>,
): { fetch: OAuthFetch; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return await respond({ url, init });
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

/**
 * The thrown value itself, for the assertions `codeOf` cannot make — `meta`, `fix`. Never a bare
 * `Error` sentinel inside a try/catch: that throw lands in the catch below it, so the one failure
 * worth naming ("it did not throw") arrives as a mismatched boolean instead.
 */
const thrownBy = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected a throw');
};

const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  await call.then(
    (value) => expect.unreachable(`expected a rejection, resolved with ${String(value)}`),
    (error: unknown) => error,
  );

describe('oauthCredentials', () => {
  test('reads the two env vars the provider table names', () => {
    const found = oauthCredentials('github', {
      GITHUB_CLIENT_ID: ' id ',
      GITHUB_CLIENT_SECRET: 'secret',
    });
    expect(found).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });

  test('a missing secret is X_ENV_MISSING naming both variables, not a silent empty string', () => {
    const call = (): unknown => oauthCredentials('google', { GOOGLE_CLIENT_ID: 'id' });
    expect(call).toThrow(/GOOGLE_CLIENT_SECRET/);

    const error = thrownBy(call);
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_ENV_MISSING');
    expect(isUltimateError(error) && error.cause).toContain('GOOGLE_CLIENT_SECRET');
    // Axiom 4: the fix is a command the reader can run, not advice to restart something.
    expect(isUltimateError(error) && error.fix).toContain('.env');
    expect(isUltimateError(error) && error.fix).toContain('x doctor --json');
  });
});

describe('exchangeOAuthCode', () => {
  test('posts the code, the PKCE verifier and the credentials as a form', async () => {
    const handshake = handshakeFor('github');
    const { fetch, calls } = recorder(() =>
      json({ access_token: 'gho_token', scope: 'read:user' }),
    );

    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token');
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe(handshake.verifier);
    expect(body.get('redirect_uri')).toBe('https://app.test/auth/callback');
    expect(body.get('client_secret')).toBe('client-secret');
    // GitHub answers form-encoded unless asked for JSON, and 403s a request with no agent.
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
    expect(headers['User-Agent']).toBe('ultimate-auth');
    expect(tokens).toEqual({
      accessToken: 'gho_token',
      refreshToken: null,
      expiresAt: null,
      idToken: null,
      claims: null,
    });
  });

  test('expires_in is measured against the injected clock, never Date.now()', async () => {
    const handshake = handshakeFor('github');
    const { fetch } = recorder(() => json({ access_token: 'gho_token', expires_in: 28_800 }));
    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch },
    );
    expect(tokens.expiresAt?.toISOString()).toBe('2026-08-09T20:00:00.000Z');
  });

  test("GitHub's HTTP 200 with an error field does not mint tokens", async () => {
    const handshake = handshakeFor('github');
    const { fetch } = recorder(() =>
      json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect' }),
    );
    const failed = exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'stale' },
      { credentials, clock, fetch },
    );
    await expect(failed).rejects.toThrow(/The code passed is incorrect/);
    expect(await codeOf(failed)).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('a non-2xx carries the provider status into the error meta', async () => {
    const handshake = handshakeFor('google');
    const { fetch } = recorder(() => json({ error_description: 'Unauthorized' }, 401));
    const error = await rejection(
      exchangeOAuthCode(
        handshake,
        { state: handshake.state, code: 'the-code' },
        { credentials, clock, fetch },
      ),
    );
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.meta).toEqual({
      provider: 'google',
      stage: 'token',
      status: 401,
    });
    expect(isUltimateError(error) && error.fix).toContain('GOOGLE_CLIENT_SECRET');
  });

  test('a transport failure before any response is still X_OAUTH_EXCHANGE_FAILED', async () => {
    const handshake = handshakeFor('github');
    // `TypeError` because that is the shape `fetch` itself rejects with, and the shape the
    // `instanceof Error` branch in `postForm` reads a message off. Not a sentinel: it is the input.
    const fetch: OAuthFetch = () => Promise.reject(new TypeError('ECONNREFUSED'));
    expect(
      await codeOf(
        exchangeOAuthCode(
          handshake,
          { state: handshake.state, code: 'the-code' },
          { credentials, clock, fetch },
        ),
      ),
    ).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('a 200 with no access_token is a failure, not an empty session', async () => {
    const handshake = handshakeFor('github');
    const { fetch } = recorder(() => json({ scope: 'read:user' }));
    expect(
      await codeOf(
        exchangeOAuthCode(
          handshake,
          { state: handshake.state, code: 'the-code' },
          { credentials, clock, fetch },
        ),
      ),
    ).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('an OIDC provider verifies its id token and returns the claims', async () => {
    const handshake = handshakeFor('google');
    const { fetch } = recorder(() =>
      json({
        access_token: 'ya29.token',
        refresh_token: '1//refresh',
        expires_in: 3599,
        id_token: idTokenFor(handshake),
      }),
    );
    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch },
    );
    expect(tokens.refreshToken).toBe('1//refresh');
    expect(tokens.claims?.sub).toBe('google-sub');
    expect(tokens.claims?.email).toBe('ada@example.com');
  });

  test('an OIDC provider that answers without an id token has identified nobody', async () => {
    const handshake = handshakeFor('google');
    const { fetch } = recorder(() => json({ access_token: 'ya29.token' }));
    expect(
      await codeOf(
        exchangeOAuthCode(
          handshake,
          { state: handshake.state, code: 'the-code' },
          { credentials, clock, fetch },
        ),
      ),
    ).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('an id token minted for another handshake is refused after the exchange', async () => {
    const handshake = handshakeFor('google');
    const other = handshakeFor('google');
    const { fetch } = recorder(() =>
      json({ access_token: 'ya29.token', id_token: idTokenFor(other) }),
    );
    expect(
      await codeOf(
        exchangeOAuthCode(
          handshake,
          { state: handshake.state, code: 'the-code' },
          { credentials, clock, fetch },
        ),
      ),
    ).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a forged state never reaches the network at all', async () => {
    const handshake = handshakeFor('github');
    const { fetch, calls } = recorder(() => json({ access_token: 'gho_token' }));
    expect(
      await codeOf(
        exchangeOAuthCode(
          handshake,
          { state: 'attacker-supplied', code: 'the-code' },
          { credentials, clock, fetch },
        ),
      ),
    ).toBe('X_OAUTH_STATE_INVALID');
    expect(calls).toHaveLength(0);
  });
});
