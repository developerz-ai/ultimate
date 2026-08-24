// The access method through the generator: emitted, recorded, and rebuilt when it moves. Split from
// `generate-index.test.ts` along the seam `index-method.ts` already draws, and because the
// assertion that matters most here is a NEGATIVE one — an index that declared no method emits the
// statement this generator has always emitted, byte for byte.

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

const posts = (indexes: readonly IndexDescriptionLike[]): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('tags', { kind: 'json' }),
  ],
  indexes,
});

const at = new Date('2026-07-26T12:00:00.000Z');

const upFor = (indexes: readonly IndexDescriptionLike[]): string =>
  generateMigration({ entities: [posts(indexes)], name: 'create posts', now: at }).up;

describe('createIndex · the access method', () => {
  test('an index that declared no method emits exactly the statement it always did', () => {
    expect(upFor([index('posts_tags_idx', ['tags'])])).toContain(
      'create index "posts_tags_idx" on "posts" ("tags");',
    );
  });

  test('a GIN index carries its clause, between the table and the column list', () => {
    expect(upFor([index('posts_tags_idx', ['tags'], { using: 'gin' })])).toContain(
      'create index "posts_tags_idx" on "posts" using gin ("tags");',
    );
  });

  test('a partial GIN index keeps both parts, in the order Postgres parses them', () => {
    expect(
      upFor([index('posts_tags_idx', ['tags'], { using: 'gin', where: '"deleted_at" is null' })]),
    ).toContain(
      'create index "posts_tags_idx" on "posts" using gin ("tags") where ("deleted_at" is null);',
    );
  });

  test('an explicit btree is still the bare form — the default is never written out', () => {
    expect(upFor([index('posts_tags_idx', ['tags'], { using: 'btree' })])).toContain(
      'create index "posts_tags_idx" on "posts" ("tags");',
    );
  });
});

describe('a declaration Postgres cannot honour is refused, not emitted', () => {
  test('a unique GIN index — Postgres has none', () => {
    expect(() =>
      upFor([index('posts_tags_idx', ['tags'], { using: 'gin', unique: true })]),
    ).toThrow('X_INVARIANT');
  });

  test('an ordered GIN index — only a btree orders its keys', () => {
    expect(() =>
      upFor([index('posts_tags_idx', ['tags'], { using: 'gin', order: 'desc' })]),
    ).toThrow('X_INVARIANT');
  });

  test('a method the closed set does not carry never reaches the statement', () => {
    // The identical hole `columnName` carried: an unvalidated operand spliced into DDL.
    const smuggled = index('posts_tags_idx', ['tags'], {
      using: 'gin) ; drop table posts; --' as 'gin',
    });
    expect(() => upFor([smuggled])).toThrow('X_SQL_UNSAFE');
    let emitted = '';
    try {
      emitted = upFor([smuggled]);
    } catch {
      emitted = '';
    }
    expect(emitted).not.toContain('drop table posts');
  });
});

describe('the snapshot', () => {
  test('records a declared method, and stays silent about the default', () => {
    const [table] = snapshotOf([
      posts([index('posts_tags_idx', ['tags'], { using: 'gin' }), index('posts_id_idx', ['id'])]),
    ]).tables;

    const tags = table?.indexes.find((each) => each.name === 'posts_tags_idx');
    const id = table?.indexes.find((each) => each.name === 'posts_id_idx');
    expect(tags?.using).toBe('gin');
    // Absent, not `'btree'`: writing the default out would rewrite every sidecar in every app on
    // the next `x db gen` for a fact that was already true.
    expect(id).not.toHaveProperty('using');
  });

  test('a GIN index that did not change generates nothing — no regeneration on every run', () => {
    const gin = index('posts_tags_idx', ['tags'], { using: 'gin' });
    const before = snapshotOf([posts([gin])]);
    const migration = generateMigration({
      entities: [posts([gin])],
      current: before,
      name: 'no change',
      now: at,
    });

    expect(migration.up).toBe('');
  });

  test('a method that moved is a drop and a recreate — Postgres cannot alter one in place', () => {
    const before = snapshotOf([posts([index('posts_tags_idx', ['tags'])])]);
    const migration = generateMigration({
      entities: [posts([index('posts_tags_idx', ['tags'], { using: 'gin' })])],
      current: before,
      name: 'gin the tags',
      now: at,
    });

    expect(migration.up).toBe(
      'drop index "posts_tags_idx";\ncreate index "posts_tags_idx" on "posts" using gin ("tags");',
    );
    // `down` drops the gin and recreates what the previous snapshot recorded — the btree, not
    // another gin. The pair is pushed forwards and read backwards, so the recreate lands last.
    expect(migration.down).toBe(
      'drop index "posts_tags_idx";\ncreate index "posts_tags_idx" on "posts" ("tags");',
    );
  });
});
