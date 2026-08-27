// The literal grammar, one rule at a time, and the pass-through that keeps every other statement
// byte-identical. `array-parameter.live.test.ts` is the other half and the one that matters: this
// file asserts what the string looks like, and only Postgres can say whether it PARSES.

import { describe, expect, test } from 'bun:test';
import { encodeArrayParameters, pgArrayLiteral } from './array-parameter';

describe('unit · pgArrayLiteral', () => {
  test('renders braces, not the comma join Bun sends', () => {
    // The defect verbatim: `Bun.SQL` sends `x,y`, which Postgres reads as a malformed literal.
    expect(pgArrayLiteral(['x', 'y'])).toBe('{x,y}');
    expect(pgArrayLiteral([])).toBe('{}');
    expect(pgArrayLiteral(['default'])).toBe('{default}');
  });

  test('a uuid needs no quoting, which is what the two affected statements bind', () => {
    expect(pgArrayLiteral(['019b76da-a800-7397-9d07-a63ca80b3c96'])).toBe(
      '{019b76da-a800-7397-9d07-a63ca80b3c96}',
    );
  });

  // Each of these unquoted would change which elements Postgres reads, or how many.
  test.each([
    ['a comma splits one element into two', ['a,b'], '{"a,b"}'],
    ['a brace opens a dimension', ['a{b'], '{"a{b"}'],
    ['a quote opens an element', ['a"b'], '{"a\\"b"}'],
    ['a backslash escapes the next character', ['a\\b'], '{"a\\\\b"}'],
    ['surrounding whitespace is stripped', [' a '], '{" a "}'],
    ['the empty string is not an element at all', [''], '{""}'],
  ])('%s', (_why, values, expected) => {
    expect(pgArrayLiteral(values)).toBe(expected);
  });

  // `NULL` bare is the array NULL; `"NULL"` is the four-character string. A queue or a key really
  // spelled `NULL` must not become a null element, and a real null must not become that string.
  test('NULL is the value bare and the string quoted, and they are different things', () => {
    expect(pgArrayLiteral([null])).toBe('{NULL}');
    expect(pgArrayLiteral(['NULL'])).toBe('{"NULL"}');
    expect(pgArrayLiteral(['null'])).toBe('{"null"}');
  });

  test('a nested array is a dimension, never a flattened list', () => {
    expect(
      pgArrayLiteral([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBe('{{a,b},{c,d}}');
  });

  // Postgres has no jagged array, so a literal this function is willing to emit must be one the
  // server is willing to read. Measured on 17: `{{a,b},{c}}` is 22P02 while `{{a,b},{c,d}}` parses
  // (`array-parameter.live.test.ts`), which is what makes this a refusal rather than a taste.
  test('a ragged nest is refused, never rendered', () => {
    expect(() => pgArrayLiteral([['a', 'b'], ['c']])).toThrow(/ragged/);
  });

  // Mixed depth is the same malformed literal, and a rule comparing row LENGTHS alone lets it
  // through — there is no row to measure.
  test('a scalar beside a dimension is refused too', () => {
    expect(() => pgArrayLiteral(['a', ['b', 'c']])).toThrow(/mixes scalars and arrays/);
  });

  test('a Date renders as the instant, not as a locale string', () => {
    expect(pgArrayLiteral([new Date('2026-08-27T02:00:00.000Z')])).toBe(
      '{"2026-08-27T02:00:00.000Z"}',
    );
  });
});

describe('unit · encodeArrayParameters', () => {
  // Every statement the framework runs goes through this, and almost none binds an array — so the
  // common path must be the caller's own array object, unchanged, and not a copy per statement.
  test('a statement with no array parameter is handed through by identity', () => {
    const values = ['ada', 3, null, new Date(0)];
    expect(encodeArrayParameters(values)).toBe(values);
  });

  test('only the array positions are rewritten', () => {
    expect(encodeArrayParameters(['ada', ['a', 'b'], 7])).toEqual(['ada', '{a,b}', 7]);
  });

  // BYTEA, not an array. `Array.isArray` answers false for a typed array, and a `Uint8Array`
  // rendered as `{1,2,3}` would be a column of numbers where the caller meant bytes.
  test('a Uint8Array is bytes and is left alone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(encodeArrayParameters([bytes])[0]).toBe(bytes);
  });
});
