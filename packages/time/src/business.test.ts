// Business-day maths: the weekend is configuration, the zone decides which local day it is, and
// `businessDaysBetween` counts the half-open `[from, to)` interval `daysBetween` measures.

import { describe, expect, test } from 'bun:test';
import {
  addBusinessDays,
  businessDaysBetween,
  isWeekend,
  nextBusinessDay,
  WEEKEND_FRI_SAT,
  WEEKEND_SAT_SUN,
} from './business';
import { fromIso } from './instant';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const DUBAI = 'Asia/Dubai';

describe('isWeekend', () => {
  test('the weekend is configuration, not Saturday and Sunday', () => {
    const friday = fromIso('2026-03-13T12:00:00Z');
    const saturday = fromIso('2026-03-14T12:00:00Z');
    const sunday = fromIso('2026-03-15T12:00:00Z');
    expect(isWeekend(friday, BERLIN, WEEKEND_SAT_SUN)).toBe(false);
    expect(isWeekend(saturday, BERLIN, WEEKEND_SAT_SUN)).toBe(true);
    // Gulf calendar: Friday and Saturday are the weekend, Sunday is a work day.
    expect(isWeekend(friday, DUBAI, WEEKEND_FRI_SAT)).toBe(true);
    expect(isWeekend(sunday, DUBAI, WEEKEND_FRI_SAT)).toBe(false);
  });

  test('the zone decides which local day it is', () => {
    // 2026-03-16T00:30Z is still Sunday evening in New York, already Monday in Berlin.
    const at = fromIso('2026-03-16T00:30:00Z');
    expect(isWeekend(at, BERLIN)).toBe(false);
    expect(isWeekend(at, 'America/New_York')).toBe(true);
  });
});

describe('addBusinessDays', () => {
  test('skips weekends and holidays while keeping the local time of day', () => {
    const friday = fromIso('2026-03-13T12:00:00Z');
    expect(toZoned(addBusinessDays(friday, 1, { zone: BERLIN }), BERLIN)).toMatchObject({
      day: 16,
      hour: 13,
    });
    expect(
      toZoned(addBusinessDays(friday, 1, { zone: BERLIN, holidays: ['2026-03-16'] }), BERLIN).day,
    ).toBe(17);
  });

  test('honours a Friday/Saturday weekend', () => {
    // Thursday + 1 business day → Sunday in the Gulf, not Friday.
    const thursday = fromIso('2026-03-12T12:00:00Z');
    const next = addBusinessDays(thursday, 1, { zone: DUBAI, weekendDays: WEEKEND_FRI_SAT });
    expect(toZoned(next, DUBAI).day).toBe(15);
  });

  test('goes backwards and treats 0 as a no-op', () => {
    const monday = fromIso('2026-03-16T12:00:00Z');
    expect(toZoned(addBusinessDays(monday, -1, { zone: BERLIN }), BERLIN).day).toBe(13);
    expect(addBusinessDays(monday, 0, { zone: BERLIN })).toBe(monday);
  });

  test('counts business days across a week', () => {
    const monday = fromIso('2026-03-16T09:00:00Z');
    const nextMonday = fromIso('2026-03-23T09:00:00Z');
    expect(businessDaysBetween(monday, nextMonday, { zone: BERLIN })).toBe(5);
  });
});

