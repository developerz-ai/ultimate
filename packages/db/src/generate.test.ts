import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import {
  type ColumnDescriptionLike,
  type EntityDescriptionLike,
  generateMigration,
  snapshotOf,
} from './generate';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const posts = (columns: readonly ColumnDescriptionLike[]): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns,
  indexes: ['posts_slug_key'],
});

const at = new Date('2026-07-26T12:00:00.000Z');

describe('generateMigration', () => {
  test('a new entity becomes CREATE TABLE with a DROP TABLE down', () => {
    const migration = generateMigration({
      entities: [
        posts([
          column('id', { kind: 'uuid', primaryKey: true, notNull: true, hasDefault: true }),
          column('slug', { notNull: true, unique: true }),
        ]),
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.id).toBe('20260726120000_create_posts');
    expect(migration.fileName).toBe('migrations/20260726120000_create_posts.sql');
    expect(migration.up).toContain('create table "posts"');
    expect(migration.up).toContain('"id" uuid default gen_random_uuid() not null');
    expect(migration.up).toContain('"slug" text not null unique');
    expect(migration.up).toContain('primary key ("id")');
    expect(migration.up).toContain('create unique index "posts_slug_key" on "posts" ("slug")');
    expect(migration.down).toContain('drop table "posts";');
  });

  test('a new column becomes ALTER TABLE ADD COLUMN with a DROP COLUMN down', () => {
    const before = snapshotOf([posts([column('id', { kind: 'uuid', primaryKey: true })])]);
    const migration = generateMigration({
      entities: [
        posts([
          column('id', { kind: 'uuid', primaryKey: true }),
          column('publish_at', { kind: 'timestamptz' }),
        ]),
      ],
      current: before,
      name: 'add publish_at',
      now: at,
    });

    expect(migration.up).toBe('alter table "posts" add column "publish_at" timestamptz;');
    expect(migration.down).toBe('alter table "posts" drop column "publish_at";');
  });

  test('a NOT NULL add with no default is emitted nullable plus the exact follow-up', () => {
    const before = snapshotOf([posts([column('id', { kind: 'uuid', primaryKey: true })])]);
    const migration = generateMigration({
      entities: [
        posts([
          column('id', { kind: 'uuid', primaryKey: true }),
          column('title', {
            notNull: true,
          }),
        ]),
      ],
      current: before,
      name: 'add title',
      now: at,
    });

    expect(migration.up).toContain('add column "title" text;');
    expect(migration.up).toContain('alter column "title" set not null;');
  });

  test('a drop that loses data throws X_MIGRATION_IRREVERSIBLE with a fix', () => {
    const before = snapshotOf([
      posts([column('id', { kind: 'uuid', primaryKey: true }), column('legacy')]),
    ]);
    let thrown: unknown;
    try {
      generateMigration({
        entities: [posts([column('id', { kind: 'uuid', primaryKey: true })])],
        current: before,
        name: 'drop legacy',
        now: at,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_MIGRATION_IRREVERSIBLE');
    expect(error.cause).toBe('dropping "posts"."legacy" discards its rows and cannot be undone');
    expect(error.fix).toContain('--allow-destructive');
  });

  test('--allow-destructive emits the drop and says the down cannot restore data', () => {
    const before = snapshotOf([
      posts([column('id', { kind: 'uuid', primaryKey: true }), column('legacy')]),
    ]);
    const migration = generateMigration({
      entities: [posts([column('id', { kind: 'uuid', primaryKey: true })])],
      current: before,
      name: 'drop legacy',
      now: at,
      allowDestructive: true,
    });
    expect(migration.up).toContain('drop column "legacy";');
    expect(migration.down).toContain('-- data is not restored');
  });

  test('the emitted snapshot is drift-free against the entities it came from', () => {
    const entities = [
      posts([
        column('id', { kind: 'uuid', primaryKey: true, notNull: true, hasDefault: true }),
        column('slug', { notNull: true, unique: true }),
      ]),
    ];
    const migration = generateMigration({ entities, name: 'create posts', now: at });
    expect(diffSchema(migration.snapshot, snapshotOf(entities)).ok).toBe(true);
  });
});
