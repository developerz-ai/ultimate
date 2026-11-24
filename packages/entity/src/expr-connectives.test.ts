// `allOf(...)` and `anyOf(...)`: a rule or an index predicate over several conditions at once —
// "both null", "at most one set". One corpus judged twice, by `holds` in the app and by the
// migration's CHECK on PGlite, in SQL's three values; and a partial index built from one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, sql, sqlState, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { invariantColumns } from './expr';
import { allOf, anyOf } from './expr-connectives';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const AT = '2026-11-24T00:00:00.000Z';

const slots = entity('connective_slots', {
  columns: {
    id: uuid().primaryKey(),
    a: text({ max: 20 }).nullable(),
    b: text({ max: 20 }).nullable(),
    n: integer().nullable(),
  },
  invariants: (c) => [
    // At most one of the two is set.
    invariant('a_or_b_unset', anyOf(c.a.isNull(), c.b.isNull())),
    // A count, when there is one, is non-negative AND below the ceiling — unknown on NULL.
    invariant('n_in_range', allOf(c.n.atLeast(0), anyOf(c.n.eq(1), c.n.eq(2), c.n.eq(3)))),
  ],
  indexes: [{ on: ['id'], where: (c) => allOf(c.a.isNull(), c.b.isNull()) }],
});

type Slot = { readonly a: string | null; readonly b: string | null; readonly n: number | null };

const CORPUS: readonly (readonly [string, Slot, boolean])[] = [
  ['neither set', { a: null, b: null, n: 1 }, true],
  ['a alone', { a: 'x', b: null, n: 2 }, true],
  ['b alone', { a: null, b: 'y', n: 3 }, true],
  ['both set', { a: 'x', b: 'y', n: 1 }, false],
  ['n unknown passes, as a CHECK passes it', { a: null, b: null, n: null }, true],
  ['n negative', { a: null, b: null, n: -1 }, false],
  ['n outside every allowed value', { a: null, b: null, n: 4 }, false],
];

const client = pgliteClient();

beforeAll(async () => {
  const migration = generateMigration({
    entities: [slots.$describe()],
    name: 'connectives',
    now: new Date(AT),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, 30_000);

afterAll(async () => {
  await client.close();
  clearRegistry();
});

const stored = (slot: Slot): Promise<boolean> =>
  client
    .execute(
      sql`insert into "connective_slots" (id, a, b, n) values (gen_random_uuid(), ${slot.a}, ${slot.b}, ${slot.n})`,
    )
    .then(
      () => true,
      (error: unknown) => (sqlState(error) === '23514' ? false : Promise.reject(error)),
    );

const accepted = (slot: Slot): boolean =>
  slots.$invariants.every((rule) => rule.holds({ id: 'x', ...slot }));

describe('allOf / anyOf', () => {
  test('the app and the CHECK agree on every row, in three values', async () => {
    const verdicts: (readonly [string, boolean, boolean, boolean])[] = [];
    for (const [label, slot, expected] of CORPUS) {
      verdicts.push([label, expected, accepted(slot), await stored(slot)]);
    }
    expect(
      verdicts.filter(([, expected, app, check]) => app !== expected || check !== expected),
    ).toEqual([]);
  });

  test('the SQL is the parenthesised conjunction and disjunction', () => {
    const rules = Object.fromEntries(slots.$invariants.map((rule) => [rule.name, rule.sql]));
    expect(rules['a_or_b_unset']).toBe('(a is null) or (b is null)');
    expect(rules['n_in_range']).toBe('(n >= 0) and ((n = 1) or (n = 2) or (n = 3))');
  });

  test('an index predicate over two columns at once is a partial index', async () => {
    const declared = slots.$describe().indexes.find((index) => index.where !== undefined);
    expect(declared?.where).toBe('(a is null) and (b is null)');
    const [row] = await client.query<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'connective_slots' and indexdef like '%WHERE%'`,
    );
    expect(row?.indexdef).toContain('WHERE ((a IS NULL) AND (b IS NULL))');
  });

  test('an app-only operand makes the whole rule app-only, never half of it', () => {
    const only = entity('connective_app_only', {
      columns: { id: uuid().primaryKey(), a: text({ max: 20 }) },
      invariants: (c) => [
        invariant(
          'a_rule',
          anyOf(
            c.a.isNull(),
            c.a.matches((value) => value.length > 1),
          ),
        ),
      ],
    });
    expect(only.$invariants[0]?.sql).toBeNull();
    expect(only.$invariants[0]?.holds({ id: 'x', a: 'xy' })).toBe(true);
    expect(only.$invariants[0]?.holds({ id: 'x', a: 'x' })).toBe(false);
  });

  const c = invariantColumns('connective_refusals', {
    id: uuid().primaryKey(),
    a: text({ max: 20 }).nullable(),
    b: text({ max: 20 }).nullable(),
  });

  test.each([
    ['one operand', () => allOf(c.a.isNull())],
    ['a unique operand', () => anyOf(c.unique(['a']), c.b.isNull())],
  ])('%s is refused at declaration', (_label, build) => {
    try {
      build();
    } catch (error) {
      expect(isUltimateError(error) ? error.code : String(error)).toBe('X_INVARIANT_VIOLATED');
      return;
    }
    expect.unreachable('the connective was accepted');
  });
});
