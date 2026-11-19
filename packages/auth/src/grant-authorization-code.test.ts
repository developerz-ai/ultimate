// A code is burned only by the request that could have redeemed it: the right client, the right
// PKCE verifier, the right redirect. Anything less is refused and leaves the code redeemable, so an
// intercepted code without its verifier can neither spend a login nor trip the replay revocation.

import { describe, expect, test } from 'bun:test';
import {
  codeFor,
  post,
  REDIRECT,
  type ServerFixture,
  serverFixture,
  tokensFor,
} from './authorization-server-fixture';

const redeem = (
  fixture: ServerFixture,
  code: string,
  verifier: string,
  over: Readonly<Record<string, string>> = {},
) =>
  post(fixture.server, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: fixture.client.clientId,
    ...over,
  });

describe('authorization-code grant · a refused request does not burn the code', () => {
  test('a wrong verifier, twice, leaves the code redeemable by its holder', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await redeem(fixture, code, 'x'.repeat(43))).body['error']).toBe('invalid_grant');
    }
    const real = await redeem(fixture, code, verifier);
    expect(real.status).toBe(200);
    expect(await fixture.server.resolve(String(real.body['access_token']))).not.toBeNull();
  });

  test('another client presenting the code leaves it redeemable by the real client', async () => {
    const fixture = await serverFixture();
    const { client: other } = await fixture.server.registerClient({
      name: 'Other app',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code'],
      scopes: ['read'],
    });
    const { code, verifier } = await codeFor(fixture);
    const stolen = await redeem(fixture, code, verifier, { client_id: other.clientId });
    expect(stolen.body['error']).toBe('invalid_grant');
    expect((await redeem(fixture, code, verifier)).status).toBe(200);
  });

  test('another redirect_uri leaves the code redeemable', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    const wrong = await redeem(fixture, code, verifier, { redirect_uri: `${REDIRECT}/` });
    expect(wrong.body['error']).toBe('invalid_grant');
    expect((await redeem(fixture, code, verifier)).status).toBe(200);
  });

  test('replaying a spent code without its verifier does not revoke what it minted', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    const real = await redeem(fixture, code, verifier);
    expect(real.status).toBe(200);
    expect((await redeem(fixture, code, 'x'.repeat(43))).body['error']).toBe('invalid_grant');
    expect(await fixture.server.resolve(String(real.body['access_token']))).not.toBeNull();
  });

  test('replaying a spent code WITH its verifier still revokes what it minted', async () => {
    const fixture = await serverFixture();
    const { code, verifier } = await codeFor(fixture);
    const real = await redeem(fixture, code, verifier);
    expect((await redeem(fixture, code, verifier)).body['error']).toBe('invalid_grant');
    expect(await fixture.server.resolve(String(real.body['access_token']))).toBeNull();
  });
});

describe('refresh grant · a retired token is a replay only from the client it was issued to', () => {
  const refresh = (fixture: ServerFixture, token: string, clientId: string) =>
    post(fixture.server, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: clientId,
    });

  test('a retired refresh token presented by another client revokes nothing', async () => {
    const fixture = await serverFixture();
    const { client: other } = await fixture.server.registerClient({
      name: 'Other app',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['read'],
    });
    const first = await tokensFor(fixture);
    const retired = String(first.body['refresh_token']);
    const rotated = await refresh(fixture, retired, fixture.client.clientId);
    expect(rotated.status).toBe(200);

    const foreign = await refresh(fixture, retired, other.clientId);
    expect(foreign.body['error']).toBe('invalid_grant');
    expect(await fixture.server.resolve(String(rotated.body['access_token']))).not.toBeNull();
    const next = await refresh(
      fixture,
      String(rotated.body['refresh_token']),
      fixture.client.clientId,
    );
    expect(next.status).toBe(200);
  });

  test('the same retired token from its own client still revokes the grant', async () => {
    const fixture = await serverFixture();
    const first = await tokensFor(fixture);
    const retired = String(first.body['refresh_token']);
    const rotated = await refresh(fixture, retired, fixture.client.clientId);
    expect((await refresh(fixture, retired, fixture.client.clientId)).body['error']).toBe(
      'invalid_grant',
    );
    expect(await fixture.server.resolve(String(rotated.body['access_token']))).toBeNull();
  });
});
