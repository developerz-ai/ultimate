// `aggregate({ … })` and `countBy(col, { where })`: the answer through the typed chain on memory,
// the ONE statement Postgres is sent (a recording client), and every refusal — judged before a row
// is read, identically in both drivers. Parity against a real server: `pg-measures.live.test.ts`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import type { EntityError } from './errors';
import { MAX_MEASURES } from './measures';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

const orders = entity('measures_test_orders', {
  columns: {
    id: uuid().primaryKey(),
    status: text({ max: 20 }),
    customer: text({ max: 20 }),
    items: integer(),
    total: money(),
    at: timestamp(),
    deletedAt: timestamp().nullable(),
  },
});

type Order = typeof orders.$row;

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const order = (n: number, status: string, customer: string, items: number, minor: number) =>
  ({
    id: id(n),
    status,
    customer,
    items,
    total: { minor, currency: 'USD' },
    at: new Date(Date.UTC(2026, 0, n)),
    deletedAt: null,
  }) satisfies Order;

const ROWS: readonly Order[] = [
  order(1, 'paid', 'ann', 2, 1000),
  order(2, 'paid', 'bob', 1, 250),
  order(3, 'open', 'ann', 5, 4000),
  order(4, 'void', 'cyd', 3, 99),
];

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const table = () => tableFor(orders, memoryRepo(orders, ROWS));

const caught = async (run: () => Promise<unknown>): Promise<EntityError | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as EntityError;
  }
};

describe('aggregate({ … }) on the chain', () => {
  test('several measures, each with its own filter, one answer', async () => {
    const answer = await table().aggregate({
      all: { fn: 'count' },
      paid: { fn: 'count', where: [['status', 'eq', 'paid']] },
      revenue: { fn: 'sum', column: 'total', where: [['status', 'eq', 'paid']] },
      items: { fn: 'sum', column: 'items' },
      mean: { fn: 'avg', column: 'items' },
      first: { fn: 'min', column: 'at' },
      none: { fn: 'max', column: 'items', where: [['status', 'eq', 'refunded']] },
      noneCounted: { fn: 'count', where: [['status', 'eq', 'refunded']] },
    });
    expect(answer).toEqual({
      all: 4,
      paid: 2,
      revenue: { minor: 1250, currency: 'USD' },
      items: '11',
      mean: '2.750000',
      first: new Date(Date.UTC(2026, 0, 1)),
      none: null,
      noneCounted: 0,
    });
  });

  test('a measure filter narrows inside the chain, never widens it', async () => {
    const answer = await table()
      .andWhere('customer', 'eq', 'ann')
      .aggregate({ paid: { fn: 'count', where: [['status', 'eq', 'paid']] } });
    expect(answer).toEqual({ paid: 1 });
  });

  test('countBy with where keeps every group and counts only the rows it keeps', async () => {
    const counts = await table().countBy('customer', { where: [['status', 'eq', 'paid']] });
    expect([...counts]).toEqual([
      ['ann', 1],
      ['bob', 1],
      ['cyd', 0],
    ]);
  });
});

describe('the Postgres statement', () => {
  test('is ONE statement with a filter per measure', async () => {
    client.on('select', { rows: [{ m0: '4', m1: '2', m2: '1250', u2: 'USD/' }] });
    const answer = await postgresRepo(orders).aggregates?.({
      all: { fn: 'count' },
      paid: { fn: 'count', where: [{ column: 'status', op: 'eq', value: 'paid' }] },
      revenue: { fn: 'sum', column: 'total' },
    });
    expect(client.texts).toHaveLength(1);
    const text = client.texts[0] ?? '';
    expect(text).toContain('count(*)::text as "m0"');
    expect(text).toContain('count(*) filter (where "status" = $1)::text as "m1"');
    expect(text).toContain('sum("total_minor")::text as "m2"');
    expect(text).toContain('string_agg(distinct "total_currency"');
    expect(text).toContain('"deleted_at" is null');
    expect(answer).toEqual({ all: 4, paid: 2, revenue: { minor: 1250, currency: 'USD' } });
  });

  test('two currencies in one money measure are refused, as sum() refuses them', async () => {
    client.on('select', { rows: [{ m0: '1250', u0: 'EUR/,USD/' }] });
    const error = await caught(
      () =>
        postgresRepo(orders).aggregates?.({ revenue: { fn: 'sum', column: 'total' } }) ??
        Promise.resolve(),
    );
    expect(error?.code).toBe('X_AGGREGATE_MIXED_CURRENCY');
  });

  test('countBy with where is a filtered count, grouped as before', async () => {
    client.on('select', { rows: [{ group_value: 'ann', group_count: '1' }] });
    await postgresRepo(orders).countBy(
      'customer',
      {},
      {
        where: [{ column: 'status', op: 'eq', value: 'paid' }],
      },
    );
    expect(client.texts.at(-1)).toContain('count(*) filter (where "status" = $1) as group_count');
  });
});

describe('refusals, before a row is read, in both drivers', () => {
  const both = async (measures: unknown): Promise<readonly (string | undefined)[]> => {
    const run = (repo: Repo<Order>) =>
      caught(() => repo.aggregates?.(measures as never) ?? Promise.resolve());
    return [(await run(memoryRepo(orders, ROWS)))?.code, (await run(postgresRepo(orders)))?.code];
  };

  test.each([
    ['no measures', {}],
    ['an unknown fn', { x: { fn: 'median', column: 'items' } }],
    ['a sum with no column', { x: { fn: 'sum' } }],
    ['avg over money', { x: { fn: 'avg', column: 'total' } }],
    ['sum over text', { x: { fn: 'sum', column: 'status' } }],
    ['a count of a column never declared', { x: { fn: 'count', column: 'nope' } }],
    [
      'a filter on a column never declared',
      { x: { fn: 'count', where: [{ column: 'nope', op: 'eq', value: 1 }] } },
    ],
    [
      'a filter with an unknown operator',
      { x: { fn: 'count', where: [{ column: 'status', op: '>', value: 1 }] } },
    ],
    ['a measure that is not an object', { x: 5 }],
  ])('%s', async (_, measures) => {
    const codes = await both(measures);
    expect(codes[0]).toBeDefined();
    expect(codes[1]).toBe(codes[0]);
    expect(client.texts).toEqual([]);
  });

  test(`more than ${MAX_MEASURES} measures`, async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_MEASURES + 1 }, (_, n) => [`m${n}`, { fn: 'count' }]),
    );
    expect(await both(many)).toEqual(['X_AGGREGATE_UNSUPPORTED', 'X_AGGREGATE_UNSUPPORTED']);
  });

  test('a chain filter operator outside the vocabulary is refused on the chain', async () => {
    const error = await caught(() =>
      table().aggregate({ x: { fn: 'count', where: [['status', '>' as never, 1]] } }),
    );
    expect(error?.code).toBe('X_ENTITY_OPERATOR_UNKNOWN');
  });

  test('a repository without aggregates() is refused with the code, not a TypeError', async () => {
    const { aggregates: _, ...bare } = memoryRepo(orders, ROWS);
    const error = await caught(() => tableFor(orders, bare).aggregate({ x: { fn: 'count' } }));
    expect(error?.code).toBe('X_AGGREGATE_UNSUPPORTED');
  });
});
