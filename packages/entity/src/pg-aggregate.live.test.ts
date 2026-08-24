// The aggregates, against a real server AND against memory in the same assertion. Both bars this
// package sets are met in one file on purpose: an aggregate has no statement TEXT worth asserting
// (the answer is what matters), and a parity test with no server cannot compute the Postgres side
// at all — a recording client returns rows, not sums.
//
// Everything asserted here is exact. If a `sum` ever comes back as a float, or an `avg` rounds at a
// different place in one driver than the other, one of these two answers moves and the other does
// not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import { decimal } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { FindManyArgs, Repo } from './repo';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const ledger = entity('pg_agg_ledger', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    likeCount: integer().default(0),
    rate: decimal({ precision: 20, scale: 4 }),
    amount: money(),
    settled: boolean().default(false),
    at: timestamp(),
  },
});

type Row = typeof ledger.$row;

const DROP = 'drop table if exists "pg_agg_ledger" cascade';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000004${String(index).padStart(2, '0')}`;

/**
 * Deliberately awkward: `0.1 + 0.2` (the float's canonical failure), a minor unit past 2^53's
 * neighbourhood, and a count of three so every mean is a repeating decimal.
 */
const SEEDED: readonly Row[] = [
  {
    id: id(1),
    label: 'a',
    likeCount: 1,
    rate: '0.1000',
    amount: { minor: 1, currency: 'USD' },
    settled: false,
    at: new Date('2026-01-02T00:00:00.000Z'),
  },
  {
    id: id(2),
    label: 'b',
    likeCount: 1,
    rate: '0.2000',
    amount: { minor: 1, currency: 'USD' },
    settled: true,
    at: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    id: id(3),
    label: 'c',
    likeCount: 2,
    rate: '3.0000',
    amount: { minor: 2, currency: 'USD' },
    settled: false,
    at: new Date('2026-01-03T00:00:00.000Z'),
  },
];

describe.skipIf(!hasPostgres)('live · postgres · aggregates', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [ledger.$describe()],
      name: 'live aggregates',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    await postgresRepo(ledger).insertAll(SEEDED);
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  /** The same call against both drivers, which have to answer the identical value. */
  const both = async (
    run: (repo: Repo<Row>) => Promise<unknown>,
  ): Promise<{ pg: unknown; memory: unknown }> => ({
    pg: await run(postgresRepo(ledger)),
    memory: await run(memoryRepo(ledger, SEEDED)),
  });

  const agrees = async (
    run: (repo: Repo<Row>) => Promise<unknown>,
    expected: unknown,
  ): Promise<void> => {
    const { pg, memory } = await both(run);
    expect(pg).toEqual(expected);
    expect(memory).toEqual(expected);
  };

  test('sum over an integer column answers TEXT, not a number', async () => {
    // The sum of a million `integer` rows is not an `integer`, and `Number()` on one past 2^53
    // loses digits — so the answer stays decimal text and the caller writes the narrowing.
    await agrees((repo) => repo.aggregate('sum', 'likeCount'), '4');
  });

  test('sum over a decimal column is exact where a float is not', async () => {
    // 0.1 + 0.2 + 3.0. A binary float answers 3.3000000000000003 for the first two alone.
    await agrees((repo) => repo.aggregate('sum', 'rate'), '3.3000');
  });

  test('avg rounds at one fixed scale in both drivers', async () => {
    // 4/3 likes and 3.3/3 rate: repeating decimals, so the two drivers only agree if they round in
    // the same place — which is why the statement says `round(avg(...), 6)` rather than taking the
    // server's own numeric scale.
    await agrees((repo) => repo.aggregate('avg', 'likeCount'), '1.333333');
    await agrees((repo) => repo.aggregate('avg', 'rate'), '1.100000');
  });

  test('min and max over a timestamp answer the instant, both drivers', async () => {
    await agrees((repo) => repo.aggregate('min', 'at'), new Date('2026-01-01T00:00:00.000Z'));
    await agrees((repo) => repo.aggregate('max', 'at'), new Date('2026-01-03T00:00:00.000Z'));
  });

  test('a money aggregate stays integer minor units and carries its currency', async () => {
    await agrees((repo) => repo.aggregate('sum', 'amount'), { minor: 4, currency: 'USD' });
    await agrees((repo) => repo.aggregate('min', 'amount'), { minor: 1, currency: 'USD' });
    await agrees((repo) => repo.aggregate('max', 'amount'), { minor: 2, currency: 'USD' });
  });

  test('an aggregate covers the chain’s filters, exactly as count() does', async () => {
    const settled: FindManyArgs = { where: [{ column: 'settled', op: 'eq', value: true }] };
    await agrees((repo) => repo.aggregate('sum', 'likeCount', settled), '1');
    await agrees((repo) => repo.count(settled), 1);
  });

  test('an empty match is null in every function, never zero', async () => {
    // `0` would claim rows were seen. SQL answers NULL and so does memory.
    const none: FindManyArgs = { where: [{ column: 'label', op: 'eq', value: 'nothing' }] };
    for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
      await agrees((repo) => repo.aggregate(fn, 'likeCount', none), null);
    }
  });

  test('two currencies are refused by BOTH drivers, with the same code', async () => {
    await postgresRepo(ledger).insert({
      id: id(9),
      label: 'eur',
      likeCount: 0,
      rate: '0.0000',
      amount: { minor: 5, currency: 'EUR' },
      settled: false,
      at: new Date('2026-01-04T00:00:00.000Z'),
    });
    const mixed = [...SEEDED, { ...SEEDED[0], id: id(9), amount: { minor: 5, currency: 'EUR' } }];
    await expect(postgresRepo(ledger).aggregate('sum', 'amount')).rejects.toBeUltimateError(
      'X_AGGREGATE_MIXED_CURRENCY',
    );
    await expect(
      memoryRepo(ledger, mixed as readonly Row[]).aggregate('sum', 'amount'),
    ).rejects.toBeUltimateError('X_AGGREGATE_MIXED_CURRENCY');
    await client.execute(raw(`delete from "pg_agg_ledger" where "id" = '${id(9)}'`));
  });

  test('approximateCount reads the planner estimate, and never a filtered one', async () => {
    // Before `ANALYZE` the estimate is `-1` — the absence of an estimate, which answers `null`
    // rather than `0`: a `0` reads exactly like an empty table to every caller.
    await client.execute(raw('analyze "pg_agg_ledger"'));
    expect(await postgresRepo(ledger).approximateCount()).toBe(3);
    expect(await memoryRepo(ledger, SEEDED).approximateCount()).toBe(3);

    const filtered: FindManyArgs = { where: [{ column: 'settled', op: 'eq', value: true }] };
    await expect(postgresRepo(ledger).approximateCount(filtered)).rejects.toBeUltimateError(
      'X_APPROXIMATE_COUNT_FILTERED',
    );
    await expect(memoryRepo(ledger, SEEDED).approximateCount(filtered)).rejects.toBeUltimateError(
      'X_APPROXIMATE_COUNT_FILTERED',
    );
  });
});
