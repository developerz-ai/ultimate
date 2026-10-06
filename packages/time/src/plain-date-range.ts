/**
 * `plainDateRange` — the calendar dates between two `PlainDate`s, as a bounded, frozen array. It is
 * how a closure becomes holidays: `holidays: [...fixed, ...plainDateRange(from, to)]`, one list.
 */

import { scheduleInvalid } from './errors';
import { addPlainDays, type PlainDate, plainDate, plainDaysBetween } from './plain-date';

/**
 * The widest span accepted, in days: ten years and change. A range is materialised, so an absurd
 * one (`0000-01-01 … 9999-12-31`, 3.65 M dates) is refused before it allocates — a holiday list or
 * a report window longer than this is a bug in whatever computed its ends.
 */
export const MAX_PLAIN_DATE_RANGE_DAYS = 3660;

export interface PlainDateRangeOptions {
  /** Leave `end` out — `[start, end)`. Default `false`: `[start, end]`, the closure reading. */
  readonly exclusive?: boolean;
  /** Days between consecutive dates, a positive whole number. Default `1`. */
  readonly stepDays?: number;
}

/**
 * Every `stepDays`-th date from `start`, up to `end` — **inclusive by default** (`[start, end]`),
 * `[start, end)` with `{ exclusive: true }`. `end` appears only when the step lands on it.
 *
 * An array, not a generator: every caller spreads it into a holiday list or iterates it twice, and
 * the bound makes it small. Frozen: each call's list is its own, not a buffer to edit. A reversed
 * range is refused rather than answered empty — `start > end` is a swapped argument far more often
 * than a deliberate empty set — as is a span over `MAX_PLAIN_DATE_RANGE_DAYS`, whatever the step.
 */
export function plainDateRange(
  start: PlainDate,
  end: PlainDate,
  options: PlainDateRangeOptions = {},
): readonly PlainDate[] {
  const from = plainDate(start);
  const to = plainDate(end);
  const step = options.stepDays ?? 1;
  if (!Number.isSafeInteger(step) || step < 1) {
    throw scheduleInvalid('stepDays', step, 'a whole number of days, at least 1');
  }
  const span = plainDaysBetween(from, to);
  if (span < 0) {
    throw scheduleInvalid('end', `${from} … ${to}`, `a date on or after start (${from})`);
  }
  if (span > MAX_PLAIN_DATE_RANGE_DAYS) {
    throw scheduleInvalid(
      'end',
      `${from} … ${to} (${span} days)`,
      `at most ${MAX_PLAIN_DATE_RANGE_DAYS} days after start — split the range`,
    );
  }
  const last = options.exclusive === true ? span - 1 : span;
  const dates: PlainDate[] = [];
  for (let offset = 0; offset <= last; offset += step) dates.push(addPlainDays(from, offset));
  return Object.freeze(dates);
}
