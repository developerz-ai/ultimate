import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { unsignedJwt } from './id-token-fixture';
import { beginOAuth, type OAuthHandshake } from './oauth';
import {
  exchangeOAuthCode,
  type OAuthFetch,
  oauthCredentials,
  providerDetail,
} from './oauth-exchange';

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

/**
 * `providerDetail` is where a REMOTE server's bytes enter this package, and they are spliced into
 * an `X_OAUTH_EXCHANGE_FAILED` cause. A token endpoint that is compromised, impersonated or behind
 * a hostile proxy could otherwise write a line of its own into the operator's log.
 */
describe('a token endpoint cannot forge a log line', () => {
  const failing =
    (body: string): OAuthFetch =>
    async () =>
      new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });

  test('an error_description carrying a newline is escaped', async () => {
    const handshake = handshakeFor('github');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      {
        credentials,
        clock,
        fetch: failing(
          JSON.stringify({ error_description: 'bad code\n2026-08-16 level=info msg="ok"' }),
        ),
      },
    ).catch((error: unknown) => error);

    const cause = isUltimateError(thrown) ? thrown.cause : '';
    expect(isUltimateError(thrown) && thrown.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(cause).not.toContain('\n');
    expect(cause).toContain('\\n');
    expect(cause).toContain('bad code');
  });

  test('a non-JSON body carrying a newline is escaped on the raw-text path too', async () => {
    const handshake = handshakeFor('github');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: failing('<html>\nnot json\n</html>') },
    ).catch((error: unknown) => error);

    const cause = isUltimateError(thrown) ? thrown.cause : '';
    expect(cause).not.toContain('\n');
    expect(cause).toContain('not json');
  });
});

/**
 * `providerDetail` is the one place a REMOTE server's bytes become a `cause:`. Every branch of it
 * is reachable from a real token endpoint, so every branch is pinned here rather than at the one
 * call site that happens to be tested.
 */
describe('providerDetail', () => {
  test('reads the OAuth error fields in the order the spec ranks them', async () => {
    // Every answer is `renderCauseValue`d — quoted and escaped — because it is a remote server's
    // bytes reaching a `cause:` line.
    expect(
      await providerDetail(new Response(JSON.stringify({ error_description: 'bad verifier' }))),
    ).toBe(JSON.stringify('bad verifier'));
    expect(await providerDetail(new Response(JSON.stringify({ error: 'invalid_grant' })))).toBe(
      JSON.stringify('invalid_grant'),
    );
    expect(await providerDetail(new Response(JSON.stringify({ message: 'Bad credentials' })))).toBe(
      JSON.stringify('Bad credentials'),
    );
    // `error_description` outranks the others when a server sends several.
    expect(
      await providerDetail(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'spent code' })),
      ),
    ).toBe(JSON.stringify('spent code'));
  });

  test('a JSON object with none of those fields falls through to its raw text', async () => {
    // Rendered, not raw: `renderCauseValue` quotes and escapes remote bytes so a body carrying a
    // newline cannot write a second log line an operator reads as genuine.
    const body = JSON.stringify({ ok: false, retryAfter: 30 });
    expect(await providerDetail(new Response(body))).toBe(JSON.stringify(body));
    // An empty description is not a description: it would render as a blank cause line.
    expect(await providerDetail(new Response(JSON.stringify({ error_description: '' })))).toContain(
      'error_description',
    );
    // A non-string description is not one either.
    expect(await providerDetail(new Response(JSON.stringify({ error: 42 })))).toContain('42');
  });

  test('a JSON array is not a record, so it is raw text too', async () => {
    expect(await providerDetail(new Response(JSON.stringify(['nope'])))).toBe(
      JSON.stringify('["nope"]'),
    );
  });

  test('an empty body says so instead of producing a blank cause line', async () => {
    expect(await providerDetail(new Response(''))).toBe('the response body was empty');
  });

  test('a long body is truncated with an ellipsis rather than logged whole', async () => {
    const detail = await providerDetail(new Response('x'.repeat(500)));
    // 200 characters plus the ellipsis, then quoted: a stack trace or an HTML page must not
    // become the whole cause line.
    expect(detail).toBe(JSON.stringify(`${'x'.repeat(200)}\u2026`));
    // Exactly at the cap is not truncated — the check is `>`, not `>=`.
    expect(await providerDetail(new Response('x'.repeat(200)))).toBe(
      JSON.stringify('x'.repeat(200)),
    );
  });
});

describe('the fix depends on the status, because the remedy does', () => {
  const failWith =
    (status: number): OAuthFetch =>
    async () =>
      json({ error_description: 'nope' }, status);

  const fixFor = async (status: number): Promise<string> => {
    const handshake = handshakeFor('google');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: failWith(status) },
    ).catch((error: unknown) => error);
    return isUltimateError(thrown) ? thrown.fix : `not-an-UltimateError: ${String(thrown)}`;
  };

  test('401 and 403 blame the credentials; 400 blames the redirect_uri', async () => {
    expect(await fixFor(401)).toContain('GOOGLE_CLIENT_SECRET');
    expect(await fixFor(403)).toContain('GOOGLE_CLIENT_SECRET');
    expect(await fixFor(400)).toContain('register this exact redirect_uri');
  });

  test('anything else says retry and names the status page — no credential to rotate', async () => {
    // A 500 or a 503 is the provider's outage, and telling an operator to rotate a secret there
    // is an instruction that makes a working configuration worse.
    for (const status of [500, 502, 503, 429]) {
      const fix = await fixFor(status);
      expect(fix).toContain('status page');
      expect(fix).not.toContain('GOOGLE_CLIENT_SECRET');
    }
  });
});

describe('a 200 that is not a token response', () => {
  test('a body that is not a JSON object is refused, naming the endpoint that sent it', async () => {
    const handshake = handshakeFor('google');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: async () => json(['access_token', 'x']) },
    ).catch((error: unknown) => error);

    expect(isUltimateError(thrown) && thrown.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(thrown) && thrown.cause).toContain('not a JSON object');
    expect(isUltimateError(thrown) && thrown.fix).toContain('https://oauth2.googleapis.com/token');
  });

  test('a 200 that is not JSON at all is the same refusal, never a bare SyntaxError', async () => {
    const handshake = handshakeFor('google');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      {
        credentials,
        clock,
        fetch: async () =>
          new Response('<!doctype html><title>Sign in</title>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
    ).catch((error: unknown) => error);

    expect(isUltimateError(thrown) && thrown.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(thrown) && thrown.cause).toContain('not a JSON object');
  });
});
