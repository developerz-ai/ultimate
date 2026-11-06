// One contract, two stores: memory (every test) and Postgres (a fleet) answer every single-use
// transition alike — and on Postgres, racing redemptions of one code spend it exactly once.
// Postgres runs against `TEST_DATABASE_URL` through `Bun.SQL`; unset, that half skips.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import { postgresAuthServerStore } from './authorization-server-postgres';
import { AUTH_SERVER_TABLES, SQL_AUTH_SERVER_TABLES } from './authorization-server-schema';
import { type AuthServerStore, memoryAuthServerStore } from './authorization-server-store';
import type {
  AuthCodeRecord,
  AuthTokenRecord,
  DeviceCodeRecord,
} from './authorization-server-types';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const code = (hash: string): AuthCodeRecord => ({
  codeHash: hash,
  grantId: 'g1',
  clientId: 'c1',
  subject: 'u1',
  scopes: ['read', 'write'],
  resource: 'https://as.test/mcp',
  redirectUri: 'https://app.test/cb',
  codeChallenge: 'x'.repeat(43),
  expiresAt: at(120),
  usedAt: null,
});
const token = (hash: string, kind: 'access' | 'refresh'): AuthTokenRecord => ({
  tokenHash: hash,
  kind,
  grantId: 'g1',
  createdAt: at(0),
  expiresAt: at(3600),
  retiredAt: null,
});
const device: DeviceCodeRecord = {
  deviceCodeHash: 'd1',
  userCodeHash: 'u-code',
  clientId: 'c1',
  scopes: ['read'],
  resource: null,
  status: 'pending',
  subject: null,
  grantedScopes: null,
  intervalSeconds: 5,
  lastPolledAt: null,
  createdAt: at(0),
  expiresAt: at(600),
};
const grant = {
  id: 'g1',
  clientId: 'c1',
  subject: 'u1',
  scopes: ['read'],
  resource: null,
  createdAt: at(0),
  refreshedAt: at(0),
  revokedAt: null,
};

