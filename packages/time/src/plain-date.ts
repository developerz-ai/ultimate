// A calendar date: a year, a month and a day, with no time and therefore no zone. The framework's
// "never format a date without an IANA zone" rule is about INSTANTS — a `PlainDate` needs no zone
// because it names no instant, and that is the whole reason it exists: `effective_on` is the date
// a rate applies, not a moment, and storing it as a `timestamptz` makes it a different date either
// side of midnight for half the planet.

import { scheduleInvalid } from './errors';
import { type Instant, instant } from './instant';
import { isoDateInZone } from './zoned';
import type { TimeZone } from './zones';

declare const plainDateBrand: unique symbol;

/**
 * `2026-03-14`. A branded STRING, not an object and not a `Date`, and each half of that is load-
 * bearing:
 *
 * - not a `Date`, because a `Date` is an instant: read back through the local zone,
 *   `2026-03-14T00:00:00Z` is the 13th anywhere west of Greenwich, and binding one to a Postgres
 *   `date` parameter fails outright (`time zone "gmt-0500" not recognized`, measured on 17.10).
 * - a string, because the ISO form sorts lexicographically exactly as it sorts chronologically,
 *   round-trips through `JSON.stringify` as itself, and is the literal Postgres accepts and
 *   returns for a `date` column.
 */
export type PlainDate = string & { readonly [plainDateBrand]: 'plain-date' };

/** The shape a CHECK constraint and a JSON Schema both spell. ECMAScript and POSIX ERE agree. */
export const PLAIN_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface PlainDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Days in a month, Gregorian. February is the only interesting one. */
const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/**
 * The parse every other function here goes through. `null` rather than a throw, so the guard and
 * the thrower share one rule and only the failure policy differs — the same split
 * `resolveEnvironment` / `tryResolveEnvironment` make in core.
 */
const read = (value: unknown): PlainDateParts | null => {
  if (typeof value !== 'string') return null;
  const match = SHAPE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  // A day the month does not have is the case a regex cannot see, and it is the one that matters:
  // `2026-02-30` reaches Postgres as `date` input and is rejected there, three layers later.
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
};

export const isPlainDate = (value: unknown): value is PlainDate => read(value) !== null;

/** A calendar date from its ISO form. Throws on anything that is not one — including `2026-02-30`. */
export function plainDate(value: string): PlainDate {
  const parts = read(value);
  if (parts === null) {
    throw scheduleInvalid('date', value, 'a real YYYY-MM-DD calendar date');
  }
  return value as PlainDate;
}

/** A calendar date from its fields. Out-of-range fields throw rather than wrap into another month. */
export function plainDateOf(parts: PlainDateParts): PlainDate {
  return plainDate(`${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`);
}

export function plainDateParts(date: PlainDate): PlainDateParts {
  const parts = read(date);
  if (parts === null) throw scheduleInvalid('date', date, 'a real YYYY-MM-DD calendar date');
  return parts;
}

/**
 * The calendar date an instant falls on **in a named zone** — the one conversion between the two,
 * and it takes a zone because there is no other honest way to make it. 09:00 UTC on the 14th is
 * still the 13th in Los Angeles.
 */
export const plainDateIn = (at: Instant, zone: TimeZone): PlainDate =>
  isoDateInZone(at, zone) as PlainDate;

/**
 * The calendar date a `Date` holds when read as UTC. For ONE caller: a Postgres driver hands a
 * `date` column back as a `Date` at UTC midnight (measured: Bun's `sql` and PGlite both), so the
 * date the column holds is its UTC date and reading it through the local zone loses a day west of
 * Greenwich. Never use this on a timestamp — that is `plainDateIn`, which asks for the zone.
 */
export function plainDateUtc(at: Date): PlainDate {
  const checked = instant(at);
  return `${pad(checked.getUTCFullYear(), 4)}-${pad(checked.getUTCMonth() + 1, 2)}-${pad(
    checked.getUTCDate(),
    2,
  )}` as PlainDate;
}

/** Midnight UTC of the date, as an instant — the inverse of `plainDateUtc`, and never of `plainDateIn`. */
export const plainDateToUtcInstant = (date: PlainDate): Instant =>
  instant(new Date(`${plainDate(date)}T00:00:00.000Z`));

/** `-1`, `0`, `1`. Lexicographic order IS chronological order for this form; that is why it sorts. */
export const comparePlainDates = (left: PlainDate, right: PlainDate): number =>
  left < right ? -1 : left > right ? 1 : 0;

const DAY_MS = 86_400_000;

/** Whole days added, over UTC midnights, so no DST rule and no zone can shorten a day here. */
export function addPlainDays(date: PlainDate, days: number): PlainDate {
  if (!Number.isSafeInteger(days)) {
    throw scheduleInvalid('days', days, 'a whole number of days');
  }
  return plainDateUtc(new Date(plainDateToUtcInstant(date).getTime() + days * DAY_MS));
}

/** Signed whole days from `from` to `to`. Always integral: both ends are UTC midnights. */
export const plainDaysBetween = (from: PlainDate, to: PlainDate): number =>
  (plainDateToUtcInstant(to).getTime() - plainDateToUtcInstant(from).getTime()) / DAY_MS;
