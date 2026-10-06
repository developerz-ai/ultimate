/**
 * Month arithmetic: the one calendar step with no fixed length. Both functions clamp the day to the
 * target month's last day, and the zoned one does it on the LOCAL date — never UTC month math.
 */

import { renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import { TimeError } from './errors';
import { type Instant, instant } from './instant';
import { daysInMonth, type PlainDate, plainDateOf, plainDateParts } from './plain-date';
import { fromZoned, toZoned } from './zoned';
import { assertTimeZone, type TimeZone } from './zones';

/** The last month a `PlainDate` can name, counted from year 0's January: 9999-12. */
const LAST_MONTH = 9999 * 12 + 11;

/**
 * `date` moved by `months` calendar months, the day clamped to the target month's last day:
 * `2026-01-31 + 1` is `2026-02-28`, `2024-01-31 + 1` is `2024-02-29`, `2026-03-31 − 1` is
 * `2026-02-28`. Negative counts go back; the year rolls either way.
 *
 * A clamp does not compose: `2026-01-31 + 1 + 1` is `2026-03-28`, while `2026-01-31 + 2` is
 * `2026-03-31`. A recurring date (a renewal, a billing day) is computed from its ANCHOR —
 * `addPlainMonths(anchor, n)` for the n-th — never chained from the previous result.
 *
 * A whole number of months, checked as `addPlainDays` checks its days; a result outside years
 * 0000-9999 is refused rather than branded.
 */
export function addPlainMonths(date: PlainDate, months: number): PlainDate {
  // Parsed first, so every refusal below can paste the caller's date back as a checked literal.
  const { year, month, day } = plainDateParts(date);
  if (!Number.isSafeInteger(months)) {
    throw monthsInvalid(
      `months must be a whole number of months, got ${renderCauseValue(months)}`,
      `addPlainMonths(${dateLiteral(date)}, ${wholeMonths(months)})   # months is a whole number — round it before the call`,
    );
  }
  // Months counted from year 0 so one floor-division carries the year in both directions.
  const from = year * 12 + (month - 1);
  const total = from + months;
  if (total < 0 || total > LAST_MONTH) {
    // The furthest count that still lands in 0000-9999, in the direction the caller asked.
    const furthest = total < 0 ? -from : LAST_MONTH - from;
    throw monthsInvalid(
      `${date} ${months < 0 ? '-' : '+'} ${Math.abs(months)} months leaves years 0000-9999`,
      `addPlainMonths(${dateLiteral(date)}, ${furthest})   # the furthest a PlainDate reaches from ${date}`,
    );
  }
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  return plainDateOf({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/**
 * `at` moved by `months` calendar months in `zone`, keeping the LOCAL wall-clock time: 09:00 EST
 * on Feb 15 + 1 is 09:00 EDT on Mar 15 — 743 hours later, not 744. The local DATE moves by
 * `addPlainMonths` (so it clamps exactly as a plain date does), then the original wall time is
 * resolved on it once. The zone is required: an instant has a month only in a zone.
 *
 * The target wall time can fail to exist, or exist twice. The rule is Temporal's `'compatible'`
 * disambiguation, and it is not configurable:
 *
 * | Target wall time | Resolves to |
 * |---|---|
 * | in a spring-forward GAP | moved FORWARD by the gap's length — 02:30 New York → 03:30 EDT; 02:15 Lord Howe (a 30-minute shift) → 02:45 |
 * | in a fall-back OVERLAP | the EARLIER instant, i.e. the pre-transition offset — 01:30 New York → 01:30 EDT |
 *
 * Those are `fromZoned`'s `{ gap: 'next', overlap: 'first' }`, the policies `addDaysInZone` uses.
 * A caller needing another answer reads the local date from this result and calls `fromZoned` with
 * its own policy. `months === 0` returns a copy of `at` untouched, even inside an overlap's second
 * pass — re-resolving it would answer the first.
 */
export function addMonthsInZone(at: Instant, months: number, timeZone: TimeZone): Instant {
  // The zone first: an omitted one is the mistake this signature exists to make loud.
  const zone = assertTimeZone(timeZone);
  if (!Number.isSafeInteger(months)) {
    throw monthsInvalid(
      `months must be a whole number of months, got ${renderCauseValue(months)}`,
      `addMonthsInZone(at, ${wholeMonths(months)}, ${renderFixLiteral(zone, '<Area/Location>')})   # months is a whole number — round it before the call`,
    );
  }
  if (months === 0) return instant(at);
  const local = toZoned(at, zone);
  const target = plainDateParts(
    addPlainMonths(plainDateOf({ year: local.year, month: local.month, day: local.day }), months),
  );
  return fromZoned(
    {
      ...target,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
      millisecond: local.millisecond,
    },
    zone,
    { gap: 'next', overlap: 'first' },
  );
}

/** A parsed `PlainDate` — digits and dashes only — as source that pastes as written. */
const dateLiteral = (date: PlainDate): string =>
  `plainDate(${renderFixLiteral(date, '<YYYY-MM-DD>')})`;

/** The whole count nearest what the caller meant, or `1` when there is nothing to round (NaN). */
const wholeMonths = (months: number): number => {
  const rounded = Math.trunc(months);
  return Number.isSafeInteger(rounded) ? rounded : 1;
};

/**
 * `X_SCHEDULE_INVALID` with the corrected CALL as its fix — `scheduleInvalid`'s generic line names a
 * field to repair, which is prose here. `TimeError` takes its fix per throw, so the code is shared.
 */
const monthsInvalid = (cause: string, fix: string): TimeError =>
  new TimeError({ code: 'X_SCHEDULE_INVALID', cause, fix });
