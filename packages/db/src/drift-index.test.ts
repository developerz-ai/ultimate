// Single responsibility: `diffSchema`'s index comparison — the three parts that ARE compared
// (columns in key order, uniqueness, partiality and direction) and the one that never is, the
// predicate's text, which the catalog rewrites into a spelling no snapshot can equal.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import { schema, table } from './drift-fixtures';
import type { TableDescription } from './introspect';

const index = (
  name: string,
  columns: readonly string[],
  unique = false,
): TableDescription['indexes'][number] => ({
  name,
  columns,
  unique,
  primary: false,
  where: null,
  order: null,
});

const withIndexes = (
  base: TableDescription,
  ...indexes: TableDescription['indexes']
): TableDescription => ({ ...base, indexes });

describe('an index migrations declare, against the one the catalog holds', () => {
  const posts = table('posts', ['id', 'org_id', 'created_at']);
  const declared = index('posts_org_id_created_at_idx', ['org_id', 'created_at']);

  test('a composite index rebuilt the other way round is drift, not a clean schema', () => {
    const live = schema(withIndexes(posts, index(declared.name, ['created_at', 'org_id'])));
    const report = diffSchema(live, schema(withIndexes(posts, declared)));
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('changed-index');
    expect(report.differences[0]?.cause).toContain('covers (created_at, org_id)');
  });

  test('an index the migrations declare and the database does not have is drift', () => {
    const report = diffSchema(schema(posts), schema(withIndexes(posts, declared)));
    expect(report.differences[0]?.kind).toBe('missing-index');
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('uniqueness dropped underneath a declared index is drift', () => {
    const live = schema(withIndexes(posts, index(declared.name, declared.columns, false)));
    const report = diffSchema(live, schema(withIndexes(posts, { ...declared, unique: true })));
    expect(report.differences[0]?.cause).toContain('is not unique');
  });

  test('an index the database has and no migration declares is not drift', () => {
    // Every primary key and every unique constraint brings one, declared by no migration.
    const live = schema(withIndexes(posts, index('posts_pkey', ['id'], true)));
    expect(diffSchema(live, schema(posts)).ok).toBe(true);
  });

  test('two spellings of one predicate are not drift — the text is never compared', () => {
    // The catalog rewrites a predicate into its own spelling, so comparing the text would report
    // two identical indexes as drift. `x db gen` compares them, where both sides are generated.
    const live = schema(withIndexes(posts, { ...declared, where: '(deleted_at IS NULL)' }));
    const expected = schema(withIndexes(posts, { ...declared, where: '"deleted_at" is null' }));
    expect(diffSchema(live, expected).ok).toBe(true);
  });

  test('a desc index rebuilt ascending by hand is drift', () => {
    // Structured on both sides — `'asc' | 'desc' | null` — so it is comparable where the
    // predicate's text is not, and a feed's newest page reads off the wrong end of the index.
    const live = schema(withIndexes(posts, { ...declared, order: null }));
    const report = diffSchema(live, schema(withIndexes(posts, { ...declared, order: 'desc' })));
    expect(report.differences[0]?.kind).toBe('changed-index');
    expect(report.differences[0]?.cause).toContain('is ascending');
  });

  test('`asc` and `null` are one direction, so a declared asc is not drift', () => {
    // `createIndex` emits `"col" asc`, which Postgres stores as not-descending — i.e. `null` on
    // the catalog side. Comparing the raw values reports every ascending index as drift.
    const live = schema(withIndexes(posts, { ...declared, order: null }));
    expect(diffSchema(live, schema(withIndexes(posts, { ...declared, order: 'asc' }))).ok).toBe(
      true,
    );
  });

  test('a partial index recreated as a total one is drift, whatever the predicate says', () => {
    // Presence is a boolean; only the text is uncomparable. A partial unique index rebuilt total
    // refuses rows the entity allows, and the reverse silently widens the constraint.
    const live = schema(withIndexes(posts, { ...declared, where: null }));
    const expected = schema(withIndexes(posts, { ...declared, where: 'deleted_at is null' }));
    const report = diffSchema(live, expected);
    expect(report.differences[0]?.kind).toBe('changed-index');
    expect(report.differences[0]?.cause).toContain('covers every row');
  });

  test('a total index narrowed to a predicate on the database is drift too', () => {
    const live = schema(withIndexes(posts, { ...declared, where: '(deleted_at IS NULL)' }));
    const report = diffSchema(live, schema(withIndexes(posts, { ...declared, where: null })));
    expect(report.differences[0]?.cause).toContain('is partial');
  });
});
