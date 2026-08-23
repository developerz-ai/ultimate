/** unit — the four values that are objects to `typeof` and are not records to a caller. */

import { describe, expect, test } from 'bun:test';
import { isJsonObject } from './json-object';

describe('isJsonObject', () => {
  test('narrows a keyed record and nothing else `typeof` calls an object', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ code: 'X_TIMEOUT' })).toBe(true);
    expect(isJsonObject(Object.create(null))).toBe(true);

    // The two `typeof value === 'object'` alone accepts, and both are why the extra terms exist:
    // `null` would index-fault on the first read, an array would answer numeric keys.
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ a: 1 }])).toBe(false);
  });

  test('rejects every primitive, including the ones that carry keys', () => {
    expect(isJsonObject(undefined)).toBe(false);
    expect(isJsonObject('{"a":1}')).toBe(false);
    expect(isJsonObject(0)).toBe(false);
    expect(isJsonObject(false)).toBe(false);
    expect(isJsonObject(() => 1)).toBe(false);
  });

  test('a Date passes, deliberately — this is a shape test, not a provenance test', () => {
    // Pinned because the opposite reading is the tempting one: a caller wanting "parsed JSON"
    // has already called `JSON.parse`, and narrowing here would duplicate @ultimat3/schema.
    expect(isJsonObject(new Date(0))).toBe(true);
  });
});
