// Single responsibility: what `createIndex` is willing to put in a statement. Both halves of an
// index declaration that are TEXT — the direction and the partial predicate — cross the tier seam
// from `@ultimat3/entity` structurally, are validated by nothing on the way, and end up in a file
// `ROLE=migrate` runs. The benign spellings are pinned beside the refusals, because a screen that
// also changed the byte-for-byte output would rewrite every migration already on disk.

import { describe, expect, test } from 'bun:test';
import type { IndexDescriptionLike } from './entity-shape';
import { createIndex } from './index-ddl';

const index = (overrides: Partial<IndexDescriptionLike> = {}): IndexDescriptionLike => ({
  name: 'posts_slug_idx',
  columns: ['slug'],
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

describe('createIndex · the direction', () => {
  test('a declaration with no direction emits what it always emitted, byte for byte', () => {
    expect(createIndex('posts', index())).toBe(
      'create index "posts_slug_idx" on "posts" ("slug");',
    );
  });

  test('each direction of the closed set is written out', () => {
    expect(createIndex('posts', index({ order: 'asc' }))).toContain('("slug" asc)');
    expect(createIndex('posts', index({ order: 'desc' }))).toContain('("slug" desc)');
  });

  test('every column of a composite index carries the direction', () => {
    expect(createIndex('posts', index({ columns: ['org_id', 'created_at'], order: 'desc' }))).toBe(
      'create index "posts_slug_idx" on "posts" ("org_id" desc, "created_at" desc);',
    );
  });

  test('a direction the closed set does not carry never reaches the statement', () => {
    // The identical hole `indexMethodSql` closed for `using`: the TYPE is not the guard, because
    // the value arrives from a projection this package cannot typecheck and from a
    // `.snapshot.json` anything may edit. Measured before the screen:
    // `create index "posts_slug_idx" on "posts" ("slug" desc; drop table users; --);`
    const smuggled = index({ order: 'desc; drop table users; --' as 'desc' });
    expect(() => createIndex('posts', smuggled)).toThrow('X_SQL_UNSAFE');
    let emitted = '';
    try {
      emitted = createIndex('posts', smuggled);
    } catch {
      emitted = '';
    }
    expect(emitted).not.toContain('drop table users');
  });
});

describe('createIndex · the partial predicate', () => {
  test('a predicate is written into the statement as it stands', () => {
    expect(createIndex('posts', index({ where: 'deleted_at is null' }))).toBe(
      'create index "posts_slug_idx" on "posts" ("slug") where (deleted_at is null);',
    );
  });

  test('a `;` inside a string literal is data, never a second command', () => {
    // `statementsOf` is this package's one lexer, which is why the screen can be exact instead of
    // a `includes(';')` that would refuse a legitimate predicate.
    expect(createIndex('posts', index({ where: "tag <> ';'" }))).toContain("where (tag <> ';')");
  });

  test('a predicate holding a second command is refused, not emitted', () => {
    // The screen `declaredChecks` already applies to a CHECK's expression — same text, same seam.
    // Measured before it: `create index "posts_slug_idx" on "posts" ("slug") where (1=1);
    // drop table users; --);`
    const smuggled = index({ where: '1=1); drop table users; --' });
    expect(() => createIndex('posts', smuggled)).toThrow('X_SQL_UNSAFE');
    let emitted = '';
    try {
      emitted = createIndex('posts', smuggled);
    } catch {
      emitted = '';
    }
    expect(emitted).not.toContain('drop table users');
  });
});
