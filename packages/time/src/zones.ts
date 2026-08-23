/**
 * IANA timezone primitives. The UTC offset of a zone is derived from
 * `Intl.DateTimeFormat.formatToParts` — the runtime already ships the tzdata, so there
 * is no offset table to keep in sync and no `date-fns-tz` dependency.
 */

import { cachedFormatter } from '@ultimat3/core';
import { timezoneInvalid } from './errors';
import type { Instant } from './instant';
import { assertLocale } from './locale';
import { canonicalTimeZone } from './zone-canonical';

/** An IANA identifier: `Europe/Berlin`, `Asia/Kathmandu`, `UTC`. Never `CET`, never `+01:00`. */
export type TimeZone = string;

export const UTC: TimeZone = 'UTC';

/**
 * The package's only builder of a UTC epoch from calendar fields, because `Date.UTC` remaps
 * years 0–99 onto 1900–1999 — silently, so a first-century wall clock resolves 1900 years off
 * and every derived answer (offset, weekday, day count) is wrong without ever throwing.
 * Overflow still carries exactly as `Date.UTC` does: day 0, day 32 and hour 24 all roll.
 */
export function utcEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getTime();
}

export function isValidTimeZone(zone: string): boolean {
  return canonicalTimeZone(zone) !== undefined;
}

/**
 * The **canonical** spelling, not the caller's. `Intl` answers for every casing of a zone name, so
 * returning the input let one zone travel the process as many strings — each one its own key in
 * every formatter cache downstream, and unbounded when the string came from a request header.
 */
export function assertTimeZone(zone: string): TimeZone {
  const canonical = canonicalTimeZone(zone);
  if (canonical === undefined) throw timezoneInvalid(zone);
  return canonical;
}

/** Wall-clock fields of an instant in a zone, seconds precision. */
export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Read the zone's wall clock for an instant. `hourCycle: 'h23'` is essential: without it
 * some locales render midnight as hour 24 and every calculation downstream drifts a day.
 */
export function zonePartsAt(zone: TimeZone, at: Instant): ZoneParts {
  const parts = partsFormatterFor(zone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw timezoneInvalid(zone);
    return Number.parseInt(value, 10);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Offset in **minutes east of UTC** at a given instant: `Europe/Berlin` → 60 or 120,
 * `Asia/Kathmandu` → 345, `America/New_York` → -300 or -240.
 *
 * The trick: format the instant in the zone, then re-read those wall-clock fields *as if
 * they were UTC*. The difference between that and the real epoch is the offset.
 */
export function offsetAt(zone: TimeZone, at: Instant): number {
  const parts = zonePartsAt(zone, at);
  const asIfUtc = utcEpoch(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Offsets are whole minutes; rounding absorbs the sub-second part `asIfUtc` drops.
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/** `+01:00`, `-04:00`, `+05:45`, `Z`. */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  return `${sign}${pad2(hours)}:${pad2(absolute % 60)}`;
}

/** Locale-aware zone label: `CET`, `GMT+5:45`, `Central European Standard Time`. */
export function zoneAbbrev(
  zone: TimeZone,
  at: Instant,
  locale = 'en-US',
  style: 'short' | 'long' | 'shortOffset' | 'longOffset' = 'short',
): string {
  const canonical = assertTimeZone(zone);
  // Both arguments arrive from a request header on the path this function exists for, so a tag
  // `Intl` cannot parse is refused with a code exactly as an unknown zone is — `X_LOCALE_INVALID`,
  // the same one `describeCron` and every formatter in `format.ts` raise.
  const tag = assertLocale(locale);
  // The one `Intl` construction in this package that escaped the shared cache: it built a formatter
  // per call on the caller's raw zone and locale, so an `x-timezone` an app renders a label from
  // paid for a fresh `Intl.DateTimeFormat` every time and an unknown one escaped as a `RangeError`.
  const formatter = cachedFormatter(labelFormatters, `${canonical}|${tag}|${style}`, () => {
    return new Intl.DateTimeFormat(tag, {
      timeZone: canonical,
      timeZoneName: style,
      hourCycle: 'h23',
    });
  });
  const label = formatter.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
  return label ?? offsetLabel(offsetAt(canonical, at));
}

/**
 * True when the zone observes a different offset at some point in the surrounding year.
 *
 * Twelve probes on the FIRST of twelve consecutive months. `setUTCMonth(+n)` rolls over at month
 * end — from 31 January the twelve probes land in January, March, March, May, May, July, July,
 * August, October, October, December, December, so February, April, June, September and November
 * are never asked, and a zone whose only transition falls in one of them reads as DST-free.
 */
export function observesDst(zone: TimeZone, at: Instant): boolean {
  const start = zonePartsAt(zone, at);
  const offsets = new Set<number>();
  for (let month = 0; month < 12; month += 1) {
    const probe = new Date(utcEpoch(start.year, start.month + month, 1, 12)) as Instant;
    offsets.add(offsetAt(zone, probe));
  }
  return offsets.size > 1;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatterFor(zone: TimeZone): Intl.DateTimeFormat {
  // Keyed on the canonical name, so 4,096 casings of one zone are one entry rather than 4,096.
  const canonical = canonicalTimeZone(zone);
  if (canonical === undefined) throw timezoneInvalid(zone);
  return cachedFormatter(
    formatters,
    canonical,
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: canonical,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
