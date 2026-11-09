/**
 * Business-day math. The weekend is configuration, not a constant: Friday/Saturday in
 * much of the Gulf, Sunday-only in parts of Asia, Saturday/Sunday in the West.
 */

import {
  countIn,
  dayOfEpoch,
  holidayDays,
  nthWorkday,
  weekdayOfDay,
  workdaysIn,
  workdayTable,
} from './business-span';
import { scheduleInvalid, type TimeError } from './errors';
import { holidaySet } from './holidays';
import type { Instant } from './instant';
import { localDayAt, skippedDays } from './zone-skipped-days';
import { daysBetween, isoDateInZone, toZoned, type ZonedDateTime } from './zoned';
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
  // A `Set` built once per list (`holidays.ts`): every business-day walk asks this per day.
  return holidaySet(calendar.holidays).has(isoDateInZone(at, calendar.zone));
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
  const wanted = Math.abs(days);
  const zoned = toZoned(at, calendar.zone);
  const origin = epochDayOf(zoned);
  const isWorkday = workdayTable(weekend);
  const holidays = holidayDays(calendar.holidays).filter((day) => isWorkday[weekdayOfDay(day)]);
  // Ten years past the last day a full week could need without one business day: the calendar has
  // none to give. The guard used to RETURN the day it stopped on, a weekend or a holiday — which a
  // caller schedules against as if it were the business day it asked for.
  const guard = wanted * 7 + 3650;
  // Workdays the zone never had at this wall time, gathered as the span grows: `[1, scanned]` days out.
  const skipped: number[] = [];
  let scanned = 0;
  // The smallest distance with `wanted` business days in `(origin, origin + distance]`: start at
  // the `wanted`th workday and move to the `(wanted + excluded)`th until the excluded count stops
  // growing — each step stays at or below the answer, so the fixed point IS the answer.
  let distance = nthWorkday(origin, wanted, step, isWorkday);
  for (;;) {
    if (distance > guard) throw noBusinessDay(calendar);
    if (distance > scanned) {
      const [low, high] = span(origin, scanned + 1, distance + 1, step);
      for (const day of skippedDays(calendar.zone, zoned, low, high)) {
        if (isWorkday[weekdayOfDay(day)] && countIn(holidays, day, day + 1) === 0)
          skipped.push(day);
      }
      skipped.sort((left, right) => left - right);
      scanned = distance;
    }
    const [low, high] = span(origin, 1, distance + 1, step);
    const excluded = countIn(holidays, low, high) + countIn(skipped, low, high);
    const next = nthWorkday(origin, wanted + excluded, step, isWorkday);
    if (next === distance) break;
    distance = next;
  }
  const landed = localDayAt(origin + step * distance, zoned, calendar.zone);
  // `skippedDays` found every date this zone lacks; a `null` here is a tzdata it was not measured on.
  if (landed === null) throw noBusinessDay(calendar);
  return landed;
}

/** The epoch days `[low, high)` that distances `[near, far)` from `origin` cover, in `step`'s direction. */
function span(origin: number, near: number, far: number, step: 1 | -1): [number, number] {
  return step === 1 ? [origin + near, origin + far] : [origin - far + 1, origin - near + 1];
}

/** The local calendar date of a zoned value, as an epoch day. */
function epochDayOf(zoned: ZonedDateTime): number {
  return dayOfEpoch(utcEpoch(zoned.year, zoned.month, zoned.day));
}

/**
 * The refusal for a calendar the loop above can never land in. Which list is at fault decides the
 * repair: a weekend covering all seven days, or — the weekend leaving days — holidays covering them.
 */
function noBusinessDay(calendar: BusinessCalendar): TimeError {
  const weekend = calendar.weekendDays ?? WEEKEND_SAT_SUN;
  if (EVERY_WEEKDAY.every((day) => weekend.includes(day))) {
    return scheduleInvalid(
      'calendar.weekendDays',
      weekend,
      'ISO weekdays (1-7) that leave at least one business day',
    );
  }
  return scheduleInvalid(
    'calendar.holidays',
    (calendar.holidays ?? []).length,
    'dates that leave at least one business day in any ten-year window (remove some of them)',
  );
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
  const zoned = toZoned(start, calendar.zone);
  const first = epochDayOf(zoned);
  const last = first + days;
  const weekend = calendar.weekendDays ?? WEEKEND_SAT_SUN;
  const isWorkday = workdayTable(weekend);
  // Whole weeks multiplied, holidays subtracted by binary search, and only the dates the zone
  // never had at this wall time asked of `Intl` — it was every date, two to three calls each.
  const holidays = holidayDays(calendar.holidays).filter((day) => isWorkday[weekdayOfDay(day)]);
  let count = workdaysIn(first, last, isWorkday) - countIn(holidays, first, last);
  for (const day of skippedDays(calendar.zone, zoned, first, last)) {
    if (isWorkday[weekdayOfDay(day)] && countIn(holidays, day, day + 1) === 0) count -= 1;
  }
  // Guarded rather than `sign * count`: an empty interval read backwards would otherwise answer
  // `-0`, which `Object.is`, a `Map` key and every `toBe` treat as a value distinct from `0`.
  return count === 0 ? 0 : sign * count;
}
