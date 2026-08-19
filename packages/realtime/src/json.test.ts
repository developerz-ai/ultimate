// The value domain, and the one hash this package still owns. `fnv1a` is the cursor's drift check
// and it is NEVER a sharing key: the sharing key is `@ultimat3/core`'s `fingerprint`, which is
// SHA-256 and twice as wide. A swap between them is invisible at a call site — 32 bits is a
// collision anyone can find offline in seconds, and a `qid` built from one is one client served
// out of another's window — so the difference is pinned here, beside the declaration that stayed.

import { describe, expect, test } from 'bun:test';
import { fingerprint } from '@ultimat3/core';
import { changedColumns, fnv1a, isRow } from './json';

describe('fnv1a is the drift check, and it is never a sharing key', () => {
  test('answers 8 hex characters, so its 32 bits are visible in the value itself', () => {
    expect(fnv1a('anything')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  test('and it never agrees with the sharing key, so a call site cannot have taken the wrong one', () => {
    expect(fnv1a('x')).not.toBe(fingerprint('x'));
    expect(fnv1a('x').length).not.toBe(fingerprint('x').length);
  });
});

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
