// The arithmetic business calendar against the day-by-day walk it replaced, kept here as the
// oracle: random spans, zones (DST, half-hour, midnight transitions, a skipped date), wall times,
// weekends and holiday lists must answer identically — and 30 years must not cost 30 years of `Intl`.

import { describe, expect, test } from 'bun:test';
import type { BusinessCalendar, IsoWeekday } from './business';
import { addBusinessDays, businessDaysBetween, isBusinessDay, WEEKEND_SAT_SUN } from './business';
import type { Instant } from './instant';
import { daysBetween, fromZoned, toZoned, type ZonedDateTime } from './zoned';
import { utcEpoch } from './zones';

/** The pre-v31 `localDay`, verbatim: the calendar date `offset` days on, or `null` if it never was. */
function oracleLocalDay(origin: ZonedDateTime, offset: number, zone: string): Instant | null {
  const candidate = fromZoned(
    {
      year: origin.year,
      month: origin.month,
      day: origin.day + offset,
      hour: origin.hour,
      minute: origin.minute,
      second: origin.second,
      millisecond: origin.millisecond,
    },
    zone,
    { gap: 'next' },
  );
  const wanted = new Date(utcEpoch(origin.year, origin.month, origin.day + offset));
  const got = toZoned(candidate, zone);
  const exists =
    got.year === wanted.getUTCFullYear() &&
    got.month === wanted.getUTCMonth() + 1 &&
    got.day === wanted.getUTCDate();
  return exists ? candidate : null;
}

function oracleBetween(from: Instant, to: Instant, calendar: BusinessCalendar): number {
  const sign = to.getTime() < from.getTime() ? -1 : 1;
  const start = sign === 1 ? from : to;
  const days = daysBetween(start, sign === 1 ? to : from, calendar.zone);
  const origin = toZoned(start, calendar.zone);
  let count = 0;
  for (let index = 0; index < days; index += 1) {
    const day = oracleLocalDay(origin, index, calendar.zone);
    if (day !== null && isBusinessDay(day, calendar)) count += 1;
  }
  return count === 0 ? 0 : sign * count;
}

function oracleAdd(at: Instant, days: number, calendar: BusinessCalendar): Instant | 'refused' {
  const step = days > 0 ? 1 : -1;
  const origin = toZoned(at, calendar.zone);
  let remaining = Math.abs(days);
  let offset = 0;
  let guard = 0;
  let landed = at;
  while (remaining > 0) {
    offset += step;
    const candidate = oracleLocalDay(origin, offset, calendar.zone);
    if (candidate !== null && isBusinessDay(candidate, calendar)) {
      remaining -= 1;
      landed = candidate;
    }
    guard += 1;
    if (guard > Math.abs(days) * 7 + 3650) return 'refused';
  }
  return landed;
}

/** mulberry32: a seeded generator, so a failure names a case that reproduces. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each zone with the instant its interesting history is near. */
const ZONES: readonly [string, number][] = [
  ['Pacific/Apia', Date.UTC(2011, 11, 20)], // skipped 2011-12-30
  ['Pacific/Kiritimati', Date.UTC(1994, 11, 20)], // skipped 1994-12-31
  ['Pacific/Kwajalein', Date.UTC(1993, 7, 10)], // skipped 1993-08-21
  ['America/Sao_Paulo', Date.UTC(2016, 9, 10)], // DST at midnight
  ['America/Recife', Date.UTC(2000, 9, 1)], // two transitions seven days apart
  ['Europe/Berlin', Date.UTC(2026, 2, 20)],
  ['America/New_York', Date.UTC(2026, 2, 1)],
  ['Australia/Lord_Howe', Date.UTC(2026, 3, 1)], // a 30-minute DST
  ['Asia/Kolkata', Date.UTC(2026, 0, 1)],
  ['UTC', Date.UTC(2026, 0, 1)],
];
const WALLS = [0, 30, 150, 540, 1410, 1439]; // minutes: 00:00, 00:30, 02:30, 09:00, 23:30, 23:59
const WEEKENDS: readonly (readonly IsoWeekday[])[] = [WEEKEND_SAT_SUN, [5, 6], [7], [1, 3, 5, 7]];

function randomCase(random: () => number): {
  from: Instant;
  calendar: BusinessCalendar;
  span: number;
} {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const [zone, near] = pick(ZONES);
  const anchor = new Date(near + Math.floor(random() * 30 - 15) * 86_400_000);
  const wall = pick(WALLS);
  const from = fromZoned(
    {
      year: anchor.getUTCFullYear(),
      month: anchor.getUTCMonth() + 1,
      day: anchor.getUTCDate(),
      hour: Math.floor(wall / 60),
      minute: wall % 60,
    },
    zone,
  );
  const holidays: string[] = [];
  const holidayCount = Math.floor(random() * 12);
  for (let index = 0; index < holidayCount; index += 1) {
    const day = new Date(near + Math.floor(random() * 80 - 30) * 86_400_000);
    holidays.push(day.toISOString().slice(0, 10));
  }
  if (random() < 0.2) holidays.push('2026-02-30', 'not a date');
  return {
    from,
    calendar: { zone, weekendDays: pick(WEEKENDS), holidays },
    span: Math.floor(random() * 120) - 60,
  };
}

describe('the arithmetic calendar answers as the day-by-day walk did', () => {
  test('businessDaysBetween, over random spans, zones, walls, weekends and holidays', () => {
    const random = seeded(31);
    for (let index = 0; index < 400; index += 1) {
      const { from, calendar, span } = randomCase(random);
      const to = new Date(from.getTime() + span * 86_400_000 + 3_600_000) as Instant;
      const label = `${calendar.zone} ${from.toISOString()} → ${to.toISOString()}`;
      expect(`${label} ${businessDaysBetween(from, to, calendar)}`).toBe(
        `${label} ${oracleBetween(from, to, calendar)}`,
      );
    }
  });

  test('addBusinessDays, in both directions, over the same cases', () => {
    const random = seeded(1031);
    for (let index = 0; index < 400; index += 1) {
      const { from, calendar, span } = randomCase(random);
      const days = span === 0 ? 1 : Math.trunc(span / 2);
      const label = `${calendar.zone} ${from.toISOString()} + ${days}`;
      const expected = oracleAdd(from, days, calendar);
      const got = addBusinessDays(from, days, calendar).toISOString();
      expect(`${label} ${got}`).toBe(
        `${label} ${expected === 'refused' ? 'refused' : expected.toISOString()}`,
      );
    }
  });
});

describe('a long span costs weeks of arithmetic, not a call into Intl per day', () => {
  // The walk took ~830 ms for 30 years and ~500 ms for 5,000 business days. The bound is loose for
  // CI; what it catches is a return to per-day `Intl`, which is two orders of magnitude over it.
  const calendar = { zone: 'America/New_York', holidays: ['2020-12-25', '2021-12-25'] };
  const from = new Date('1996-01-01T14:00:00Z') as Instant;

  test('30 years of businessDaysBetween', () => {
    businessDaysBetween(from, new Date('1997-01-01T14:00:00Z') as Instant, calendar);
    const started = performance.now();
    const count = businessDaysBetween(from, new Date('2026-01-01T14:00:00Z') as Instant, calendar);
    expect(performance.now() - started).toBeLessThan(50);
    // 7,828 weekdays, less one Friday holiday; the Saturday one was never a business day.
    expect(count).toBe(7827);
  });

  test('5,000 business days of addBusinessDays', () => {
    const started = performance.now();
    addBusinessDays(from, 5000, calendar);
    addBusinessDays(from, -5000, calendar);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
