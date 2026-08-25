// The grammar both directions depend on. A `name` attribute that does not parse back to the
// segments an issue path formats from is a rejection that reaches no control.

import { describe, expect, test } from 'bun:test';
import { formatFieldPath, MAX_FIELD_INDEX, parseFieldPath } from './field-path';

describe('formatFieldPath', () => {
  test('renders a nested array path exactly as the server does', () => {
    expect(formatFieldPath(['items', 2, 'price'])).toBe('items[2].price');
  });

  test('accepts the wrapped segments a Standard Schema issue carries', () => {
    expect(formatFieldPath([{ key: 'items' }, { key: 0 }, { key: 'price' }])).toBe(
      'items[0].price',
    );
  });

  test('an absent or empty path is the form itself, never a field named ""', () => {
    expect(formatFieldPath(undefined)).toBe('');
    expect(formatFieldPath([])).toBe('');
  });

  test('a leading index keeps its brackets — the root is an array, not a key', () => {
    expect(formatFieldPath([0, 'price'])).toBe('[0].price');
  });
});

describe('parseFieldPath', () => {
  test('round-trips the path format', () => {
    const parsed = parseFieldPath('items[2].price');
    expect(parsed).toEqual(['items', 2, 'price']);
    expect(formatFieldPath(parsed ?? [])).toBe('items[2].price');
  });

  test('reads consecutive indexes', () => {
    expect(parseFieldPath('grid[0][1]')).toEqual(['grid', 0, 1]);
  });

  test('refuses a prototype-reaching key — a control named __proto__ is not a field', () => {
    expect(parseFieldPath('__proto__')).toBeNull();
    expect(parseFieldPath('user.__proto__.role')).toBeNull();
    expect(parseFieldPath('user.constructor')).toBeNull();
    expect(parseFieldPath('user.prototype')).toBeNull();
  });

  test('refuses malformed names rather than guessing at them', () => {
    for (const name of ['', '.', 'a.', '.a', 'a..b', 'items[]', 'items[a]', 'items[0', 'a b']) {
      expect(parseFieldPath(name)).toBeNull();
    }
  });

  test('refuses an index that does not round-trip, so the two directions cannot disagree', () => {
    expect(parseFieldPath('items[01]')).toBeNull();
  });

  test('refuses an index no form has, which is the one that allocates', () => {
    expect(parseFieldPath(`items[${MAX_FIELD_INDEX}]`)).toEqual(['items', MAX_FIELD_INDEX]);
    expect(parseFieldPath(`items[${MAX_FIELD_INDEX + 1}]`)).toBeNull();
  });
});