function contract(name: string, fresh: () => Promise<AuthServerStore>): void {
  describe(`contract · ${name} authorization-server store`, () => {
    let store: AuthServerStore;
    beforeEach(async () => {
      store = await fresh();
    });

    test('a client round-trips, lists intact', async () => {
      const client = {
        clientId: 'c1',
        name: 'App',
        secretHash: null,
        authMethod: 'none' as const,
        redirectUris: ['https://app.test/cb', 'http://localhost:4000/cb'],
        grantTypes: ['authorization_code' as const],
        scopes: ['read'],
        resources: [],
        createdAt: at(0),
      };
      await store.putClient(client);
      expect(await store.getClient('c1')).toEqual(client);
      expect(await store.getClient('nope')).toBeNull();
    });

    test('a code is taken fresh once; the second take is a replay', async () => {
      await store.putCode(code('h1'));
      const first = await store.takeCode('h1', at(1));
      expect(first?.fresh).toBe(true);
      expect(first?.code.scopes).toEqual(['read', 'write']);
      expect((await store.takeCode('h1', at(2)))?.fresh).toBe(false);
      expect(await store.takeCode('none', at(2))).toBeNull();
    });

    test('racing takes of one code spend it exactly once', async () => {
      await store.putCode(code('race'));
      const takes = await Promise.all(
        Array.from({ length: 8 }, () => store.takeCode('race', at(1))),
      );
      expect(takes.filter((take) => take?.fresh === true)).toHaveLength(1);
    });

    test('a refresh rotates once; the retired one is a replay; racing rotations rotate once', async () => {
      await store.putToken(token('r1', 'refresh'));
      expect(await store.rotateRefresh('r1', token('r2', 'refresh'), at(1))).toEqual({
        outcome: 'rotated',
        grantId: 'g1',
      });
      expect(await store.rotateRefresh('r1', token('r3', 'refresh'), at(2))).toEqual({
        outcome: 'replayed',
        grantId: 'g1',
      });
      expect(await store.rotateRefresh('zz', token('r4', 'refresh'), at(2))).toEqual({
        outcome: 'unknown',
      });
      const raced = await Promise.all(
        ['a', 'b', 'c', 'd'].map((n) =>
          store.rotateRefresh('r2', token(`n-${n}`, 'refresh'), at(3)),
        ),
      );
      expect(raced.filter((r) => r.outcome === 'rotated')).toHaveLength(1);
    });

    test('grants revoke one by one and by subject', async () => {
      await store.putGrant(grant);
      await store.putGrant({ ...grant, id: 'g2', clientId: 'c2' });
      await store.revokeGrant('g1', at(1));
      expect((await store.getGrant('g1'))?.revokedAt?.getTime()).toBe(at(1).getTime());
      expect(await store.revokeGrants({ subject: 'u1' }, at(2))).toBe(1);
      expect(await store.revokeGrants({ subject: 'u1', clientId: 'c2' }, at(3))).toBe(0);
    });

    test('a device code is decided once and consumed once', async () => {
      await store.putDevice(device);
      expect((await store.pollDevice('d1', at(1)))?.lastPolledAt).toBeNull();
      expect((await store.pollDevice('d1', at(6)))?.lastPolledAt?.getTime()).toBe(at(1).getTime());
      const decided = await store.decideDevice(
        'u-code',
        { status: 'approved', subject: 'u1', scopes: ['read'] },
        at(7),
      );
      expect(decided).toMatchObject({ status: 'approved', subject: 'u1', grantedScopes: ['read'] });
      expect(await store.decideDevice('u-code', { status: 'denied' }, at(8))).toBeNull();
      const consumed = await Promise.all([
        store.consumeDevice('d1', at(9)),
        store.consumeDevice('d1', at(9)),
      ]);
      expect(consumed.filter(Boolean)).toHaveLength(1);
    });

    test('an expired device code cannot be decided', async () => {
      await store.putDevice(device);
      expect(await store.decideDevice('u-code', { status: 'denied' }, at(600))).toBeNull();
    });

    test('purge removes what expired, what was revoked and what sat idle', async () => {
      await store.putCode(code('old'));
      await store.putToken(token('t-old', 'access'));
      await store.putGrant({ ...grant, refreshedAt: at(0) });
      expect(await store.purge(at(200), at(-1))).toBe(1);
      expect(await store.purge(at(4000), at(1))).toBe(2);
      expect(await store.getGrant('g1')).toBeNull();
    });
  });
}

contract('memory', async () => memoryAuthServerStore());

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_oauth_store_contract');

describe.skipIf(!hasPostgres)('postgres', () => {
  let admin: InstanceType<typeof Bun.SQL>;
  let sql: InstanceType<typeof Bun.SQL>;
  const executor: PgExecutor = {
    query: async <R>(text: string, params: readonly unknown[]) =>
      (await sql.unsafe(text, [...params])) as readonly R[],
  };
  const applyDdl = async () => {
    for (const statement of SQL_AUTH_SERVER_TABLES.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  };

  beforeAll(async () => {
    admin = new Bun.SQL(url ?? '');
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await sweepProbeDatabases(
      {
        query: async <R>(text: string, params: readonly unknown[]) =>
          [...(await admin.unsafe(text, [...params]))] as R[],
      },
      PROBE_DB,
    );
    await admin.unsafe(`create database ${PROBE_DB}`);
    const probe = new URL(url ?? '');
    probe.pathname = `/${PROBE_DB}`;
    sql = new Bun.SQL({ url: probe.toString(), max: 8 });
    await applyDdl();
  });

  afterAll(async () => {
    await sql.close();
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await admin.close();
  });

  contract('postgres', async () => {
    await sql.unsafe(`truncate ${AUTH_SERVER_TABLES.join(', ')}`);
    return postgresAuthServerStore({ executor });
  });

  test('the DDL is re-runnable: every boot applies it', async () => {
    await applyDdl();
  });
});
