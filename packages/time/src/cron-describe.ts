/**
 * Human-readable cron descriptions (`describeCron`) — locale-aware via `Intl`, with all
 * connective English phrases injectable so this package never hardcodes user-facing strings.
 */

import { type CronExpression, parseCronOnce } from './cron-parse';

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
