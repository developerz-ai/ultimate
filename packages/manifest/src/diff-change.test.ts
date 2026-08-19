// The vocabulary the whole `diff-*` family is built on. Every classifier delegates its scalar
// comparisons here, so a rule loosened in this file loosens the contract gate everywhere at once —
// and none of the three helpers had a test of its own.

import { describe, expect, test } from 'bun:test';
import { diffNamedSet, diffScalar, index } from './diff-change';

describe('index', () => {
  test('keys by the extractor, and the LAST duplicate wins', () => {
    const items = [
      { name: 'a', v: 1 },
      { name: 'b', v: 2 },
      { name: 'a', v: 3 },
    ];
    const byName = index(items, (item) => item.name);
    expect([...byName.keys()]).toEqual(['a', 'b']);
    expect(byName.get('a')?.v).toBe(3);
    expect(byName.get('b')?.v).toBe(2);
    expect(byName.get('missing')).toBeUndefined();
  });

  test('an empty list is an empty map, not a map of one undefined', () => {
    expect(index([], (item: { name: string }) => item.name).size).toBe(0);
  });
});

describe('diffNamedSet', () => {
  test('reports what left and what arrived, and nothing about what stayed', () => {
    const changes = diffNamedSet('permissions', ['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(changes).toEqual([
      { kind: 'breaking', path: 'permissions.a', detail: 'removed' },
      { kind: 'additive', path: 'permissions.d', detail: 'added' },
    ]);
    expect(diffNamedSet('permissions', ['a'], ['a'])).toEqual([]);
  });

  test('removal is breaking by default and additive only where the caller says so', () => {
    // The two callers in `diff.ts`: a permission disappearing breaks a grant, a locale
    // disappearing does not break a caller.
    expect(diffNamedSet('permissions', ['a'], [])[0]?.kind).toBe('breaking');
    expect(diffNamedSet('locales', ['fr'], [], 'additive')[0]?.kind).toBe('additive');
    // The ADDITION side is not configurable — an added name is additive whatever the removal
    // kind is, because nothing that worked stops working.
    expect(diffNamedSet('locales', [], ['fr'], 'additive')[0]?.kind).toBe('additive');
    expect(diffNamedSet('permissions', [], ['a'])[0]?.kind).toBe('additive');
  });

  test('a duplicated name is not reported twice against the same set', () => {
    // `before` is a file off disk; a hand-edited list can repeat a name.
    expect(diffNamedSet('permissions', ['a', 'a'], ['a'])).toEqual([]);
  });
});

describe('diffScalar', () => {
  test('an equal pair is no change, whatever kind was asked for', () => {
    expect(diffScalar('breaking', 'p', 'x', 'x')).toEqual([]);
    expect(diffScalar('breaking', 'p', 3, 3)).toEqual([]);
    expect(diffScalar('breaking', 'p', false, false)).toEqual([]);
  });

  test('a changed pair renders `from -> to` unless the caller supplies a detail', () => {
    expect(diffScalar('breaking', 'routes./x.surface', 'site', 'api')).toEqual([
      { kind: 'breaking', path: 'routes./x.surface', detail: 'site -> api' },
    ]);
    // Non-strings go through `String`, so a numeric field reads the same way.
    expect(diffScalar('internal', 'p', 1, 2)[0]?.detail).toBe('1 -> 2');
    expect(
      diffScalar('internal', 'p', 'a', 'b', (from, to) => `renamed ${from} to ${to}`)[0]?.detail,
    ).toBe('renamed a to b');
  });

  test('the kind is the caller’s, not inferred from the values', () => {
    expect(diffScalar('internal', 'p', 'a', 'b')[0]?.kind).toBe('internal');
    expect(diffScalar('additive', 'p', 'a', 'b')[0]?.kind).toBe('additive');
  });

  // The regression the guard exists for: `before` is a manifest parsed off disk, so a field it
  // predates is ABSENT. Reading absence as a value reported every route in an upgraded app as
  // newly re-surfaced, on a diff where nothing had changed.
  test('absence on either side is no evidence, and false is not absence', () => {
    expect(diffScalar('breaking', 'p', undefined, 'api')).toEqual([]);
    expect(diffScalar('breaking', 'p', 'site', undefined)).toEqual([]);
    expect(diffScalar('breaking', 'p', null, 'api')).toEqual([]);
    expect(diffScalar('breaking', 'p', 'site', null)).toEqual([]);
    expect(diffScalar('breaking', 'p', undefined, undefined)).toEqual([]);
    // `false`, `0` and `''` are values a field really holds — they must still be compared.
    expect(diffScalar('breaking', 'p', false, true)[0]?.detail).toBe('false -> true');
    expect(diffScalar('breaking', 'p', 0, 1)[0]?.detail).toBe('0 -> 1');
    expect(diffScalar('breaking', 'p', '', 'x')[0]?.detail).toBe(' -> x');
  });
});
