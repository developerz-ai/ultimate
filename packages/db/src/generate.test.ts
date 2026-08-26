// `x db gen` on the framework's own engine: what it writes, what it refuses to write, and the
// round trip that makes the second generation incremental — the file it emits must parse back
// through the reader that applies it. Indexes are `generate-index.test.ts`.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
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
      // Recorded, so these two tests keep asking about the TYPE alone. A snapshot that omits it is
      // a different question — "the database may be holding the old anonymous form" — and
      // `check-ddl.test.ts` is where that one is pinned.
      checks: [{ name: 'posts_price_currency_check', expression: "price_currency ~ '^[A-Z]{3}$'" }],
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
    //
    // The CHECK reads the column, so it is moved out of the ALTER's way and put back — the
    // conservative half of `retype-dependents.ts`. `char` -> `char(3)` is measurably a retype
    // Postgres CAN re-derive the expression across, and `integer` -> `text` under `c >= 0` is not:
    // which of the two this is cannot be decided from two type NAMES without becoming the
    // expression parser the server already is, so the answer that costs a rebuild is taken over
    // the one that costs `42883` inside `ROLE=migrate`.
    const migration = generateMigration({
      entities: [priced],
      current: recorded('char'),
      name: 'widen currency',
      now: at,
    });

    expect(migration.up).toBe(
      'alter table "posts" drop constraint "posts_price_currency_check";\n' +
        'alter table "posts" alter column "price_currency" type char(3) ' +
        'using "price_currency"::char(3);\n' +
        'alter table "posts" add constraint "posts_price_currency_check" ' +
        "check (price_currency ~ '^[A-Z]{3}$');",
    );
    // Reversed as a whole: the constraint compiled against `char(3)` comes off first, the column
    // goes back, and only then is the recorded predicate added again.
    expect(migration.down).toBe(
      'alter table "posts" drop constraint "posts_price_currency_check";\n' +
        'alter table "posts" alter column "price_currency" type char ' +
        'using "price_currency"::char;\n' +
        'alter table "posts" add constraint "posts_price_currency_check" ' +
        "check (price_currency ~ '^[A-Z]{3}$');",
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
    expect(migration.destructive).toBe(true);
  });

  test('a create-only migration is not destructive, and its `down` full of drops does not make it', () => {
    const migration = generateMigration({
      entities: [posts([column('id', { kind: 'uuid', primaryKey: true }), column('title')])],
      name: 'create posts',
      now: at,
    });
    expect(migration.down).toContain('drop table "posts";');
    expect(migration.destructive).toBe(false);
  });

  test('a retype is destructive even though no --allow-destructive gates it', () => {
    const before = snapshotOf([posts([column('legacy', { kind: 'char' })])]);
    const migration = generateMigration({
      entities: [posts([column('legacy', { kind: 'text' })])],
      current: before,
      name: 'retype legacy',
      now: at,
    });
    expect(migration.up).toContain('alter column "legacy" type text');
    expect(migration.destructive).toBe(true);
  });

  test('the snapshot records the foreign key the column clause writes', () => {
    // Recording `foreignKeys: []` beside a `references "orgs" ("id")` the same run emitted was a
    // snapshot denying a constraint its own migration creates, so drift had nothing to compare
    // and a key dropped on the database by hand was invisible to every check.
    const entities = [
      posts([
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('org_id', { kind: 'uuid', notNull: true, references: 'orgs.id' }),
      ]),
    ];
    const migration = generateMigration({ entities, name: 'create posts', now: at });
    expect(migration.up).toContain('references "orgs" ("id")');
    expect(migration.snapshot.tables[0]?.foreignKeys).toEqual([
      {
        name: 'posts_org_id_fkey',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
        onDelete: null,
      },
    ]);
  });

  test('a reference with no column named falls back to id, in the clause and the snapshot alike', () => {
    const entities = [posts([column('org_id', { kind: 'uuid', references: 'orgs' })])];
    const migration = generateMigration({ entities, name: 'create posts', now: at });
    expect(migration.up).toContain('references "orgs" ("id")');
    expect(migration.snapshot.tables[0]?.foreignKeys[0]?.referencedColumns).toEqual(['id']);
  });

  // Postgres refuses `drop table` while a constraint still points at it (`2BP01`), and the drops
  // were emitted alphabetically with every `alter table … drop constraint` appended AFTER them.

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