describe('businessDaysBetween counts [from, to)', () => {
  const UTC_CAL = { zone: 'UTC' };
  const monday09 = fromIso('2026-03-02T09:00:00Z');

  test('the wall-clock time of either endpoint is not part of the question', () => {
    // Comparing INSTANTS made the final day depend on whether `to`'s clock time had passed
    // `from`'s: the same calendar span answered 4 or 3.
    expect(businessDaysBetween(monday09, fromIso('2026-03-06T10:00:00Z'), UTC_CAL)).toBe(4);
    expect(businessDaysBetween(monday09, fromIso('2026-03-06T08:00:00Z'), UTC_CAL)).toBe(4);
    expect(businessDaysBetween(monday09, fromIso('2026-03-06T23:59:59Z'), UTC_CAL)).toBe(4);
  });

  test('half-open: `from`s own day counts, `to`s does not', () => {
    // The same interval `daysBetween` counts, so business days are days minus the weekend.
    expect(businessDaysBetween(monday09, monday09, UTC_CAL)).toBe(0);
    // Mon → Tue is Monday alone.
    expect(businessDaysBetween(monday09, fromIso('2026-03-03T09:00:00Z'), UTC_CAL)).toBe(1);
    // Sat → Mon is nothing at all: the interval holds only Saturday and Sunday.
    expect(
      businessDaysBetween(
        fromIso('2026-03-07T09:00:00Z'),
        fromIso('2026-03-09T09:00:00Z'),
        UTC_CAL,
      ),
    ).toBe(0);
  });

  test('a holiday inside the interval is not a business day', () => {
    expect(
      businessDaysBetween(monday09, fromIso('2026-03-06T09:00:00Z'), {
        zone: 'UTC',
        holidays: ['2026-03-03'],
      }),
    ).toBe(3);
  });

  test('a reversed range is the same count, negated', () => {
    const friday = fromIso('2026-03-06T10:00:00Z');
    expect(businessDaysBetween(friday, monday09, UTC_CAL)).toBe(-4);
  });

  test('an empty reversed interval is +0, not the -0 that `sign * 0` produces', () => {
    // `Object.is(-0, 0)` is false, so a `-0` leaks through `toBe`, a `Map` key and a JSON diff as
    // a distinct value — and "zero business days, backwards" is not a different answer to "zero".
    const later = fromIso('2026-03-02T17:00:00Z');
    expect(Object.is(businessDaysBetween(later, monday09, UTC_CAL), 0)).toBe(true);
    // Same local day, so the half-open interval is empty in either direction.
    expect(businessDaysBetween(monday09, later, UTC_CAL)).toBe(0);
    // A reversed interval that straddles a weekend is empty too, and equally must not be -0.
    expect(
      Object.is(
        businessDaysBetween(
          fromIso('2026-03-09T09:00:00Z'),
          fromIso('2026-03-07T09:00:00Z'),
          UTC_CAL,
        ),
        0,
      ),
    ).toBe(true);
  });
});

