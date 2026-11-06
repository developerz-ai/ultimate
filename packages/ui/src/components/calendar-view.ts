// A month as a grid of `PlainDate`s, and every rule a calendar keys on: week start from the
// locale, 6 rows always so the box never jumps, the arrow step (flipped by `dir`, skipping what is
// disabled), and the one day holding the tab stop. Pure, over `@ultimat3/time`'s plain dates.

import { cachedFormatter } from '@ultimat3/core';
import {
  addPlainDays,
  addPlainMonths,
  comparePlainDates,
  isPlainDate,
  type PlainDate,
  plainDateOf,
  plainDateParts,
  plainDateToUtcInstant,
} from '@ultimat3/time';
import { invalidValueError } from '../errors';

/** ISO weekday: 1 is Monday, 7 is Sunday — `Intl.Locale#getWeekInfo().firstDay`'s numbering. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CalendarBounds {
  readonly min?: PlainDate | undefined;
  readonly max?: PlainDate | undefined;
  readonly isDisabled?: ((date: PlainDate) => boolean) | undefined;
}

export interface CalendarDay {
  readonly date: PlainDate;
  readonly day: number;
  /** In the month shown; the others pad the grid to whole weeks. */
  readonly inMonth: boolean;
  readonly disabled: boolean;
}

const WEEKS = 6;
/** How far an arrow keeps stepping over disabled days before it gives up and stays put. */
const MAX_SKIP = 366;

/** `value` as a `PlainDate`, or `X_UI_INVALID_VALUE` naming the prop. */
export function plainDateProp(prop: string, value: unknown): PlainDate {
  if (!isPlainDate(value)) throw invalidValueError(prop, value, 'a YYYY-MM-DD calendar date');
  return value;
}

/** An optional date prop: absent or empty is no date, anything else must be a `PlainDate`. */
export const optionalDateProp = (prop: string, value: string | undefined): PlainDate | undefined =>
  value === undefined || value === '' ? undefined : plainDateProp(prop, value);

/** `min` after `max` leaves no day to pick: refused, naming both. */
export function assertBounds(component: string, bounds: CalendarBounds): void {
  const { min, max } = bounds;
  if (min !== undefined) plainDateProp(`${component} min`, min);
  if (max !== undefined) plainDateProp(`${component} max`, max);
  if (min !== undefined && max !== undefined && comparePlainDates(min, max) > 0) {
    throw invalidValueError(
      `${component} min`,
      `${min} after max ${max}`,
      'a min on or before max',
    );
  }
}

interface WeekInfoLocale {
  getWeekInfo?: () => { readonly firstDay?: number };
  readonly weekInfo?: { readonly firstDay?: number };
}

const isWeekday = (value: unknown): value is Weekday =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;

/**
 * The locale's first day of the week, from the platform (`en-US` Sunday, `de` Monday), so no table
 * ships. `override` wins; an engine without `getWeekInfo` falls back to ISO Monday.
 */
export function weekStartOf(locale: string, override?: Weekday | undefined): Weekday {
  if (override !== undefined) {
    if (!isWeekday(override))
      throw invalidValueError('Calendar weekStart', override, 'a weekday 1–7');
    return override;
  }
  const info = new Intl.Locale(locale) as unknown as WeekInfoLocale;
  const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
  return isWeekday(firstDay) ? firstDay : 1;
}

/** The ISO weekday of a plain date. */
export function weekdayOf(date: PlainDate): Weekday {
  const sunday0 = plainDateToUtcInstant(date).getUTCDay();
  return (sunday0 === 0 ? 7 : sunday0) as Weekday;
}

export const firstOfMonth = (date: PlainDate): PlainDate => {
  const { year, month } = plainDateParts(date);
  return plainDateOf({ year, month, day: 1 });
};

export function isDayDisabled(date: PlainDate, bounds: CalendarBounds): boolean {
  if (bounds.min !== undefined && comparePlainDates(date, bounds.min) < 0) return true;
  if (bounds.max !== undefined && comparePlainDates(date, bounds.max) > 0) return true;
  return bounds.isDisabled?.(date) === true;
}

