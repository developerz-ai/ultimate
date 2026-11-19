// `predicate-operand.test.ts`'s claims that only a server's own client can prove, against a real
// Postgres through `Bun.SQL`: an `in` list bound as ONE array parameter reads each kind as the
// value bound alone did, and text that is no uuid never reaches the wire. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  statementsOf,
} from '@ultimat3/db';
import { plainDate } from '@ultimat3/time';
import { boolean, integer, text, timestamp, uuid } from './columns';
import { bigint, date, decimal } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { IN_LIST_AS_ARRAY_FROM } from './predicate-operand';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import type { Predicate } from './tenancy';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const rows = entity('predicate_operand_live_rows', {
  columns: {
    id: uuid().primaryKey(),
    ref: uuid().nullable(),
    label: text({ max: 20 }),
    n: integer(),
    big: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    flag: boolean(),
    at: timestamp(),
    day: date(),
  },
});
type Row = typeof rows.$row;

const idAt = (index: number): string => `00000000-0000-7000-8000-00000000000${String(index)}`;
const PAST = 70_000;

const SEED = [0, 1, 2].map((index) => ({
  id: idAt(index),
  ref: index === 1 ? null : idAt(7 + index),
  label: `a${String(index)}`,
  n: index + 1,
  big: String(9_200_000_000_000_000_000n + BigInt(index)),
  rate: `${String(index)}.50`,
  flag: index !== 1,
  at: new Date(Date.UTC(2026, index, 1)),
  day: plainDate(`2026-0${String(index + 1)}-01`),
}));

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · a predicate operand', () => {
  let client: PostgresClient;
  let memory: Repo<Row>;
  let postgres: Repo<Row>;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string, profile: { max: 1 } });
    await client.execute(raw('drop table if exists predicate_operand_live_rows cascade'));
    const { up } = generateMigration({ entities: [rows.$describe()], name: 'operand live' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
    memory = memoryRepo(rows);
    postgres = postgresRepo(rows, { client });
    for (const repo of [memory, postgres]) for (const row of SEED) await repo.insert(row);
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists predicate_operand_live_rows cascade'));
    await client.close();
  });

  const answer = async (repo: Repo<Row>, predicate: Predicate): Promise<unknown> => {
    try {
      const found = await repo.findMany({
        where: [predicate],
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      return found.rows.map((row) => Number(row.id.slice(-1)));
    } catch (error: unknown) {
      return (error as { code?: unknown }).code;
    }
  };
  const both = async (predicate: Predicate): Promise<readonly unknown[]> => [
    await answer(memory, predicate),
    await answer(postgres, predicate),
  ];
  /** `values`, repeated past the bind budget: the list's length is the case, not its variety. */
  const past = (values: readonly unknown[]): unknown[] =>
    Array.from({ length: PAST }, (_, at) => values[at % values.length]);

  test('the list is long enough to cross as an array', () => {
    expect(PAST).toBeGreaterThan(IN_LIST_AS_ARRAY_FROM);
  });

  test.each([
    ['id', [idAt(0), idAt(2).toUpperCase(), 'nope'], [0, 2]],
    ['ref', [idAt(9), null], [1, 2]],
    ['label', ['a1', 'q"\\,{} NULL', ''], [1]],
    ['n', [1, '3', 40], [0, 2]],
    ['big', [9_200_000_000_000_000_001n, '9200000000000000002'], [1, 2]],
    ['rate', ['0.5', 1.5, '002.50'], [0, 1, 2]],
    ['flag', [false], [1]],
    ['at', [new Date(Date.UTC(2026, 1, 1)), '2026-03-01T00:00:00Z', '2026-01-01'], [0, 1, 2]],
    ['day', [new Date('2026-02-01T00:00:00Z'), '2026-03-01'], [1, 2]],
  ] as const)(
    'in over %s past the bind budget answers as the short list does',
    async (column, values, expected) => {
      expect(await both({ column, op: 'in', value: [...values] })).toEqual([expected, expected]);
      expect(await both({ column, op: 'in', value: past(values) })).toEqual([expected, expected]);
    },
  );

  test('text that is no uuid equals no row and is distinct from every row', async () => {
    expect(await both({ column: 'id', op: 'eq', value: 'nope' })).toEqual([[], []]);
    expect(await both({ column: 'id', op: 'eq', value: 5 })).toEqual([[], []]);
    expect(await both({ column: 'ref', op: 'neq', value: 'nope' })).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    expect(await both({ column: 'id', op: 'eq', value: `{${idAt(1)}}` })).toEqual([[1], [1]]);
    for (const repo of [memory, postgres]) expect(await repo.findById('nope')).toBeNull();
  });
});
