// The two codes as an author is handed them: a preload line that already resolves, or the batched
// read of the statement that repeated. A fix naming a relation the schema never declared would be
// worse than no fix at all — it is a command the reader pastes.

import { afterAll, describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { text, uuid } from './columns';
import { entity } from './entity';
import { ENTITY_ERROR_CODES } from './errors';
import { nPlusOne, preloadsFor } from './n-plus-one';
import { clearRegistry } from './registry';
import { relationMap } from './relations';

// `relationMap()` projects the WHOLE registry, so this file owns it for its duration — and one test
// below deliberately poisons it, which is why registering is a function rather than a top-level run.
const register = (): void => {
  const members = entity('n1_members', {
    columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
  });
  const posts = entity('n1_posts', {
    columns: {
      id: uuid().primaryKey(),
      authorId: uuid().references(() => members.id),
      title: text({ max: 120 }),
    },
  });
  entity('n1_reviews', {
    columns: {
      id: uuid().primaryKey(),
      authorId: uuid().references(() => members.id),
      verdict: text({ max: 40 }),
    },
  });
  entity('n1_comments', {
    columns: {
      id: uuid().primaryKey(),
      postId: uuid().references(() => posts.id),
      body: text({ max: 200 }),
    },
  });
  entity('n1_tags', { columns: { id: uuid().primaryKey(), label: text({ max: 20 }) } });
};

clearRegistry();
register();

afterAll(() => {
  clearRegistry();
});

const read = (entityName: string | undefined, op: string | undefined, count = 12) =>
  nPlusOne({
    kind: 'read',
    subject:
      entityName === undefined ? 'select * from n1_members where id = $1' : `${entityName}.${op}`,
    count,
    entity: entityName,
    op,
  });

const write = (entityName: string | undefined, op: string | undefined, count = 12) =>
  nPlusOne({
    kind: 'write',
    subject:
      entityName === undefined ? 'insert into n1_posts (id) values ($1)' : `${entityName}.${op}`,
    count,
    entity: entityName,
    op,
  });

describe('the codes themselves', () => {
  test('both are owned by this package and registered with a title of its own', () => {
    expect(ENTITY_ERROR_CODES).toContain('X_N_PLUS_ONE_QUERY');
    expect(ENTITY_ERROR_CODES).toContain('X_N_PLUS_ONE_WRITE');
    expect(hasErrorCode('X_N_PLUS_ONE_QUERY')).toBe(true);
    expect(hasErrorCode('X_N_PLUS_ONE_WRITE')).toBe(true);
    // Humanising the code would render "n plus one query" — the registration is what prevents it.
    expect(describeErrorCode('X_N_PLUS_ONE_QUERY').title).toBe('a read repeated once per row');
    expect(describeErrorCode('X_N_PLUS_ONE_WRITE').title).toBe('a write repeated once per row');
  });

  test('the cause names what repeated and how often, and the render carries all three lines', () => {
    const error = read('n1_members', 'findById', 50);
    expect(error).toBeUltimateError('X_N_PLUS_ONE_QUERY');
    expect(error.cause).toBe('n1_members.findById ran 50 times in one request — one read per row');
    const rendered = error.format().split('\n');
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toBe('X_N_PLUS_ONE_QUERY: a read repeated once per row');
    expect(rendered[1]).toContain('n1_members.findById ran 50 times');
    expect(rendered[2]).toContain("db.n1_posts.preload('author')");
  });
});

describe('a read loop, fixed by the relation the schema already declared', () => {
  test('a point lookup names the belongsTo pages that carry it, the first one pasteable', () => {
    // `n1_posts.authorId` and `n1_reviews.authorId` both point at n1_members, and the ledger saw
    // the lookup — never the loop above it — so a guess between the two would be a wrong fix.
    expect(preloadsFor('n1_members', 'findById')).toEqual([
      { from: 'n1_posts', relation: 'author' },
      { from: 'n1_reviews', relation: 'author' },
    ]);
    expect(read('n1_members', 'findById').fix).toBe(
      "db.n1_posts.preload('author')   # one statement for the whole page, or: db.n1_reviews.preload('author')",
    );
  });

  test('a single candidate is the whole fix, with no alternatives tacked on', () => {
    expect(read('n1_posts', 'findById').fix).toBe(
      "db.n1_comments.preload('post')   # one statement for the whole page",
    );
  });

  test('a filtered read per row is the hasMany side, and preloads from the page that owns it', () => {
    expect(preloadsFor('n1_comments', 'findMany')).toEqual([
      { from: 'n1_posts', relation: 'n1_comments' },
    ]);
    expect(read('n1_comments', 'findMany').fix).toBe(
      "db.n1_posts.preload('n1_comments')   # one statement for the whole page",
    );
  });

  test('the two kinds are not interchangeable — a lookup is never fixed by a hasMany', () => {
    // n1_members is pointed AT by two belongsTo and points at nothing, so `findMany` on it has no
    // hasMany candidate — answering with `posts.preload('author')` would attach the wrong rows.
    expect(preloadsFor('n1_members', 'findMany')).toEqual([]);
    expect(preloadsFor('n1_posts', 'findMany')).toEqual([
      { from: 'n1_members', relation: 'n1_posts' },
    ]);
  });
});

describe('a read loop with no relation to name', () => {
  test('an entity nothing references falls back to the in form of its own statement', () => {
    expect(preloadsFor('n1_tags', 'findById')).toEqual([]);
    expect(read('n1_tags', 'findById').fix).toBe(
      "db.n1_tags.andWhere('id', 'in', ids).all()   # read the set once, then look each row up in memory",
    );
  });

  test('an operation no preload answers takes the same fallback, not a relation that misfits', () => {
    expect(preloadsFor('n1_members', 'count')).toEqual([]);
    expect(preloadsFor('n1_members', undefined)).toEqual([]);
    expect(read('n1_members', 'count').fix).toContain("db.n1_members.andWhere('id', 'in', ids)");
  });

  test('hand-written SQL names no chain, so the fix names the statement and the suppression', () => {
    const fix = read(undefined, undefined).fix;
    expect(fix).toContain('any($1)');
    expect(fix).toContain("expectedQueryLoop('<why one per row is optimal>', fn)");
    expect(fix).not.toContain('undefined');
  });

  test('a schema whose relations cannot be named still reports the loop it was asked about', () => {
    clearRegistry();
    try {
      const badges = entity('n1_bad_badges', { columns: { id: uuid().primaryKey() } });
      entity('n1_bad_holders', {
        columns: {
          id: uuid().primaryKey(),
          badge: uuid().references(() => badges.id),
          badgeId: uuid().references(() => badges.id),
        },
      });
      // Two inbound keys this map cannot tell apart: the derivation itself is a refusal.
      expect(() => relationMap()).toThrow();
      const error = read('n1_bad_badges', 'findById');
      expect(error).toBeUltimateError('X_N_PLUS_ONE_QUERY');
      expect(error.fix).toContain("db.n1_bad_badges.andWhere('id', 'in', ids).all()");
    } finally {
      clearRegistry();
      register();
    }
  });
});

describe('a write loop, fixed by the bulk form of the same call', () => {
  test('each single-row write names its own bulk call', () => {
    expect(write('n1_posts', 'insert').fix).toBe(
      'db.n1_posts.insertAll(rows)   # one statement for the whole set',
    );
    expect(write('n1_posts', 'update').fix).toBe(
      'db.n1_posts.updateWhere(filter, patch)   # one statement for the whole set',
    );
    expect(write('n1_posts', 'delete').fix).toBe(
      'db.n1_posts.deleteWhere(filter)   # one statement for the whole set',
    );
  });

  test('the cause and the code are the write half, never the read one', () => {
    const error = write('n1_posts', 'insert', 7);
    expect(error).toBeUltimateError('X_N_PLUS_ONE_WRITE');
    expect(error.cause).toBe('n1_posts.insert ran 7 times in one request — one write per row');
  });

  test('an op with no bulk form of its own names both, rather than guessing one', () => {
    const fix = write('n1_posts', 'insertAll').fix;
    expect(fix).toContain('db.n1_posts.insertAll(rows)');
    expect(fix).toContain('db.n1_posts.updateWhere(filter, patch)');
    expect(write('n1_posts', undefined).fix).toBe(fix);
  });

  test('hand-written SQL names the statement and the suppression, never a chain', () => {
    const fix = write(undefined, undefined).fix;
    expect(fix).toContain('insert … values');
    expect(fix).toContain("expectedQueryLoop('<why one per row is optimal>', fn)");
    expect(fix).not.toContain('db.undefined');
  });
});
