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

const posts = (
  primaryKey: readonly string[],
  columns = ['id', 'slug'],
  overrides: Readonly<Record<string, Partial<ColumnDescriptionLike>>> = {},
): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey,
  columns: columns.map((name) =>
    column(name, { primaryKey: primaryKey.includes(name), ...overrides[name] }),
  ),
  indexes: [],
});

const refusal = (run: () => unknown): { code?: string; cause?: string; fix?: string } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
  return expect.unreachable('the key change was generated');
};

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

  test('a key column added by the same migration, WITH a default, exists before the key is', () => {
    const filled = {
      org_id: { hasDefault: true, default: { kind: 'value', value: 'acme' } },
    } as const;
    const migration = generate(
      [posts(['id', 'org_id'], ['id', 'slug', 'org_id'], filled)],
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
    // Reversed — and the old key is NOT asked for again: `org_id` comes back empty, so `add
    // primary key` over it fails on every populated table. Named as the follow-up instead.
    expect(migration.down.split('\n')).toEqual([
      DROP,
      'alter table "posts" add column "org_id" text; -- data is not restored',
      `-- backfill "org_id", then: ${add('"id", "org_id"')}`,
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

  // `add column` with no default lands NULL in every existing row, and a primary key refuses a
  // NULL: the generated `up` could not apply to any table holding a row.
  test('a key over a column this migration adds with no default is refused, naming the two steps', () => {
    const thrown = refusal(() =>
      generate([posts(['id', 'org_id'], ['id', 'slug', 'org_id'])], snapshotOf([posts(['id'])])),
    );
    expect(thrown.code).toBe('X_MIGRATION_IRREVERSIBLE');
    expect(thrown.cause).toContain('"org_id"');
    expect(thrown.fix).toStartWith('x db gen "rekey"');
    expect(thrown.fix).toContain('backfill');
  });

  // Postgres marks every key column NOT NULL and dropping the key does not undo it, so a column
  // the declaration allows NULL in would stay NOT NULL after it left the key — in either direction.
  test('a nullable column leaving the key gets its NOT NULL dropped, up and down', () => {
    const nullable = { slug: { notNull: false }, id: { notNull: false } } as const;
    const before = posts(['id'], ['id', 'slug'], nullable);
    const after = posts(['slug'], ['id', 'slug'], nullable);
    const migration = generate([after], snapshotOf([before]));
    expect(migration.up.split('\n')).toEqual([
      DROP,
      'alter table "posts" alter column "id" drop not null;',
      add('"slug"'),
    ]);
    expect(migration.down.split('\n')).toEqual([
      DROP,
      'alter table "posts" alter column "slug" drop not null;',
      add('"id"'),
    ]);
  });

  test('a column declared NOT NULL keeps it when it leaves the key', () => {
    const migration = generate([posts(['slug'])], snapshotOf([posts(['id'])]));
    expect(migration.up).not.toContain('drop not null');
    expect(migration.down).not.toContain('drop not null');
  });
});
