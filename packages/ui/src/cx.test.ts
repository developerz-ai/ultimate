import { describe, expect, test } from 'bun:test';
import { cx } from './cx';

describe('cx', () => {
  test('joins strings and drops falsy values', () => {
    expect(cx('a', undefined, null, false, '', 'b')).toBe('a b');
  });

  test('emits object keys only when truthy', () => {
    expect(cx('btn', { 'btn--primary': true, 'btn--ghost': false })).toBe('btn btn--primary');
  });

  test('flattens nested arrays', () => {
    expect(cx(['a', ['b', { c: true }]], 'd')).toBe('a b c d');
  });

  test('collapses duplicates so repeated module classes stay stable', () => {
    expect(cx('a b', 'b', ['a'])).toBe('a b');
  });

  test('returns an empty string when nothing is truthy', () => {
    expect(cx(false, null, undefined, {})).toBe('');
  });
});
