// The codec's own edges: what is tagged, what an app's look-alike key becomes, and what a value
// the codec did not write decodes to. The tier-level claim is `tier-value-shape.test.ts`.

import { describe, expect, test } from 'bun:test';
import { decodeCacheValue, encodeCacheValue } from './value-codec';

const AT = { key: 'k', tier: 'lru' };
const roundTrip = (value: unknown): unknown => decodeCacheValue(encodeCacheValue(value, AT));

describe('encodeCacheValue / decodeCacheValue', () => {
  test('a top-level Date and bigint survive, not only nested ones', () => {
    expect(roundTrip(new Date(0))).toEqual(new Date(0));
    expect(roundTrip(-12n)).toBe(-12n);
  });

  test('an Invalid Date stays an Invalid Date rather than throwing in toISOString', () => {
    const back = roundTrip(new Date(Number.NaN));
    expect(back).toBeInstanceOf(Date);
    expect(Number.isNaN((back as Date).getTime())).toBe(true);
  });

  test("an app object that LOOKS like a tag comes back as the app's object", () => {
    const lookalikes = [
      { $x: 'date', v: '2026-10-07T00:00:00.000Z' },
      { $$x: 'bigint', v: '1' },
      { $x: 'set', v: [1], $$$x: 2, other: true },
    ];
    for (const value of lookalikes) expect(roundTrip(value)).toEqual(value);
  });

  test('a Map keyed by non-strings keeps its keys, and nests tagged values', () => {
    const value = new Map<unknown, unknown>([
      [1, new Date(5)],
      [2n, new Set([3n])],
    ]);
    expect(roundTrip(value)).toEqual(value);
  });

  test('plain JSON written before the codec decodes as JSON.parse would', () => {
    for (const text of ['{"v":{"a":[1,"2",null]},"t":[]}', '"plain"', '{"$x":"nope","v":1}']) {
      expect(decodeCacheValue(text)).toEqual(JSON.parse(text));
    }
  });

  test('a malformed tag is left alone, never a throw from BigInt or new Map', () => {
    const text = '[{"$x":"bigint","v":"1.5"},{"$x":"map","v":[1]}]';
    expect(decodeCacheValue(text)).toEqual(JSON.parse(text));
  });

  test('a top-level undefined encodes as null rather than as no text at all', () => {
    expect(encodeCacheValue(undefined, AT)).toBe('null');
  });
});
