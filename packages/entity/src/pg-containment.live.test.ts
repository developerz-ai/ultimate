// `@>`, `<@`, `&&` and a JSON key test, against a real server AND against memory in the same
// assertion. A `json()` or `arrayOf()` column was declared, written and then unfilterable — the ten
// operators before these could compare a column to a scalar and nothing else — so every app with
// one had to leave the query language for hand-written SQL, which is the single read path in this
// framework with no tenancy guard on it.
//
// Both drivers in one file for the reason `pg-aggregate.live.test.ts` gives: containment has no
// statement TEXT worth asserting, and a recording client cannot compute the Postgres side. The
// corpus is deliberately adversarial — nested objects, arrays inside arrays, and the documented
// `'[1,2]' @> '2'` exception an implementation forgets first.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { arrayOf, json } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { countStatement } from './pg-sql';
import { planFor as buildPlan } from './plan';
import { clearRegistry } from './registry';
import type { Operator } from './tenancy';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

/**
 * Every member optional, so one schema covers a corpus whose rows deliberately hold DIFFERENT
 * keys — which is the whole point of a jsonb column and the thing a containment predicate is asked
 * about.
 */
const shape = t.object({
  a: t.optional(t.object({ b: t.number })),
  n: t.optional(t.number),
  list: t.optional(t.array(t.number)),
  extra: t.optional(t.boolean),
});

const docs = entity('pg_contain_docs', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 20 }),
    /** Nullable on both, because "a NULL matches no containment predicate" is one of the rules. */
    tags: arrayOf(text({ max: 20 })).nullable(),
    data: json(shape).nullable(),
  },
});

type Doc = typeof docs.$row;

