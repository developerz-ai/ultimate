// `queryHash` is the read's IDENTITY, and three durable things are keyed by it: the read-cache
// entry `cacheKeyFor` fills, the scope a cursor is signed against (`pagination.ts`) and the live
// query id a subscription window is shared under (`live.ts`). So two different inputs sharing one
// hash is one caller served another caller's rows — for the TTL, for a whole page two, and for the
// life of a subscription.
//
// A `Date` is the value that reaches here: `http.ts` decodes a query string through `coerceQuery`,
// which turns a `t.date` member into a real `Date`, and `input-shape.ts` permits `date` members on
// purpose. It has no own enumerable key, so the object branch rendered every date as `{}` and one
// key answered for every date window that read ever served.

import { describe, expect, test } from 'bun:test';
import { cacheKeyFor } from './cache';
import { queryHash } from './query';

const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

describe('queryHash separates the values a parsed input actually holds', () => {
  test('two date windows are two hashes, and neither is the empty object', () => {
    const first = queryHash('feed', range('2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z'));
    const second = queryHash('feed', range('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
    expect(first).not.toBe(second);
    expect(first).not.toBe(queryHash('feed', { from: {}, to: {} }));
  });

  test('a date is not the epoch a t.number field holding the same instant would be', () => {
    const at = new Date('2026-02-01T00:00:00Z');
    expect(queryHash('feed', { at })).not.toBe(queryHash('feed', { at: at.getTime() }));
    expect(queryHash('feed', { at })).not.toBe(queryHash('feed', { at: at.toISOString() }));
  });

  test('the name is part of the identity, and key order is not', () => {
    expect(queryHash('feed', { a: 1, b: 2 })).toBe(queryHash('feed', { b: 2, a: 1 }));
    expect(queryHash('feed', { a: 1 })).not.toBe(queryHash('otherFeed', { a: 1 }));
  });
});

describe('a read-cache key separates them too — it is the same fingerprint', () => {
  test('two date windows fill two entries', () => {
    const key = (from: string, to: string) =>
      cacheKeyFor('feed', range(from, to), [], '["actor","u1"]');
    expect(key('2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z')).not.toBe(
      key('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    );
  });
});
