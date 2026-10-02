// Parity, against Postgres itself. `compare-parity.test.ts` holds both JS evaluators to the
// table's `order` and `equal` columns; this is what holds those columns to the database — and
// what shows a live window ordered on a `bigint()` or `decimal()` column the order a real
// `order by` returns. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry } from '@ultimat3/entity';
import { SQL } from 'bun';
import {
  applied,
  declareParityEntity,
  PARITY,
  PARITY_PG_TYPE,
  PARITY_TABLE,
} from './compare-parity-fixture';
import { match } from './matcher';
import type { QueryShape } from './shape';
import { from } from './source';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/** A parameter as the text Postgres parses for the cast beside it. */
const wire = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

interface Ledger {
  readonly id: string;
  readonly bigint: string | null;
  readonly numeric: string | null;
}

/** Values chosen so text order, numeric order and insertion order are three different orders. */
const SEEDED: readonly (readonly [string, string | null, string | null])[] = [
  ['a', '9', '9.5'],
  ['b', '100', '100'],
  ['c', '10', '10.25'],
  ['d', null, null],
  ['e', '2', '2.50'],
  ['f', '-5', '-0.5'],
  ['g', '10', '2.5'],
  ['h', '9007199254740993', '9007199254740992.0001'],
];

describe.skipIf(!hasPostgres)('live · postgres · one comparison, three readers', () => {
  let sql: SQL;

  beforeAll(async () => {
    declareParityEntity();
    sql = new SQL(url ?? '');
    await sql.unsafe(`drop table if exists "${PARITY_TABLE}"`);
    await sql.unsafe(
      `create table "${PARITY_TABLE}" ("id" text primary key, "bigint" bigint, "numeric" numeric(24, 4))`,
    );
    for (const [id, big, numeric] of SEEDED) {
      await sql.unsafe(`insert into "${PARITY_TABLE}" values ($1, $2::bigint, $3::numeric)`, [
        id,
        big,
        numeric,
      ]);
    }
  });

  afterAll(async () => {
    await sql.unsafe(`drop table if exists "${PARITY_TABLE}"`);
    await sql.close();
    clearRegistry();
  });

  test('Postgres answers every row of the parity table as the table says', async () => {
    for (const { kind, left, right, order, equal } of PARITY) {
      const type = PARITY_PG_TYPE[kind];
      if (type === undefined) return expect.unreachable(`no Postgres type for ${kind}`);
      const [answer] = await sql.unsafe(
        `select case when $1::${type} < $2::${type} then -1 when $1::${type} > $2::${type} then 1 else 0 end as "order", ($1::${type} = $2::${type}) as "equal"`,
        [wire(left), wire(right)],
      );
      expect({ kind, left, right, order: answer.order, equal: answer.equal }).toEqual({
        kind,
        left,
        right,
        order,
        equal,
      });
    }
  });

  /** The rows as a repository hands them back: a `bigint()` and a `decimal()` are decimal TEXT. */
  const stored = async (): Promise<readonly Ledger[]> =>
    sql.unsafe(
      `select "id", "bigint"::text as "bigint", "numeric"::text as "numeric" from "${PARITY_TABLE}" order by "id"`,
    );

  const databaseOrder = async (column: string, direction: 'asc' | 'desc'): Promise<string[]> => {
    const nulls = direction === 'asc' ? 'nulls last' : 'nulls first';
    const rows: readonly Ledger[] = await sql.unsafe(
      `select "id" from "${PARITY_TABLE}" order by "${column}" ${direction} ${nulls}, "id" asc`,
    );
    return rows.map((row) => row.id);
  };

  describe.each([
    ['bigint', 'asc'],
    ['bigint', 'desc'],
    ['numeric', 'asc'],
    ['numeric', 'desc'],
  ] as const)('ordered on %s %s', (column, direction) => {
    const shape: QueryShape = {
      entity: PARITY_TABLE,
      filters: [],
      orderBy: [{ column, direction }],
      limit: 50,
      unsupported: [],
    };

    test('a live window patches each row in where the database returns it', async () => {
      let window: readonly Ledger[] = [];
      for (const row of await stored()) {
        const event = { entity: PARITY_TABLE, op: 'insert' as const, row };
        window = applied(window, match('ledger', shape, window, event));
      }
      expect(window.map((row) => row.id)).toEqual(await databaseOrder(column, direction));
    });

    test('the in-memory source serves the same order, and pages it at the same boundaries', async () => {
      const rows = await stored();
      const served = await from<Ledger>(PARITY_TABLE, rows)
        .orderBy(column, direction)
        .total()
        .execute();
      const expected = await databaseOrder(column, direction);
      expect(served.map((row) => row.id)).toEqual(expected);

      const cut = served[2];
      if (cut === undefined) return expect.unreachable('the fixture holds more than three rows');
      const after = await from<Ledger>(PARITY_TABLE, rows)
        .orderBy(column, direction)
        .seek({ key: [cut[column]], id: cut.id }, 50)
        .execute();
      expect(after.map((row) => row.id)).toEqual(expected.slice(3));
    });
  });
});
