// The two hashes this package keys things by, and the canonical form both of them read. They are
// not interchangeable and they do not look different: `stableDigest` is the SHARING key a `qid` is
// built from, `fnv1a` is a cursor's drift check, and a swap between them is invisible at a call
// site — so the difference is pinned here, beside the declarations, rather than at one caller.

import { describe, expect, test } from 'bun:test';
import { canonicalJson, changedColumns, fnv1a, isRow, stableDigest } from './json';

describe('stableDigest', () => {
  test('is 16 hex characters — 64 bits, the width entity cursors already chose', () => {
    expect(stableDigest('anything')).toMatch(/^[0-9a-f]{16}$/);
    expect(stableDigest('a')).not.toBe(stableDigest('b'));
    expect(stableDigest('a')).toBe(stableDigest('a'));
  });

  test('is SHA-256 and not something that merely answers 16 hex characters', () => {
    // Computed here rather than through the function under test, so swapping the primitive under
    // it is a failing test instead of a green one that agrees with itself.
    const expected = new Bun.CryptoHasher('sha256').update('x').digest('hex').slice(0, 16);
    expect(stableDigest('x')).toBe(expected);
  });
});

describe('fnv1a is the other one, and it is never a sharing key', () => {
  test('answers 8 hex characters, so its 32 bits are visible in the value itself', () => {
    expect(fnv1a('anything')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  test('and the two never agree, so a call site cannot have silently taken the wrong one', () => {
    expect(fnv1a('x')).not.toBe(stableDigest('x'));
    expect(fnv1a('x').length).not.toBe(stableDigest('x').length);
  });
});

describe('canonicalJson', () => {
  test('sorts keys at every depth, so property order cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test('keeps array order, which is data rather than spelling', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test('distinguishes values `JSON.stringify` would flatten to the same text', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('null')).toBe('"null"');
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
