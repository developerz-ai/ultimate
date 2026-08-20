import { describe, expect, test } from 'bun:test';
import { type Clock, frozenClock } from '@ultimat3/core';
import {
  addMs,
  compareInstants,
  differenceMs,
  epoch,
  fromEpochMs,
  fromEpochSeconds,
  fromIso,
  instant,
  isAfter,
  isBefore,
  isInstant,
  now,
  subtractMs,
  toEpochMs,
  toIso,
  toIsoDateUtc,
} from './instant';

describe('instant', () => {
  test('round-trips ISO-8601 in UTC', () => {
    expect(toIso(fromIso('2026-03-14T09:00:00+01:00'))).toBe('2026-03-14T08:00:00.000Z');
    expect(toIso(fromIso('2026-03-14T08:00:00Z'))).toBe('2026-03-14T08:00:00.000Z');
  });

  test('rejects an unparseable timestamp with X_INSTANT_INVALID', () => {
    expect(codeOf(() => fromIso('14/03/2026'))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromIso(''))).toBe('X_INSTANT_INVALID');
  });

  test('refuses a bare local timestamp, which resolves through the process zone', () => {
    // `new Date('2026-03-14T09:00:00')` is the SERVER's 09:00: the same CSV row imported on a
    // pod in America/Bogota and a pod in UTC becomes two different instants, five hours apart.
    expect(codeOf(() => fromIso('2026-03-14T09:00:00'))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromIso('2026-03-14T09:00'))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromIso('2026-03-14T09:00:00.123'))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromIso('March 14, 2026 09:00:00'))).toBe('X_INSTANT_INVALID');
  });

  test('keeps every spelling that names one point on the timeline', () => {
    // A date-only ISO form is UTC by specification, so it carries no ambient zone and stays in.
    expect(toIso(fromIso('2026-03-14'))).toBe('2026-03-14T00:00:00.000Z');
    expect(toIso(fromIso('2026-03-14t08:00:00z'))).toBe('2026-03-14T08:00:00.000Z');
    expect(toIso(fromIso('2026-03-14T09:00:00+0100'))).toBe('2026-03-14T08:00:00.000Z');
    expect(toIso(fromIso('2026-03-14T09:00:00.500-05:00'))).toBe('2026-03-14T14:00:00.500Z');
  });

  test('takes its clock by injection, so tests can freeze time', () => {
    const frozen: Clock = frozenClock('2026-03-14T08:00:00Z');
    expect(toIso(now(frozen))).toBe('2026-03-14T08:00:00.000Z');
    expect(differenceMs(now(frozen), fromIso('2026-03-14T09:00:00Z'))).toBe(3_600_000);
  });

  test('wraps an untrusted Date by copying it, never by branding the callers own object', () => {
    // `value as Instant` handed back the caller's object, still `setTime()`-able after the brand.
    const caller = new Date('2026-03-14T09:00:00Z');
    const wrapped = instant(caller);
    caller.setTime(0);
    expect(toIso(wrapped)).toBe('2026-03-14T09:00:00.000Z');
  });

  test('epoch() is a fresh instant, so one consumer cannot corrupt it for the process', () => {
    // A shared mutable `Date` exported from a tier-1 package is one `setUTCFullYear` away from
    // being wrong for every other consumer, permanently and silently.
    const first = epoch();
    expect(toIso(first)).toBe('1970-01-01T00:00:00.000Z');
    first.setUTCFullYear(1999);
    expect(toIso(epoch())).toBe('1970-01-01T00:00:00.000Z');
  });

  test('guards untrusted values', () => {
    expect(isInstant(new Date('2026-03-14T08:00:00Z'))).toBe(true);
    expect(isInstant(new Date('nope'))).toBe(false);
    expect(isInstant('2026-03-14T08:00:00Z')).toBe(false);
    expect(isInstant(null)).toBe(false);
  });
});

