// Zone maths and the one-zone-one-key rule: every casing of an IANA name has to reach `Intl` as
// one string, because the string arrives from `x-timezone` and every formatter cache keys on it.

import { describe, expect, test } from 'bun:test';
// `node:` because the framework is Bun-only and this is the one Node API with no Bun equivalent:
// the test measures *JavaScript heap* growth, and `Bun.unsafe.memoryFootprint()` reports the
// process footprint, which moves with allocator behaviour rather than with retained formatters.
import { memoryUsage } from 'node:process';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { fromIso } from './instant';
import { canonicalTimeZone } from './zone-canonical';
import {
  assertTimeZone,
  isValidTimeZone,
  observesDst,
  offsetAt,
  offsetLabel,
  zoneAbbrev,
  zonePartsAt,
} from './zones';

const winter = fromIso('2026-01-15T12:00:00Z');
const summer = fromIso('2026-07-15T12:00:00Z');

describe('offsetAt', () => {
  test('tracks DST per instant, in minutes east of UTC', () => {
    expect(offsetAt('Europe/Berlin', winter)).toBe(60);
    expect(offsetAt('Europe/Berlin', summer)).toBe(120);
    expect(offsetAt('America/New_York', winter)).toBe(-300);
    expect(offsetAt('America/New_York', summer)).toBe(-240);
    expect(offsetAt('UTC', summer)).toBe(0);
  });

  test('handles non-hour offsets', () => {
    expect(offsetAt('Asia/Kathmandu', summer)).toBe(345); // +05:45
    expect(offsetAt('Asia/Kolkata', summer)).toBe(330); // +05:30
    expect(offsetAt('Pacific/Chatham', winter)).toBe(825); // +13:45
  });

  test('a zone without DST reports one offset all year', () => {
    expect(offsetAt('Asia/Tokyo', winter)).toBe(offsetAt('Asia/Tokyo', summer));
    expect(observesDst('Asia/Tokyo', winter)).toBe(false);
    expect(observesDst('Europe/Berlin', winter)).toBe(true);
  });
});

describe('offsetLabel', () => {
  test('renders ISO-style offsets', () => {
    expect(offsetLabel(0)).toBe('Z');
    expect(offsetLabel(60)).toBe('+01:00');
    expect(offsetLabel(345)).toBe('+05:45');
    expect(offsetLabel(-240)).toBe('-04:00');
    expect(offsetLabel(-330)).toBe('-05:30');
  });
});

describe('isValidTimeZone', () => {
  test('accepts IANA names and rejects abbreviations and offsets', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    // Abbreviations are ambiguous (CST is three different zones) and are rejected.
    expect(isValidTimeZone('CET')).toBe(false);
    expect(isValidTimeZone('EST5EDT')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+01:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

// `Intl` accepts every casing of an IANA name, and every formatter cache was keyed on the raw
// string. `x-timezone: eUrOpE/bErLiN` therefore minted a permanent `Intl.DateTimeFormat` per
// casing — 2^12 of them for a 13-letter zone, from a request header.
const CASINGS = 4096;

function casing(zone: string, mask: number): string {
  const chars = [...zone];
  let bit = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? '';
    if (!/[a-z]/i.test(char)) continue;
    chars[index] = (mask >> bit) & 1 ? char.toUpperCase() : char.toLowerCase();
    bit += 1;
  }
  return chars.join('');
}

describe('one zone is one key', () => {
  test('every casing canonicalizes to the same name', () => {
    expect(canonicalTimeZone('eUrOpE/bErLiN')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('Mars/Olympus')).toBe(undefined);
    expect(canonicalTimeZone('+01:00')).toBe(undefined);
    expect(canonicalTimeZone('')).toBe(undefined);

    const keys = new Set<string | undefined>();
    for (let mask = 0; mask < CASINGS; mask += 1)
      keys.add(canonicalTimeZone(casing('Europe/Berlin', mask)));
    expect([...keys]).toEqual(['Europe/Berlin']);
  });

  test('assertTimeZone answers the canonical name, so a formatter key cannot fork', () => {
    expect(assertTimeZone('eUrOpE/bErLiN')).toBe('Europe/Berlin');
    expect(assertTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  test('4,096 casings do not grow the heap', () => {
    // Measured against the unbounded raw-keyed cache: 4,096 variants retained 31 MB, ~7.7 KB per
    // `Intl.DateTimeFormat`. The bound and the canonical key together hold this near zero.
    zonePartsAt('Europe/Berlin', winter);
    Bun.gc(true);
    const before = memoryUsage().heapUsed;
    for (let mask = 0; mask < CASINGS; mask += 1) {
      expect(zonePartsAt(casing('Europe/Berlin', mask), winter).year).toBe(2026);
    }
    Bun.gc(true);
    expect((memoryUsage().heapUsed - before) / 1e6).toBeLessThan(8);
  });
});

describe('zoneAbbrev', () => {
  test('labels the zone for the user', () => {
    expect(zoneAbbrev('Europe/Berlin', summer, 'en-US', 'shortOffset')).toBe('GMT+2');
    expect(zoneAbbrev('Asia/Kathmandu', summer, 'en-US', 'shortOffset')).toBe('GMT+5:45');
  });

  test('refuses an unknown zone with X_TIMEZONE_INVALID, like every other entry point', () => {
    // It built its own `Intl.DateTimeFormat` on the caller's raw string, so the one label an app
    // renders from an `x-timezone` header answered a bare `RangeError` with no code and no fix.
    let caught: unknown;
    try {
      zoneAbbrev('Mars/Olympus', summer);
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_TIMEZONE_INVALID');
  });

  test('every casing answers one label, because the key is the canonical name', () => {
    expect(zoneAbbrev('eUrOpE/bErLiN', summer, 'en-US', 'shortOffset')).toBe('GMT+2');
    expect(zoneAbbrev('europe/berlin', summer, 'en-US', 'shortOffset')).toBe('GMT+2');
  });
});
