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
