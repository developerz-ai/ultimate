// `describeCron`'s summaries: that every connective word comes from the caller, that a truncated
// clock-time list never reads as complete, and that a schedule it has no vocabulary for is
// declined rather than described wrong.

import { describe, expect, test } from 'bun:test';
import { type CronPhrases, describeCron } from './cron-describe';

/** The caller owns the wording; the package ships none, so the fixture supplies it here. */
const EN: CronPhrases = {
  everyMinute: 'every minute',
  everyNMinutes: 'every {n} minutes',
  everyHour: 'every hour',
  everyNHours: 'every {n} hours',
  at: 'at {time}',
  andMore: 'and {n} more',
  onDaysOfMonth: 'on day {days}',
  onWeekdays: 'on {days}',
  inMonths: 'in {months}',
  everyDay: 'every day',
};

describe('describeCron', () => {
  test('renders a human summary with Intl month and weekday names', () => {
    expect(describeCron('0 3 * * *', 'en', EN)).toBe('at 03:00 every day');
    expect(describeCron('*/15 * * * *', 'en', EN)).toBe('every 15 minutes');
    expect(describeCron('0 9 * * MON-FRI', 'en', EN)).toContain('Monday');
    expect(describeCron('0 0 1 1 *', 'en', EN)).toContain('January');
    expect(describeCron('0 0 1 1 *', 'de', EN)).toContain('Januar');
  });

  test('every phrase comes from the caller, so no English leaks into another locale', () => {
    const de: CronPhrases = { ...EN, at: 'um {time}', everyDay: 'täglich' };
    expect(describeCron('0 3 * * *', 'de', de)).toBe('um 03:00 täglich');
  });

  test('a step of one reads as "every hour" / "every minute", never "every 1 hours"', () => {
    expect(describeCron('0 * * * *', 'en', EN)).toBe('every hour');
    expect(describeCron('@hourly', 'en', EN)).toBe('every hour');
    expect(describeCron('* * * * *', 'en', EN)).toBe('every minute');
    expect(describeCron('0 */6 * * *', 'en', EN)).toBe('every 6 hours');
    expect(describeCron('*/30 * * * *', 'en', EN)).toBe('every 30 minutes');
  });

  test('an offset minute keeps its clock times instead of collapsing to an hour interval', () => {
    // `15 */6 * * *` is not "every 6 hours" — that wording drops the :15 the job runs at.
    const summary = describeCron('15 */6 * * *', 'en', EN);
    expect(summary).toContain('00:15');
    expect(summary).toContain('18:15');
    expect(summary).not.toContain('every 6 hours');
  });

  test('a capped clock-time list says how many it left out', () => {
    // 12 times, 6 shown: a truncated list that reads as complete is a wrong answer.
    const summary = describeCron('*/5 9 * * *', 'en', EN);
    expect(summary).toBe('at 09:00, 09:05, 09:10, 09:15, 09:20, 09:25 and 6 more every day');
    expect(summary).not.toContain('09:30');
    // The cut list drops the closing conjunction, so the phrase's own "and" is not doubled.
    expect(summary).not.toContain('and and');
    // Six or fewer is the whole list, with nothing to announce.
    expect(describeCron('0,30 9 * * *', 'en', EN)).not.toContain('more');
  });

  test('a seconds field it has no vocabulary for is declined, never summarised wrong', () => {
    // `*/10 * * * * *` rendered as "every minute" and `30 0 3 * * *` rendered identically to
    // `0 3 * * *`. `CronPhrases` has no seconds phrase, and a summary that is wrong is worse
    // than one that declines.
    const error = errorOf(() => describeCron('*/10 * * * * *', 'en', EN));
    expect(error.code).toBe('X_CRON_NOT_DESCRIBABLE');
    expect(String(error.cause)).toContain('*/10');
    expect(String(error.fix)).toContain('nextCronOccurrences');
    expect(errorOf(() => describeCron('30 0 3 * * *', 'en', EN)).code).toBe(
      'X_CRON_NOT_DESCRIBABLE',
    );
    // A 6-field expression whose seconds field says nothing a 5-field one does not still reads.
    expect(describeCron('0 0 3 * * *', 'en', EN)).toBe('at 03:00 every day');
    expect(describeCron('0 3 * * *', 'en', EN)).toBe('at 03:00 every day');
  });

  test('a malformed locale tag fails as X_LOCALE_INVALID, not a bare RangeError', () => {
    const error = errorOf(() => describeCron('0 3 * * *', 'en_US', EN));
    expect(error.code).toBe('X_LOCALE_INVALID');
    // `meta.locale`, never the prose: the cause is a BOUNDED excerpt `@ultimat3/core` owns
    // (issue #366), and an assertion on its wording made one message edit an eight-file edit.
    expect(error.meta?.['locale']).toBe('en_US');
    expect(String(error.fix)).toContain('en-GB');
    expect(errorOf(() => describeCron('0 3 * * *', 'not a locale', EN)).code).toBe(
      'X_LOCALE_INVALID',
    );
    expect(errorOf(() => describeCron('0 3 * * *', '', EN)).code).toBe('X_LOCALE_INVALID');
    // Well-formed but unknown to ICU is not an error — it falls back, like every Intl call.
    expect(() => describeCron('0 3 * * *', 'zz', EN)).not.toThrow();
  });
});

type ThrownFacts = {
  code?: unknown;
  cause?: unknown;
  fix?: unknown;
  meta?: Readonly<Record<string, unknown>>;
};

function errorOf(run: () => unknown): ThrownFacts {
  try {
    run();
  } catch (error) {
    return error as ThrownFacts;
  }
  return { code: 'no-throw', cause: 'no-throw', fix: 'no-throw' };
}
