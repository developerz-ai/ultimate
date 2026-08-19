// Business-day maths: the weekend is configuration, the zone decides which local day it is, and
// `businessDaysBetween` counts the half-open `[from, to)` interval `daysBetween` measures.

import { describe, expect, test } from 'bun:test';
import {
  addBusinessDays,
  businessDaysBetween,
  isWeekend,
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
