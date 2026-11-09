// RFC 8628 on an injected clock: `authorization_pending` until a person decides, `slow_down` for a
// poll inside the interval, `expired_token` past the life, `access_denied` on a denial, tokens on
// an approval — exactly once — and a user code that is 8 no-lookalike letters, guessed at a cost.

import { describe, expect, test } from 'bun:test';
import { post, serverFixture } from './authorization-server-fixture';
import { DEVICE_GRANT } from './authorization-server-types';
import { normaliseUserCode, USER_CODE_ALPHABET, userCode } from './grant-device';

const start = async () => {
  const fixture = await serverFixture();
  const started = await post(fixture.server, '/oauth/device', {
    client_id: fixture.client.clientId,
    scope: 'read',
  });
  const poll = () =>
    post(fixture.server, '/oauth/token', {
      grant_type: DEVICE_GRANT,
      device_code: String(started.body['device_code']),
      client_id: fixture.client.clientId,
    });
  return { fixture, started, poll, userCode: String(started.body['user_code']) };
};

describe('device authorization grant', () => {
  test('the codes and the verification page', async () => {
    const { started, userCode: shown } = await start();
    expect(started.status).toBe(200);
    expect(shown).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.body).toMatchObject({
      verification_uri: 'https://as.test/oauth/device',
      interval: 5,
      expires_in: 600,
    });
  });

  test('pending, slow_down inside the interval, then approved tokens exactly once', async () => {
    const { fixture, poll, userCode: shown } = await start();
    expect((await poll()).body['error']).toBe('authorization_pending');
    fixture.clock.advance(1_000);
    expect((await poll()).body['error']).toBe('slow_down');
    await fixture.server.approveDevice({
      subject: 'user-1',
      userCode: shown.toLowerCase(),
      key: 'ip:1',
      scopes: ['read'],
    });
    fixture.clock.advance(5_000);
    const tokens = await poll();
    expect(tokens.status).toBe(200);
    expect(tokens.body['scope']).toBe('read');
    const resolved = await fixture.server.resolve(String(tokens.body['access_token']));
    expect(resolved?.subject).toBe('user-1');
    fixture.clock.advance(5_000);
    expect((await poll()).body['error']).toBe('invalid_grant');
  });

  test('denied answers access_denied', async () => {
    const { fixture, poll, userCode: shown } = await start();
    await fixture.server.denyDevice({ userCode: shown, key: 'ip:1' });
    expect((await poll()).body['error']).toBe('access_denied');
  });

  test('past its life the device code is expired_token and cannot be approved', async () => {
    const { fixture, poll, userCode: shown } = await start();
    fixture.clock.advance(600_000);
    expect((await poll()).body['error']).toBe('expired_token');
    await expect(
      fixture.server.approveDevice({ subject: 'u', userCode: shown, key: 'k', scopes: ['read'] }),
    ).rejects.toMatchObject({ code: 'X_AUTH_CONSENT_INVALID' });
  });

  test('approving a scope the device never asked for is refused', async () => {
    const { fixture, userCode: shown } = await start();
    await expect(
      fixture.server.approveDevice({ subject: 'u', userCode: shown, key: 'k', scopes: ['write'] }),
    ).rejects.toMatchObject({ code: 'X_AUTH_CONSENT_INVALID' });
  });

  test('walking user codes locks the walker out', async () => {
    const { fixture, userCode: shown } = await start();
    for (let guess = 0; guess < 10; guess += 1) {
      expect(await fixture.server.readDevice({ userCode: 'BCDF-GHJK', key: 'walker' })).toEqual({
        ok: false,
        reason: 'unknown',
      });
    }
    await expect(
      fixture.server.readDevice({ userCode: shown, key: 'walker' }),
    ).rejects.toMatchObject({
      code: 'X_ACCOUNT_LOCKED',
    });
    expect((await fixture.server.readDevice({ userCode: shown, key: 'someone-else' })).ok).toBe(
      true,
    );
  });

  test('another client polling the device code neither spends nor slows the real one', async () => {
    const { fixture, started, poll, userCode: shown } = await start();
    const { client: other } = await fixture.server.registerClient({
      name: 'Other app',
      redirectUris: ['https://other.test/cb'],
      grantTypes: [DEVICE_GRANT],
      scopes: ['read'],
    });
    await fixture.server.approveDevice({
      subject: 'u',
      userCode: shown,
      key: 'k',
      scopes: ['read'],
    });
    const stolen = await post(fixture.server, '/oauth/token', {
      grant_type: DEVICE_GRANT,
      device_code: String(started.body['device_code']),
      client_id: other.clientId,
    });
    expect(stolen.body['error']).toBe('invalid_grant');
    expect((await poll()).status).toBe(200);
  });

  test('the alphabet and the normalisation', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = userCode();
      expect(code).toHaveLength(8);
      for (const char of code) expect(USER_CODE_ALPHABET).toContain(char);
    }
    expect(normaliseUserCode(' bcdf-ghjk ')).toBe('BCDFGHJK');
  });
});
