// The codec's own edges: what is tagged, what an app's look-alike key becomes, and what a value
// the codec did not write decodes to. The tier-level claim is `tier-value-shape.test.ts`.

import { describe, expect, test } from 'bun:test';
import { CacheValueUnencodableError } from './errors';
import {
  CACHE_CODEC_MARK,
  decodeCacheValue,
  encodeCacheValue,
  MAX_CACHE_BIGINT_DIGITS,
  MAX_CACHE_VALUE_DEPTH,
} from './value-codec';

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
    expect(decodeCacheValue(`${CACHE_CODEC_MARK}${text}`)).toEqual(JSON.parse(text));
  });

  test('a top-level undefined encodes as null rather than as no text at all', () => {
    expect(encodeCacheValue(undefined, AT)).toBe(`${CACHE_CODEC_MARK}null`);
  });
});

/** A value nested `depth` arrays deep, built without recursion. */
const nested = (depth: number): unknown => {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
};

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof CacheValueUnencodableError ? error.code : 'bare';
  }
  return 'accepted';
};

describe('a value is stored and readable, or refused — never written and then unreadable', () => {
  test('nesting past MAX_CACHE_VALUE_DEPTH is refused at the write', () => {
    expect(codeOf(() => encodeCacheValue(nested(20_000), AT))).toBe('X_CACHE_VALUE_UNENCODABLE');
    expect(codeOf(() => encodeCacheValue(nested(MAX_CACHE_VALUE_DEPTH + 1), AT))).toBe(
      'X_CACHE_VALUE_UNENCODABLE',
    );
  });

  test('nesting at the cap round-trips, including through tagged Maps', () => {
    expect(roundTrip(nested(MAX_CACHE_VALUE_DEPTH - 1))).toEqual(nested(MAX_CACHE_VALUE_DEPTH - 1));
    const map = new Map([['k', nested(10)]]);
    expect(roundTrip(map)).toEqual(map);
  });

  test('a bigint past MAX_CACHE_BIGINT_DIGITS is refused at the write', () => {
    const huge = 10n ** BigInt(MAX_CACHE_BIGINT_DIGITS);
    expect(codeOf(() => encodeCacheValue(huge, AT))).toBe('X_CACHE_VALUE_UNENCODABLE');
    expect(roundTrip(10n ** BigInt(MAX_CACHE_BIGINT_DIGITS - 1))).toBe(
      10n ** BigInt(MAX_CACHE_BIGINT_DIGITS - 1),
    );
  });
});

describe('only text the codec wrote is revived', () => {
  test('unmarked plain JSON from a pre-codec pod is never revived or renamed', () => {
    expect(decodeCacheValue('{"$x":"bigint","v":"12"}')).toEqual({ $x: 'bigint', v: '12' });
    expect(decodeCacheValue('{"$$x":1}')).toEqual({ $$x: 1 });
    expect(decodeCacheValue('{"v":{"$x":"date","v":"2026-10-07T00:00:00.000Z"},"t":[]}')).toEqual({
      v: { $x: 'date', v: '2026-10-07T00:00:00.000Z' },
      t: [],
    });
  });

  test('a forged million-digit bigint tag is left alone, never a RangeError or a 1s parse', () => {
    const text = encodeCacheValue({ v: 1n }, AT).replace('"1"', `"${'9'.repeat(1_000_000)}"`);
    const started = performance.now();
    const back = decodeCacheValue(text) as { v: unknown };
    expect(typeof back.v).not.toBe('bigint');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
