// One declaration, two enforcement points — so this file only ever asserts the two together. A
// rule the app accepts and the CHECK refuses is not a stricter database, it is a row that reaches
// Postgres as a raw constraint error instead of `X_INVARIANT_VIOLATED`.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { invariantColumns } from './expr';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const c = invariantColumns('expr_test_posts', ['slug', 'title']);
/** Physical names are the entity's job; here the property name IS the column. */
const resolve = (path: readonly string[]): string => path.join('_');

const codeOf = (build: () => unknown): string => {
  try {
    build();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

describe('matches(/…/) reaches the database with its flags, or not at all', () => {
  test('a case-insensitive pattern compiles to ~*, so both halves accept the same row', () => {
    const rule = c.slug.matches(/^[A-Z]+$/i);
    expect(rule.holds({ slug: 'abc' })).toBe(true);
    // `~` is case-SENSITIVE in Postgres: the old emission rejected the row `holds` had approved.
    expect(rule.toSql(resolve)).toBe("slug ~* '^[A-Z]+$'");
  });

  test('a plain pattern still compiles to ~', () => {
    expect(c.slug.matches(/^[a-z]+$/).toSql(resolve)).toBe("slug ~ '^[a-z]+$'");
  });

  test('a flag Postgres has no operator for is refused where the rule is written', () => {
    // Not "emitted without it": `/^a$/m` means something different line by line, and a CHECK that
    // silently drops it is the same disagreement one flag along.
    for (const pattern of [/^a$/m, /a/s, /a/gi, /a/u, /a/y]) {
      expect(codeOf(() => c.slug.matches(pattern))).toBe('X_INVARIANT_VIOLATED');
    }
  });

  test('a JS predicate is still app-only and still reports no SQL', () => {
    const rule = c.slug.matches((value) => value.startsWith('x'));
    expect(rule.toSql(resolve)).toBeNull();
    expect(rule.holds({ slug: 'xy' })).toBe(true);
  });
});

describe('minLength counts what Postgres counts', () => {
  test('an astral character is ONE character in both halves', () => {
    // `char_length('👍')` is 1 in Postgres; `'👍'.length` is 2 in JS. The old predicate approved a
    // row the CHECK then refused, so the framework's own invariant was bypassed on the way out.
    const rule = c.title.minLength(2);
    expect(rule.toSql(resolve)).toBe('char_length(title) >= 2');
    expect(rule.holds({ title: '👍' })).toBe(false);
    expect(rule.holds({ title: '👍👍' })).toBe(true);
    expect(rule.holds({ title: 'ab' })).toBe(true);
  });

  test('a combining sequence counts its code points, exactly as char_length does', () => {
    // `char_length('é')` for `e` + U+0301 is 2 — Postgres counts characters, not graphemes, and so
    // does this. Agreeing with the database beats agreeing with a human's idea of a letter.
    expect(c.title.minLength(2).holds({ title: 'é' })).toBe(true);
  });
});
