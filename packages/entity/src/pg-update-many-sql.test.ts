// The statement an `updateMany` batch compiles to. The text is the claim: one `update … from`
// per bind-count chunk, the source typed by the table itself, the address and the tenant scope in
// the `where`, and `returning` only when asked. The server's half is the `.live.` file beside it.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { integer, money, text, timestamp, uuid } from './columns';
import { json } from './columns-data';
import { entity } from './entity';
import { updateManyStatements } from './pg-update-many-sql';
import { clearRegistry } from './registry';
import { updateManyPlan } from './update-many';

const notes = entity('um_sql_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    excerpt: text().nullable(),
    meta: json(t.object({ a: t.number })).nullable(),
    price: money().nullable(),
    rank: integer().default(0),
    deletedAt: timestamp().nullable(),
  },
});

afterAll(() => clearRegistry());

const ORG = '00000000-0000-7000-8000-000000000900';
const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const inTenant = <T>(work: () => T): T =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: ORG }) }), work);

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const compile = (
  patches: readonly { id: string; patch: Record<string, unknown> }[],
  returning = false,
) =>
  inTenant(() => updateManyStatements(notes, updateManyPlan(notes, patches, undefined), returning));

describe('updateManyStatements', () => {
  test('two rows are one statement: source typed by the table, joined on the key, scoped', () => {
    const [statement, extra] = compile([
      { id: idAt(1), patch: { excerpt: 'one', rank: 1 } },
      { id: idAt(2), patch: { excerpt: 'two', rank: 2 } },
    ]);
    expect(extra).toBeUndefined();
    expect(squash(statement?.text ?? '')).toBe(
      'update "um_sql_notes" set "excerpt" = "v"."C0$UM", "rank" = "v"."C1$UM" from (' +
        'select "id" as "K$UM", "excerpt" as "C0$UM", "rank" as "C1$UM" from "um_sql_notes" where false' +
        ' union all select $1, $2, $3 union all select $4, $5, $6) as "v"' +
        ' where "um_sql_notes"."id" = "v"."K$UM" and "org_id" = $7 and "deleted_at" is null',
    );
    expect(statement?.values).toEqual([idAt(1), 'one', 1, idAt(2), 'two', 2, ORG]);
  });

  test('returning hands back the TABLE row, not the source columns beside it', () => {
    const [statement] = compile([{ id: idAt(1), patch: { rank: 1 } }], true);
    expect(statement?.text).toEndWith(' returning "um_sql_notes".*');
    const [counted] = compile([{ id: idAt(1), patch: { rank: 1 } }]);
    expect(counted?.text).not.toContain('returning');
  });

  test('a jsonb cell is cast through text, so an object is stored as one', () => {
    const [statement] = compile([{ id: idAt(1), patch: { meta: { a: 1 } } }]);
    expect(squash(statement?.text ?? '')).toContain('union all select $1, $2::text::jsonb)');
  });

  test('money is its physical columns, every one of them in every row', () => {
    const [statement] = compile([
      { id: idAt(1), patch: { price: { minor: 100, currency: 'EUR' } } },
      { id: idAt(2), patch: { price: null } },
    ]);
    const text = squash(statement?.text ?? '');
    expect(text).toContain('"price_minor" = "v"."C0$UM", "price_currency" = "v"."C1$UM"');
    expect(statement?.values.slice(0, 8)).toEqual([
      idAt(1),
      100,
      'EUR',
      null,
      idAt(2),
      null,
      null,
      null,
    ]);
  });

  test('1,000 rows is one statement', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: idAt(index),
      patch: { excerpt: `e${index}` },
    }));
    expect(compile(rows)).toHaveLength(1);
  });

  test('a batch past the bind ceiling is split, every chunk inside it', () => {
    const width = 3;
    // The tenant's bind rides on every statement, so it comes out of the budget first.
    const perStatement = Math.floor((MAX_BIND_PARAMETERS - 1) / width);
    const rows = Array.from({ length: perStatement + 1 }, (_, index) => ({
      id: idAt(index),
      patch: { excerpt: 'e', rank: index },
    }));
    const statements = compile(rows);
    expect(statements).toHaveLength(2);
    expect(statements.map((each) => each.values.length)).toEqual([perStatement * width + 1, 4]);
    for (const each of statements)
      expect(each.values.length).toBeLessThanOrEqual(MAX_BIND_PARAMETERS);
  });

  test('no rows is no statement', () => {
    expect(compile([])).toEqual([]);
  });
});
