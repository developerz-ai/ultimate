// The arm that was missing: a RECORDED index no entity declares any more. `diffTable` walked the
// declared side only, so `member_unique_per_org` and `members_tz_idx` survived every regeneration
// of `examples/dummy` while the sidecar beside them stopped recording either one — the database
// held two objects no snapshot described, and the `drift` step judges the declared side, so nothing
// could see it. What this file pins is the plan; `index-removal.live.test.ts` pins that it applies.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { IndexDescription, SchemaDescription, TableDescription } from './introspect';

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

const recordedIndex = (
  name: string,
  columns: readonly string[],
  overrides: Partial<IndexDescription> = {},
): IndexDescription => ({
  name,
  columns,
  unique: false,
  primary: false,
  where: null,
  order: null,
  ...overrides,
});

const at = new Date('2026-08-25T00:00:00.000Z');

/** A recorded `posts` table with `id`/`org_id`/`slug`/`status`, and whatever indexes are passed. */
const recordedPosts = (
  indexes: readonly IndexDescription[],
  overrides: Partial<TableDescription> = {},
): SchemaDescription => ({
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
        { name: 'org_id', dataType: 'uuid', nullable: false, default: null, position: 2 },
        { name: 'slug', dataType: 'text', nullable: false, default: null, position: 3 },
        { name: 'status', dataType: 'text', nullable: false, default: null, position: 4 },
      ],
      primaryKey: ['id'],
      indexes,
      foreignKeys: [],
      ...overrides,
    },
  ],
});

const posts = (overrides: Partial<EntityDescriptionLike> = {}): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    column('slug', { notNull: true }),
    column('status', { notNull: true }),
  ],
  indexes: [],
  ...overrides,
});

