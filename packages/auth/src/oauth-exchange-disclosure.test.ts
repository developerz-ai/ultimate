// What a REMOTE token endpoint can put into this process's logs and into a caller's response.
// Split from `oauth-exchange.test.ts` at the 500-line ceiling, and it is one subject: every case
// here is a byte string the other end chose, arriving at a `cause:` an operator reads or a body a
// browser renders. Two leak paths and one forgery path, which is why they sit together.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { beginOAuth, type OAuthHandshake } from './oauth';
import { exchangeOAuthCode, type OAuthFetch, providerDetail } from './oauth-exchange';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

/** Declared here rather than imported from the sibling suite: importing a test file runs it. */
const handshakeFor = (provider: 'github' | 'google'): OAuthHandshake =>
  beginOAuth({ provider, clientId: 'client-id', redirectUri: 'https://app.test/auth/callback' });

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
    // Asserted at `providerDetail`, because the TOKEN leg no longer quotes a raw body at all —
    // its request carries `client_secret`. The raw path is still live on userinfo, discovery and
    // jwks, and this is the escaping every one of them depends on.
    const detail = await providerDetail(new Response('<html>\nnot json\n</html>'));
    expect(detail).not.toContain('\n');
    expect(detail).toContain('not json');
  });

  test('the same body through the token leg says nothing about itself', async () => {
    const handshake = handshakeFor('github');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: failing('<html>\nnot json\n</html>') },
    ).catch((error: unknown) => error);

    const cause = isUltimateError(thrown) ? thrown.cause : '';
    expect(cause).not.toContain('\n');
    expect(cause).not.toContain('not json');
  });
});

/**
 * The `POST /token` leg is the ONE request in this package that carries `client_secret`, and its
 * body was reflected into an anonymous `X_OAUTH_EXCHANGE_FAILED` cause whenever it did not parse
 * as a coded OAuth error. Measured against an echoing endpoint: 38 of 42 characters of the client
 * secret reached the response body a browser rendered, and a shorter `redirect_uri` puts all of it
 * inside `MAX_DETAIL_LENGTH`.
 *
 * The userinfo / discovery / jwks legs keep the raw fallback: those requests carry a bearer token
 * or nothing, and their raw text is what makes a misconfigured enterprise OP debuggable.
 */
describe('the token leg never echoes a body that is not a coded OAuth error', () => {
  const secretEcho = (): OAuthFetch => async (_url, init) =>
    new Response(`upstream rejected: ${String(init?.body ?? '')}`, { status: 400 });

  test('a raw body is replaced, and the secret does not reach the cause', async () => {
    const handshake = handshakeFor('github');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: secretEcho() },
    ).catch((error: unknown) => error);

    const cause = isUltimateError(thrown) ? thrown.cause : '';
    expect(isUltimateError(thrown) && thrown.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(cause).not.toContain(credentials.clientSecret);
    expect(cause).not.toContain('client_secret');
    // The status and the fix still travel, so the failure stays actionable.
    expect(cause).toContain('400');
  });

  test('a coded OAuth error still comes through — that is what makes the failure fixable', async () => {
    const handshake = handshakeFor('github');
    const thrown = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      {
        credentials,
        clock,
        fetch: async () =>
          new Response(
            JSON.stringify({ error: 'invalid_grant', error_description: 'spent code' }),
            {
              status: 400,
            },
          ),
      },
    ).catch((error: unknown) => error);
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('spent code');
  });

  test("providerDetail's default is still the raw fallback, for the legs that carry no secret", async () => {
    expect(await providerDetail(new Response('<html>nope</html>'))).toBe(
      JSON.stringify('<html>nope</html>'),
    );
    expect(await providerDetail(new Response('<html>nope</html>'), 'coded-only')).not.toContain(
      'nope',
    );
  });
});
