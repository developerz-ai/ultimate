// `valuesList` is a faster spelling of the nested one — a fragment per cell, joined per row and per
// chunk — so the claim is identity: the same text, the same values in the same order, for every
// mix of bound, `default` and `jsonb` cells.

import { describe, expect, test } from 'bun:test';
import { join, raw, type SqlFragment, sql } from '@ultimat3/db';
import { valuesList } from './pg-values-list';

/** The spelling `insertStatement` used before, kept here as the reference it must equal. */
const nested = (
  json: ReadonlySet<string>,
  columns: readonly string[],
  rows: readonly ReadonlyMap<string, unknown>[],
): SqlFragment =>
  join(
    rows.map(
      (row) =>
        sql`(${join(
          columns.map((column) =>
            !row.has(column)
              ? raw('default')
              : json.has(column)
                ? sql`${row.get(column)}${raw('::text::jsonb')}`
                : sql`${row.get(column)}`,
          ),
        )})`,
    ),
  );

const row = (entries: readonly (readonly [string, unknown])[]) => new Map(entries);

describe('valuesList', () => {
  const columns = ['id', 'doc', 'note'];
  const json = new Set(['doc']);
  const cases: Record<string, readonly ReadonlyMap<string, unknown>[]> = {
    'one whole row': [
      row([
        ['id', 1],
        ['doc', '{}'],
        ['note', 'n'],
      ]),
    ],
    'a default first, a default last, a default between': [
      row([
        ['doc', '{"a":1}'],
        ['note', null],
      ]),
      row([
        ['id', 2],
        ['doc', 'null'],
      ]),
      row([
        ['id', 3],
        ['note', 'x'],
      ]),
    ],
    'a row naming nothing': [row([]), row([['id', 4]])],
  };

  for (const [name, rows] of Object.entries(cases)) {
    test(`${name}: the nested spelling's text and values`, () => {
      const flat = valuesList(json, columns, rows);
      const reference = nested(json, columns, rows);
      expect(flat.text).toBe(reference.text);
      expect(flat.values).toEqual(reference.values);
    });
  }

  test('nests into a statement and renumbers like any fragment', () => {
    const list = valuesList(json, ['id'], [row([['id', 7]]), row([['id', 8]])]);
    const statement = sql`insert into t (id) values ${list} returning ${9}`;
    expect(statement.text).toBe('insert into t (id) values ($1), ($2) returning $3');
    expect(statement.values).toEqual([7, 8, 9]);
  });
});
