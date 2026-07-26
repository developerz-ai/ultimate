/**
 * A real cron parser and occurrence calculator. Timezone-aware through `fromZoned`, so
 * `0 3 * * *` in `Europe/Berlin` fires at 03:00 local on both sides of a DST change
 * instead of drifting to 02:00 or 04:00 for half the year.
 */

import { cronInvalid } from './errors';
import { fromEpochMs, type Instant } from './instant';
import { fromZoned, toZoned } from './zoned';
import { assertTimeZone, type TimeZone } from './zones';

export interface CronExpression {
  /** The normalized source text. */
  source: string;
  seconds: readonly number[];
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[];
  months: readonly number[];
  /** ISO weekdays, 1 = Monday … 7 = Sunday (cron's 0 and 7 both mean Sunday). */
  daysOfWeek: readonly number[];
  /** Vixie semantics: when both day fields are restricted, either one matching is a hit. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse 5 fields (`m h dom mon dow`) or 6 with a leading seconds field. */
export function parseCron(expression: string): CronExpression {
  const trimmed = expression.trim().toLowerCase();
  const expanded = MACROS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/).filter((field) => field !== '');

  if (fields.length !== 5 && fields.length !== 6) {
    throw cronInvalid(expression, `expected 5 or 6 fields, got ${fields.length}`);
  }
  const withSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, domField, monthField, dowField] = withSeconds
    ? fields
    : ['0', ...fields];

  const seconds = parseField(expression, secondField ?? '0', 0, 59);
  const minutes = parseField(expression, minuteField ?? '*', 0, 59);
  const hours = parseField(expression, hourField ?? '*', 0, 23);
  const daysOfMonth = parseField(expression, domField ?? '*', 1, 31);
  const months = parseField(expression, monthField ?? '*', 1, 12, MONTH_NAMES, 1);
  const rawDow = parseField(expression, dowField ?? '*', 0, 7, DAY_NAMES, 0);

  // 0 and 7 are both Sunday in cron; ISO calls Sunday 7.
  const daysOfWeek = [...new Set(rawDow.map((day) => (day === 0 ? 7 : day)))].sort((a, b) => a - b);

  return {
    source: expanded,
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: isRestricted(domField ?? '*'),
    dayOfWeekRestricted: isRestricted(dowField ?? '*'),
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

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

export interface CronPhrases {
  everyMinute: string;
  everyNMinutes: string;
  everyHour: string;
  everyNHours: string;
  at: string;
  onDaysOfMonth: string;
  onWeekdays: string;
  inMonths: string;
  everyDay: string;
}

/** English defaults; the admin dashboard passes `t('time.cron.*')` instead. */
export const DEFAULT_CRON_PHRASES: CronPhrases = {
  everyMinute: 'every minute',
  everyNMinutes: 'every {n} minutes',
  everyHour: 'every hour',
  everyNHours: 'every {n} hours',
  at: 'at {time}',
  onDaysOfMonth: 'on day {days}',
  onWeekdays: 'on {days}',
  inMonths: 'in {months}',
  everyDay: 'every day',
};

/**
 * `describeCron('0 3 * * MON-FRI', 'en')` → `at 03:00 on Monday–Friday`.
 * Month and weekday names come from `Intl`; the connective phrases are injected so this
 * package never hardcodes a user-facing English string.
 */
export function describeCron(
  expression: string | CronExpression,
  locale: string,
  phrases: Partial<CronPhrases> = {},
): string {
  const cron = parseCronOnce(expression);
  const words = { ...DEFAULT_CRON_PHRASES, ...phrases };
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const segments: string[] = [];

  const minuteStep = uniformStep(cron.minutes, 60);
  const hourStep = uniformStep(cron.hours, 24);
  // Only a fixed clock time reads as "at 03:00 every day"; an interval already says it.
  let explicitTime = false;

  if (cron.minutes.length === 60 && cron.hours.length === 24) {
    segments.push(words.everyMinute);
  } else if (minuteStep !== undefined && cron.hours.length === 24) {
    segments.push(fill(words.everyNMinutes, { n: minuteStep }));
  } else if (cron.minutes.length === 1 && hourStep !== undefined) {
    segments.push(fill(words.everyNHours, { n: hourStep }));
  } else {
    explicitTime = true;
    const times = cron.hours.flatMap((hour) =>
      cron.minutes.map((minute) => `${pad2(hour)}:${pad2(minute)}`),
    );
    segments.push(fill(words.at, { time: list.format(times.slice(0, 6)) }));
  }

  if (cron.dayOfMonthRestricted) {
    const days = list.format(cron.daysOfMonth.map(String));
    segments.push(fill(words.onDaysOfMonth, { days }));
  }
  if (cron.dayOfWeekRestricted) {
    const days = list.format(cron.daysOfWeek.map((day) => weekdayName(day, locale)));
    segments.push(fill(words.onWeekdays, { days }));
  }
  if (cron.months.length < 12) {
    const months = list.format(cron.months.map((month) => monthName(month, locale)));
    segments.push(fill(words.inMonths, { months }));
  }
  if (explicitTime && segments.length === 1) segments.push(words.everyDay);
  return segments.join(' ');
}

interface Cursor {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseCronOnce(expression: string | CronExpression): CronExpression {
  return typeof expression === 'string' ? parseCron(expression) : expression;
}

function matchesDay(cron: CronExpression, day: number, weekday: number): boolean {
  const domHit = cron.daysOfMonth.includes(day);
  const dowHit = cron.daysOfWeek.includes(weekday);
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return domHit || dowHit;
  if (cron.dayOfMonthRestricted) return domHit;
  if (cron.dayOfWeekRestricted) return dowHit;
  return true;
}

function parseField(
  expression: string,
  field: string,
  min: number,
  max: number,
  names: readonly string[] = [],
  nameOffset = 0,
): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') throw cronInvalid(expression, `empty list item in "${field}"`);
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined || (part.includes('/') && stepPart === undefined)) {
      throw cronInvalid(expression, `malformed step in "${part}"`);
    }
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) {
      throw cronInvalid(expression, `step must be a positive integer in "${part}"`);
    }

    let from: number;
    let to: number;
    if (isWildcard(rangePart)) {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [left, right] = rangePart.split('-');
      from = toNumber(expression, left, min, max, names, nameOffset);
      to = toNumber(expression, right, min, max, names, nameOffset);
    } else {
      from = toNumber(expression, rangePart, min, max, names, nameOffset);
      to = stepPart === undefined ? from : max;
    }

    if (from > to) {
      // Wrapping ranges (`fri-mon`, `22-2`) are a real cron idiom.
      for (let value = from; value <= max; value += step) values.add(value);
      for (let value = min; value <= to; value += step) values.add(value);
    } else {
      for (let value = from; value <= to; value += step) values.add(value);
    }
  }
  if (values.size === 0) throw cronInvalid(expression, `field "${field}" matches nothing`);
  return [...values].sort((a, b) => a - b);
}

