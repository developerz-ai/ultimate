// One grant by name: `resolve` says which grant a token belongs to, `grants` lists a subject's
// live ones, and `revoke({ subject, grantId })` ends that one alone — never another subject's,
// never a sibling on the same client, and not escaped by a refresh rotation.

import { describe, expect, test } from 'bun:test';
import { codeFor, serverFixture, T0, tokensFor } from './authorization-server-fixture';
import { oneGrantRevokedCase } from './authorization-server-grants-fixture';
import { type AuthServerStore, memoryAuthServerStore } from './authorization-server-store';
import { sha256Hex } from './tokens';

describe('authorizationServer · one grant by id', () => {
  test('two grants on one client: revoking one leaves the other working, refresh included', async () => {
    await oneGrantRevokedCase(await serverFixture());
  });

  test('a grant id on another client than the one named is not revoked', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const grantId = (await fixture.server.resolve(String(tokens.body['access_token'])))?.grantId;
    expect(
      await fixture.server.revoke({
        subject: 'user-1',
        clientId: 'c_other',
        grantId: grantId ?? '',
      }),
    ).toBe(0);
    expect(
      await fixture.server.revoke({
        subject: 'user-1',
        clientId: fixture.client.clientId,
        grantId: grantId ?? '',
      }),
    ).toBe(1);
  });

  test('a token whose row was written before grants were named still resolves, with its grant', async () => {
    const fixture = await serverFixture();
    const at = new Date(T0);
    await fixture.store.putGrant({
      id: 'g_stored-earlier',
      clientId: fixture.client.clientId,
      subject: 'user-1',
      scopes: ['read'],
      resource: null,
      createdAt: at,
      refreshedAt: at,
      revokedAt: null,
    });
    await fixture.store.putToken({
      tokenHash: sha256Hex('xat_stored-earlier'),
      kind: 'access',
      grantId: 'g_stored-earlier',
      createdAt: at,
      expiresAt: new Date(T0 + 60_000),
      retiredAt: null,
    });
    expect(await fixture.server.resolve('xat_stored-earlier')).toMatchObject({
      grantId: 'g_stored-earlier',
      subject: 'user-1',
    });
  });

  test('a grant no live token holds is not listed: an abandoned consent, one idle past its window', async () => {
    const fixture = await serverFixture();
    await codeFor(fixture);
    expect(await fixture.server.grants({ subject: 'user-1' })).toEqual([]);
    await tokensFor(fixture);
    expect(await fixture.server.grants({ subject: 'user-1' })).toHaveLength(1);
    fixture.clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(await fixture.server.grants({ subject: 'user-1' })).toEqual([]);
  });

  test('a store without liveGrants is X_AUTH_GRANTS_UNSUPPORTED, naming the stores that list', async () => {
    const { liveGrants: _dropped, ...rest } = memoryAuthServerStore();
    const store: AuthServerStore = rest;
    const fixture = await serverFixture({ store });
    await expect(fixture.server.grants({ subject: 'user-1' })).rejects.toMatchObject({
      code: 'X_AUTH_GRANTS_UNSUPPORTED',
    });
  });
});
