// Single responsibility: a changed `primaryKey` on a table that already exists. The diff had no arm
// for it, so `x db gen` wrote NO statement while the snapshot beside it recorded the new key — and
// an empty `up` is what `@ultimat3/cli` reads as "nothing changed". Applied to a real server in
// `generate-primary-key.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const posts = (primaryKey: readonly string[], columns = ['id', 'slug']): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey,
  columns: columns.map((name) => column(name, { primaryKey: primaryKey.includes(name) })),
  indexes: [],
});

const comments: EntityDescriptionLike = {
  name: 'Comment',
  table: 'comments',
  primaryKey: ['id'],
  columns: [column('id', { primaryKey: true }), column('post_id', { references: 'posts.id' })],
  indexes: [],
};

const NOW = new Date('2026-10-02T00:00:00.000Z');
const generate = (
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
  allowDestructive = false,
) => generateMigration({ entities, current, name: 'rekey', now: NOW, allowDestructive });

const DROP = 'alter table "posts" drop constraint if exists "posts_pkey";';
const add = (columns: string): string =>
  `alter table "posts" add constraint "posts_pkey" primary key (${columns});`;

describe('a changed primary key', () => {
  test('is a drop and an add, reversed in down, and the snapshot records what up produced', () => {
    const migration = generate([posts(['slug'])], snapshotOf([posts(['id'])]));
    expect(migration.up.split('\n')).toEqual([DROP, add('"slug"')]);
    expect(migration.down.split('\n')).toEqual([DROP, add('"id"')]);
    expect(migration.snapshot.tables[0]?.primaryKey).toEqual(['slug']);
  });

  test('column ORDER is part of the key: (a, b) to (b, a) is a change', () => {
    const migration = generate([posts(['slug', 'id'])], snapshotOf([posts(['id', 'slug'])]));
    expect(migration.up.split('\n')).toEqual([DROP, add('"slug", "id"')]);
  });

  test('an unchanged key emits nothing', () => {
    expect(generate([posts(['id'])], snapshotOf([posts(['id'])])).up).toBe('');
  });

  test('a key column added by the same migration exists before the key is', () => {
    const migration = generate(
      [posts(['id', 'org_id'], ['id', 'slug', 'org_id'])],
      snapshotOf([posts(['id'])]),
    );
    const up = migration.up.split('\n');
    expect(up[0]).toBe(DROP);
    expect(up.at(-1)).toBe(add('"id", "org_id"'));
    expect(up.findIndex((line) => line.includes('add column "org_id"'))).toBeGreaterThan(0);
  });

  test('a key column dropped by the same migration goes before the new key is added', () => {
    const migration = generate(
      [posts(['id'], ['id', 'slug'])],
      snapshotOf([posts(['id', 'org_id'], ['id', 'slug', 'org_id'])]),
      true,
    );
    expect(migration.up.split('\n')).toEqual([
      DROP,
      'alter table "posts" drop column "org_id";',
      add('"id"'),
    ]);
    // Reversed: the column is back before the two-column key is asked for again.
    expect(migration.down.split('\n')).toEqual([
      DROP,
      'alter table "posts" add column "org_id" text; -- data is not restored',
      add('"id", "org_id"'),
    ]);
  });

  test('a table gaining its first key only adds, and one losing its key only drops', () => {
    expect(generate([posts(['id'])], snapshotOf([posts([])])).up).toBe(add('"id"'));
    expect(generate([posts([])], snapshotOf([posts(['id'])])).up).toBe(DROP);
  });

  test('a key another table references is refused, naming the constraints in the way', () => {
    const current = snapshotOf([posts(['id']), comments]);
    let thrown: { code?: string; cause?: string; fix?: string } | undefined;
    try {
      generate([posts(['slug']), comments], current);
      expect.unreachable('a key with an inbound foreign key was regenerated');
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown?.code).toBe('X_MIGRATION_IRREVERSIBLE');
    expect(thrown?.cause).toContain('comments_post_id_fkey');
    expect(thrown?.fix).toContain('x db gen');
  });
});
