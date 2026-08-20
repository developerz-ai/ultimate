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

  // ICU 78 (Bun 1.4) resolves every one of these where ICU 75 threw, so the guard cannot ask
  // `Intl` whether a string is an IANA zone and asserts `Area/Location` itself. One case per name,
  // named, so a later ICU bump that reopens one fails with the name in the report rather than
  // silently widening the guard.
  const ABBREVIATIONS = [
    'CET',
    'EET',
    'MET',
    'WET',
    'EST',
    'MST',
    'HST',
    'GMT',
    'GMT0',
    'UCT',
    'Zulu',
    'EST5EDT',
    'CST6CDT',
    'MST7MDT',
    'PST8PDT',
  ];

  test.each(ABBREVIATIONS)('rejects %s — an abbreviation carries no DST rule', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
    // Every casing, because `Intl` accepts every casing and the string arrives from a header.
    expect(isValidTimeZone(zone.toLowerCase())).toBe(false);
    expect(canonicalTimeZone(zone)).toBe(undefined);
  });

  // Single-label `backward` links name real zones, and refusing them is deliberate rather than ICU
  // drift: no structural rule keeps `CET` out and lets `Japan` in, both being one label, and the
  // alternative is a denylist that grows with every tzdata release. `Asia/Tokyo` is the spelling
  // that survives being a formatter-cache key. BREAKING at 6.0.0 — `Japan` → `Asia/Tokyo`.
  test.each(['Japan', 'GB', 'Eire', 'W-SU', 'PRC', 'ROK', 'Singapore', 'Israel', 'Universal'])(
    'rejects the single-label legacy link %s',
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(false);
      expect(canonicalTimeZone(zone)).toBe(undefined);
    },
  );

  test.each(['Europe/Berlin', 'UTC', 'utc', 'US/Eastern', 'Asia/Calcutta', 'Etc/GMT+2'])(
    'still accepts %s',
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(true);
    },
  );
});

// Axiom 4, applied to a refusal that grew a second class. `Japan` and `CET` are both refused and
// the remedies are not the same — one swaps mechanically, the other has no replacement at all —
// so a `fix:` describing only abbreviations left an operator holding `"Japan"` reading about `CET`.
describe('X_TIMEZONE_INVALID instructs both refused classes', () => {
  function refusal(zone: string): UltimateError {
    try {
      assertTimeZone(zone);
    } catch (error) {
      if (isUltimateError(error)) return error;
    }
    return expect.unreachable(`${zone} must be refused with an UltimateError`);
  }

  test('the cause names the input and the shape it is missing', () => {
    expect(refusal('Japan').cause).toBe('"Japan" is not an IANA Area/Location zone name');
    expect(refusal('CET').cause).toBe('"CET" is not an IANA Area/Location zone name');
  });

  test('the fix carries the mechanical swap, the class that has none, and how to look one up', () => {
    const fix = refusal('Japan').fix;
    // The legacy-link half: a replacement the operator can paste, not a description of the rule.
    expect(fix).toContain('Japan → Asia/Tokyo');
    // The abbreviation half, and WHY it gets no replacement rather than a wrong one.
    expect(fix).toContain('carry no DST rule');
    expect(fix).toContain("Intl.supportedValuesOf('timeZone')");
    // One code, one instruction: an abbreviation and an offset read the same remedy.
    expect(refusal('CET').fix).toBe(fix);
    expect(refusal('+01:00').fix).toBe(fix);
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
