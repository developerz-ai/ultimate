import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { epochOf, isoOf, newestEpoch, nowEpoch, rfc822Of } from './feed-dates';

describe('epochOf', () => {
  test('parses an ISO timestamp', () => {
    expect(epochOf('2026-07-01T00:00:00.000Z')).toBe(Date.UTC(2026, 6, 1));
  });

  test('normalises an offset to the same instant', () => {
    expect(epochOf('2026-07-01T02:00:00+02:00')).toBe(Date.UTC(2026, 6, 1));
  });

  test('a string that is not a date at all is absent, not NaN', () => {
    expect(epochOf('last tuesday')).toBeUndefined();
    expect(epochOf('')).toBeUndefined();
    expect(epochOf('2026-13-45')).toBeUndefined();
  });

  test('an absent timestamp stays absent', () => {
    expect(epochOf(undefined)).toBeUndefined();
  });

  test('the epoch itself is an instant, not a falsy miss', () => {
    expect(epochOf('1970-01-01T00:00:00.000Z')).toBe(0);
  });
});

describe('newestEpoch', () => {
  test('answers the newest instant', () => {
    expect(newestEpoch([300, 100, 200])).toBe(300);
  });

  test('skips the entries that carry no instant', () => {
    expect(newestEpoch([undefined, 100, undefined])).toBe(100);
  });

  test('an empty feed, and a feed nothing in which parsed, have no instant', () => {
    expect(newestEpoch([])).toBeUndefined();
    expect(newestEpoch([undefined, undefined])).toBeUndefined();
  });

  test('a feed far larger than the engine argument limit still answers', () => {
    // The regression this exists for: `Math.max(...times)` passes one argument per item, and this
    // engine overflows its stack somewhere under a million of them — so a long-lived blog's feed
    // stopped rendering at a size nobody chose. A loop has no such limit.
    const times = new Array<number>(1_000_000).fill(1_700_000_000_000);
    times[999_999] = 1_800_000_000_000;
    expect(newestEpoch(times)).toBe(1_800_000_000_000);
  });
});

describe('nowEpoch', () => {
  test('reads the clock it is handed', () => {
    expect(nowEpoch(frozenClock('2026-03-04T05:06:07.000Z'))).toBe(Date.UTC(2026, 2, 4, 5, 6, 7));
  });

  test('a clock handing back an invalid Date renders the epoch instead of throwing', () => {
    expect(nowEpoch({ now: () => new Date(Number.NaN), monotonic: () => 0 })).toBe(0);
  });
});

describe('formatting', () => {
  test('isoOf is RFC 3339 in UTC', () => {
    expect(isoOf(Date.UTC(2026, 6, 1))).toBe('2026-07-01T00:00:00.000Z');
  });

  test('rfc822Of is RSS 2.0 date format', () => {
    expect(rfc822Of(Date.UTC(2026, 6, 1))).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
  });
});
