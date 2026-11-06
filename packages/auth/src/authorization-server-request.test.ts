// Screening an authorization request: what a consent page may show, and which refusals it shows
// in place instead of redirecting (an unknown client, an unregistered redirect). Every redirect
// variant a lenient matcher would accept is refused; `plain` PKCE is refused; scopes narrow.

import { describe, expect, test } from 'bun:test';
import {
  authorizeUrl,
  ISSUER,
  pkce,
  REDIRECT,
  RESOURCE,
  serverFixture,
} from './authorization-server-fixture';

describe('readRequest', () => {
  test('a well-formed request reads as the client, scopes, resource and redirect', async () => {
    const { server, client } = await serverFixture();
    const read = await server.readRequest(authorizeUrl(client.clientId, pkce().challenge));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.request.client.clientId).toBe(client.clientId);
    expect(read.request.scopes).toEqual(['read', 'write']);
    expect(read.request.resource).toBe(RESOURCE);
    expect(read.request.redirectUri).toBe(REDIRECT);
  });

  test('every redirect variant is refused and shown, never redirected to', async () => {
    const { server, client } = await serverFixture();
    const variants = [
      `${REDIRECT}/`,
      `${REDIRECT}?x=1`,
      REDIRECT.toUpperCase(),
      REDIRECT.replace('https://', 'http://'),
      `${REDIRECT}/../callback`,
      REDIRECT.replace('app.test', 'app.test.evil.test'),
      REDIRECT.slice(0, -1),
      `${REDIRECT}#frag`,
    ];
    for (const redirect_uri of variants) {
      const read = await server.readRequest(
        authorizeUrl(client.clientId, pkce().challenge, { redirect_uri }),
      );
      expect(read).toMatchObject({ ok: false, error: 'invalid_request', redirectTo: null });
    }
  });

  test('an unknown client is shown, never redirected to', async () => {
    const { server } = await serverFixture();
    const read = await server.readRequest(authorizeUrl('c_nobody', pkce().challenge));
    expect(read).toMatchObject({ ok: false, error: 'invalid_client', redirectTo: null });
  });

  test('plain PKCE, a missing method and a missing challenge are refused with iss', async () => {
    const { server, client } = await serverFixture();
    const { challenge } = pkce();
    for (const extra of [
      { code_challenge_method: 'plain' },
      { code_challenge_method: '' },
      { code_challenge: '' },
    ]) {
      const read = await server.readRequest(authorizeUrl(client.clientId, challenge, extra));
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.error).toBe('invalid_request');
      const back = new URL(read.redirectTo ?? '');
      expect(back.searchParams.get('iss')).toBe(ISSUER);
      expect(back.searchParams.get('state')).toBe('st-1');
    }
  });

  test('scopes narrow: asking for fewer is fine, beyond the client is invalid_scope', async () => {
    const { server, client } = await serverFixture();
    const fewer = await server.readRequest(
      authorizeUrl(client.clientId, pkce().challenge, { scope: 'read' }),
    );
    expect(fewer.ok && fewer.request.scopes).toEqual(['read']);
    const beyond = await server.readRequest(
      authorizeUrl(client.clientId, pkce().challenge, { scope: 'read admin' }),
    );
    expect(beyond).toMatchObject({ ok: false, error: 'invalid_scope' });
  });

  test('a resource this server does not serve is invalid_target', async () => {
    const { server, client } = await serverFixture();
    const read = await server.readRequest(
      authorizeUrl(client.clientId, pkce().challenge, { resource: 'https://other.test/mcp' }),
    );
    expect(read).toMatchObject({ ok: false, error: 'invalid_target' });
  });

  test('a repeated parameter is refused', async () => {
    const { server, client } = await serverFixture();
    const url = new URL(authorizeUrl(client.clientId, pkce().challenge));
    url.searchParams.append('redirect_uri', REDIRECT);
    const read = await server.readRequest(url);
    expect(read).toMatchObject({ ok: false, error: 'invalid_request', redirectTo: null });
  });

  test('approve re-screens: a forged request is X_AUTH_CONSENT_INVALID', async () => {
    const { server, client } = await serverFixture();
    const read = await server.readRequest(authorizeUrl(client.clientId, pkce().challenge));
    if (!read.ok) return expect.unreachable('the fixture request must read');
    const forged = { ...read.request, redirectUri: 'https://evil.test/cb' };
    await expect(server.approve({ subject: 'u', request: forged })).rejects.toMatchObject({
      code: 'X_AUTH_CONSENT_INVALID',
    });
    await expect(
      server.approve({ subject: 'u', request: read.request, scopes: ['admin'] }),
    ).rejects.toMatchObject({ code: 'X_AUTH_CONSENT_INVALID' });
  });
});