const DROP = 'drop table if exists "pg_contain_docs" cascade';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000005${String(index).padStart(2, '0')}`;

const SEEDED: readonly Doc[] = [
  { id: id(1), label: 'a', tags: ['red', 'blue'], data: { a: { b: 1 }, n: 2 } },
  { id: id(2), label: 'b', tags: ['blue'], data: { a: { b: 2 } } },
  { id: id(3), label: 'c', tags: ['green', 'red'], data: { list: [1, 2, 3] } },
  { id: id(4), label: 'd', tags: [], data: { a: { b: 1 }, extra: true } },
];

describe.skipIf(!hasPostgres)('live · postgres · containment', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [docs.$describe()],
      name: 'live containment',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    await postgresRepo(docs).insertAll(SEEDED);
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  /** The labels each driver matches, which have to be the same labels in the same order. */
  const agrees = async (
    column: string,
    op: Operator,
    value: unknown,
    expected: readonly string[],
  ): Promise<void> => {
    const args = {
      where: [{ column, op, value }],
      orderBy: [{ column: 'label' as const, direction: 'asc' as const }],
      limit: 50,
    };
    const pg = (await postgresRepo(docs).findMany(args)).rows.map((row) => row.label);
    const memory = (await memoryRepo(docs, SEEDED).findMany(args)).rows.map((row) => row.label);
    expect(pg).toEqual([...expected]);
    expect(memory).toEqual([...expected]);
  };

  test('an array column contains every element asked for, in any order', async () => {
    await agrees('tags', 'contains', ['red'], ['a', 'c']);
    await agrees('tags', 'contains', ['red', 'blue'], ['a']);
    // An empty right-hand side is contained by every array, the empty one included.
    await agrees('tags', 'contains', [], ['a', 'b', 'c', 'd']);
  });

  test('contained-by is the same operator with the sides swapped', async () => {
    await agrees('tags', 'contained-by', ['red', 'blue', 'green'], ['a', 'b', 'c', 'd']);
    await agrees('tags', 'contained-by', ['blue'], ['b', 'd']);
  });

  test('overlaps is "shares at least one", never "contains all"', async () => {
    await agrees('tags', 'overlaps', ['red', 'purple'], ['a', 'c']);
    await agrees('tags', 'overlaps', ['purple'], []);
  });

  test('jsonb containment matches NESTED structure, which is what replaces a path language', async () => {
    await agrees('data', 'contains', { a: { b: 1 } }, ['a', 'd']);
    await agrees('data', 'contains', { a: {} }, ['a', 'b', 'd']);
    await agrees('data', 'contains', { n: 2 }, ['a']);
  });

  test('the array-contains-scalar exception is TOP LEVEL only, which is the half that is missed', async () => {
    // `'[1,2,3]'::jsonb @> '2'::jsonb` is true, and `'{"list":[1,2,3]}' @> '{"list":2}'` is FALSE —
    // Postgres does not apply that exception recursively. Measured on the server before this test
    // was written, and it caught an implementation here that did apply it recursively.
    await agrees('data', 'contains', { list: 2 }, []);
    await agrees('data', 'contains', { list: [3, 1] }, ['c']);
    await agrees('data', 'contains', { list: [] }, ['c']);
  });

  test('has-key tests a top-level key, and a number is not a key', async () => {
    await agrees('data', 'has-key', 'extra', ['d']);
    await agrees('data', 'has-key', 'a', ['a', 'b', 'd']);
    await agrees('data', 'has-key', 'missing', []);
  });

  test('a declared GIN index is the one the containment operators actually use', async () => {
    // The point of the whole feature: without an index every one of these is a sequential scan, so
    // "the operator exists" and "the operator is usable at scale" are two different claims. This
    // asserts the second one against the planner rather than assuming it.
    //
    // `enable_seqscan = off` because the corpus is four rows: this asks whether the index CAN
    // serve the operator, which is a property of the operator class, not whether it is cheapest
    // for a table this size.
    await client.execute(
      raw('create index pg_contain_tags on "pg_contain_docs" using gin ("tags")'),
    );
    await client.execute(
      raw('create index pg_contain_data on "pg_contain_docs" using gin ("data")'),
    );
    await client.execute(raw('analyze "pg_contain_docs"'));
    await client.execute(raw('set enable_seqscan = off'));

    /**
     * The driver's OWN statement, explained — not a hand-written lookalike. `countStatement` and
     * not `selectStatement`: a page carries `order by "id"` and a `limit`, and on a four-row table
     * the planner satisfies both by walking the primary key and filtering, whatever the predicate
     * could have used. A count has no ordering, so the only access-path decision left is the one
     * this test is about. Same `conditions()`, same operator, same binds.
     */
    const planFor = async (column: string, op: Operator, value: unknown): Promise<string> => {
      const statement = countStatement(
        docs,
        buildPlan(docs, { where: [{ column, op, value }], limit: 50 }),
        { includeDeleted: false },
      );
      const rows = await client.query<Record<string, string>>(
        sql`explain (costs off) ${statement}`,
      );
      return rows.map((row) => row['QUERY PLAN'] ?? '').join('\n');
    };

    // Array GIN serves all three, and jsonb GIN serves `@>` and `?`.
    expect(await planFor('tags', 'contains', ['red'])).toContain('pg_contain_tags');
    expect(await planFor('tags', 'contained-by', ['red', 'blue'])).toContain('pg_contain_tags');
    expect(await planFor('tags', 'overlaps', ['red'])).toContain('pg_contain_tags');
    expect(await planFor('data', 'contains', { a: { b: 1 } })).toContain('pg_contain_data');
    // `has-key` is the one that made the SQL move: `jsonb_exists(col, $1)` is the same test and is
    // not index-matched, because an index is matched against an operator expression and a bare
    // function call is not one.
    expect(await planFor('data', 'has-key', 'extra')).toContain('pg_contain_data');

    // And the one Postgres itself cannot index: `jsonb <@` is not in the default `jsonb_ops`
    // operator class, so it is a sequential scan whatever index is declared. Worth pinning so a
    // reader is not left guessing whether it is this package's doing.
    expect(await planFor('data', 'contained-by', { a: { b: 1 } })).toContain('Seq Scan');

    await client.execute(raw('set enable_seqscan = on'));
    await client.execute(raw('drop index pg_contain_tags, pg_contain_data'));
  });

  test('a NULL column value matches no containment predicate, in either driver', async () => {
    await postgresRepo(docs).insert({ id: id(9), label: 'z', tags: null, data: null });
    const withNull: readonly Doc[] = [...SEEDED, { id: id(9), label: 'z', tags: null, data: null }];
    for (const op of ['contains', 'contained-by', 'overlaps'] as const) {
      const args = { where: [{ column: 'tags', op, value: ['red'] }], limit: 50 };
      expect((await postgresRepo(docs).findMany(args)).rows.some((row) => row.label === 'z')).toBe(
        false,
      );
      expect(
        (await memoryRepo(docs, withNull).findMany(args)).rows.some((row) => row.label === 'z'),
      ).toBe(false);
    }
    await client.execute(raw(`delete from "pg_contain_docs" where "id" = '${id(9)}'`));
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