// T4. `plain-date.ts`'s `addPlainDays` is the in-package pattern: `Number.isSafeInteger` plus
// `scheduleInvalid`. `addBusinessDays` had neither, so a fractional count moved a whole day and a
// `NaN` — the shape a corrupted config takes — returned the input unchanged, which reads as
// "no movement was needed" rather than as a failure.
describe('addBusinessDays refuses a day count that is not whole', () => {
  const monday = fromIso('2026-03-16T09:00:00Z');
  const calendar = { zone: BERLIN };

  test('a fraction is refused rather than silently moving a whole day', () => {
    expect(codeOf(() => addBusinessDays(monday, 0.5, calendar))).toBe('X_SCHEDULE_INVALID');
    expect(codeOf(() => addBusinessDays(monday, -1.5, calendar))).toBe('X_SCHEDULE_INVALID');
  });

  test('NaN is refused rather than reading as "no movement"', () => {
    expect(codeOf(() => addBusinessDays(monday, Number.NaN, calendar))).toBe('X_SCHEDULE_INVALID');
    expect(codeOf(() => addBusinessDays(monday, Number.POSITIVE_INFINITY, calendar))).toBe(
      'X_SCHEDULE_INVALID',
    );
  });

  test('whole counts, including zero and negatives, still answer exactly as before', () => {
    expect(addBusinessDays(monday, 0, calendar)).toBe(monday);
    expect(toZoned(addBusinessDays(monday, 1, calendar), BERLIN).day).toBe(17);
    expect(toZoned(addBusinessDays(monday, 5, calendar), BERLIN).day).toBe(23);
    expect(toZoned(addBusinessDays(monday, -1, calendar), BERLIN).day).toBe(13);
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

describe('nextBusinessDay', () => {
  test('a business day is its own answer — the same object, not an equal one', () => {
    const monday = fromIso('2026-03-16T09:00:00Z');
    expect(nextBusinessDay(monday, { zone: BERLIN })).toBe(monday);
  });

  test('a weekend day advances to the next business day at the same local time', () => {
    const saturday = fromIso('2026-03-14T09:00:00Z');
    const answer = nextBusinessDay(saturday, { zone: BERLIN });
    expect(toZoned(answer, BERLIN).day).toBe(16);
    expect(toZoned(answer, BERLIN).hour).toBe(toZoned(saturday, BERLIN).hour);
  });

  test('a holiday is skipped too, and consecutive holidays chain', () => {
    const monday = fromIso('2026-03-16T09:00:00Z');
    const calendar = { zone: BERLIN, holidays: ['2026-03-16', '2026-03-17'] };
    expect(toZoned(nextBusinessDay(monday, calendar), BERLIN).day).toBe(18);
  });

  test('the configured weekend decides which day qualifies', () => {
    const friday = fromIso('2026-03-13T09:00:00Z');
    // Friday is a business day under Sat/Sun and a weekend day under Fri/Sat.
    expect(nextBusinessDay(friday, { zone: DUBAI, weekendDays: WEEKEND_SAT_SUN })).toBe(friday);
    const shifted = nextBusinessDay(friday, { zone: DUBAI, weekendDays: WEEKEND_FRI_SAT });
    expect(toZoned(shifted, DUBAI).day).toBe(15);
  });
});

describe('addBusinessDays keeps the ORIGINAL wall time across a spring-forward day', () => {
  test('a skipped Sunday does not shift Monday by an hour', () => {
    // Berlin skips 02:00–03:00 on Sunday 2026-03-29. Stepping an instant a day at a time landed
    // Sunday on 03:30 and carried that to Monday; the candidate is the calendar date plus the
    // wall time the caller started with.
    const friday = fromIso('2026-03-27T01:30:00Z'); // 02:30 CET
    const monday = addBusinessDays(friday, 1, { zone: BERLIN });
    expect(toZoned(monday, BERLIN)).toMatchObject({ month: 3, day: 30, hour: 2, minute: 30 });
    expect(monday.toISOString()).toBe('2026-03-30T00:30:00.000Z');
  });

  test('and backwards across the same day', () => {
    const monday = fromIso('2026-03-30T00:30:00Z'); // 02:30 CEST
    const friday = addBusinessDays(monday, -1, { zone: BERLIN });
    expect(friday.toISOString()).toBe('2026-03-27T01:30:00.000Z');
  });

  test('a destination inside the gap itself takes the next valid instant, that day', () => {
    // Sunday is a work day on a Fri/Sat weekend, and its 02:30 does not exist.
    const thursday = fromIso('2026-03-26T01:30:00Z');
    const sunday = addBusinessDays(thursday, 1, { zone: BERLIN, weekendDays: WEEKEND_FRI_SAT });
    expect(toZoned(sunday, BERLIN)).toMatchObject({ day: 29, hour: 3, minute: 30 });
    // …and the day after it is back on the wall time that was asked for.
    const monday = addBusinessDays(thursday, 2, { zone: BERLIN, weekendDays: WEEKEND_FRI_SAT });
    expect(toZoned(monday, BERLIN)).toMatchObject({ day: 30, hour: 2, minute: 30 });
  });
});

describe('businessDaysBetween walks calendar dates, not a chain of instants', () => {
  test('a day the zone skipped entirely does not push the walk past `to`', () => {
    // Samoa crossed the date line and had no 2011-12-30. Thu 29th → Mon 2 Jan is [29, 30, 31, 1]:
    // Thursday, a date that never happened, Saturday, Sunday — one business day. Chaining an
    // instant a day at a time stepped 29 → 31 → 1 → 2 and counted the Monday `to` excludes.
    const APIA = 'Pacific/Apia';
    const thursday = fromIso('2011-12-29T22:00:00Z'); // 12:00 on the 29th, UTC-10
    const monday = fromIso('2012-01-01T22:00:00Z'); // 12:00 on 2 Jan, UTC+14
    expect(toZoned(thursday, APIA)).toMatchObject({ day: 29, weekday: 4 });
    expect(toZoned(monday, APIA)).toMatchObject({ day: 2, weekday: 1 });
    expect(businessDaysBetween(thursday, monday, { zone: APIA })).toBe(1);
    expect(businessDaysBetween(monday, thursday, { zone: APIA })).toBe(-1);
  });
});

// The loop's guard used to RETURN when it ran out — `localDay(origin, offset)`, a weekend day
// handed back as if it were the business day asked for. A calendar with no business day in it has
// no answer, and saying so is the only answer that cannot be scheduled against.
describe('a calendar with no business day in it refuses', () => {
  const monday = fromIso('2026-03-16T09:00:00Z');
  const allWeekend = { zone: BERLIN, weekendDays: [1, 2, 3, 4, 5, 6, 7] as const };

  test('addBusinessDays names the calendar, in either direction', () => {
    expect(codeOf(() => addBusinessDays(monday, 1, allWeekend))).toBe('X_SCHEDULE_INVALID');
    expect(codeOf(() => addBusinessDays(monday, -3, allWeekend))).toBe('X_SCHEDULE_INVALID');
  });

  test('nextBusinessDay refuses instead of returning a weekend day', () => {
    expect(codeOf(() => nextBusinessDay(monday, allWeekend))).toBe('X_SCHEDULE_INVALID');
  });

  const refusal = (run: () => unknown): { cause: string; fix: string } => {
    try {
      run();
    } catch (error) {
      const { cause, fix } = error as { cause?: unknown; fix?: unknown };
      return { cause: String(cause), fix: String(fix) };
    }
    return { cause: 'no-throw', fix: 'no-throw' };
  };

  test('an all-weekend calendar is told to shorten its weekend', () => {
    const { cause, fix } = refusal(() => addBusinessDays(monday, 1, allWeekend));
    expect(cause).toStartWith('calendar.weekendDays must be');
    expect(cause).toContain('at least one business day');
    expect(fix).toContain('weekendDays: [6, 7]');
  });

  // Not the weekend this time: every business day the week leaves is a holiday, for longer than
  // the walk's guard looks. Only the guard can see this one, so it is the guard that must refuse.
  test('a calendar whose every business day is a holiday refuses at the guard', () => {
    const sundays: string[] = [];
    for (let day = 0; day < 12 * 366; day += 7) {
      // 2026-03-22 is a Sunday; UTC date arithmetic, then formatted as the local date it names.
      sundays.push(new Date(Date.UTC(2026, 2, 22 + day)).toISOString().slice(0, 10));
    }
    const calendar = { zone: BERLIN, weekendDays: [1, 2, 3, 4, 5, 6] as const, holidays: sundays };
    expect(codeOf(() => addBusinessDays(monday, 1, calendar))).toBe('X_SCHEDULE_INVALID');
    // Its repair is fewer holidays — a shorter weekend could not help a calendar with one already.
    const { cause, fix } = refusal(() => addBusinessDays(monday, 1, calendar));
    expect(cause).toStartWith('calendar.holidays must be');
    expect(fix).toContain('holidays: []');
  });

  test('one business day a week is still a calendar', () => {
    const sundaysOnly = { zone: BERLIN, weekendDays: [1, 2, 3, 4, 5, 6] as const };
    const landed = toZoned(addBusinessDays(monday, 2, sundaysOnly), BERLIN);
    expect([landed.weekday, landed.day]).toEqual([7, 29]);
  });
});