function toNumber(
  expression: string,
  token: string | undefined,
  min: number,
  max: number,
  names: readonly string[],
  nameOffset: number,
): number {
  if (token === undefined || token === '') throw cronInvalid(expression, 'missing value');
  const named = names.indexOf(token.slice(0, 3));
  const value = named === -1 ? Number.parseInt(token, 10) : named + nameOffset;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw cronInvalid(expression, `"${token}" is out of range ${min}-${max}`);
  }
  return value;
}

function isWildcard(field: string): boolean {
  const [head] = field.split('/');
  return head === '*' || head === '?';
}

/** `*` and `?` are "any"; a step like every-2nd-day restricts, and Vixie's OR rule sees that. */
function isRestricted(field: string): boolean {
  return field !== '*' && field !== '?';
}

/** Step fields: an evenly spaced set starting at 0 that covers the whole range. */
function uniformStep(values: readonly number[], size: number): number | undefined {
  const first = values[0];
  if (values.length < 2 || first !== 0) return undefined;
  const step = (values[1] ?? 0) - first;
  if (step <= 0 || values.length !== Math.ceil(size / step)) return undefined;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? -1) - (values[index - 1] ?? -1) !== step) return undefined;
  }
  return step;
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

function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

const monthFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function monthName(month: number, locale: string): string {
  let formatter = monthFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    monthFormatters.set(locale, formatter);
  }
  return formatter.format(new Date(Date.UTC(2026, month - 1, 1)));
}

function weekdayName(isoDay: number, locale: string): string {
  let formatter = weekdayFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    weekdayFormatters.set(locale, formatter);
  }
  // 2026-06-01 is a Monday, so ISO day N is that date + (N - 1).
  return formatter.format(new Date(Date.UTC(2026, 5, isoDay)));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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
