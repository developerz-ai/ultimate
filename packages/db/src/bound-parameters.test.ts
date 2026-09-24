// The one encoder `sendOn` runs over a statement's values before `Bun.SQL` sees them.

import { describe, expect, test } from 'bun:test';
import { encodeBoundParameters } from './bound-parameters';

describe('unit · encodeBoundParameters', () => {
  test('a statement with nothing to encode is handed through by identity', () => {
    const values = ['ada', 3, null, true, 7n, new Uint8Array([1])];
    expect(encodeBoundParameters(values)).toBe(values);
  });

  // On an UNNAMED statement (`prepare: false`) `Bun.SQL` has no described type to go by, and sent
  // a `Date` as `Date.prototype.toString()` — a local-zone string Postgres refuses.
  test('a Date becomes its ISO-8601 instant', () => {
    expect(encodeBoundParameters(['a', new Date(Date.UTC(2026, 0, 1))])).toEqual([
      'a',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  test('an array is still the Postgres array literal', () => {
    expect(encodeBoundParameters([['a', 'b'], 1])).toEqual(['{a,b}', 1]);
  });
});
