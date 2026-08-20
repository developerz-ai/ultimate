// Indexes through the generator: every part of a declaration reaching the statement, the snapshot
// carrying all of it, and a definition that moved dropped and recreated rather than skipped.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';

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

const index = (
  name: string,
  columns: readonly string[],
  overrides: Partial<IndexDescriptionLike> = {},
): IndexDescriptionLike => ({
  name,
  columns,
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

const slugKey = index('posts_slug_key', ['slug'], { unique: true });

const posts = (columns: readonly ColumnDescriptionLike[]): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns,
  indexes: [slugKey],
});

const at = new Date('2026-07-26T12:00:00.000Z');

describe('generateMigration · indexes', () => {
  test('an index a column clause does not imply still gets its own statement', () => {
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('slug', { notNull: true, unique: true }),
            column('org_id', { kind: 'uuid', notNull: true }),
          ]),
          indexes: [slugKey, index('posts_org_id_idx', ['org_id'])],
        },
      ],
      name: 'create posts',
      now: at,
    });

    // Only the one Postgres makes for free is skipped — a plain index is nobody else's job.
    expect(migration.up).not.toContain('create unique index "posts_slug_key"');
    expect(migration.up).toContain('create index "posts_org_id_idx" on "posts" ("org_id")');
  });

  test('a composite index spells every column it was declared over, in order', () => {
    // The name is `<table>_<a>_<b>_idx` — one string for two columns, and it does not run
    // backwards. Recovering the list from it read `("org_id_created_at")`: a `42703` at apply.
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('org_id', { kind: 'uuid', notNull: true }),
            column('created_at', { kind: 'timestamptz', notNull: true }),
          ]),
          indexes: [index('posts_org_id_created_at_idx', ['org_id', 'created_at'])],
        },
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.up).toContain(
      'create index "posts_org_id_created_at_idx" on "posts" ("org_id", "created_at");',
    );
    expect(migration.up).not.toContain('"org_id_created_at"');
  });

  test('a composite unique index is emitted whole, so `on conflict` can be inferred against it', () => {
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('org_id', { kind: 'uuid', notNull: true }),
            column('reference', { notNull: true }),
          ]),
          indexes: [index('posts_org_id_reference_key', ['org_id', 'reference'], { unique: true })],
        },
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.up).toContain(
      'create unique index "posts_org_id_reference_key" on "posts" ("org_id", "reference");',
    );
  });

  test('a partial index carries its predicate, and its direction', () => {
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('org_id', { kind: 'uuid', notNull: true }),
            column('published_at', { kind: 'timestamptz' }),
          ]),
          indexes: [
            index('posts_org_id_published_at_idx', ['org_id', 'published_at'], {
              where: "status = 'published'",
              order: 'desc',
            }),
          ],
        },
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.up).toContain(
      'create index "posts_org_id_published_at_idx" on "posts" ' +
        `("org_id" desc, "published_at" desc) where (status = 'published');`,
    );
  });

  test('a PARTIAL unique index over a unique column is still emitted', () => {
    // The column clause constrains every row; the partial one constrains a subset. Skipping it
    // as "already implied" would silently widen the constraint the entity declared.
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('slug', { notNull: true, unique: true }),
          ]),
          indexes: [
            slugKey,
            index('posts_slug_live_key', ['slug'], { unique: true, where: 'deleted_at is null' }),
          ],
        },
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.up).not.toContain('create unique index "posts_slug_key"');
    expect(migration.up).toContain(
      'create unique index "posts_slug_live_key" on "posts" ("slug") where (deleted_at is null);',
    );
  });

  test('an index over columns that already exist is added with a DROP INDEX down', () => {
    const before = snapshotOf([
      posts([
        column('id', { kind: 'uuid', primaryKey: true }),
        column('org_id', { kind: 'uuid' }),
        column('created_at', { kind: 'timestamptz' }),
      ]),
    ]);
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true }),
            column('org_id', { kind: 'uuid' }),
            column('created_at', { kind: 'timestamptz' }),
          ]),
          indexes: [slugKey, index('posts_org_id_created_at_idx', ['org_id', 'created_at'])],
        },
      ],
      current: before,
      name: 'index the feed',
      now: at,
    });

    expect(migration.up).toBe(
      'create index "posts_org_id_created_at_idx" on "posts" ("org_id", "created_at");',
    );
    expect(migration.down).toBe('drop index "posts_org_id_created_at_idx";');
  });

  test('the snapshot records the whole index, not a name to parse later', () => {
    const [table] = snapshotOf([
      {
        ...posts([column('id', { kind: 'uuid', primaryKey: true })]),
        indexes: [
          index('posts_org_id_created_at_idx', ['org_id', 'created_at'], {
            where: '"deleted_at" is null',
            order: 'desc',
          }),
        ],
      },
    ]).tables;

    // `where` and `order` ride along or the next generation cannot see either one change.
    expect(table?.indexes).toEqual([
      {
        name: 'posts_org_id_created_at_idx',
        columns: ['org_id', 'created_at'],
        unique: false,
        primary: false,
        where: '"deleted_at" is null',
        order: 'desc',
      },
    ]);
  });

  test('a predicate added to an existing index is a drop and a recreate', () => {
    const total = index('posts_org_id_idx', ['org_id']);
    const before = snapshotOf([{ ...posts([column('id', { kind: 'uuid' })]), indexes: [total] }]);
    const migration = generateMigration({
      entities: [
        {
          ...posts([column('id', { kind: 'uuid' })]),
          indexes: [{ ...total, where: '"deleted_at" is null' }],
        },
      ],
      current: before,
      name: 'narrow the index',
      now: at,
    });

    // Postgres has no `alter index` for a predicate: same name, different index.
    expect(migration.up).toBe(
      'drop index "posts_org_id_idx";\n' +
        'create index "posts_org_id_idx" on "posts" ("org_id") where ("deleted_at" is null);',
    );
    expect(migration.down).toBe(
      'drop index "posts_org_id_idx";\ncreate index "posts_org_id_idx" on "posts" ("org_id");',
    );
  });

  test('a reversed direction is a drop and a recreate too', () => {
    const asc = index('posts_org_id_idx', ['org_id']);
    const before = snapshotOf([{ ...posts([column('id', { kind: 'uuid' })]), indexes: [asc] }]);
    const migration = generateMigration({
      entities: [
        { ...posts([column('id', { kind: 'uuid' })]), indexes: [{ ...asc, order: 'desc' }] },
      ],
      current: before,
      name: 'reverse the index',
      now: at,
    });

    expect(migration.up).toContain('create index "posts_org_id_idx" on "posts" ("org_id" desc);');
  });

  test('an unchanged index generates nothing', () => {
    const same = index('posts_org_id_idx', ['org_id'], { where: '"a" is null', order: 'desc' });
    const before = snapshotOf([{ ...posts([column('id', { kind: 'uuid' })]), indexes: [same] }]);
    const migration = generateMigration({
      entities: [{ ...posts([column('id', { kind: 'uuid' })]), indexes: [same] }],
      current: before,
      name: 'nothing to do',
      now: at,
    });

    expect(migration.up).toBe('');
  });

  test('an index naming no column is X_INVARIANT, never DDL Postgres cannot parse', () => {
    let thrown: unknown;
    try {
      generateMigration({
        entities: [
          {
            ...posts([column('id', { kind: 'uuid', primaryKey: true })]),
            indexes: [index('posts__idx', [])],
          },
        ],
        name: 'create posts',
        now: at,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toBe('index "posts__idx" on "posts" names no columns');
    expect(error.fix).toContain("on: ['<column>']");
  });
});