describe('generateMigration · a recorded index the entities no longer declare', () => {
  test('is dropped, and the down recreates it from what the SNAPSHOT recorded', () => {
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts([
        recordedIndex('posts_feed_idx', ['org_id', 'status'], {
          where: "status <> 'draft'",
          order: 'desc',
        }),
      ]),
      name: 'drop the feed index',
      now: at,
    });

    expect(migration.up).toBe('drop index "posts_feed_idx";');
    // The RECORDED definition, whole — the predicate and the direction included. Rebuilding it
    // from the entity is impossible here: the entity is exactly what stopped declaring it.
    expect(migration.down).toBe(
      'create index "posts_feed_idx" on "posts" ' +
        `("org_id" desc, "status" desc) where (status <> 'draft');`,
    );
  });

  test('a recorded UNIQUE index is removed through the constraint-safe pair, never `drop index`', () => {
    // `columnClause` writes `unique` into `create table`, and Postgres backs THAT with a
    // CONSTRAINT named `<table>_<column>_key` — `drop index` on it is 2BP01, which `if exists`
    // does not suppress (measured). The snapshot records a constraint's index and a plain unique
    // index identically, so the pair is the one statement correct on both.
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts([recordedIndex('posts_slug_key', ['slug'], { unique: true })]),
      name: 'slug is no longer unique',
      now: at,
    });

    expect(migration.up).toBe(
      'alter table "posts" drop constraint if exists "posts_slug_key";\n' +
        'drop index if exists "posts_slug_key";',
    );
    expect(migration.down).toBe('create unique index "posts_slug_key" on "posts" ("slug");');
  });

  test('a unique index Postgres could not be backing with a constraint takes the bare drop', () => {
    // A UNIQUE constraint's index is total, unordered and btree. A partial one is none of those,
    // so `drop constraint if exists` there is a notice that can never match anything.
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts([
        recordedIndex('posts_slug_live_key', ['slug'], {
          unique: true,
          where: "status <> 'deleted'",
        }),
      ]),
      name: 'drop the partial unique',
      now: at,
    });

    expect(migration.up).toBe('drop index "posts_slug_live_key";');
    expect(migration.up).not.toContain('drop constraint');
  });

  test('a PRIMARY recorded index is never dropped by this arm', () => {
    // `drop index` on a primary key's index is 2BP01 too, and the key is `TableDescription.
    // primaryKey` — a different question with a different answer.
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts([
        recordedIndex('posts_pkey', ['id'], { unique: true, primary: true }),
      ]),
      name: 'nothing to do',
      now: at,
    });

    expect(migration.up).toBe('');
  });

  test('an index a retype already moved aside is not dropped a second time', () => {
    // `moveDependentsAside` took it out ahead of the ALTER; a second `drop index` is 42704.
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts(
        [recordedIndex('posts_feed_idx', ['org_id'], { where: "status = 'published'" })],
        {
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
            { name: 'org_id', dataType: 'uuid', nullable: false, default: null, position: 2 },
            { name: 'slug', dataType: 'text', nullable: false, default: null, position: 3 },
            {
              name: 'status',
              dataType: 'post_status',
              nullable: false,
              default: null,
              position: 4,
            },
          ],
        },
      ),
      name: 'status becomes text',
      now: at,
    });

    expect(migration.up.match(/drop index "posts_feed_idx"/g)).toHaveLength(1);
    // And its restore is the retype's own, at the far end of `down`, once only.
    expect(migration.down.match(/create index "posts_feed_idx"/g)).toHaveLength(1);
  });

  test('an index over a column this migration DROPS is left to the `drop column`', () => {
    // `alter table … drop column` takes every index over it, so a `drop index` beside it is a
    // statement about an object the same migration removes anyway — the rule `foreignKeyPlan`
    // already applies to a constraint on a dropped column.
    const migration = generateMigration({
      entities: [
        posts({
          columns: posts().columns.filter((each) => each.column !== 'slug'),
        }),
      ],
      current: recordedPosts([recordedIndex('posts_slug_idx', ['slug'])]),
      name: 'drop slug',
      now: at,
      allowDestructive: true,
    });

    expect(migration.up).not.toContain('drop index');
    expect(migration.up).toContain('alter table "posts" drop column "slug";');
  });

  test('an index on a table this migration DROPS is left to the `drop table`', () => {
    const migration = generateMigration({
      entities: [],
      current: recordedPosts([recordedIndex('posts_slug_key', ['slug'], { unique: true })]),
      name: 'drop posts',
      now: at,
      allowDestructive: true,
    });

    expect(migration.up).toBe('drop table "posts";');
  });

  test('an index over a column `regenerate` rebuilt went with the column', () => {
    // Plain -> generated is `drop column` + `add column`, which takes the index with it; the
    // snapshot still records it, and dropping it again is 42704.
    const migration = generateMigration({
      entities: [
        posts({
          columns: [
            column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
            column('org_id', { kind: 'uuid', notNull: true }),
            column('slug', { notNull: true }),
            column('status', { notNull: true, generated: 'lower(slug)' }),
          ],
        }),
      ],
      current: recordedPosts([recordedIndex('posts_status_idx', ['status'])]),
      name: 'status becomes generated',
      now: at,
    });

    expect(migration.up).not.toContain('drop index "posts_status_idx"');
  });

  test('a renamed index is created under the new name and removed under the old one', () => {
    // The shape `examples/dummy` is in: `member_unique_per_org` recorded, `members_…_key`
    // declared, identical columns. Both halves have to be in one migration or the database ends up
    // holding two indexes over the same columns forever.
    const migration = generateMigration({
      entities: [
        posts({
          indexes: [
            {
              name: 'posts_post_slug_unique_key',
              columns: ['org_id', 'slug'],
              unique: true,
              where: null,
              order: null,
            },
          ],
        }),
      ],
      current: recordedPosts([
        recordedIndex('post_slug_unique_per_org', ['org_id', 'slug'], { unique: true }),
      ]),
      name: 'rename the unique',
      now: at,
    });

    expect(migration.up).toBe(
      'create unique index "posts_post_slug_unique_key" on "posts" ("org_id", "slug");\n' +
        'alter table "posts" drop constraint if exists "post_slug_unique_per_org";\n' +
        'drop index if exists "post_slug_unique_per_org";',
    );
    expect(migration.down).toBe(
      'create unique index "post_slug_unique_per_org" on "posts" ("org_id", "slug");\n' +
        'drop index "posts_post_slug_unique_key";',
    );
  });

  test('a schema that still declares every recorded index regenerates to nothing', () => {
    const entity = posts({
      indexes: [
        { name: 'posts_org_id_idx', columns: ['org_id'], unique: false, where: null, order: null },
      ],
    });
    const migration = generateMigration({
      entities: [entity],
      current: snapshotOf([entity]),
      name: 'again',
      now: at,
    });

    expect(migration.up).toBe('');
  });

  test('dropping an index does not mark the migration destructive', () => {
    // An index holds no rows of its own and the `down` beside it recreates the recorded
    // definition, which is the exact test `destructive.ts` applies — `drop column`'s down says
    // "data is not restored" and this one does not. Marking it would mark every rename too
    // (`redefineIndex` has emitted a bare `drop index` since it existed), and a mark on all is none.
    const migration = generateMigration({
      entities: [posts()],
      current: recordedPosts([recordedIndex('posts_org_id_idx', ['org_id'])]),
      name: 'drop an index',
      now: at,
    });

    expect(migration.up).toContain('drop index');
    expect(migration.destructive).toBe(false);
  });
});
