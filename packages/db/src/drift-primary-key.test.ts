// Single responsibility: what `diffSchema` reports when the two sides disagree about a table's
// PRIMARY KEY. `compareTable` skipped nullability for the union of both keys "because the key
// comparison owns it" — and there was no key comparison, so a re-keyed table read `ok: true`.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import { schema, table } from './drift-fixture';
import type { TableDescription } from './introspect';

const keyed = (
  primaryKey: readonly string[],
  overrides: Partial<TableDescription> = {},
): TableDescription => ({
  ...table('posts', ['id', 'slug']),
  primaryKey,
  ...overrides,
});

/** The live side as `introspect()` answers it: the key is the primary index's columns. */
const held = (primaryKey: readonly string[], name = 'posts_pkey'): TableDescription =>
  keyed(primaryKey, {
    indexes:
      primaryKey.length === 0
        ? []
        : [{ name, columns: primaryKey, unique: true, primary: true, where: null, order: null }],
  });

const kinds = (live: TableDescription, expected: TableDescription): readonly string[] =>
  diffSchema(schema(live), schema(expected)).differences.map((difference) => difference.kind);

describe('drift · primary key', () => {
  test('the same key on both sides is no difference', () => {
    expect(diffSchema(schema(held(['id'])), schema(keyed(['id']))).ok).toBe(true);
  });

  test('a different key is reported, and its fix is the drop/add pair', () => {
    const report = diffSchema(schema(held(['id'])), schema(keyed(['slug'])));
    expect(report.ok).toBe(false);
    const difference = report.differences.find((entry) => entry.kind === 'changed-primary-key');
    expect(difference?.table).toBe('posts');
    expect(difference?.cause).toBe(
      'table "posts" has primary key (id) as constraint "posts_pkey", and migrations declare (slug)',
    );
    // ONE command a shell runs: the pair is psql's argument, never bare DDL beside a `#`.
    expect(difference?.fix).toBe(
      `psql "$DATABASE_URL" -c 'alter table "posts" drop constraint "posts_pkey"; alter table ` +
        `"posts" add constraint "posts_pkey" primary key ("slug");'   # then x db migrate, which re-checks`,
    );
  });

  test('the constraint dropped is the one the DATABASE holds, whatever it was named', () => {
    const report = diffSchema(schema(held(['id'], 'legacy_pk')), schema(keyed(['slug'])));
    expect(report.differences[0]?.fix).toContain('drop constraint "legacy_pk";');
  });

  test('a key the database lacks altogether is reported, with only the add', () => {
    const report = diffSchema(schema(held([])), schema(keyed(['id'])));
    expect(report.differences.map((entry) => entry.kind)).toEqual(['changed-primary-key']);
    expect(report.differences[0]?.cause).toBe(
      'table "posts" has no primary key, and migrations declare (id)',
    );
    expect(report.differences[0]?.fix).toBe(
      `psql "$DATABASE_URL" -c 'alter table "posts" add constraint "posts_pkey" primary key ("id");'   # then x db migrate, which re-checks`,
    );
  });

  test('column order is the key: (id, slug) is not (slug, id)', () => {
    expect(kinds(held(['id', 'slug']), keyed(['slug', 'id']))).toEqual(['changed-primary-key']);
  });

  test('a name no statement can spell degrades the fix to prose, never to SQL', () => {
    const report = diffSchema(schema(held(['id'], 'pk`rm -rf`')), schema(keyed(['slug'])));
    expect(report.differences[0]?.fix).not.toContain('`');
    expect(report.differences[0]?.fix).not.toContain('alter table');
    // Prose still leads with a command that runs.
    expect(report.differences[0]?.fix).toStartWith('psql "$DATABASE_URL"');
    // And the finding still NAMES the constraint it could not spell — in the cause, never the fix.
    expect(report.differences[0]?.cause).toContain('as constraint "pk`rm -rf`"');
  });

  test("a ' in a name cannot close the shell word the statements ride in", () => {
    const report = diffSchema(schema(held(['id'], "o'pk")), schema(keyed(['slug'])));
    expect(report.differences[0]?.fix).toContain(`drop constraint "o'\\''pk";`);
  });

  // Postgres forces NOT NULL onto a key column, so only the DECLARED key excuses a nullable
  // spelling. A column the database alone keys is a second, separate fault: dropping the stray
  // constraint leaves it NOT NULL.
  test('nullability is skipped for the declared key only', () => {
    const notNull = (
      description: TableDescription,
      columns: readonly string[],
    ): TableDescription => ({
      ...description,
      columns: description.columns.map((column) =>
        columns.includes(column.name) ? { ...column, nullable: false } : column,
      ),
    });
    // Live keys `id` (so NOT NULL); migrations key `slug` and declare `id` nullable.
    expect(kinds(notNull(held(['id']), ['id']), keyed(['slug']))).toEqual([
      'changed-column',
      'changed-primary-key',
    ]);
    // The declared key's own column: the catalog's NOT NULL is the key's doing, and not drift.
    expect(kinds(notNull(held(['slug']), ['slug']), keyed(['slug']))).toEqual([]);
  });
});
