// Parity, without a server: `@ultimat3/entity`'s evaluator and this package's matcher and source
// answer every row of the one table as Postgres does. There used to be two comparators — entity's
// decided by the column's declared kind and this package's by `typeof` — and they disagreed on a
// `bigint()`, a `decimal()`, a `uuid` and a `timestamptz`, so a live window and the database
// returned one read in two orders. `compare-parity.live.test.ts` asks the database itself.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, compareByKind, sameValueOfKind } from '@ultimat3/entity';
import { kindsOf } from './column-kinds';
import {
  applied,
  declareParityEntity,
  PARITY,
  PARITY_PG_TYPE,
  PARITY_TABLE,
} from './compare-parity-fixture';
import type { ChangeEvent } from './matcher';
import { match } from './matcher';
import type { QueryShape } from './shape';
import { compareRows, matchesFilter } from './shape';
import { from } from './source';

type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

const shapeOn = (column: string, patch: Partial<QueryShape> = {}): QueryShape => ({
  entity: PARITY_TABLE,
  filters: [],
  orderBy: [{ column, direction: 'asc' }],
  limit: 50,
  unsupported: [],
  ...patch,
});

const insert = (row: Row): ChangeEvent<Row> => ({ entity: PARITY_TABLE, op: 'insert', row });

beforeAll(() => {
  declareParityEntity();
});

afterAll(() => {
  clearRegistry();
});

const label = (value: unknown): string =>
  value instanceof Date ? `Date(${value.toISOString()})` : `${typeof value} ${String(value)}`;

const cases = PARITY.map((entry) => ({
  ...entry,
  name: `${entry.kind}: ${label(entry.left)} vs ${label(entry.right)}`,
}));

test('every kind the table names is a column of the entity the reads resolve kinds from', () => {
  const kindOf = kindsOf(PARITY_TABLE);
  for (const kind of Object.keys(PARITY_PG_TYPE)) expect(kindOf(kind)).toBe(kind as never);
  expect([...new Set(PARITY.map((entry): string => entry.kind))].sort()).toEqual(
    Object.keys(PARITY_PG_TYPE).sort(),
  );
});

describe.each(cases)('$name', ({ kind, left, right, order, equal }) => {
  test('@ultimat3/entity orders and equates the pair as Postgres does', () => {
    expect(compareByKind(kind, left, right)).toBe(order);
    expect(compareByKind(kind, right, left)).toBe(-order || 0);
    expect(sameValueOfKind(kind, left, right)).toBe(equal);
  });

  test('this package’s row comparison and filter agree — they ARE that evaluator', () => {
    const kindOf = kindsOf(PARITY_TABLE);
    const by = [{ column: kind, direction: 'asc' as const }];
    expect(compareRows({ [kind]: left }, { [kind]: right }, by, kindOf)).toBe(order);
    expect(matchesFilter({ [kind]: left }, { column: kind, op: '=', value: right }, kindOf)).toBe(
      equal,
    );
    expect(matchesFilter({ [kind]: left }, { column: kind, op: '<', value: right }, kindOf)).toBe(
      order < 0,
    );
    expect(matchesFilter({ [kind]: left }, { column: kind, op: '>=', value: right }, kindOf)).toBe(
      order >= 0,
    );
  });

  test('the live matcher places and admits the row where the database would', () => {
    // `right` is the row the window already holds, with the LATER id — so a tie on the column
    // puts the new row first, exactly as `order by <column>, id` would.
    const held: Row = { id: 'z-held', [kind]: right };
    const incoming: Row = { id: 'a-new', [kind]: left };
    const placed = applied([held], match('parity', shapeOn(kind), [held], insert(incoming)));
    expect(placed.map((entry) => entry.id)).toEqual(
      order <= 0 ? ['a-new', 'z-held'] : ['z-held', 'a-new'],
    );

    const filtered = shapeOn(kind, { filters: [{ column: kind, op: '=', value: right }] });
    expect(match('parity', filtered, [], insert(incoming)).length > 0).toBe(equal);
  });

  test('the in-memory source sorts the pair into the same order', async () => {
    const rows: readonly Row[] = [
      { id: 'z-held', [kind]: right },
      { id: 'a-new', [kind]: left },
    ];
    const served = await from<Row>(PARITY_TABLE, rows).orderBy(kind).total().execute();
    expect(served.map((entry) => entry.id)).toEqual(
      order <= 0 ? ['a-new', 'z-held'] : ['z-held', 'a-new'],
    );
  });
});

describe('a live window ordered on a decimal-text column', () => {
  const ledger = (column: 'bigint' | 'numeric', values: readonly string[]): readonly Row[] =>
    values.map((value, index) => ({ id: `row-${String(index)}`, [column]: value }));

  test.each([
    ['bigint', ['9', '100', '10', '2', '-5'], ['-5', '2', '9', '10', '100']],
    ['numeric', ['9.5', '100', '10.25', '2.50', '-0.5'], ['-0.5', '2.50', '9.5', '10.25', '100']],
  ] as const)(
    '%s rows are patched in where `order by` returns them',
    (column, arriving, sorted) => {
      let window: readonly Row[] = [];
      for (const row of ledger(column, arriving)) {
        window = applied(window, match('ledger', shapeOn(column), window, insert(row)));
      }
      expect(window.map((row) => row[column])).toEqual([...sorted]);
    },
  );

  test('a relation no entity declares has no kinds, and its digits stay text', async () => {
    // The other half of the rule: Postgres orders a `text` column holding `'10'` and `'9'`
    // lexically, so a comparator GUESSING "these look numeric" would be wrong the other way.
    const served = await from<Row>('query_parity_undeclared', ledger('bigint', ['9', '10']))
      .orderBy('bigint')
      .total()
      .execute();
    expect(served.map((row) => row['bigint'])).toEqual(['10', '9']);
  });
});
