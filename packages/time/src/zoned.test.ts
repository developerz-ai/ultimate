import { describe, expect, test } from 'bun:test';
import { fromIso, toIso } from './instant';
import {
  addDaysInZone,
  daysBetween,
  fromZoned,
  fromZonedDetailed,
  startOfDay,
  toZoned,
} from './zoned';
import { offsetAt, UTC } from './zones';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';
const KATHMANDU = 'Asia/Kathmandu';
const ADELAIDE = 'Australia/Adelaide';
const TOKYO = 'Asia/Tokyo';

describe('toZoned', () => {
  test('renders the same instant differently per zone', () => {
    const at = fromIso('2026-03-14T08:00:00Z');
    expect(toZoned(at, BERLIN)).toMatchObject({ hour: 9, offsetMinutes: 60, weekday: 6 });
    expect(toZoned(at, NEW_YORK)).toMatchObject({ hour: 4, offsetMinutes: -240 });
    // A 45-minute offset zone: 08:00Z is 13:45 in Kathmandu.
    expect(toZoned(at, KATHMANDU)).toMatchObject({ hour: 13, minute: 45, offsetMinutes: 345 });
  });
});

describe('fromZoned — spring-forward gap', () => {
  // 2026-03-08 02:30 does not exist in New York: 02:00 jumps straight to 03:00.
  const wall = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 };

  test('reports the gap instead of silently inventing a time', () => {
    expect(fromZonedDetailed(wall, NEW_YORK).resolution).toBe('gap');
  });

  test("gap: 'next' shifts forward past the gap", () => {
    const at = fromZoned(wall, NEW_YORK, { gap: 'next' });
    expect(toIso(at)).toBe('2026-03-08T07:30:00.000Z');
    expect(toZoned(at, NEW_YORK).hour).toBe(3);
  });

  test("gap: 'previous' shifts back before it", () => {
    const at = fromZoned(wall, NEW_YORK, { gap: 'previous' });
    expect(toIso(at)).toBe('2026-03-08T06:30:00.000Z');
    expect(toZoned(at, NEW_YORK).hour).toBe(1);
  });

  test("gap: 'throw' raises X_DST_NONEXISTENT", () => {
    expect(codeOf(() => fromZoned(wall, NEW_YORK, { gap: 'throw' }))).toBe('X_DST_NONEXISTENT');
  });

  test('the same gap exists in Berlin at 02:30 on 2026-03-29', () => {
    const berlinWall = { year: 2026, month: 3, day: 29, hour: 2, minute: 30 };
    expect(fromZonedDetailed(berlinWall, BERLIN).resolution).toBe('gap');
    expect(toIso(fromZoned(berlinWall, BERLIN, { gap: 'next' }))).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('fromZoned — fall-back overlap', () => {
  // 2026-11-01 01:30 happens twice in New York: once at -04:00, once at -05:00.
  const wall = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };

  test('detects the repeated hour', () => {
    expect(fromZonedDetailed(wall, NEW_YORK).resolution).toBe('overlap');
  });

  test("overlap: 'first' is the pre-transition instant (EDT)", () => {
    const at = fromZoned(wall, NEW_YORK, { overlap: 'first' });
    expect(toIso(at)).toBe('2026-11-01T05:30:00.000Z');
    expect(offsetAt(NEW_YORK, at)).toBe(-240);
  });

  test("overlap: 'second' is the post-transition instant (EST)", () => {
    const at = fromZoned(wall, NEW_YORK, { overlap: 'second' });
    expect(toIso(at)).toBe('2026-11-01T06:30:00.000Z');
    expect(offsetAt(NEW_YORK, at)).toBe(-300);
  });

  test("overlap: 'throw' raises X_DST_AMBIGUOUS", () => {
    expect(codeOf(() => fromZoned(wall, NEW_YORK, { overlap: 'throw' }))).toBe('X_DST_AMBIGUOUS');
  });
});

describe('non-hour offsets', () => {
  test('Asia/Kathmandu (+05:45) round-trips exactly', () => {
    const wall = { year: 2026, month: 3, day: 14, hour: 9, minute: 0 };
    const at = fromZoned(wall, KATHMANDU);
    expect(toIso(at)).toBe('2026-03-14T03:15:00.000Z');
    expect(toZoned(at, KATHMANDU)).toMatchObject({ hour: 9, minute: 0, offsetMinutes: 345 });
  });

  test('Australia/Adelaide (+09:30/+10:30) round-trips in both halves of the year', () => {
    const winter = fromZoned({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, ADELAIDE);
    const summer = fromZoned({ year: 2026, month: 1, day: 1, hour: 9, minute: 0 }, ADELAIDE);
    expect(offsetAt(ADELAIDE, winter)).toBe(570);
    expect(offsetAt(ADELAIDE, summer)).toBe(630);
    expect(toZoned(winter, ADELAIDE).hour).toBe(9);
    expect(toZoned(summer, ADELAIDE).hour).toBe(9);
  });

  test('every whole hour of a DST day round-trips or is explained', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const result = fromZonedDetailed({ year: 2026, month: 3, day: 8, hour, minute: 0 }, NEW_YORK);
      if (result.resolution === 'exact') {
        expect(toZoned(result.instant, NEW_YORK).hour).toBe(hour);
      } else {
        expect(hour).toBe(2); // the only skipped hour
      }
    }
  });
});

describe('calendar arithmetic in a zone', () => {
  test('adding a day across spring forward is 23 hours, not 24', () => {
    const before = fromZoned({ year: 2026, month: 3, day: 7, hour: 12, minute: 0 }, NEW_YORK);
    const after = addDaysInZone(before, 1, NEW_YORK);
    expect(toZoned(after, NEW_YORK)).toMatchObject({ day: 8, hour: 12 });
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  test('startOfDay is local midnight, not 00:00Z', () => {
    const at = fromIso('2026-03-14T08:00:00Z');
    expect(toIso(startOfDay(at, BERLIN))).toBe('2026-03-13T23:00:00.000Z');
    expect(toZoned(startOfDay(at, BERLIN), BERLIN)).toMatchObject({ day: 14, hour: 0 });
  });
});

describe('daysBetween', () => {
  test('counts local calendar days, signed, never fractional', () => {
    const noon = fromIso('2026-03-14T12:00:00Z');
    expect(daysBetween(noon, fromIso('2026-03-14T23:59:59.999Z'), UTC)).toBe(0);
    expect(daysBetween(noon, fromIso('2026-03-15T00:00:00Z'), UTC)).toBe(1);
    expect(daysBetween(fromIso('2026-03-15T00:00:00Z'), noon, UTC)).toBe(-1);
  });

  test('a 23-hour spring-forward day still counts as one day', () => {
    const before = fromZoned({ year: 2026, month: 3, day: 7, hour: 12, minute: 0 }, NEW_YORK);
    const after = addDaysInZone(before, 1, NEW_YORK);
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
    expect(daysBetween(before, after, NEW_YORK)).toBe(1);
  });

  test('a 25-hour fall-back day still counts as one day', () => {
    const before = fromZoned({ year: 2026, month: 10, day: 31, hour: 12, minute: 0 }, NEW_YORK);
    const after = addDaysInZone(before, 1, NEW_YORK);
    expect(after.getTime() - before.getTime()).toBe(25 * 3_600_000);
    expect(daysBetween(before, after, NEW_YORK)).toBe(1);
  });

  test('24 real hours inside one 25-hour local day is zero days', () => {
    // 00:30 EDT and 23:30 EST are both 2026-11-01 in New York, and exactly 24h apart.
    const from = fromIso('2026-11-01T04:30:00Z');
    const to = fromIso('2026-11-02T04:30:00Z');
    expect(to.getTime() - from.getTime()).toBe(86_400_000);
    expect(daysBetween(from, to, NEW_YORK)).toBe(0);
  });

  test('the zone decides: 90 minutes across local midnight in Tokyo, none in UTC', () => {
    const from = fromIso('2026-03-14T14:30:00Z'); // 23:30 Tokyo, 14 March
    const to = fromIso('2026-03-14T16:00:00Z'); // 01:00 Tokyo, 15 March
    expect(daysBetween(from, to, TOKYO)).toBe(1);
    expect(daysBetween(from, to, UTC)).toBe(0);
  });

  test('a whole year is 365 days, and 366 in a leap year', () => {
    expect(daysBetween(fromIso('2026-01-01T00:00:00Z'), fromIso('2027-01-01T00:00:00Z'), UTC)).toBe(
      365,
    );
    expect(daysBetween(fromIso('2024-01-01T00:00:00Z'), fromIso('2025-01-01T00:00:00Z'), UTC)).toBe(
      366,
    );
  });

  test('an unknown zone raises X_TIMEZONE_INVALID', () => {
    const at = fromIso('2026-03-14T08:00:00Z');
    expect(codeOf(() => daysBetween(at, at, 'Mars/Olympus'))).toBe('X_TIMEZONE_INVALID');
  });
});

// `Date.UTC(99, …)` does not mean year 99 — the legacy constructor remaps years 0–99 onto
// 1900–1999, so any date arithmetic that rebuilds an epoch from zoned fields silently jumps
// nineteen centuries for a first-century date. These fixtures come from ISO strings, which are
// parsed literally, and the assertions are the values the proleptic Gregorian calendar gives.
describe('years before 100', () => {
  test('the 0099 → 0100 boundary is one day, not -693959', () => {
    const from = fromIso('0099-12-31T12:00:00Z');
    const to = fromIso('0100-01-01T12:00:00Z');
    // Pins the fixtures: a remapped `from` would read 1999-12-31 and the test would prove nothing.
    expect(toIso(from)).toBe('0099-12-31T12:00:00.000Z');
    expect(toZoned(from, UTC).year).toBe(99);
    expect(daysBetween(from, to, UTC)).toBe(1);
    expect(daysBetween(to, from, UTC)).toBe(-1);
  });

  test('a whole local day inside year 0050 is one day', () => {
    const from = fromIso('0050-06-10T00:00:00Z');
    const to = fromIso('0050-06-11T00:00:00Z');
    expect(daysBetween(from, to, UTC)).toBe(1);
    expect(daysBetween(from, fromIso('0050-06-10T23:59:59.999Z'), UTC)).toBe(0);
  });

  test('a year spanning the boundary is 365 days — 0100 is not a leap year', () => {
    const from = fromIso('0099-06-15T00:00:00Z');
    const to = fromIso('0100-06-15T00:00:00Z');
    expect(daysBetween(from, to, UTC)).toBe(365);
  });

  test('toZoned reports the real weekday: 0099-12-31 is a Thursday, not 1999-12-31 Friday', () => {
    expect(toZoned(fromIso('0099-12-31T12:00:00Z'), UTC)).toMatchObject({
      year: 99,
      month: 12,
      day: 31,
      weekday: 4,
    });
    expect(toZoned(fromIso('0050-06-10T12:00:00Z'), UTC).weekday).toBe(5);
  });

  test('fromZoned resolves the year it was asked for, not 1900 + it', () => {
    // The other half of the same remap: `offsetAt` rebuilds an epoch from wall-clock fields too,
    // so before the fix this returned 1950 with `resolution: 'exact'` — or, once the caller was
    // fixed alone, a ~1.9-million-year-off instant reported as a DST gap.
    const resolved = fromZonedDetailed({ year: 50, month: 6, day: 10, hour: 12, minute: 0 }, UTC);
    expect(resolved.resolution).toBe('exact');
    expect(resolved.offsetMinutes).toBe(0);
    expect(toIso(resolved.instant)).toBe('0050-06-10T12:00:00.000Z');
    // And through a real zone, where the offset is what the remap corrupted: Berlin had no
    // standard time in year 99, so `Intl` answers with its LMT, +00:53.
    const berlin = fromZoned({ year: 99, month: 12, day: 31, hour: 0, minute: 0 }, BERLIN);
    expect(offsetAt(BERLIN, berlin)).toBe(53);
    expect(toIso(berlin)).toBe('0099-12-30T23:07:00.000Z');
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
