/**
 * Cron occurrence math: walking the local wall clock forward to the next matching instant,
 * converted once with `fromZoned` so DST gaps and overlaps resolve correctly.
 */

import { finiteCount } from '@ultimat3/core';
import { type CronExpression, matchesDay, parseCronOnce } from './cron-parse';
import { cronInvalid } from './errors';
import { fromEpochMs, type Instant } from './instant';
import { fromZoned, toZoned } from './zoned';
import { assertTimeZone, offsetAt, type TimeZone, utcEpoch } from './zones';

/** True when `at` matches the expression in `zone`, to the second. */
export function matchesCron(
  expression: string | CronExpression,
  at: Instant,
  zone: TimeZone,
): boolean {
  const cron = parseCronOnce(expression);
  const zoned = toZoned(at, zone);
  return (
    cron.seconds.includes(zoned.second) &&
    cron.minutes.includes(zoned.minute) &&
    cron.hours.includes(zoned.hour) &&
    cron.months.includes(zoned.month) &&
    matchesDay(cron, zoned.day, zoned.weekday)
  );
}

/**
 * Iteration guard, counted in field advancements — not in minutes, and not in years. Each step
 * moves whichever field rejected first, so one step is worth a second or a whole month depending
 * on the expression; the budget only has to outlast every schedule that can actually match.
 */
const MAX_STEPS = 200_000;

/**
 * The next instant strictly after `after` that matches, computed on the zone's wall clock
 * and converted with `fromZoned({ gap: 'next', overlap: 'first' })`:
 *  - spring forward: a 02:30 daily job runs once, at the first existing local time after
 *    the gap, instead of being silently skipped;
 *  - fall back, a FIXED time (`30 2 * * *`): the repeated local time runs once, on its first
 *    occurrence — asked from anywhere, including from inside the repeated hour;
 *  - fall back, an INTERVAL (every five minutes, `0 * * * *` — `CronExpression.wildcardTime`):
 *    the repeated hour is real elapsed time and the schedule runs through both passes of it.
 *
 * The last two are Vixie cron's rule, and they are one rule about what the author named: a fixed
 * time names a moment of the day, an interval names a rhythm. The wall clock alone could not say
 * it — walking it forward from 02:55 reaches 03:00 and never sees 02:00 come round again, so
 * every interval schedule went dark for one hour a year.
 */
export function nextCronOccurrence(
  expression: string | CronExpression,
  zone: TimeZone,
  after: Instant,
): Instant {
  const cron = parseCronOnce(expression);
  assertTimeZone(zone);
  const source = typeof expression === 'string' ? expression : cron.source;

  const start = toZoned(after, zone);
  const first = walk(cron, zone, source, after, {
    year: start.year,
    month: start.month,
    day: start.day,
    hour: start.hour,
    minute: start.minute,
    second: start.second + 1,
  });
  if (!cron.wildcardTime) return first;

  // The second pass of an overlap that begins AFTER `after`. Its wall times are behind the cursor
  // the first walk started from, so that walk cannot have met them; they are met here, by walking
  // again from the wall clock the transition lands on. Only a transition inside the overlap's own
  // reach matters — past it, every repeated wall time has a first-pass instant that is itself
  // after `after`, and the first walk already answered with something at or before it.
  const horizon = Math.min(first.getTime(), after.getTime() + OVERLAP_REACH_MS);
  const offsetBefore = offsetAt(zone, after);
  if (offsetAt(zone, fromEpochMs(horizon)) >= offsetBefore) return first;
  const landed = toZoned(fromEpochMs(fallBackAt(zone, after.getTime(), horizon)), zone);
  const repeated = walk(
    cron,
    zone,
    source,
    after,
    {
      year: landed.year,
      month: landed.month,
      day: landed.day,
      hour: landed.hour,
      minute: landed.minute,
      second: landed.second,
    },
    'second',
  );
  return repeated.getTime() < first.getTime() ? repeated : first;
}

/**
 * How far ahead of `after` a fall-back can begin and still repeat a wall time `after` has already
 * passed. A day and a bit: no zone's clock has ever been set back by more than a day.
 */
const OVERLAP_REACH_MS = 26 * 3_600_000;

/** The first epoch ms in `(from, to]` whose offset is below `from`'s — found by bisection. */
function fallBackAt(zone: TimeZone, from: number, to: number): number {
  const before = offsetAt(zone, fromEpochMs(from));
  let lo = from;
  let hi = to;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(zone, fromEpochMs(mid)) < before) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Walk the wall clock forward from `cursor` (inclusive) to the first matching wall time whose
 * instant is after `after`. `overlap` is which pass a repeated wall time resolves to FIRST.
 */
