// Single responsibility: the foreign-key half of `checkDrift` — a key matched on where it points,
// and the `on delete` rule compared once both sides speak one vocabulary. Split from
// `drift.test.ts` for the file-size ceiling, along the seam `compareForeignKeys` already draws.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import type { SchemaDescription, TableDescription } from './introspect';

const table = (name: string, columns: readonly string[]): TableDescription => ({
  schema: 'public',
  name,
  columns: columns.map((column, index) => ({
    name: column,
    dataType: 'text',
    nullable: true,
    default: null,
    position: index + 1,
  })),
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
});

const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });

describe('a foreign key migrations declare, against the one the catalog holds', () => {
  const posts = table('posts', ['id', 'org_id']);
  const key = (
    overrides: Partial<TableDescription['foreignKeys'][number]> = {},
  ): TableDescription['foreignKeys'][number] => ({
    name: 'posts_org_id_fkey',
    columns: ['org_id'],
    referencedTable: 'orgs',
    referencedColumns: ['id'],
    onDelete: null,
    ...overrides,
  });
  const withKeys = (
    base: TableDescription,
    ...foreignKeys: TableDescription['foreignKeys']
  ): TableDescription => ({ ...base, foreignKeys });

  test('a key the migrations declare and the database does not have is drift', () => {
    const report = diffSchema(schema(posts), schema(withKeys(posts, key())));
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('missing-foreign-key');
    expect(report.differences[0]?.cause).toContain('no foreign key on (org_id) to "orgs" (id)');
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('a key repointed at another table is the declared one missing', () => {
    const live = schema(withKeys(posts, key({ referencedTable: 'tenants' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).differences[0]?.kind).toBe(
      'missing-foreign-key',
    );
  });

  test('a key repointed at another column is drift too', () => {
    const live = schema(withKeys(posts, key({ referencedColumns: ['slug'] })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(false);
  });

  test('the same key under another constraint name is not drift', () => {
    // Postgres names an inline clause `posts_org_id_fkey`; a hand-written migration may not.
    const live = schema(withKeys(posts, key({ name: 'fk_posts_org' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(true);
  });

  test('a cascade on the database under a key the snapshot declares no rule for is drift', () => {
    // `addForeignKey` spells the rule now, so a snapshot's `null` means "no rule was declared"
    // rather than "nothing was recorded" — and a cascade nobody declared deletes rows on a
    // delete the entity expects to be refused. Nothing compared it until 3.0.
    const live = schema(withKeys(posts, key({ onDelete: 'c' })));
    const report = diffSchema(live, schema(withKeys(posts, key())));
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('changed-foreign-key');
    expect(report.differences[0]?.cause).toContain('is on delete cascade');
  });

  test('a declared cascade the database dropped to no action is drift the other way', () => {
    const live = schema(withKeys(posts, key({ onDelete: 'a' })));
    const report = diffSchema(live, schema(withKeys(posts, key({ onDelete: 'cascade' }))));
    expect(report.differences[0]?.kind).toBe('changed-foreign-key');
    expect(report.differences[0]?.cause).toContain('declares no on delete rule');
    // Executable, and it is the pair: `add constraint` alone is `42710` on a name already taken.
    expect(report.differences[0]?.fix).toBe(
      'alter table "posts" drop constraint "posts_org_id_fkey"; ' +
        'alter table "posts" add constraint "posts_org_id_fkey" foreign key ("org_id") ' +
        'references "orgs" ("id") on delete cascade;   # in a new migration',
    );
  });

  test('the two spellings of one rule are not drift', () => {
    // The catalog answers `c` and a snapshot holds `cascade`; comparing the raw values would
    // report every declared rule in the framework as a difference.
    const live = schema(withKeys(posts, key({ onDelete: 'c' })));
    expect(diffSchema(live, schema(withKeys(posts, key({ onDelete: 'cascade' })))).ok).toBe(true);
  });

  test('the default Postgres records on every key is not a declared rule', () => {
    // `a` is `no action`, which is what a key with no clause has — reading it as a rule would
    // put one finding on every foreign key in a correct database.
    const live = schema(withKeys(posts, key({ onDelete: 'a' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(true);
  });

  test('a key the database has and no migration declares is not drift', () => {
    expect(diffSchema(schema(withKeys(posts, key())), schema(posts)).ok).toBe(true);
  });
});
