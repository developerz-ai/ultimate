import { describe, expect, test } from 'bun:test';
import {
  interpolate,
  placeholdersOf,
  pluralCategory,
  pluralKeyCandidates,
  selectPluralKey,
} from './interpolate';

describe('interpolate', () => {
  test('substitutes and escapes braces', () => {
    expect(interpolate('Hi {name}', { name: 'Ada' })).toBe('Hi Ada');
    expect(interpolate('{{literal}} {name}', { name: 'x' })).toBe('{literal} x');
    expect(interpolate('no vars')).toBe('no vars');
  });

  test('renders an unknown variable loudly', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi ⟦name⟧');
  });

  test('lists the placeholders a template needs', () => {
    expect(placeholdersOf('{from}–{to} of {total}').sort()).toEqual(['from', 'to', 'total']);
  });
});

describe('plural selection', () => {
  test('uses CLDR categories, not an English one/other split', () => {
    expect(pluralCategory(1, 'ru')).toBe('one');
    expect(pluralCategory(2, 'ru')).toBe('few');
    expect(pluralCategory(5, 'ru')).toBe('many');
    expect(pluralCategory(21, 'ru')).toBe('one');
    expect(pluralCategory(0, 'en')).toBe('other');
    expect(pluralCategory(2, 'ja')).toBe('other');
  });

  test('candidate order prefers the exact category, then the two-form shortcut', () => {
    expect(pluralKeyCandidates('items', 5, 'ru')).toEqual([
      'items_many',
      'items_plural',
      'items_other',
      'items',
    ]);
    expect(pluralKeyCandidates('items', 1, 'ru')).toEqual(['items_one', 'items']);
  });

  test('falls back through the candidate list', () => {
    const twoForm = new Set(['items', 'items_plural']);
    expect(selectPluralKey('items', 5, 'ru', (key) => twoForm.has(key))).toBe('items_plural');
    expect(selectPluralKey('items', 1, 'ru', (key) => twoForm.has(key))).toBe('items');
    expect(selectPluralKey('nope', 5, 'ru', () => false)).toBe('nope');
  });
});
