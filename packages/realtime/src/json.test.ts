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

  /**
   * A qid is `stableDigest(canonicalJson(input))`, and a qid HIT hands the joiner the existing
   * entry — the first subscriber's compiled source, matcher and seated row window. So two inputs
   * that canonicalise to one string are two clients served out of one window. `JSON.stringify`
   * folds `NaN` and `±Infinity` onto `null` and spells `-0` as `"0"`, which is the whole of what
   * these pin.
   */
  test('the four values `JSON.stringify` folds onto `null` are four canonical forms', () => {
    const forms = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map((n) =>
      canonicalJson({ limit: n }),
    );
    expect(new Set(forms).size).toBe(4);
  });

  /**
   * `-0` is the one of the four a client can put on the wire: `JSON.parse('{"a":-0}')` answers
   * `-0`, while `NaN` and `±Infinity` have no JSON spelling at all and can only arrive from a
   * caller that builds `input` in JS — `useLive(feed, () => ({ limit: Number.parseInt(raw) }))`
   * with an unparseable `raw`, or a row column in the client's identity map.
   */
  test('-0 and 0 are two subscriptions, so they are two canonical forms', () => {
    expect(canonicalJson({ limit: -0 })).not.toBe(canonicalJson({ limit: 0 }));
  });

  test('a bare token cannot collide with the string that spells it', () => {
    const pairs = [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
      [-0, '-0'],
    ] as const;
    for (const [number, text] of pairs) {
      expect(canonicalJson({ limit: number })).not.toBe(canonicalJson({ limit: text }));
    }
  });

  test('an ordinary input is unchanged, so no live subscription re-keyed', () => {
    expect(canonicalJson({ orgId: 'org-a', limit: 50, ratio: 1.5, ok: true, tail: null })).toBe(
      '{"limit":50,"ok":true,"orgId":"org-a","ratio":1.5,"tail":null}',
    );
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
