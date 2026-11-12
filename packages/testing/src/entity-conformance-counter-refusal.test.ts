// A `defineDriver` store has no lifecycle hook, so it keeps no `countedIn` counter: a parent's count
// would never move there while memory and Postgres move it. Refused when the child's repository is
// built — at `database()`, before a row is written — never a count that silently stays put.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, database, entity, integer, memoryDriver, uuid } from '@ultimat3/entity';
import { defineDriver } from '@ultimat3/entity/adapter';
import { toyStore } from './entity-conformance-toy-fixture';
import { testName } from './test-types';

afterAll(() => clearRegistry());

const posts = entity('ecr_posts', {
  columns: { id: uuid().primaryKey(), likeCount: integer().default(0) },
});
const likes = entity('ecr_likes', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, { countedIn: () => posts.likeCount }),
  },
});
const plain = entity('ecr_plain', {
  columns: { id: uuid().primaryKey(), postId: uuid().references(() => posts.id) },
});

const refusal = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return isUltimateError(error) ? [error.code, error.meta?.['capability']] : String(error);
  }
  return 'built';
};

describe(testName('unit', 'a defineDriver store and a countedIn counter'), () => {
  test('a counted child is refused at database(), naming the counter', () => {
    expect(refusal(() => database({ posts, likes }, { driver: defineDriver(toyStore()) }))).toEqual(
      ['X_DRIVER_UNSUPPORTED', 'countedIn'],
    );
  });

  test('the parent alone, and a key that counts nothing, still build', () => {
    expect(refusal(() => database({ posts, plain }, { driver: defineDriver(toyStore()) }))).toBe(
      'built',
    );
  });

  test('the memory driver, which keeps the counter, builds the same set', () => {
    expect(refusal(() => database({ posts, likes }, { driver: memoryDriver() }))).toBe('built');
  });
});
