// The matcher runs on both sides of the round trip, so the cases that matter are the ones where
// a naive `includes` would disagree with a user: case, accents, and which match comes first.

import { describe, expect, test } from 'bun:test';
import { COMBOBOX_LIMIT, filterOptions, normalizeQuery } from './combobox-filter';

const options = [
  { value: 'Berlin' },
  { value: 'Bern' },
  { value: 'Zürich', hint: 'Switzerland' },
  { value: 'Bordeaux', hint: 'France' },
  { value: 'Amberg' },
];

const values = (query: string): string[] =>
  filterOptions(options, query).map((option) => option.value);

describe('normalizeQuery', () => {
  test('folds case, accents and outer whitespace', () => {
    expect(normalizeQuery('  Zürich ')).toBe('zurich');
    expect(normalizeQuery('CAFÉ')).toBe('cafe');
  });
});

describe('filterOptions', () => {
  test('an empty query offers everything, capped', () => {
    expect(values('')).toEqual(['Berlin', 'Bern', 'Zürich', 'Bordeaux', 'Amberg']);
    expect(filterOptions(options, '   ')).toHaveLength(5);
  });

  test('prefix matches come before substring matches', () => {
    expect(values('ber')).toEqual(['Berlin', 'Bern', 'Amberg']);
    expect(values('rn')).toEqual(['Bern']);
  });

  test('accents and case are ignored on both sides', () => {
    expect(values('zur')).toEqual(['Zürich']);
    expect(values('ZÜRICH')).toEqual(['Zürich']);
  });

  test('the hint is searchable, so "France" finds Bordeaux', () => {
    expect(values('france')).toEqual(['Bordeaux']);
  });

  test('no match is an empty list, never the unfiltered one', () => {
    expect(values('xyz')).toEqual([]);
  });

  test('the cap is applied to matches, not to the input', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ value: `item-${index}` }));
    expect(filterOptions(many, 'item')).toHaveLength(COMBOBOX_LIMIT);
    expect(filterOptions(many, 'item', 5)).toHaveLength(5);
    expect(filterOptions(many, '', 3)).toHaveLength(3);
  });
});

/**
 * `limit` is a BARE PARAMETER DEFAULT, so `??` never runs and `NaN` reaches `slice(0, NaN)`, which
 * is `[]`. Every suggestion vanishes and `<Combobox>` renders "no results" — a filter reporting
 * that nothing matches when the caller's cap is what matched nothing. `Infinity` is the mirror:
 * every option rendered, out of the function whose whole job is that long lists are a scroll.
 */
describe('a suggestion cap that is not a cap', () => {
  const many = Array.from({ length: 40 }, (_unused, index) => ({ value: `item ${String(index)}` }));

  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
    test(`limit: ${String(limit)} is refused, never an empty list called "no results"`, () => {
      expect(() => filterOptions(many, 'item', limit)).toThrow(/X_INVARIANT/);
      expect(() => filterOptions(many, '', limit)).toThrow(/X_INVARIANT/);
    });
  }

  test('limit: 0 renders nothing on purpose, and the default still applies', () => {
    expect(filterOptions(many, 'item', 0)).toHaveLength(0);
    expect(filterOptions(many, 'item')).toHaveLength(COMBOBOX_LIMIT);
  });
});
