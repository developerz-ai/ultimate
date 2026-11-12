// `aggregates(measures)` and the filtered `countBy` against a real server AND memory in the same
// assertion — the filter clause, money's folded unit check and every decode have to answer alike.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { integer, money, text, timestamp, uuid } from './columns';
import { decimal } from './columns-data';
import { entity } from './entity';
import type { MeasureMap } from './measures';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Predicate } from './tenancy';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orders = entity('pg_measures_orders', {
  columns: {
    id: uuid().primaryKey(),
    status: text({ max: 20 }),
    customer: text({ max: 20 }),
    items: integer(),
    rate: decimal({ precision: 20, scale: 4 }),
    total: money(),
    at: timestamp(),
  },
});

type Order = typeof orders.$row;

const DROP = 'drop table if exists "pg_measures_orders" cascade';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const order = (
  n: number,
  status: string,
  customer: string,
  items: number,
  rate: string,
  currency: string,
): Order => ({
  id: id(n),
  status,
  customer,
  items,
  rate,
  total: { minor: n * 100, currency },
  at: new Date(Date.UTC(2026, 0, n, 12, 0, 0, 123)),
});

const ROWS: readonly Order[] = [
  order(1, 'paid', 'ann', 2, '0.1000', 'USD'),
  order(2, 'paid', 'bob', 1, '0.2000', 'USD'),
  order(3, 'open', 'ann', 5, '3.0000', 'EUR'),
  order(4, 'void', 'cyd', 3, '1.0000', 'USD'),
];

const paid: readonly Predicate[] = [{ column: 'status', op: 'eq', value: 'paid' }];

describe.skipIf(!hasPostgres)('live · postgres · measures', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [orders.$describe()],
      name: 'live measures',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    await postgresRepo(orders).insertAll(ROWS);
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const agrees = async (
    measures: MeasureMap,
    expected: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    expect(await postgresRepo(orders).aggregates?.(measures)).toEqual(expected);
    expect(await memoryRepo(orders, ROWS).aggregates?.(measures)).toEqual(expected);
  };

  const codeOf = async (run: () => Promise<unknown> | undefined): Promise<unknown> => {
    try {
      await run();
      return undefined;
    } catch (error) {
      return (error as { code?: unknown }).code;
    }
  };

  test('counts, filtered and not, in one statement', async () => {
    await agrees(
      {
        all: { fn: 'count' },
        paid: { fn: 'count', where: paid },
        none: { fn: 'count', where: [{ column: 'status', op: 'eq', value: 'refunded' }] },
        ratesCounted: { fn: 'count', column: 'rate' },
      },
      { all: 4, paid: 2, none: 0, ratesCounted: 4 },
    );
  });

  test('sum, avg, min and max decode exactly as the single aggregates do', async () => {
    await agrees(
      {
        rate: { fn: 'sum', column: 'rate', where: paid },
        items: { fn: 'avg', column: 'items' },
        first: { fn: 'min', column: 'at', where: [{ column: 'customer', op: 'eq', value: 'ann' }] },
        most: { fn: 'max', column: 'items', where: paid },
        empty: { fn: 'sum', column: 'items', where: [{ column: 'items', op: 'gt', value: 99 }] },
      },
      {
        rate: '0.3000',
        items: '2.750000',
        first: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 123)),
        most: 2,
        empty: null,
      },
    );
  });

  test('money: a filter that keeps one currency answers it; one that keeps two is refused', async () => {
    await agrees(
      {
        usd: {
          fn: 'sum',
          column: 'total',
          where: [{ column: 'total.currency', op: 'eq', value: 'USD' }],
        },
      },
      { usd: { minor: 700, currency: 'USD' } },
    );
    const measures: MeasureMap = { all: { fn: 'sum', column: 'total' } };
    expect(await codeOf(() => postgresRepo(orders).aggregates?.(measures))).toBe(
      'X_AGGREGATE_MIXED_CURRENCY',
    );
    expect(await codeOf(() => memoryRepo(orders, ROWS).aggregates?.(measures))).toBe(
      'X_AGGREGATE_MIXED_CURRENCY',
    );
  });

  test('countBy with where: every group present, counting only the kept rows', async () => {
    const expected: [string, number][] = [
      ['ann', 1],
      ['bob', 1],
      ['cyd', 0],
    ];
    expect([...(await postgresRepo(orders).countBy('customer', {}, { where: paid }))]).toEqual(
      expected,
    );
    expect([...(await memoryRepo(orders, ROWS).countBy('customer', {}, { where: paid }))]).toEqual(
      expected,
    );
  });
});

afterAll(() => {
  clearRegistry();
});
