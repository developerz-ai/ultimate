// `stableStringify` is the DOCUMENT form and it has exactly one duty the hash form may not have:
// `serializeOpenApi` publishes what it emits as `openapi.json` and `json-schema.ts` re-reads it
// with `JSON.parse`. The bare token `NaN` — which `@ultimat3/core`'s `canonicalJson` emits, and
// must — would make a published spec unparseable, which is why these are two functions.

import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '@ultimat3/core';
import { stableStringify } from './stable';

describe('stableStringify keeps the DOCUMENT duty: what it emits is valid JSON', () => {
  test('a non-finite number is `null`, because `NaN` is not a JSON token', () => {
    const document = stableStringify({ maximum: Number.POSITIVE_INFINITY, minimum: Number.NaN }, 2);
    expect(JSON.parse(document)).toEqual({ maximum: null, minimum: null });
  });

  test('a date is its ISO string, and a map and a set are the empty object', () => {
    const value = {
      at: new Date('2020-01-01T00:00:00.000Z'),
      m: new Map([['a', 1]]),
      s: new Set([1]),
    };
    expect(JSON.parse(stableStringify(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  test('keys are sorted at every depth, so a published spec is byte-stable', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

/**
 * And what the split cost: nothing, for any payload carrying none of the values the two forms
 * disagree about. `requestHash` and the job dedupe key are taken over the hash form, so this is
 * the assertion that says no idempotency record and no enqueued job moved when it left this file.
 */
describe('the two forms agree on everything they are not about', () => {
  test('an ordinary payload is byte-identical to core canonical form', () => {
    const input = { amount: 100, currency: 'EUR', items: [1, 2.5, null], ok: true, id: 7n };
    expect(canonicalJson(input)).toBe(stableStringify(input));
  });
});
