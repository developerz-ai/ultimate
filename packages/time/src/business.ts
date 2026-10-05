/**
 * Business-day math. The weekend is configuration, not a constant: Friday/Saturday in
 * much of the Gulf, Sunday-only in parts of Asia, Saturday/Sunday in the West.
 */

import { scheduleInvalid, type TimeError } from './errors';
import type { Instant } from './instant';
import { daysBetween, fromZoned, isoDateInZone, toZoned, type ZonedDateTime } from './zoned';
import { type TimeZone, utcEpoch } from './zones';

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKEND_SAT_SUN: readonly IsoWeekday[] = [6, 7];
/** Gulf states, and the default in Israel (Fri/Sat). */
export const WEEKEND_FRI_SAT: readonly IsoWeekday[] = [5, 6];
export const WEEKEND_SUN_ONLY: readonly IsoWeekday[] = [7];
const EVERY_WEEKDAY: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

export interface BusinessCalendar {
  zone: TimeZone;
  /** Defaults to Saturday + Sunday, which is a choice, not a law. */
  weekendDays?: readonly IsoWeekday[];
  /** Local `YYYY-MM-DD` dates that are holidays in this calendar. */
  holidays?: readonly string[];
}

export function isWeekend(at: Instant, zone: TimeZone, weekendDays = WEEKEND_SAT_SUN): boolean {
  return weekendDays.includes(toZoned(at, zone).weekday as IsoWeekday);
}

export function isHoliday(at: Instant, calendar: BusinessCalendar): boolean {
  const holidays = calendar.holidays ?? [];
  return holidays.includes(isoDateInZone(at, calendar.zone));
}

/** A business day is a non-weekend, non-holiday local day. */
export function isBusinessDay(at: Instant, calendar: BusinessCalendar): boolean {
  return (
    !isWeekend(at, calendar.zone, calendar.weekendDays ?? WEEKEND_SAT_SUN) &&
    !isHoliday(at, calendar)
  );
}

/**
 * Move `days` business days forward (or back, if negative), keeping the local wall-clock
 * time. `days === 0` returns the input untouched, even on a weekend — callers that want
 * "the next business day" should ask for 1.
 *
 * The count is a WHOLE number of days, checked the way `plain-date.ts`'s `addPlainDays` checks its
 * own: `0.5` used to reach `Math.abs(days)` as a loop bound and move a whole day, and a `NaN` —
 * the shape a corrupted config or a failed parse takes — failed `remaining > 0` on the first test
 * and returned the input, which reads as "no movement was needed" rather than as a failure.
 */
export function addBusinessDays(at: Instant, days: number, calendar: BusinessCalendar): Instant {
  if (!Number.isSafeInteger(days)) {
    throw scheduleInvalid('days', days, 'a whole number of business days');
  }
  if (days === 0) return at;
  // The misconfiguration this refusal is usually about, answered before ten years of walking.
  const weekend = calendar.weekendDays ?? WEEKEND_SAT_SUN;
  if (EVERY_WEEKDAY.every((day) => weekend.includes(day))) {
    throw noBusinessDay(calendar);
  }
  const step = days > 0 ? 1 : -1;
  const origin = toZoned(at, calendar.zone);
  let remaining = Math.abs(days);
  let offset = 0;
  let guard = 0;
  let landed = at;

  while (remaining > 0) {
    offset += step;
    const candidate = localDay(origin, offset, calendar.zone);
    if (candidate !== null && isBusinessDay(candidate, calendar)) {
      remaining -= 1;
      landed = candidate;
    }
    guard += 1;
    // Ten years past the last day a full week could need without one business day: the calendar has
    // none to give. It used to RETURN here — the day the guard stopped on, a weekend or a holiday —
    // which a caller schedules against as if it were the business day it asked for.
    if (guard > Math.abs(days) * 7 + 3650) throw noBusinessDay(calendar);
  }
  return landed;
}

/** The refusal for a calendar the loop above can never land in — all weekend, or all holiday. */
function noBusinessDay(calendar: BusinessCalendar): TimeError {
  return scheduleInvalid(
    'calendar',
    {
      zone: calendar.zone,
      weekendDays: calendar.weekendDays ?? WEEKEND_SAT_SUN,
      holidays: (calendar.holidays ?? []).length,
    },
    'a calendar with at least one business day',
  );
}

/**
 * The calendar date `offset` days from `origin`'s, at `origin`'s wall time — or `null` when the
 * zone never had that date (Samoa's 2011-12-30).
 *
 * Built from the calendar date and the ORIGINAL wall time, never from the day before it. Chaining
 * `addDaysInZone` a day at a time carried a DST repair forward: 02:30 through a spring-forward
 * Sunday became 03:30 there and stayed 03:30 on Monday, where 02:30 exists. `fromZoned` normalizes
 * the day overflow, so `day + offset` is the whole walk.
 */
function localDay(origin: ZonedDateTime, offset: number, zone: TimeZone): Instant | null {
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

/** The next business day at the same local time; today if it already qualifies. */
export function nextBusinessDay(at: Instant, calendar: BusinessCalendar): Instant {
  return isBusinessDay(at, calendar) ? at : addBusinessDays(at, 1, calendar);
}

/**
 * Business days in `[from, to)` — **half-open, and counted on local calendar days**: `from`'s own
 * day counts, `to`'s does not, and the wall-clock time of either endpoint is not part of the
 * question. It is exactly the interval `daysBetween` measures, minus the weekends and holidays
 * in it, so the two functions can never disagree about how long a span is.
 *
 * The loop used to advance an *instant* one local day at a time and stop on
 * `cursor.getTime() > end.getTime()`, which made the last day depend on whether `to`'s clock time
 * had passed `from`'s: `Mon 09:00 → Fri 10:00` answered 4 and `Mon 09:00 → Fri 08:00` answered 3
 * for the same calendar span. Order-independent: a reversed range returns a negative count, and an
 * empty one returns `0` in either direction — never `-0`.
 */
export function businessDaysBetween(
  from: Instant,
  to: Instant,
  calendar: BusinessCalendar,
): number {
  const sign = to.getTime() < from.getTime() ? -1 : 1;
  const start = sign === 1 ? from : to;
  const end = sign === 1 ? to : from;
  // `daysBetween` is the day count of the same half-open interval, so it is also the exact number
  // of iterations. Each one is a calendar DATE counted from `start`'s — not the instant a day after
  // the previous one, which steps over a date the zone skipped and so reaches past `to`.
  const days = daysBetween(start, end, calendar.zone);
  const origin = toZoned(start, calendar.zone);
  let count = 0;
  for (let index = 0; index < days; index += 1) {
    const day = localDay(origin, index, calendar.zone);
    if (day !== null && isBusinessDay(day, calendar)) count += 1;
  }
  // Guarded rather than `sign * count`: an empty interval read backwards would otherwise answer
  // `-0`, which `Object.is`, a `Map` key and every `toBe` treat as a value distinct from `0`.
  return count === 0 ? 0 : sign * count;
}
