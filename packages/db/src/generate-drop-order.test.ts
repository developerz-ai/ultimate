// Dropping a table another entity still references: the ORDER the statements come out in.
// Split from `generate.test.ts` at the 500-line ceiling, along the seam it already drew — that
// file asks what `x db gen` writes for one table, this one asks what it writes when two tables
// have to come down in a particular order or not at all.

// `x db gen` on the framework's own engine: what it writes, what it refuses to write, and the
// round trip that makes the second generation incremental — the file it emits must parse back
// through the reader that applies it. Indexes are `generate-index.test.ts`.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { unrestorableNote } from './foreign-key';
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

const _priced: EntityDescriptionLike = {
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
const _recorded = (currency: string): SchemaDescription => ({
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

// The migration aborted mid-file during the release phase, the ledger recorded nothing, and the
// `down` is `-- cannot be restored` — so there was nothing to reverse either.
describe('dropping a referenced table', () => {
  const authors: EntityDescriptionLike = {
    name: 'Author',
    table: 'authors',
    primaryKey: ['id'],
    columns: [column('id', { kind: 'uuid', primaryKey: true, notNull: true })],
    indexes: [],
  };
  const linked = posts([
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('author_id', { kind: 'uuid', references: 'authors.id' }),
  ]);

  test('drops the surviving table constraint BEFORE the table it points at', () => {
    const before = snapshotOf([authors, linked]);
    const migration = generateMigration({
      // `posts` survives and keeps the column, but the `references()` went with the entity.
      entities: [
        posts([
          column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
          column('author_id', { kind: 'uuid' }),
        ]),
      ],
      current: before,
      name: 'drop authors',
      now: at,
      allowDestructive: true,
    });

    const drop = migration.up.indexOf('drop constraint "posts_author_id_fkey"');
    const table = migration.up.indexOf('drop table "authors";');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(table);
  });

  test('a dropped COLUMN takes its key with it — no drop constraint before the drop table', () => {
    // The column is gone, so `drop column` already removed the constraint: a `drop constraint`
    // after that statement is `42704` on one that no longer exists.
    const migration = generateMigration({
      entities: [posts([column('id', { kind: 'uuid', primaryKey: true, notNull: true })])],
      current: snapshotOf([authors, linked]),
      name: 'drop authors',
      now: at,
      allowDestructive: true,
    });

    expect(migration.up).not.toContain('drop constraint');
    // Presence first: `indexOf` answers -1 for a needle it never found, and -1 is less than
    // every real index — so a `drop column` that stopped being emitted would read as ordered.
    expect(migration.up).toContain('drop column "author_id"');
    expect(migration.up.indexOf('drop column "author_id"')).toBeLessThan(
      migration.up.indexOf('drop table "authors";'),
    );
  });

  test('drops the referencing table before the referenced one, whatever the alphabet says', () => {
    const before = snapshotOf([authors, linked]);
    const migration = generateMigration({
      entities: [],
      current: before,
      name: 'drop both',
      now: at,
      allowDestructive: true,
    });

    // "authors" sorts first and is the PARENT: dropped first it is 2BP01.
    // Presence first — a missing child drop is -1, which reads as "ordered first".
    expect(migration.up).toContain('drop table "posts";');
    expect(migration.up.indexOf('drop table "posts";')).toBeLessThan(
      migration.up.indexOf('drop table "authors";'),
    );
  });

  test('a still-declared reference to a dropped table is dropped, never left dangling', () => {
    // The entity still says `references('authors.id')` while the authors entity is gone. The
    // constraint cannot survive the table, so it goes with it — and the `down` says so rather
    // than emitting an `add constraint` against a table no `down` can restore.
    const before = snapshotOf([authors, linked]);
    const migration = generateMigration({
      entities: [linked],
      current: before,
      name: 'drop authors',
      now: at,
      allowDestructive: true,
    });

    expect(migration.up).toContain('drop constraint "posts_author_id_fkey"');
    expect(migration.up.indexOf('drop constraint "posts_author_id_fkey"')).toBeLessThan(
      migration.up.indexOf('drop table "authors";'),
    );
    expect(migration.down).not.toContain('add constraint "posts_author_id_fkey"');
    // And the note it gets instead is `foreign-key.ts`'s ONE text. `retype-keys.ts` says the
    // same thing about the same failed rollback and used to spell it differently, so an
    // operator read whichever module emitted last.
    expect(migration.down).toContain(unrestorableNote('posts', 'posts_author_id_fkey', 'authors'));
  });

  test('without --allow-destructive it refuses, naming a table and the flag', () => {
    let thrown: unknown;
    try {
      generateMigration({
        entities: [],
        current: snapshotOf([authors, linked]),
        name: 'drop both',
        now: at,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_MIGRATION_IRREVERSIBLE');
    // The child, because the refusal walks the same order the drops would run in.
    expect(error.cause).toBe('dropping table "posts" discards every row and cannot be undone');
    expect(error.fix).toContain('--allow-destructive');
  });

  test('a self-referencing table needs no constraint drop of its own', () => {
    const tree: EntityDescriptionLike = {
      name: 'Node',
      table: 'nodes',
      primaryKey: ['id'],
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('parent_id', { kind: 'uuid', references: 'nodes.id' }),
      ],
      indexes: [],
    };
    const migration = generateMigration({
      entities: [],
      current: snapshotOf([tree]),
      name: 'drop nodes',
      now: at,
      allowDestructive: true,
    });

    expect(migration.up).toContain('drop table "nodes";');
    expect(migration.up).not.toContain('drop constraint');
  });
});
