// Single responsibility: a many-row insert's `(…), (…)` list, compiled in ONE `sql` call. The
// obvious spelling — a fragment per cell, joined per row, joined per chunk — builds and renders
// four nested fragments per value, and at 100k rows that was the larger half of `insertAll`'s time
// spent in JavaScript (measured 2026-11-11: 180 ms vs 60-120 ms per 16k-row chunk).

import { type SqlFragment, sql } from '@ultimat3/db';

/**
 * The text between two bound values. Every one is a constant of this file — punctuation, the
 * `default` keyword and the `jsonb` cast — and never derived from a value or a name, so the
 * template this builds is the template a hand-written `sql` call with that many holes would be.
 * The `default` cell is what makes a row inside a many-row `insert` mean what the same row means
 * on its own, where an unnamed column is simply left out.
 */
const OPEN = '(';
const NEXT_CELL = ', ';
const NEXT_ROW = '), (';
const CLOSE = ')';
const DEFAULT_CELL = 'default';
/** Why `::text::jsonb` and never `::jsonb`: `pg-write-sql.ts`, above `jsonColumns`. */
const JSON_CAST = '::text::jsonb';

/** `strings` as the tagged-template argument `sql` reads: it reads `strings[i]` and nothing else. */
const template = (strings: string[]): TemplateStringsArray =>
  Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;

/**
 * `(a, b), (c, default)` for `rows` over `columns`: a value bound where the row names the column, a
 * `default` cell where it does not, and a `jsonb` column's value cast from its text.
 */
export const valuesList = (
  json: ReadonlySet<string>,
  columns: readonly string[],
  rows: readonly ReadonlyMap<string, unknown>[],
): SqlFragment => {
  const strings: string[] = [OPEN];
  const values: unknown[] = [];
  let tail = OPEN;
  for (const [index, row] of rows.entries()) {
    if (index > 0) tail += NEXT_ROW;
    for (const [position, column] of columns.entries()) {
      if (position > 0) tail += NEXT_CELL;
      if (!row.has(column)) {
        tail += DEFAULT_CELL;
        continue;
      }
      strings[strings.length - 1] = tail;
      values.push(row.get(column));
      tail = json.has(column) ? JSON_CAST : '';
      strings.push(tail);
    }
  }
  strings[strings.length - 1] = tail + CLOSE;
  return sql(template(strings), ...values);
};
