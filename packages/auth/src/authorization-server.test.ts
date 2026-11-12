// The person flow end to end — consent, code, tokens, refresh, resolve — and the rules that make
// it safe: a code is single use and a replay revokes what it minted; a code lives two minutes; a
// rotated refresh token's replay revokes the grant; a grant idle past its window cannot refresh.

import { describe, expect, test } from 'bun:test';
import { AUTH_CODE_TTL_MS, authorizationServer } from './authorization-server';
import {
  codeFor,
  ISSUER,
  post,
  REDIRECT,
  RESOURCE,
  refreshAfterNarrowing,
  serverFixture,
  tokensFor,
} from './authorization-server-fixture';
import { memoryAuthServerStore } from './authorization-server-store';

const DAY_MS = 24 * 60 * 60 * 1000;

const refresh = (fixture: Awaited<ReturnType<typeof serverFixture>>, token: unknown) =>
  post(fixture.server, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: String(token),
    client_id: fixture.client.clientId,
  });

describe('authorizationServer · the code flow', () => {
  test('consent → code (with iss and state) → tokens → resolve', async () => {
    const fixture = await serverFixture();
    const { redirect } = await codeFor(fixture);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    expect(redirect.searchParams.get('state')).toBe('st-1');
    const tokens = await tokensFor(fixture);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'read write',
    });
    const resolved = await fixture.server.resolve(String(tokens.body['access_token']));
    expect(resolved).toMatchObject({
      subject: 'user-1',
      clientId: fixture.client.clientId,
      resource: RESOURCE,
    });
    expect([...(resolved?.scopes ?? [])].sort()).toEqual(['read', 'write']);
  });

  test('a replayed code is refused AND revokes the tokens it minted', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    const form = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: fixture.client.clientId,
    };
    const first = await post(fixture.server, '/oauth/token', form);
    expect(first.status).toBe(200);
    const again = await post(fixture.server, '/oauth/token', form);
    expect(again.body['error']).toBe('invalid_grant');
    expect(await fixture.server.resolve(String(first.body['access_token']))).toBeNull();
    expect((await refresh(fixture, first.body['refresh_token'])).body['error']).toBe(
      'invalid_grant',
    );
  });

  test('a code past two minutes is refused', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    fixture.clock.advance(AUTH_CODE_TTL_MS);
    const answer = await post(fixture.server, '/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: fixture.client.clientId,
    });
    expect(answer.body['error']).toBe('invalid_grant');
  });

  test('a wrong verifier, another redirect or another resource is refused', async () => {
    const fixture = await serverFixture();
    for (const over of [
      { code_verifier: 'x'.repeat(43) },
      { redirect_uri: `${REDIRECT}/` },
      { resource: 'https://as.test/other' },
    ]) {
      const { code, verifier } = await codeFor(fixture);
      const answer = await post(fixture.server, '/oauth/token', {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: fixture.client.clientId,
        ...over,
      });
      expect(['invalid_grant', 'invalid_target']).toContain(String(answer.body['error']));
    }
  });

  test('a refresh rotates; replaying the retired one revokes the whole grant', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const rotated = await refresh(fixture, tokens.body['refresh_token']);
    expect(rotated.status).toBe(200);
    expect(rotated.body['refresh_token']).not.toBe(tokens.body['refresh_token']);
    const replay = await refresh(fixture, tokens.body['refresh_token']);
    expect(replay.body['error']).toBe('invalid_grant');
    expect(await fixture.server.resolve(String(rotated.body['access_token']))).toBeNull();
    expect((await refresh(fixture, rotated.body['refresh_token'])).body['error']).toBe(
      'invalid_grant',
    );
  });

  test('a client not registered for refresh_token gets no refresh token and cannot refresh', async () => {
    const { before, code, device, refreshed } = await refreshAfterNarrowing(await serverFixture());
    expect(typeof before.body['refresh_token']).toBe('string');
    expect(code.status).toBe(200);
    expect(code.body['refresh_token']).toBeUndefined();
    expect(device.status).toBe(200);
    expect(device.body['refresh_token']).toBeUndefined();
    expect(refreshed.body['error']).toBe('unauthorized_client');
  });

  test('a grant idle past refreshIdleDays cannot refresh; a used one keeps sliding', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    fixture.clock.advance(29 * DAY_MS);
    const used = await refresh(fixture, tokens.body['refresh_token']);
    expect(used.status).toBe(200);
    fixture.clock.advance(29 * DAY_MS);
    const slid = await refresh(fixture, used.body['refresh_token']);
    expect(slid.status).toBe(200);
    fixture.clock.advance(30 * DAY_MS);
    expect((await refresh(fixture, slid.body['refresh_token'])).body['error']).toBe(
      'invalid_grant',
    );
  });

  test('an access token dies at accessSeconds', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    fixture.clock.advance(600_000);
    expect(await fixture.server.resolve(String(tokens.body['access_token']))).toBeNull();
  });

  test('revoke({ subject }) holds at once; purge removes what expired', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    expect(await fixture.server.revoke({ subject: 'user-1' })).toBe(1);
    expect(await fixture.server.resolve(String(tokens.body['access_token']))).toBeNull();
    fixture.clock.advance(31 * DAY_MS);
    expect(await fixture.server.purge({ before: fixture.clock.now() })).toBeGreaterThan(0);
  });

  test('a grant not enabled answers unsupported_grant_type', async () => {
    const fixture = await serverFixture({ grants: ['authorization_code', 'refresh_token'] });
    const answer = await post(fixture.server, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: fixture.client.clientId,
    });
    expect(answer).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
  });

  test('a bad issuer, path or lifetime is X_AUTH_SERVER_INVALID naming the field', () => {
    const base = {
      issuer: ISSUER,
      store: memoryAuthServerStore(),
      consentPath: '/oauth/consent',
      lifetimes: { accessSeconds: 60, refreshIdleDays: 30 },
      scopes: ['read'],
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ issuer: 'http://as.test' }, 'issuer'],
      [{ issuer: 'https://as.test/' }, 'issuer'],
      [{ consentPath: 'oauth/consent' }, 'consentPath'],
      [
        { lifetimes: { accessSeconds: Number.NaN, refreshIdleDays: 30 } },
        'lifetimes.accessSeconds',
      ],
      [{ grants: ['client_credentials'] }, 'lifetimes.clientSeconds'],
      [{ grants: ['urn:ietf:params:oauth:grant-type:device_code'] }, 'devicePath'],
      [{ scopes: ['a b'] }, 'scopes'],
    ];
    for (const [over, field] of cases) {
      expect(() => authorizationServer({ ...base, ...over })).toThrow(
        expect.objectContaining({ code: 'X_AUTH_SERVER_INVALID', meta: { field } }),
      );
    }
  });

  test('the RFC 8414 document names every endpoint and S256 alone', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    expect(server.metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/consent`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      device_authorization_endpoint: `${ISSUER}/oauth/device`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    const route = server.routes.find((r) => r.path === '/.well-known/oauth-authorization-server');
    expect(route?.meta).toEqual({ name: 'oauth:metadata', auth: 'public' });
  });

  // http's `csrf` stage refuses a cross-origin browser POST unless the route declares itself
  // cookie-less AND names its own authenticator, so the session cookie decides nothing there.
  test('every POST endpoint is cookieless, authenticated by no cookie', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    const posts = server.routes.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.path).sort()).toEqual([
      '/oauth/device',
      '/oauth/introspect',
      '/oauth/register',
      '/oauth/revoke',
      '/oauth/token',
    ]);
    for (const route of posts) {
      expect(route.meta.csrf).toBe('cookieless');
      expect(route.meta.authenticate?.()).toBeNull();
    }
  });
});
