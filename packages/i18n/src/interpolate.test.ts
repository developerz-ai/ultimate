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

  test('an inherited property is not a variable', () => {
    // Without an own-property guard these walk `Object.prototype` and render a function's
    // source, `[object Object]` or `true` into a page — the same prototype reach
    // `catalog.ts` shuts off by nesting into null-prototype nodes.
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(interpolate(`x {${inherited}} y`, {})).toBe(`x ⟦${inherited}⟧ y`);
    }
  });

  test('an own property named like a prototype member still substitutes', () => {
    expect(interpolate('{toString}', { toString: 'ok' })).toBe('ok');
    expect(
      interpolate('{constructor}', Object.assign(Object.create(null), { constructor: 1 })),
    ).toBe('1');
  });

  test('un-escapes a closing brace with no opening one in sight', () => {
    // The `{`-only fast path let one escape mean two things: collapsed inside `{{a}}b`,
    // untouched in `a}}b`.
    expect(interpolate('a}}b')).toBe('a}b');
    expect(interpolate('{{a}}b')).toBe('{a}b');
    expect(interpolate('}}', { x: 1 })).toBe('}');
    expect(interpolate('a}b')).toBe('a}b');
    expect(interpolate('no braces at all')).toBe('no braces at all');
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
      'items_one',
    ]);
    // `one` keeps the BARE key second — in the two-form shortcut it is the singular — but still
    // ends on the same set every other category probes, because `Translator.has()` promises all
    // four. A shorter chain is one function in this package promising a string the other refuses.
    expect(pluralKeyCandidates('items', 1, 'ru')).toEqual([
      'items_one',
      'items',
      'items_plural',
      'items_other',
    ]);
  });

  test('never probes the same candidate twice', () => {
    // `other` used to emit `items_other` at both the category slot and the fallback slot.
    for (const [count, locale] of [
      [0, 'en'],
      [1, 'en'],
      [5, 'ru'],
      [2, 'ar'],
    ] as const) {
      const candidates = pluralKeyCandidates('items', count, locale);
      expect(candidates).toEqual([...new Set(candidates)]);
    }
  });

  test('a `one` count still resolves when only the plural forms are authored', () => {
    const otherOnly = new Set(['items_other', 'items_plural']);
    expect(selectPluralKey('items', 1, 'en', (key) => otherOnly.has(key))).toBe('items_plural');
  });

  test('falls back through the candidate list', () => {
    const twoForm = new Set(['items', 'items_plural']);
    expect(selectPluralKey('items', 5, 'ru', (key) => twoForm.has(key))).toBe('items_plural');
    expect(selectPluralKey('items', 1, 'ru', (key) => twoForm.has(key))).toBe('items');
    expect(selectPluralKey('nope', 5, 'ru', () => false)).toBe('nope');
  });
});