/** Six weeks starting on `weekStart`, around `month`'s first day. Always 42 days. */
export function monthGrid(
  month: PlainDate,
  weekStart: Weekday,
  bounds: CalendarBounds = {},
): readonly (readonly CalendarDay[])[] {
  const first = firstOfMonth(month);
  const lead = (weekdayOf(first) - weekStart + 7) % 7;
  const start = addPlainDays(first, -lead);
  const shown = plainDateParts(first).month;
  return Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = addPlainDays(start, week * 7 + weekday);
      const parts = plainDateParts(date);
      return {
        date,
        day: parts.day,
        inMonth: parts.month === shown,
        disabled: isDayDisabled(date, bounds),
      };
    }),
  );
}

export interface StepOptions extends CalendarBounds {
  readonly dir: 'ltr' | 'rtl';
  readonly weekStart: Weekday;
  readonly shiftKey?: boolean | undefined;
}

/** One key's move, ignoring what is disabled. `undefined` is a key the grid does not take. */
function rawStep(from: PlainDate, key: string, options: StepOptions): PlainDate | undefined {
  const forward = options.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const back = options.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  const offset = (weekdayOf(from) - options.weekStart + 7) % 7;
  switch (key) {
    case forward:
      return addPlainDays(from, 1);
    case back:
      return addPlainDays(from, -1);
    case 'ArrowDown':
      return addPlainDays(from, 7);
    case 'ArrowUp':
      return addPlainDays(from, -7);
    case 'Home':
      return addPlainDays(from, -offset);
    case 'End':
      return addPlainDays(from, 6 - offset);
    case 'PageDown':
      return addPlainMonths(from, options.shiftKey === true ? 12 : 1);
    case 'PageUp':
      return addPlainMonths(from, options.shiftKey === true ? -12 : -1);
    default:
      return undefined;
  }
}

/**
 * The day a key lands on. A disabled day is stepped over one day at a time in the direction the
 * key moved, so the roving stop never lands on a day that refuses focus. Stays put (`undefined`)
 * when nothing reachable is left that way.
 */
export function stepDay(from: PlainDate, key: string, options: StepOptions): PlainDate | undefined {
  let target = rawStep(from, key, options);
  if (target === undefined) return undefined;
  const ahead = comparePlainDates(target, from) > 0;
  for (let skipped = 0; skipped < MAX_SKIP; skipped += 1) {
    if (target === from) return undefined;
    if (!isDayDisabled(target, options)) return target;
    const outOfRange =
      (ahead && options.max !== undefined && comparePlainDates(target, options.max) > 0) ||
      (!ahead && options.min !== undefined && comparePlainDates(target, options.min) < 0);
    if (outOfRange) return undefined;
    target = addPlainDays(target, ahead ? 1 : -1);
  }
  return undefined;
}

/**
 * The one day carrying `tabindex="0"`: the focused day, else the selected one, else the first
 * enabled day of the month — each only when it is in the month shown and enabled. `undefined` when
 * the whole month is disabled, and then nothing is tabbable, which is the correct answer.
 */
export function rovingDay(
  grid: readonly (readonly CalendarDay[])[],
  candidates: readonly (PlainDate | undefined)[],
): PlainDate | undefined {
  const days = grid.flat().filter((day) => day.inMonth && !day.disabled);
  for (const candidate of candidates) {
    if (candidate !== undefined && days.some((day) => day.date === candidate)) return candidate;
  }
  return days[0]?.date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** `timeZone: 'UTC'` on a plain date's UTC midnight: the date named, never shifted by a zone. */
const formatter = (locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  cachedFormatter(
    formatters,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }),
  );

export const monthLabel = (month: PlainDate, locale: string): string =>
  formatter(locale, { month: 'long', year: 'numeric' }).format(plainDateToUtcInstant(month));

export const dayLabel = (date: PlainDate, locale: string): string =>
  formatter(locale, { dateStyle: 'full' }).format(plainDateToUtcInstant(date));

/** Seven column headers from `weekStart`: the short name shown, the long one as `abbr`. */
export function weekdayLabels(
  locale: string,
  weekStart: Weekday,
): readonly { readonly short: string; readonly long: string }[] {
  // 2024-01-01 is a Monday: ISO weekday `n` is that date plus `n - 1` days.
  const monday = plainDateOf({ year: 2024, month: 1, day: 1 });
  return Array.from({ length: 7 }, (_, index) => {
    const date = plainDateToUtcInstant(addPlainDays(monday, (weekStart - 1 + index) % 7));
    return {
      short: formatter(locale, { weekday: 'narrow' }).format(date),
      long: formatter(locale, { weekday: 'long' }).format(date),
    };
  });
}
