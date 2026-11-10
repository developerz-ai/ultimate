// The Postgres authorization-server store's statements, run on PGlite — a real engine, no service to
// start — one walk per record kind. The contract every store owes is `@ultimat3/testing`'s
// `authServerStoreConformance` (memory, and Postgres in `live`); this is the unit-tier run of the
// SQL itself, which `@ultimat3/auth` cannot borrow from the package above it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import { postgresAuthServerStore } from './authorization-server-postgres';
import { SQL_AUTH_SERVER_TABLES } from './authorization-server-schema';
import type { AuthServerStore } from './authorization-server-store';
import type { DeviceCodeRecord } from './authorization-server-types';

const PGLITE_BOOT_MS = 30_000;
const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const client = pgliteClient();
const executor: PgExecutor = {
  query: <R>(text: string, values: readonly unknown[]) => client.query<R>({ text, values }),
};
let store: AuthServerStore;

beforeAll(async () => {
  for (const statement of SQL_AUTH_SERVER_TABLES.split(';')) {
    if (statement.trim() !== '') await client.execute(raw(statement));
  }
  store = postgresAuthServerStore({ executor });
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

const device = (hash: string, userCode: string): DeviceCodeRecord => ({
  deviceCodeHash: hash,
  userCodeHash: userCode,
  clientId: 'c1',
  scopes: ['read', 'write'],
  resource: 'https://as.test/mcp',
  status: 'pending',
  subject: null,
  grantedScopes: null,
  intervalSeconds: 5,
  lastPolledAt: null,
  createdAt: at(0),
  expiresAt: at(600),
});

describe('postgresAuthServerStore on PGlite', () => {
  test('a confidential client round-trips with every field, and an unknown one is null', async () => {
    const stored = {
      clientId: 'confidential',
      name: 'Back office',
      secretHash: 'f'.repeat(64),
      authMethod: 'client_secret_basic' as const,
      redirectUris: ['https://app.test/cb'],
      grantTypes: ['client_credentials' as const, 'refresh_token' as const],
      scopes: ['read', 'write'],
      resources: ['https://as.test/mcp'],
      createdAt: at(0),
    };
    await store.putClient(stored);
    expect(await store.getClient('confidential')).toEqual(stored);
    expect(await store.getClient('nobody')).toBeNull();
  });

  test('a code reads unspent, takes fresh once, then replays', async () => {
    await store.putCode({
      codeHash: 'code-1',
      grantId: 'g-code',
      clientId: 'c1',
      subject: 'u1',
      scopes: ['read'],
      resource: null,
      redirectUri: 'https://app.test/cb',
      codeChallenge: 'x'.repeat(43),
      expiresAt: at(120),
      usedAt: null,
    });
    expect(await store.getCode('code-1')).toMatchObject({ resource: null, usedAt: null });
    expect((await store.takeCode('code-1', at(1)))?.fresh).toBe(true);
    const replay = await store.takeCode('code-1', at(2));
    expect([replay?.fresh, replay?.code.usedAt?.getTime()]).toEqual([false, at(1).getTime()]);
    expect([await store.getCode('none'), await store.takeCode('none', at(1))]).toEqual([
      null,
      null,
    ]);
  });

  test('grants touch, revoke by id, and revoke by subject and client', async () => {
    const grant = {
      id: 'g1',
      clientId: 'c1',
      subject: 'walk',
      scopes: ['read'],
      resource: 'https://as.test/mcp',
      createdAt: at(0),
      refreshedAt: at(0),
      revokedAt: null,
    };
    await store.putGrant(grant);
    await store.putGrant({ ...grant, id: 'g2', clientId: 'c2' });
    await store.putGrant({ ...grant, id: 'g3', clientId: 'c3' });
    await store.touchGrant('g1', at(30));
    expect(await store.getGrant('g1')).toEqual({ ...grant, refreshedAt: at(30) });
    await store.revokeGrant('g1', at(40));
    expect((await store.getGrant('g1'))?.revokedAt).toEqual(at(40));
    expect(await store.revokeGrants({ subject: 'walk', clientId: 'c2' }, at(50))).toBe(1);
    expect(await store.revokeGrants({ subject: 'walk' }, at(60))).toBe(1);
    expect(await store.getGrant('nobody')).toBeNull();
  });

  test('a refresh token rotates, then replays, and an unknown one is unknown', async () => {
    const token = {
      tokenHash: 'r1',
      kind: 'refresh' as const,
      grantId: 'g-r',
      createdAt: at(0),
      expiresAt: at(3600),
      retiredAt: null,
    };
    await store.putToken(token);
    expect(await store.getToken('r1')).toEqual(token);
    const next = { ...token, tokenHash: 'r2' };
    expect(await store.rotateRefresh('r1', next, at(1))).toEqual({
      outcome: 'rotated',
      grantId: 'g-r',
    });
    expect((await store.getToken('r1'))?.retiredAt).toEqual(at(1));
    expect(await store.rotateRefresh('r1', { ...token, tokenHash: 'r3' }, at(2))).toEqual({
      outcome: 'replayed',
      grantId: 'g-r',
    });
    expect(await store.rotateRefresh('none', next, at(2))).toEqual({ outcome: 'unknown' });
    expect(await store.getToken('none')).toBeNull();
  });

  test('a device code polls, is approved once, and is consumed once', async () => {
    await store.putDevice(device('d1', 'uc-1'));
    expect((await store.deviceByUserCode('uc-1'))?.scopes).toEqual(['read', 'write']);
    expect(await store.deviceByUserCode('none')).toBeNull();
    expect((await store.pollDevice('d1', 'c1', at(1)))?.lastPolledAt).toBeNull();
    expect(await store.pollDevice('d1', 'c2', at(2))).toBeNull();
    expect((await store.pollDevice('d1', 'c1', at(6)))?.lastPolledAt).toEqual(at(1));
    expect(
      await store.decideDevice(
        'uc-1',
        { status: 'approved', subject: 'u1', scopes: ['read'] },
        at(7),
      ),
    ).toMatchObject({ status: 'approved', subject: 'u1', grantedScopes: ['read'] });
    expect(await store.decideDevice('uc-1', { status: 'denied' }, at(8))).toBeNull();
    expect(await store.consumeDevice('d1', at(9))).toBe(true);
    expect(await store.consumeDevice('d1', at(10))).toBe(false);
  });

  test('a denied device code is decided with no subject, and an expired one not at all', async () => {
    await store.putDevice(device('d2', 'uc-2'));
    expect(await store.decideDevice('uc-2', { status: 'denied' }, at(1))).toMatchObject({
      status: 'denied',
      subject: null,
      grantedScopes: null,
    });
    expect(await store.consumeDevice('d2', at(2))).toBe(false);
    await store.putDevice(device('d3', 'uc-3'));
    expect(await store.decideDevice('uc-3', { status: 'denied' }, at(600))).toBeNull();
  });

  test('purge removes what expired and what sat idle, and counts it', async () => {
    expect(await store.purge(at(100_000), at(100_000))).toBeGreaterThan(0);
    expect(await store.getGrant('g2')).toBeNull();
    expect(await store.getToken('r2')).toBeNull();
    expect(await store.purge(at(100_000), at(100_000))).toBe(0);
  });
});
