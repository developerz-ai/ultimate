// The declared optimistic lock in property space: the declaration's validation, which write shapes
// may carry the version, and the compare-and-increment a code-merging store applies.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import {
  assertUnversionedPatch,
  assertVersionedUpdate,
  assertVersionedUpsert,
  nextVersion,
  staleOrNotFound,
  versionColumnOf,
  versionedMerge,
  versionOf,
} from './version-lock';

const columnsOf = () => ({
  id: uuid().primaryKey(),
  title: text(),
  lockVersion: integer().default(0),
  loose: integer().nullable(),
  bare: integer(),
});
const columns = columnsOf();

/** A versioned entity before `entity()` takes `version`: the field the declaration sets. */
const posts = Object.defineProperty(entity('posts', { columns }), '$version', {
  value: 'lockVersion',
});
type Post = { id: string; title: string; lockVersion: number };

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('unit · versionColumnOf', () => {
  test('an integer with a default and NOT NULL is a lock column', () => {
    expect(versionColumnOf('posts', columns, 'lockVersion')).toBe('lockVersion');
    expect(versionColumnOf('posts', columns, undefined)).toBeNull();
  });

  test('anything else is refused where it is declared', () => {
    for (const bad of ['nope', 'title', 'loose', 'bare', 'id', 'constructor']) {
      expect(codeOf(() => versionColumnOf('posts', columns, bad))).toBe('X_ENTITY_VERSION_INVALID');
    }
  });
});

describe('unit · the write shapes', () => {
  test('update names the version it read, as an integer', () => {
    expect(assertVersionedUpdate(posts, { title: 'x', lockVersion: 3 })).toBe(3);
    expect(codeOf(() => assertVersionedUpdate(posts, { title: 'x' }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
    expect(codeOf(() => assertVersionedUpdate(posts, { title: 'x', lockVersion: undefined }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
    expect(codeOf(() => assertVersionedUpdate(posts, { lockVersion: null }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
    expect(codeOf(() => assertVersionedUpdate(posts, { lockVersion: 1.5 }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
  });

  test('an unversioned entity is untouched by every guard', () => {
    const plain = entity('plain', { columns: columnsOf() });
    expect(versionOf(plain)).toBeNull();
    expect(assertVersionedUpdate(plain, { title: 'x' })).toBeUndefined();
    assertUnversionedPatch(plain, { lockVersion: 4 }, 'updateWhere');
    assertVersionedUpsert(plain, 'update');
    expect(nextVersion(plain, { lockVersion: 4 })).toBeUndefined();
  });

  test('a filtered write may not set the version; the filter carries it instead', () => {
    assertUnversionedPatch(posts, { title: 'x' }, 'updateWhere');
    expect(codeOf(() => assertUnversionedPatch(posts, { lockVersion: 2 }, 'updateWhere'))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
  });

  test("upsertAll overwriting stored rows is refused; onMatch: 'nothing' is not", () => {
    assertVersionedUpsert(posts, 'nothing');
    expect(codeOf(() => assertVersionedUpsert(posts, 'update'))).toBe('X_ENTITY_VERSION_INVALID');
  });
});

describe('unit · versionedMerge', () => {
  const stored: Post = { id: 'a', title: 'old', lockVersion: 3 };
  const idOf = (row: Post): string => row.id;

  test('the version it read: merged, one past the stored version', () => {
    const merged = versionedMerge(
      posts as never,
      stored,
      { lockVersion: 3 },
      { ...stored, title: 'new' },
      idOf,
    );
    expect(merged).toEqual({ id: 'a', title: 'new', lockVersion: 4 });
  });

  test('a version the row has moved past is X_ENTITY_STALE (409)', () => {
    expect(
      codeOf(() => versionedMerge(posts as never, stored, { lockVersion: 2 }, stored, idOf)),
    ).toBe('X_ENTITY_STALE');
  });

  test('a write naming no version (a filtered one) still increments', () => {
    expect(versionedMerge(posts as never, stored, { title: 't' }, stored, idOf).lockVersion).toBe(
      4,
    );
  });

  test('nextVersion is the expected + 1 a value-setting store writes', () => {
    expect(nextVersion(posts, { lockVersion: 7 })).toBe(8);
  });
});

describe('unit · staleOrNotFound', () => {
  test('a row still there is stale, naming its stored version; gone is X_NOT_FOUND', async () => {
    const stale = await staleOrNotFound(posts as never, 'a', { lockVersion: 1 }, async () => ({
      id: 'a',
      title: 't',
      lockVersion: 5,
    }));
    expect(isUltimateError(stale) && stale.code).toBe('X_ENTITY_STALE');
    expect(stale.message + (isUltimateError(stale) ? stale.cause : '')).toContain('5');
    const gone = await staleOrNotFound(posts as never, 'a', { lockVersion: 1 }, async () => null);
    expect(isUltimateError(gone) && gone.code).toBe('X_NOT_FOUND');
  });
});
