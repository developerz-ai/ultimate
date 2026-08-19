/**
 * `Intl.DateTimeFormat` at the edge. Every function takes an explicit `zone` and
 * `locale` — there is no ambient default and no `toLocaleString()` without options,
 * because "the server's timezone" is never the answer to "what time is it for the user".
 */

import { cachedFormatter, canonicalLocale } from '@ultimat3/core';
import { differenceMs, type Instant } from './instant';
import { isoDateInZone } from './zoned';
import { assertTimeZone, type TimeZone } from './zones';

export type DateTimeStyle = 'short' | 'medium' | 'long' | 'full';

export interface FormatContext {
  locale: string;
  /** IANA zone. Required, always. */
  zone: TimeZone;
}

export interface FormatDateTimeOptions extends FormatContext {
  /** Sets both date and time style; `dateStyle`/`timeStyle` override it. */
  style?: DateTimeStyle;
  dateStyle?: DateTimeStyle;
  timeStyle?: DateTimeStyle;
  hour12?: boolean;
}

/** `14 Mar 2026, 09:00` in `en-GB` / `Europe/Berlin`. */
export function formatDateTime(at: Instant, options: FormatDateTimeOptions): string {
  const style = options.style ?? 'medium';
  return formatterFor(options.locale, {
    timeZone: assertTimeZone(options.zone),
    dateStyle: options.dateStyle ?? style,
    timeStyle: options.timeStyle ?? (style === 'full' || style === 'long' ? 'medium' : style),
    ...(options.hour12 === undefined ? {} : { hour12: options.hour12 }),
  }).format(at);
}

export function formatDate(
  at: Instant,
  options: FormatContext & { style?: DateTimeStyle },
): string {
  return formatterFor(options.locale, {
    timeZone: assertTimeZone(options.zone),
    dateStyle: options.style ?? 'medium',
  }).format(at);
}

export function formatTime(
  at: Instant,
  options: FormatContext & { style?: DateTimeStyle; hour12?: boolean },
): string {
  return formatterFor(options.locale, {
    timeZone: assertTimeZone(options.zone),
    timeStyle: options.style ?? 'short',
    ...(options.hour12 === undefined ? {} : { hour12: options.hour12 }),
  }).format(at);
}

/**
 * `14 Mar 2026, 09:00 (GMT+1)` — the offset made visible.
 * Built with `timeZoneName: 'shortOffset'` + `formatToParts` so the offset is appended
 * in a fixed position instead of wherever the locale pattern happens to put it.
 */
export function formatWithOffset(at: Instant, options: FormatDateTimeOptions): string {
  const style = options.style ?? 'medium';
  // `timeZoneName` is a component option, and Intl forbids mixing those with dateStyle /
  // timeStyle — so the components are spelled out here instead.
  const parts = formatterFor(options.locale, {
    timeZone: assertTimeZone(options.zone),
    year: 'numeric',
    month: style === 'short' ? 'numeric' : style === 'medium' ? 'short' : 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(options.hour12 === undefined ? { hourCycle: 'h23' as const } : { hour12: options.hour12 }),
    timeZoneName: 'shortOffset',
  }).formatToParts(at);

  const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  const text = parts
    .filter((part) => part.type !== 'timeZoneName')
    .map((part) => part.value)
    .join('')
    .replace(/[\s,]+$/u, '')
    .trim();
  return offset === '' ? text : `${text} (${offset})`;
}

/**
 * ISO-8601 date parts in a zone, for `<input type="date">` and CSV columns.
 *
 * Built from `isoDateInZone`, not from `Intl`: `year: 'numeric'` neither zero-pads a year below
 * 1000 nor carries the era, so this answered `'50-01-01'` where `isoDateInZone` answered
 * `'0050-01-01'` — two functions in one package answering one question differently, and the short
 * form matches no ISO pattern and is rejected by the very input this exists for. One padding rule,
 * in one place.
 */
export function formatIsoDate(at: Instant, zone: TimeZone): string {
  return isoDateInZone(at, assertTimeZone(zone));
}

export interface FormatRelativeOptions extends Omit<FormatContext, 'zone'> {
  /** The reference point. Pass `now(clock)` — never let this default to a live clock. */
  now: Instant;
  numeric?: 'always' | 'auto';
  style?: 'long' | 'short' | 'narrow';
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** `in 3 days` / `2 hours ago`, picking the largest unit that fits. */
export function formatRelative(at: Instant, options: FormatRelativeOptions): string {
  const delta = differenceMs(options.now, at);
  const formatter = new Intl.RelativeTimeFormat(options.locale, {
    numeric: options.numeric ?? 'auto',
    style: options.style ?? 'long',
  });
  const magnitude = Math.abs(delta);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (magnitude >= ms) {
      return formatter.format(Math.trunc(delta / ms), unit);
    }
  }
  return formatter.format(0, 'second');
}

/** `14–16 Mar 2026` — one call, so the locale decides how to collapse the range. */
export function formatRange(from: Instant, to: Instant, options: FormatDateTimeOptions): string {
  const style = options.style ?? 'medium';
  const formatter = formatterFor(options.locale, {
    timeZone: assertTimeZone(options.zone),
    dateStyle: options.dateStyle ?? style,
    ...(options.timeStyle === undefined ? {} : { timeStyle: options.timeStyle }),
  }) as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string;
  };
  // `formatRange` is ES2021; fall back to two formatted endpoints on older engines.
  if (typeof formatter.formatRange === 'function') return formatter.formatRange(from, to);
  return `${formatter.format(from)} – ${formatter.format(to)}`;
}

const ORDINAL_SUFFIX: Record<Intl.LDMLPluralRule, string> = {
  one: 'st',
  two: 'nd',
  few: 'rd',
  other: 'th',
  zero: 'th',
  many: 'th',
};

/**
 * `Intl` renders `November 5, 2011`, never `5th of November`. When a design asks for the ordinal,
 * build it from `Intl.PluralRules` with `type: 'ordinal'` — **English only**, which is why it is a
 * helper and not the default date format.
 *
 * It takes NO locale, and that is the enforcement rather than a note. It used to accept one, pick
 * the plural category with it, and then append the ENGLISH suffix for that category: `ordinal(1,
 * 'de')` was `'1th'`, a word in no language. A parameter that cannot change the answer correctly
 * is removed, so a caller who wants a localized ordinal finds out from `tsc` instead of from a
 * rendered page. **Breaking: the `locale` parameter is gone.**
 */
export function ordinal(value: number): string {
  const category = new Intl.PluralRules('en', { type: 'ordinal' }).select(value);
  return `${value}${ORDINAL_SUFFIX[category]}`;
}

const cache = new Map<string, Intl.DateTimeFormat>();

/**
 * Bounded, and keyed on a zone `assertTimeZone` and a locale `canonicalLocale` have both already
 * canonicalized — `Accept-Language` sends `EN-us` and `en-US` for one locale, and each spelling
 * used to mint its own permanent entry. The bound stays: an unknown `-u-` extension value survives
 * canonicalization as a distinct string, so only the cap keeps this key space finite.
 *
 * A tag `Intl` cannot parse falls through unchanged, so the `Intl.DateTimeFormat` constructor
 * still raises it — this seam decides a cache key, never whether a locale is acceptable.
 */
function formatterFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = canonicalLocale(locale) ?? locale;
  const key = `${tag}|${JSON.stringify(options)}`;
  return cachedFormatter(cache, key, () => new Intl.DateTimeFormat(tag, options));
}