// T1. `Number.isFinite` is not the `Date` range. Every constructor below reached `new Date(ms)`
// with a finite number outside +/-8.64e15 and branded the Invalid Date that came back as an
// `Instant` — a value `isInstant` then answers `false` for, and `toIso` throws a bare `RangeError`
// out of, from a package whose every other refusal carries a code.
describe('the epoch constructors', () => {
  test('round-trip an epoch, in milliseconds and in seconds', () => {
    expect(toIso(fromEpochMs(1_773_478_800_000))).toBe('2026-03-14T09:00:00.000Z');
    expect(toEpochMs(fromEpochMs(1_773_478_800_000))).toBe(1_773_478_800_000);
    expect(toIso(fromEpochSeconds(1_773_478_800))).toBe('2026-03-14T09:00:00.000Z');
    expect(toIso(addMs(fromEpochMs(0), 86_400_000))).toBe('1970-01-02T00:00:00.000Z');
    expect(toIso(subtractMs(fromEpochMs(86_400_000), 86_400_000))).toBe('1970-01-01T00:00:00.000Z');
  });

  test('refuse an epoch outside the Date range rather than branding an Invalid Date', () => {
    expect(codeOf(() => fromEpochMs(8.64e15 + 1))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromEpochMs(-8.64e15 - 1))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromEpochMs(1e16))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromEpochMs(Number.NaN))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromEpochMs(Number.POSITIVE_INFINITY))).toBe('X_INSTANT_INVALID');
  });

  test('the refusal reaches every caller that builds an instant from a number', () => {
    // Each of these used to hand back a branded Invalid Date instead.
    expect(codeOf(() => fromEpochSeconds(1e13))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => addMs(epoch(), 1e16))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => subtractMs(epoch(), 1e16))).toBe('X_INSTANT_INVALID');
    // A clock skewed past the `Date` range: `now()` answers an Invalid Date, which `now(clock)`
    // must refuse rather than brand. `Clock.now` returns a `Date`, so this is the only shape the
    // out-of-range case can arrive in.
    const runaway: Clock = { now: () => new Date(1e16), monotonic: () => 0 };
    expect(codeOf(() => now(runaway))).toBe('X_INSTANT_INVALID');
  });

  test('the boundary itself is a valid instant — the check is the range, not a smaller one', () => {
    expect(toEpochMs(fromEpochMs(8.64e15))).toBe(8.64e15);
    expect(isInstant(fromEpochMs(8.64e15))).toBe(true);
    expect(isInstant(fromEpochMs(-8.64e15))).toBe(true);
  });

  test("a certified instant satisfies the type's own predicate, which is what failed", () => {
    // `isInstant(fromEpochMs(1e16))` used to be `false`: the constructor certified a value the
    // predicate rejects, so nothing downstream could tell a checked instant from an unchecked one.
    for (const ms of [0, 1_773_478_800_000, -1_000]) {
      expect(isInstant(fromEpochMs(ms))).toBe(true);
    }
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

describe('ordering', () => {
  const earlier = fromIso('2026-03-14T08:00:00Z');
  const later = fromIso('2026-03-14T09:00:00Z');
  const same = fromIso('2026-03-14T08:00:00.000Z');

  test('isBefore and isAfter are strict, so an equal pair is neither', () => {
    expect(isBefore(earlier, later)).toBe(true);
    expect(isBefore(later, earlier)).toBe(false);
    expect(isAfter(later, earlier)).toBe(true);
    expect(isAfter(earlier, later)).toBe(false);
    expect(isBefore(earlier, same)).toBe(false);
    expect(isAfter(earlier, same)).toBe(false);
  });

  test('a one-millisecond gap is enough — the comparison is the epoch, not the second', () => {
    const tick = addMs(earlier, 1);
    expect(isBefore(earlier, tick)).toBe(true);
    expect(isAfter(tick, earlier)).toBe(true);
    expect(compareInstants(earlier, tick)).toBe(-1);
  });

  test('compareInstants answers exactly -1, 0 or 1, so it can sort', () => {
    expect(compareInstants(earlier, later)).toBe(-1);
    expect(compareInstants(later, earlier)).toBe(1);
    expect(compareInstants(earlier, same)).toBe(0);
    const sorted = [later, earlier, same].sort(compareInstants).map(toIso);
    expect(sorted).toEqual([
      '2026-03-14T08:00:00.000Z',
      '2026-03-14T08:00:00.000Z',
      '2026-03-14T09:00:00.000Z',
    ]);
  });

  test('two distinct objects for one point on the timeline compare equal', () => {
    // Identity is not the question: `earlier !== same` while both name the same instant.
    expect(earlier).not.toBe(same);
    expect(compareInstants(earlier, same)).toBe(0);
  });
});

describe('toIsoDateUtc', () => {
  test('is the UTC calendar day, never the local one', () => {
    expect(toIsoDateUtc(fromIso('2026-03-14T23:30:00Z'))).toBe('2026-03-14');
    // 23:30 in Tokyo on the 14th is 14:30Z the same day; 09:00 in Tokyo is 00:00Z, still the 14th.
    expect(toIsoDateUtc(fromIso('2026-03-15T00:30:00+09:00'))).toBe('2026-03-14');
  });

  test('keeps four digits for a year below 1000', () => {
    expect(toIsoDateUtc(fromIso('0050-01-01T00:00:00Z'))).toBe('0050-01-01');
    expect(toIsoDateUtc(fromIso('0050-01-01T00:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
