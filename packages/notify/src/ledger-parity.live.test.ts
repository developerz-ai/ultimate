// One suite, two delivery ledgers: every outcome `memoryDeliveryLedger` answers, the Postgres
// ledger answers the same way against a real server — the identity of a delivery (a NULL and an
// empty recipient are one row) and a settle that found no claim (it records nothing).
// The Postgres half needs `TEST_DATABASE_URL`; it makes its own database and drops it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { type DeliveryClaim, type DeliveryLedger, memoryDeliveryLedger } from './ledger';
import { postgresDeliveryLedger, SQL_NOTIFY_DELIVERIES_TABLE } from './ledger-pg';

const url = Bun.env['TEST_DATABASE_URL'];
/**
 * One database per INVOCATION: a fixed name let two concurrent runs (CI shards, a dev re-run)
 * share it, and the first `afterAll` dropped it from under the other. pid for the process, a
 * random hex suffix for two runs that land on one pid in different containers.
 */
const PROBE_DB = `x_notify_ledger_probe_${String(process.pid)}_${crypto.randomUUID().slice(0, 8)}`;
const AT = new Date('2026-08-24T09:00:00Z');
const bulk: DeliveryClaim = {
  notifier: 'post.liked',
  key: 'k1',
  recipient: null,
  channel: 'slack',
};

type Sql = InstanceType<typeof Bun.SQL>;
let sql: Sql | undefined;

const admin = async (statement: string): Promise<void> => {
  const client = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await client.unsafe(statement, []);
  } finally {
    await client.end();
  }
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
  await admin(`create database ${PROBE_DB}`);
  const target = new URL(url);
  target.pathname = `/${PROBE_DB}`;
  sql = new Bun.SQL(target.href, { max: 2, prepare: false });
  for (const statement of SQL_NOTIFY_DELIVERIES_TABLE.split(';')) {
    if (statement.trim().length > 0) await sql.unsafe(statement, []);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

const LEDGERS: readonly (readonly [string, () => Promise<DeliveryLedger>])[] = [
  ['memory', () => Promise.resolve(memoryDeliveryLedger())],
  [
    'postgres',
    async () => {
      await sql?.unsafe('truncate x_notify_deliveries', []);
      return postgresDeliveryLedger({ executor: executor() });
    },
  ],
];

for (const [name, fresh] of LEDGERS) {
  describe.skipIf(name === 'postgres' && url === undefined)(`${name} delivery ledger`, () => {
    test('a NULL and an empty recipient are ONE delivery: sent once, never claimed again', async () => {
      const ledger = await fresh();
      expect(await ledger.claim(bulk, AT)).toBe(true);
      await ledger.settle(bulk, 'sent', AT);
      expect(await ledger.claim({ ...bulk, recipient: '' }, AT)).toBe(false);
      expect(await ledger.find({ ...bulk, recipient: '' })).toMatchObject({
        recipient: null,
        status: 'sent',
        attempts: 1,
      });
    });

    test('a settle with no claim records nothing, so the claim after it still sends', async () => {
      const ledger = await fresh();
      await ledger.settle(bulk, 'sent', AT);
      expect(await ledger.find(bulk)).toBeUndefined();
      expect(await ledger.claim(bulk, AT)).toBe(true);
    });

    test('a re-claim counts the attempt and keeps the row it found', async () => {
      const ledger = await fresh();
      await ledger.claim(bulk, AT);
      expect(await ledger.claim({ ...bulk, recipient: '' }, AT)).toBe(true);
      expect(await ledger.find(bulk)).toMatchObject({
        recipient: null,
        status: 'sending',
        attempts: 2,
      });
    });
  });
}