function walk(
  cron: CronExpression,
  zone: TimeZone,
  source: string,
  after: Instant,
  cursor: Cursor,
  overlap: 'first' | 'second' = 'first',
): Instant {
  carry(cursor);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (!cron.months.includes(cursor.month)) {
      cursor.month += 1;
      cursor.day = 1;
      resetTime(cursor);
      carry(cursor);
      continue;
    }
    if (cursor.day > daysInMonth(cursor.year, cursor.month)) {
      cursor.month += 1;
      cursor.day = 1;
      resetTime(cursor);
      carry(cursor);
      continue;
    }
    if (!matchesDay(cron, cursor.day, isoWeekday(cursor))) {
      cursor.day += 1;
      resetTime(cursor);
      carry(cursor);
      continue;
    }
    if (!cron.hours.includes(cursor.hour)) {
      cursor.hour += 1;
      cursor.minute = 0;
      cursor.second = 0;
      carry(cursor);
      continue;
    }
    if (!cron.minutes.includes(cursor.minute)) {
      cursor.minute += 1;
      cursor.second = 0;
      carry(cursor);
      continue;
    }
    if (!cron.seconds.includes(cursor.second)) {
      cursor.second += 1;
      carry(cursor);
      continue;
    }

    const candidate = fromZoned({ ...cursor }, zone, { gap: 'next', overlap });
    if (candidate.getTime() > after.getTime()) return candidate;
    // `after` is INSIDE the second pass of a repeated hour, so the first pass of this wall time is
    // behind it. An interval schedule's next run is the second pass; a fixed time already ran.
    if (cron.wildcardTime && overlap === 'first') {
      const later = fromZoned({ ...cursor }, zone, { gap: 'next', overlap: 'second' });
      if (later.getTime() > after.getTime()) return later;
    }
    // The DST gap can push a candidate onto an instant we have already passed; step on.
    cursor.second += 1;
    carry(cursor);
  }

  // The backstop, not the primary check. An impossible day/month pair — `0 0 30 2 *`, a 30th of
  // February — is refused by `parseCron` in constant time, because reaching it here cost ~150ms of
  // blocking CPU per call and `firedSince` pays that per tick of the scheduler's leader loop.
  throw cronInvalid(
    source,
    `no occurrence after ${MAX_STEPS} search steps — the date fields can never all match`,
  );
}

/**
 * The next `count` occurrences, each strictly after the previous one.
 *
 * `count` is screened because it bounds the loop: `NaN` answered `[]` — "no occurrences" — `2.5`
 * ran three times, and `Infinity` pushed until the process ran out of memory.
 */
export function nextCronOccurrences(
  expression: string | CronExpression,
  zone: TimeZone,
  after: Instant,
  count: number,
): Instant[] {
  const total = finiteCount('nextCronOccurrences', 'count', count, 0);
  const cron = parseCronOnce(expression);
  const results: Instant[] = [];
  let cursor = after;
  for (let index = 0; index < total; index += 1) {
    cursor = nextCronOccurrence(cron, zone, cursor);
    results.push(cursor);
  }
  return results;
}

/** Exported for the scheduler's leader loop: has this expression fired since `since`? */
export function firedSince(
  expression: string | CronExpression,
  zone: TimeZone,
  since: Instant,
  until: Instant,
): boolean {
  if (until.getTime() <= since.getTime()) return false;
  const next = nextCronOccurrence(expression, zone, since);
  return next.getTime() <= until.getTime();
}

/** Epoch-ms helper used by the jobs package when it only has a number. */
export function nextCronOccurrenceMs(
  expression: string | CronExpression,
  zone: TimeZone,
  afterMs: number,
): number {
  return nextCronOccurrence(expression, zone, fromEpochMs(afterMs)).getTime();
}

interface Cursor {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function isoWeekday(cursor: Cursor): number {
  const day = new Date(utcEpoch(cursor.year, cursor.month, cursor.day)).getUTCDay();
  return ((day + 6) % 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcEpoch(year, month + 1, 0)).getUTCDate();
}

function resetTime(cursor: Cursor): void {
  cursor.hour = 0;
  cursor.minute = 0;
  cursor.second = 0;
}

/** Carry overflow up the fields so the cursor stays a real calendar date. */
function carry(cursor: Cursor): void {
  if (cursor.second > 59) {
    cursor.minute += Math.floor(cursor.second / 60);
    cursor.second %= 60;
  }
  if (cursor.minute > 59) {
    cursor.hour += Math.floor(cursor.minute / 60);
    cursor.minute %= 60;
  }
  if (cursor.hour > 23) {
    cursor.day += Math.floor(cursor.hour / 24);
    cursor.hour %= 24;
  }
  while (cursor.month > 12) {
    cursor.month -= 12;
    cursor.year += 1;
  }
  while (cursor.day > daysInMonth(cursor.year, cursor.month)) {
    cursor.day -= daysInMonth(cursor.year, cursor.month);
    cursor.month += 1;
    if (cursor.month > 12) {
      cursor.month = 1;
      cursor.year += 1;
    }
  }
}
