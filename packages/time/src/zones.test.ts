import { describe, expect, test } from 'bun:test';
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

describe('one zone is one key', () => {
  // `Intl` accepts every casing of an IANA name, and both formatter caches were keyed on the raw
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
    const before = process.memoryUsage().heapUsed;
    for (let mask = 0; mask < CASINGS; mask += 1) {
      expect(zonePartsAt(casing('Europe/Berlin', mask), winter).year).toBe(2026);
    }
    Bun.gc(true);
    expect((process.memoryUsage().heapUsed - before) / 1e6).toBeLessThan(8);
  });
});

describe('zoneAbbrev', () => {
  test('labels the zone for the user', () => {
    expect(zoneAbbrev('Europe/Berlin', summer, 'en-US', 'shortOffset')).toBe('GMT+2');
    expect(zoneAbbrev('Asia/Kathmandu', summer, 'en-US', 'shortOffset')).toBe('GMT+5:45');
  });
});
