// The order Postgres gives a `numeric` or an `int8`, over the TEXT those columns' row values are.
// `["10","100","2","9"]` is what `String(left) < String(right)` answers for a `bigint` column and
// `["2","9","10","100"]` is what the database answers — one keyset page boundary cut where the
// database never cuts one.

import { describe, expect, test } from 'bun:test';
import { compareDecimalText } from './decimal-order';

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => compareDecimalText(left, right) ?? 0);

describe('compareDecimalText orders digits, never their spelling', () => {
  test('magnitude beats character order — the whole of the defect', () => {
    expect(sorted(['9', '10', '100', '2'])).toEqual(['2', '9', '10', '100']);
  });

  test('exact past 2^53, where a Number would round two values onto one', () => {
    expect(compareDecimalText('9007199254740992', '9007199254740993')).toBe(-1);
    expect(Number('9007199254740992') === Number('9007199254740993')).toBe(true);
  });

  test('exact at 38 digits, which is a numeric a Number cannot hold at all', () => {
    const base = '1'.repeat(38);
    expect(compareDecimalText(base, `${base.slice(0, 37)}2`)).toBe(-1);
  });

  test('a fraction is padded rather than compared as text', () => {
    expect(compareDecimalText('1.5', '1.25')).toBe(1);
    expect(compareDecimalText('1.50', '1.5')).toBe(0);
    expect(sorted(['0.9', '0.10', '0.100', '0.2'])).toEqual(['0.10', '0.100', '0.2', '0.9']);
  });

  test('negatives invert, and two equal negatives are a plain zero and never -0', () => {
    expect(sorted(['-9', '-10', '0', '10', '9'])).toEqual(['-10', '-9', '0', '9', '10']);
    expect(Object.is(compareDecimalText('-1.0', '-1'), 0)).toBe(true);
  });

  test('a sign and a leading zero are spelling, not value', () => {
    expect(compareDecimalText('+7', '007')).toBe(0);
  });

  test('a bigint and a number are the digits they spell', () => {
    expect(compareDecimalText(9n, '10')).toBe(-1);
    expect(compareDecimalText(2, '10')).toBe(-1);
  });
});

/**
 * Both, or neither. A caller that knows the column's kind asks; one that does not must not — and
 * a value a `numeric` column cannot hold is not a value Postgres would be ordering either, so it
 * falls back to the caller's own rule rather than being guessed at.
 */
describe('it answers undefined rather than guessing', () => {
  test('anything that is not a plain decimal is not one side of a numeric comparison', () => {
    for (const value of ['', ' ', 'abc', '1e21', String(1e21), 'NaN', null, undefined, {}, true]) {
      expect(compareDecimalText(value, '1')).toBeUndefined();
      expect(compareDecimalText('1', value)).toBeUndefined();
    }
  });
});
