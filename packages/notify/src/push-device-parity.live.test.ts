// One suite, two device stores: every answer `memoryPushDeviceStore` gives, the Postgres store gives
// the same way against a real server — a re-register that moves the device and keeps its first
// `createdAt`, one `(platform, token)` order, a remove that names its owner reaching only theirs, and
// a bad-token count both keep across a re-register.
// The Postgres half needs `TEST_DATABASE_URL`; it makes its own database and drops it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PushDeviceStore } from './push-device';
import { memoryPushDeviceStore } from './push-device';
import { postgresPushDeviceStore, SQL_PUSH_DEVICES_TABLE } from './push-device-pg';

const url = Bun.env['TEST_DATABASE_URL'];
const PROBE_DB = probeDatabaseName('x_notify_devices_probe');

type Sql = InstanceType<typeof Bun.SQL>;
let sql: Sql | undefined;

const admin = async (statement: string, values: readonly unknown[] = []): Promise<unknown[]> => {
  const client = new Bun.SQL(url ?? '', { max: 1 });
  try {
    return [...(await client.unsafe(statement, [...values]))];
  } finally {
    await client.end();
  }
};

const adminExecutor = {
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    (await admin(text, values)) as R[],
};

/** `Bun.SQL` over `unsafe` binds a `Date` by `toString()`, which Postgres cannot parse. */
const bound = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

const executor = (): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
    if (sql === undefined) return expect.unreachable('beforeAll opened no database');
    return [...(await sql.unsafe(text, values.map(bound)))] as R[];
  },
});

beforeAll(async () => {
  if (url === undefined) return;
  await admin(`drop database if exists ${PROBE_DB} with (force)`);
  await sweepProbeDatabases(adminExecutor, PROBE_DB);
  await admin(`create database ${PROBE_DB}`);
  const target = new URL(url);
  target.pathname = `/${PROBE_DB}`;
  sql = new Bun.SQL(target.href, { max: 2, prepare: false });
  for (const statement of SQL_PUSH_DEVICES_TABLE.split(';')) {
    if (statement.trim().length > 0) await sql.unsafe(statement, []);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

const STORES: readonly (readonly [string, () => Promise<PushDeviceStore>])[] = [
  ['memory', () => Promise.resolve(memoryPushDeviceStore())],
  [
    'postgres',
    async () => {
      await sql?.unsafe('truncate x_push_devices', []);
      return postgresPushDeviceStore({ executor: executor() });
    },
  ],
];

const IOS = 'ab'.repeat(32);
const ANDROID = `fcm:${'Z'.repeat(60)}`;
const record = (overrides: Record<string, unknown> = {}) => ({
  platform: 'ios' as const,
  token: IOS,
  actorId: 'ana',
  locale: 'es',
  timeZone: 'Europe/Madrid',
  createdAt: Date.parse('2026-11-06T09:00:00Z'),
  ...overrides,
});

for (const [name, fresh] of STORES) {
  describe.skipIf(name === 'postgres' && url === undefined)(`${name} push device store`, () => {
    test('a re-register moves the device and keeps its first createdAt', async () => {
      const store = await fresh();
      await store.save(record());
      await store.save(record({ actorId: 'ben', locale: 'de', createdAt: 0 }));
      expect(await store.listFor('ana')).toEqual([]);
      expect(await store.listFor('ben')).toEqual([record({ actorId: 'ben', locale: 'de' })]);
    });

    test('one order, (platform, token) by code point', async () => {
      const store = await fresh();
      // Upper case sorts before lower case by code point, and after it in most locales.
      for (const token of ['cd'.repeat(32), IOS, 'AB'.repeat(32)])
        await store.save(record({ token }));
      await store.save(record({ platform: 'android', token: ANDROID }));
      expect(
        (await store.listFor('ana')).map((d) => `${d.platform}:${d.token.slice(0, 2)}`),
      ).toEqual(['android:fc', 'ios:AB', 'ios:ab', 'ios:cd']);
    });

    test('a remove naming another owner is absent; the sender’s remove reaches anyone', async () => {
      const store = await fresh();
      await store.save(record());
      expect(await store.remove('ios', IOS, 'ben')).toBe(false);
      expect(await store.remove('android', IOS)).toBe(false);
      expect(await store.remove('ios', IOS)).toBe(true);
      expect(await store.listFor('ana')).toEqual([]);
    });

    test('bad-token answers count up, survive a re-register, and a clear or a missing row is 0', async () => {
      const store = await fresh();
      await store.save(record());
      expect(await store.noteBadToken('ios', IOS)).toBe(1);
      expect(await store.noteBadToken('ios', IOS)).toBe(2);
      await store.save(record({ locale: 'de' }));
      expect(await store.listFor('ana')).toEqual([record({ locale: 'de', badTokens: 2 })]);
      await store.clearBadToken('ios', IOS);
      expect(await store.listFor('ana')).toEqual([record({ locale: 'de' })]);
      expect(await store.noteBadToken('android', IOS)).toBe(0);
    });
  });
}
