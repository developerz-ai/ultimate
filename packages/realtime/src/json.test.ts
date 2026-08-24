// The value domain. This package owns NO hash: `canonicalJson` and the sharing-key `fingerprint`
// are `@ultimat3/core`'s, and the 32-bit `fnv1a` that stayed behind for `LiveCursor.digest` was
// deleted with it (2026-08-24). The pin that used to live here — "fnv1a is never the sharing key,
// because 32 bits is a collision anyone finds offline in seconds" — is now enforced by the module
// not exporting one, which is the stronger form of the same rule.

import { describe, expect, test } from 'bun:test';
import { changedColumns, isRow } from './json';

describe('changedColumns is what an update patch carries', () => {
  test('answers only what moved, so a patch is not a whole row', () => {
    expect(
      changedColumns({ id: 'p1', likes: 0, title: 't' }, { id: 'p1', likes: 1, title: 't' }),
    ).toEqual({
      likes: 1,
    });
  });

  test('an insert has no before, so every column is a change', () => {
    expect(changedColumns(null, { id: 'p1', likes: 0 })).toEqual({ id: 'p1', likes: 0 });
  });

  test('compares nested values structurally, not by reference', () => {
    expect(changedColumns({ id: 'p1', tags: ['a'] }, { id: 'p1', tags: ['a'] })).toEqual({});
    expect(changedColumns({ id: 'p1', tags: ['a'] }, { id: 'p1', tags: ['b'] })).toEqual({
      tags: ['b'],
    });
  });
});

describe('isRow', () => {
  test('requires a string id, because every window and every map is keyed by one', () => {
    expect(isRow({ id: 'p1' })).toBe(true);
    expect(isRow({ id: 1 })).toBe(false);
    expect(isRow({})).toBe(false);
    expect(isRow(null)).toBe(false);
    expect(isRow(['id'])).toBe(false);
  });
});
