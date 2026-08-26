/**
 * Human-readable cron descriptions (`describeCron`): month and weekday names from `Intl`, every
 * connective phrase supplied by the caller. Tier 1 cannot reach `t()`, and a default set would
 * ship English to every locale that forgot the argument — so injection is mandatory, not opt-in.
 */

import { assertLocale, cachedFormatter } from '@ultimat3/core';
import { type CronExpression, parseCronOnce } from './cron-parse';
import { cronNotDescribable } from './errors';

export interface CronPhrases {
  everyMinute: string;
  everyNMinutes: string;
  everyHour: string;
  everyNHours: string;
  at: string;
  /** Closes a capped clock-time list, e.g. `and {n} more`. */
  andMore: string;
  onDaysOfMonth: string;
  onWeekdays: string;
  inMonths: string;
  everyDay: string;
}

/** `1-59 * * * *` expands to 1416 clock times; a summary that long is not a summary. */
const MAX_LISTED_TIMES = 6;

/**
 * `describeCron('0 3 * * MON-FRI', 'en', phrases)` → `at 03:00 on Monday–Friday`.
 * Every phrase comes from the caller's `t('time.cron.*')`; only the names are `Intl`'s.
 *
 * A 6-field expression whose seconds field says something a 5-field one cannot is **declined**,
 * not summarised: `CronPhrases` has no seconds vocabulary, so a ten-second step rendered as
 * "every minute" and `30 0 3 * * *` rendered identically to `0 3 * * *`. A summary that is wrong
 * is worse than one that says so, and the phrases are the caller's — adding a required field to
 * `CronPhrases` breaks every existing caller to describe a schedule almost nobody writes.
 */
export function describeCron(
  expression: string | CronExpression,
  locale: string,
  phrases: CronPhrases,
): string {
  // Canonicalized once, at the entry point, and `tag` is what every line below uses — `EN-us` and
  // `en-US` are one locale to `Intl`, and must be one key in the caches at the foot of this file.
  const tag = assertLocale(locale);
  const cron = parseCronOnce(expression);
  if (cron.seconds.length !== 1 || cron.seconds[0] !== 0) throw cronNotDescribable(cron);
  const list = new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' });
  const segments: string[] = [];

  const minuteStep = uniformStep(cron.minutes, 60);
  const hourStep = uniformStep(cron.hours, 24);
  // Only a fixed clock time reads as "at 03:00 every day"; an interval already says it.
  let explicitTime = false;

  if (minuteStep !== undefined && cron.hours.length === 24) {
    segments.push(
      minuteStep === 1 ? phrases.everyMinute : fill(phrases.everyNMinutes, { n: minuteStep }),
    );
  } else if (cron.minutes.length === 1 && cron.minutes[0] === 0 && hourStep !== undefined) {
    // Only an on-the-hour minute is a bare interval: `15 */6 * * *` must keep its :15 offset.
    segments.push(hourStep === 1 ? phrases.everyHour : fill(phrases.everyNHours, { n: hourStep }));
  } else {
    explicitTime = true;
    segments.push(fill(phrases.at, { time: clockTimes(cron, phrases, tag, list) }));
  }

  if (cron.dayOfMonthRestricted) {
    const days = list.format(cron.daysOfMonth.map(String));
    segments.push(fill(phrases.onDaysOfMonth, { days }));
  }
  if (cron.dayOfWeekRestricted) {
    const days = list.format(cron.daysOfWeek.map((day) => weekdayName(day, tag)));
    segments.push(fill(phrases.onWeekdays, { days }));
  }
  if (cron.months.length < 12) {
    const months = list.format(cron.months.map((month) => monthName(month, tag)));
    segments.push(fill(phrases.inMonths, { months }));
  }
  if (explicitTime && segments.length === 1) segments.push(phrases.everyDay);
  return segments.join(' ');
}

/** The clock times, capped — the overflow is counted out loud so a cut list never reads whole. */
function clockTimes(
  cron: CronExpression,
  phrases: CronPhrases,
  locale: string,
  list: Intl.ListFormat,
): string {
  const times = cron.hours.flatMap((hour) =>
    cron.minutes.map((minute) => `${pad2(hour)}:${pad2(minute)}`),
  );
  if (times.length <= MAX_LISTED_TIMES) return list.format(times);
  // A cut list is not a closed one, so it drops the conjunction: `… and 09:25` would promise
  // 09:25 is the last time there is. `unit` is ICU's comma-only list for exactly that reason.
  const open = new Intl.ListFormat(locale, { style: 'long', type: 'unit' });
  const shown = open.format(times.slice(0, MAX_LISTED_TIMES));
  return `${shown} ${fill(phrases.andMore, { n: times.length - MAX_LISTED_TIMES })}`;
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

function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Canonically keyed **and** hard-capped, because `locale` can arrive from an Accept-Language
 * header. `assertLocale` collapses the spellings of one locale — `EN-us`, `en-latn-us` — but it
 * still returns a distinct string for every unknown `-u-` extension value, so the key alone does
 * not bound anything and only the cap keeps the key space finite. Neither half is redundant. The
 * cap and its FIFO live in `@ultimat3/core`'s `intl-cache.ts`, because `zones.ts`, `format.ts` and
 * `@ultimat3/money`'s formatter all need the same rule, and a hazard documented in one file is a
 * hazard every other one repeats.
 *
 * Both caches are fed the canonical `tag` by `describeCron` alone, never a caller string.
 */
const monthFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function monthName(month: number, locale: string): string {
  const formatter = cachedFormatter(
    monthFormatters,
    locale,
    () => new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }),
  );
  return formatter.format(new Date(Date.UTC(2026, month - 1, 1)));
}

function weekdayName(isoDay: number, locale: string): string {
  const formatter = cachedFormatter(
    weekdayFormatters,
    locale,
    () => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }),
  );
  // 2026-06-01 is a Monday, so ISO day N is that date + (N - 1).
  return formatter.format(new Date(Date.UTC(2026, 5, isoDay)));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
