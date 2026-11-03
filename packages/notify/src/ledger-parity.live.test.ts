// One suite, two delivery ledgers: every outcome `memoryDeliveryLedger` answers, the Postgres
// ledger answers the same way against a real server — the identity of a delivery (a NULL and an
// empty recipient are one row) and a settle that found no claim (it records nothing).
// The Postgres half needs `TEST_DATABASE_URL`; it makes its own database and drops it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import {
  type DeliveryClaim,
  type DeliveryClaimAnswer,
  type DeliveryLedger,
  memoryDeliveryLedger,
} from './ledger';
import { postgresDeliveryLedger, SQL_NOTIFY_DELIVERIES_TABLE } from './ledger-pg';

const url = Bun.env['TEST_DATABASE_URL'];
/**
 * One database per INVOCATION: a fixed name let two concurrent runs (CI shards, a dev re-run)
 * share it, and the first `afterAll` dropped it from under the other. pid for the process, a
 * random hex suffix for two runs that land on one pid in different containers.
 */
const PROBE_DB = probeDatabaseName('x_notify_ledger_probe');
const AT = new Date('2026-08-24T09:00:00Z');
const bulk: DeliveryClaim = {
  notifier: 'post.liked',
  key: 'k1',
  recipient: null,
  channel: 'slack',
};

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

/** The server-level connection as an executor, for `sweepProbeDatabases`. */
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
  for (const statement of SQL_NOTIFY_DELIVERIES_TABLE.split(';')) {
    if (statement.trim().length > 0) await sql.unsafe(statement, []);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

const RECLAIM_MS = 60_000;

const LEDGERS: readonly (readonly [string, () => Promise<DeliveryLedger>])[] = [
  ['memory', () => Promise.resolve(memoryDeliveryLedger({ reclaimAfterMs: RECLAIM_MS }))],
  [
    'postgres',
    async () => {
      await sql?.unsafe('truncate x_notify_deliveries', []);
      return postgresDeliveryLedger({ executor: executor(), reclaimAfterMs: RECLAIM_MS });
    },
  ],
];

const after = (ms: number): Date => new Date(AT.getTime() + ms);

/** The claim id of an answer that must have been `owned`. */
const owned = (answer: DeliveryClaimAnswer): string =>
  answer.outcome === 'owned' ? answer.claimId : expect.unreachable(`got ${answer.outcome}`);

for (const [name, fresh] of LEDGERS) {
  describe.skipIf(name === 'postgres' && url === undefined)(`${name} delivery ledger`, () => {
    test('a NULL and an empty recipient are ONE delivery: sent once, never claimed again', async () => {
      const ledger = await fresh();
      const claimId = owned(await ledger.claim(bulk, AT));
      await ledger.settle(bulk, 'sent', AT, claimId);
      expect(await ledger.claim({ ...bulk, recipient: '' }, AT)).toEqual({ outcome: 'sent' });
      expect(await ledger.find({ ...bulk, recipient: '' })).toMatchObject({
        recipient: null,
        status: 'sent',
        attempts: 1,
      });
    });

    test('a settle with no claim records nothing, so the claim after it still sends', async () => {
      const ledger = await fresh();
      expect(await ledger.settle(bulk, 'sent', AT, crypto.randomUUID())).toBe(false);
      expect(await ledger.find(bulk)).toBeUndefined();
      owned(await ledger.claim(bulk, AT));
    });

    test('two claims at once: one owner, and the other is told when to come back', async () => {
      const ledger = await fresh();
      const answers = await Promise.all([ledger.claim(bulk, AT), ledger.claim(bulk, AT)]);
      expect(answers.filter((answer) => answer.outcome === 'owned')).toHaveLength(1);
      const other = answers.find((answer) => answer.outcome !== 'owned');
      expect(other).toEqual({ outcome: 'held', retryAfterMs: RECLAIM_MS });
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending', attempts: 1 });
    });

    test('a live claim is held up to the window, and reclaimed one past it', async () => {
      const ledger = await fresh();
      owned(await ledger.claim(bulk, AT));
      expect(await ledger.claim(bulk, after(RECLAIM_MS))).toEqual({
        outcome: 'held',
        retryAfterMs: 0,
      });
      owned(await ledger.claim(bulk, after(RECLAIM_MS + 1)));
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending', attempts: 2 });
    });

    test("a late settle changes nothing: the row is its reclaimer's", async () => {
      const ledger = await fresh();
      const late = owned(await ledger.claim(bulk, AT));
      const current = owned(await ledger.claim(bulk, after(RECLAIM_MS + 1)));
      expect(current).not.toBe(late);

      expect(await ledger.settle(bulk, 'failed', after(RECLAIM_MS + 2), late)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending' });

      expect(await ledger.settle(bulk, 'sent', after(RECLAIM_MS + 3), current)).toBe(true);
      expect(await ledger.settle(bulk, 'failed', after(RECLAIM_MS + 4), late)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sent' });
    });

    test('an attempt cannot move its own `sent` back to `failed`', async () => {
      const ledger = await fresh();
      const claimId = owned(await ledger.claim(bulk, AT));
      expect(await ledger.settle(bulk, 'sent', AT, claimId)).toBe(true);
      expect(await ledger.settle(bulk, 'failed', AT, claimId)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sent' });
    });

    test('a failed delivery is re-claimable at once, counting the attempt', async () => {
      const ledger = await fresh();
      const claimId = owned(await ledger.claim(bulk, AT));
      await ledger.settle(bulk, 'failed', AT, claimId);
      owned(await ledger.claim({ ...bulk, recipient: '' }, AT));
      expect(await ledger.find(bulk)).toMatchObject({
        recipient: null,
        status: 'sending',
        attempts: 2,
      });
    });
  });
}
