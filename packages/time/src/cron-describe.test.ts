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

  test('a malformed locale tag fails as X_LOCALE_INVALID, not a bare RangeError', () => {
    const error = errorOf(() => describeCron('0 3 * * *', 'en_US', EN));
    expect(error.code).toBe('X_LOCALE_INVALID');
    expect(String(error.cause)).toContain('en_US');
    expect(String(error.fix)).toContain('en-GB');
    expect(errorOf(() => describeCron('0 3 * * *', 'not a locale', EN)).code).toBe(
      'X_LOCALE_INVALID',
    );
    expect(errorOf(() => describeCron('0 3 * * *', '', EN)).code).toBe('X_LOCALE_INVALID');
    // Well-formed but unknown to ICU is not an error — it falls back, like every Intl call.
    expect(() => describeCron('0 3 * * *', 'zz', EN)).not.toThrow();
  });
});

function errorOf(run: () => unknown): { code?: unknown; cause?: unknown; fix?: unknown } {
  try {
    run();
  } catch (error) {
    return error as { code?: unknown; cause?: unknown; fix?: unknown };
  }
  return { code: 'no-throw', cause: 'no-throw', fix: 'no-throw' };
}
