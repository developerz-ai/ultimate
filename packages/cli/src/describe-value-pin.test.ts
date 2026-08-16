// `@ultimat3/core` holds a character-for-character duplicate of `@ultimat3/schema`'s
// `describeValue`. It has to: both are tier 0, `SIDEWAYS_ALLOW` has no `core → schema` entry, and
// core declares `"dependencies": {}` — so neither package can import the other, and neither can
// check the duplicate against its source. The pin lives here for the same reason
// `schema-error-codes-pin.test.ts` does: `@ultimat3/cli` is tier 5 and may legally import both.
//
// What it protects is the one thing the duplicate exists for. `describeValue` is what a `cause:`
// prints INSTEAD of the offending value, so an edit to one copy alone means the same bad password
// is described one way by a schema parse and another by an error render — and a widening in one
// copy that leaks a value is a breach the other copy's test would never see.

import { describe, expect, test } from 'bun:test';
import { describeValue as coreDescribeValue } from '@ultimat3/core';
import { describeValue as schemaDescribeValue } from '@ultimat3/schema';

/**
 * One case per branch of both copies, plus the values a leak would show up in. `secret-token` and
 * `4111111111111111` are here on purpose: if either copy ever starts echoing its input, the
 * expectation below is what fails, and it fails naming the string that escaped.
 */
const CASES: readonly [label: string, value: unknown, expected: string][] = [
  ['undefined', undefined, 'undefined'],
  ['null', null, 'null'],
  ['empty string', '', 'an empty string'],
  ['one-character string', 'a', 'a string of 1 character'],
  ['a secret', 'secret-token', 'a string of 12 characters'],
  ['a card number', '4111111111111111', 'a string of 16 characters'],
  ['number', 42, 'a number'],
  ['NaN', Number.NaN, 'NaN'],
  ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
  ['-Infinity', Number.NEGATIVE_INFINITY, '-Infinity'],
  ['boolean', true, 'a boolean'],
  ['bigint', 1n, 'a bigint'],
  ['symbol', Symbol('s'), 'a symbol'],
  ['function', () => undefined, 'a function'],
  ['empty array', [], 'an empty array'],
  ['one-item array', [1], 'an array of 1 item'],
  ['array', [1, 2], 'an array of 2 items'],
  ['Date', new Date(0), 'a Date'],
  ['invalid Date', new Date(Number.NaN), 'an invalid Date'],
  ['object', { a: 1 }, 'an object'],
];

describe('core and schema describeValue are one function in two files', () => {
  for (const [label, value, expected] of CASES) {
    test(`${label} reads identically in both copies`, () => {
      expect(schemaDescribeValue(value)).toBe(expected);
      expect(coreDescribeValue(value)).toBe(expected);
    });
  }

  test('no case echoes the value it was given', () => {
    // The whole point of the duplicate. A copy that ever interpolated its input would pass every
    // shape test above for the branches that do not, and fail exactly here.
    for (const [, value] of CASES) {
      // Long enough that a substring hit means an echo and not a coincidence: `'a'` occurs in
      // `'a string of 1 character'` because English does, which is not a leak.
      if (typeof value !== 'string' || value.length < 4) continue;
      expect(schemaDescribeValue(value)).not.toContain(value);
      expect(coreDescribeValue(value)).not.toContain(value);
    }
  });
});
