/**
 * Business-day math. The weekend is configuration, not a constant: Friday/Saturday in
 * much of the Gulf, Sunday-only in parts of Asia, Saturday/Sunday in the West.
 */

import type { Instant } from './instant';
import { addDaysInZone, daysBetween, isoDateInZone, toZoned } from './zoned';
import type { TimeZone } from './zones';

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKEND_SAT_SUN: readonly IsoWeekday[] = [6, 7];
/** Gulf states, and the default in Israel (Fri/Sat). */
export const WEEKEND_FRI_SAT: readonly IsoWeekday[] = [5, 6];
export const WEEKEND_SUN_ONLY: readonly IsoWeekday[] = [7];

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
 */
export function addBusinessDays(at: Instant, days: number, calendar: BusinessCalendar): Instant {
  if (days === 0) return at;
  const step = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);
  let cursor = at;
  let guard = 0;

  while (remaining > 0) {
    cursor = addDaysInZone(cursor, step, calendar.zone);
    if (isBusinessDay(cursor, calendar)) remaining -= 1;
    guard += 1;
    // A calendar with every day marked as a holiday would otherwise loop forever.
    if (guard > Math.abs(days) * 7 + 3650) return cursor;
  }
  return cursor;
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
 * for the same calendar span. Order-independent: a reversed range returns a negative count.
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
  // of iterations — the loop cannot run away on a calendar `addDaysInZone` handles oddly.
  const days = daysBetween(start, end, calendar.zone);
  let cursor = start;
  let count = 0;
  for (let index = 0; index < days; index += 1) {
    if (isBusinessDay(cursor, calendar)) count += 1;
    cursor = addDaysInZone(cursor, 1, calendar.zone);
  }
  return sign * count;
}
