/**
 * Cron occurrence math: walking the local wall clock forward to the next matching instant,
 * converted once with `fromZoned` so DST gaps and overlaps resolve correctly.
 */

import { type CronExpression, matchesDay, parseCronOnce } from './cron-parse';
import { cronInvalid } from './errors';
import { fromEpochMs, type Instant } from './instant';
import { fromZoned, toZoned } from './zoned';
import { assertTimeZone, type TimeZone } from './zones';

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

/** Iteration guard: ~4 years of minute-level field advancement. */
const MAX_STEPS = 200_000;

/**
 * The next instant strictly after `after` that matches, computed on the zone's wall clock
 * and converted with `fromZoned({ gap: 'next', overlap: 'first' })`:
 *  - spring forward: a 02:30 daily job runs once, at the first existing local time after
 *    the gap, instead of being silently skipped;
 *  - fall back: a repeated local time runs once, on its first occurrence.
 */
export function nextCronOccurrence(
  expression: string | CronExpression,
  zone: TimeZone,
  after: Instant,
): Instant {
  const cron = parseCronOnce(expression);
  assertTimeZone(zone);

  const start = toZoned(after, zone);
  const cursor: Cursor = {
    year: start.year,
    month: start.month,
    day: start.day,
    hour: start.hour,
    minute: start.minute,
    second: start.second + 1,
  };
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

    const candidate = fromZoned({ ...cursor }, zone, { gap: 'next', overlap: 'first' });
    if (candidate.getTime() > after.getTime()) return candidate;
    // The DST gap can push a candidate onto an instant we have already passed; step on.
    cursor.second += 1;
    carry(cursor);
  }

  throw cronInvalid(
    typeof expression === 'string' ? expression : cron.source,
    'no occurrence within the next ~4 years — the date fields can never all match (e.g. "0 0 30 2 *")',
  );
}

/** The next `count` occurrences, each strictly after the previous one. */
export function nextCronOccurrences(
  expression: string | CronExpression,
  zone: TimeZone,
  after: Instant,
  count: number,
): Instant[] {
  const cron = parseCronOnce(expression);
  const results: Instant[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
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
  const day = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).getUTCDay();
  return ((day + 6) % 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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
