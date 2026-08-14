import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import {
  type ColumnDescriptionLike,
  type EntityDescriptionLike,
  generateMigration,
  type IndexDescriptionLike,
  snapshotOf,
} from './generate';
import type { SchemaDescription } from './introspect';

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

const priced: EntityDescriptionLike = {
  ...posts([
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('price_currency', {
      kind: 'char',
      notNull: true,
      check: "price_currency ~ '^[A-Z]{3}$'",
    }),
  ]),
  indexes: [],
};

/** The snapshot an earlier generated migration recorded — `dataType` is that run's `sqlType()`. */
const recorded = (currency: string): SchemaDescription => ({
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
        { name: 'price_currency', dataType: currency, nullable: false, default: null, position: 2 },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    },
  ],
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
    // The `unique` clause above already creates `posts_slug_key`; naming it again is `42P07`.
    expect(migration.up).not.toContain('create unique index "posts_slug_key"');
    expect(migration.down).toContain('drop table "posts";');
  });

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

  test('the snapshot records the columns an index covers, not a name to parse later', () => {
    const [table] = snapshotOf([
      {
        ...posts([column('id', { kind: 'uuid', primaryKey: true })]),
        indexes: [index('posts_org_id_created_at_idx', ['org_id', 'created_at'])],
      },
    ]).tables;

    expect(table?.indexes).toEqual([
      {
        name: 'posts_org_id_created_at_idx',
        columns: ['org_id', 'created_at'],
        unique: false,
        primary: false,
      },
    ]);
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

  test('a unique column added later does not also emit its implied index', () => {
    const before = snapshotOf([posts([column('id', { kind: 'uuid', primaryKey: true })])]);
    const migration = generateMigration({
      entities: [
        posts([
          column('id', { kind: 'uuid', primaryKey: true }),
          column('slug', { notNull: true, unique: true }),
        ]),
      ],
      current: before,
      name: 'add slug',
      now: at,
    });

    // ALTER TABLE ADD COLUMN carries the same `unique` clause, so it creates the same index.
    expect(migration.up).toContain('add column "slug" text unique');
    expect(migration.up).not.toContain('create unique index "posts_slug_key"');
  });

  test("money's currency carries its length, so the CHECK beside it can be satisfied", () => {
    // Bare `char` is `char(1)` in Postgres and no three-letter code fits it — the generated
    // table would reject every money row the framework can write.
    const migration = generateMigration({
      entities: [
        {
          ...posts([
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('price_minor', { kind: 'bigint', notNull: true }),
            column('price_currency', {
              kind: 'char',
              notNull: true,
              check: "price_currency ~ '^[A-Z]{3}$'",
            }),
          ]),
          indexes: [],
        },
      ],
      name: 'create posts',
      now: at,
    });

    expect(migration.up).toContain('"price_currency" char(3) not null');
    expect(migration.up).not.toContain('"price_currency" char not null');
  });

  test('a column whose SQL type changed is retyped, and the down restores the old one', () => {
    // The table was created when `char` meant `char(1)`; skipping it by name left the database
    // rejecting every currency while the new snapshot claimed `char(3)`.
    const migration = generateMigration({
      entities: [priced],
      current: recorded('char'),
      name: 'widen currency',
      now: at,
    });

    expect(migration.up).toBe(
      'alter table "posts" alter column "price_currency" type char(3) ' +
        'using "price_currency"::char(3);',
    );
    expect(migration.down).toBe(
      'alter table "posts" alter column "price_currency" type char using "price_currency"::char;',
    );
  });

  test('an unchanged column type is not retyped, so a settled schema generates nothing', () => {
    const migration = generateMigration({
      entities: [priced],
      current: recorded('char(3)'),
      name: 'no change',
      now: at,
    });

    expect(migration.up).toBe('');
    expect(migration.down).toBe('');
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

  test('omitting `now` still stamps the id with a valid, current timestamp', () => {
    const entities = [posts([column('id', { kind: 'uuid', primaryKey: true })])];
    const before = Date.now();
    const migration = generateMigration({ entities, name: 'create posts' });
    const after = Date.now();

    const [stamp] = migration.id.split('_');
    expect(stamp).toMatch(/^\d{14}$/);
    const stampMs = Date.parse(
      `${stamp?.slice(0, 4)}-${stamp?.slice(4, 6)}-${stamp?.slice(6, 8)}T` +
        `${stamp?.slice(8, 10)}:${stamp?.slice(10, 12)}:${stamp?.slice(12, 14)}Z`,
    );
    expect(stampMs).toBeGreaterThanOrEqual(before - 1000);
    expect(stampMs).toBeLessThanOrEqual(after + 1000);
  });
});
