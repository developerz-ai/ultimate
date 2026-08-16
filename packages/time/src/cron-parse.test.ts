import { describe, expect, test } from 'bun:test';
import { isValidCron, parseCron } from './cron-parse';

describe('parseCron', () => {
  test('parses 5 fields, steps, ranges, lists and names', () => {
    expect(parseCron('0 3 * * *')).toMatchObject({ minutes: [0], hours: [3] });
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9-17/4 * * *').hours).toEqual([9, 13, 17]);
    expect(parseCron('0 0 1,15 * *').daysOfMonth).toEqual([1, 15]);
    expect(parseCron('0 9 * * MON-FRI').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 0 * JAN,JUL *').months).toEqual([1, 7]);
    // cron day 0 and day 7 are both Sunday; ISO calls it 7.
    expect(parseCron('0 0 * * 0').daysOfWeek).toEqual([7]);
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([7]);
  });

  test('parses a 6-field expression with seconds and the @macros', () => {
    expect(parseCron('30 0 3 * * *')).toMatchObject({ seconds: [30], minutes: [0], hours: [3] });
    expect(parseCron('@daily')).toMatchObject({ minutes: [0], hours: [0] });
    expect(parseCron('@weekly').daysOfWeek).toEqual([7]);
  });

  test('a wrapping range keeps one stride across the wrap', () => {
    // `23-3/2` is every second hour starting at 23: 23, 01, 03. Restarting the stride at the
    // field minimum after the wrap answered 23, 00, 02 — a schedule nobody wrote, one hour off
    // for every occurrence past midnight.
    expect(parseCron('0 23-3/2 * * *').hours).toEqual([1, 3, 23]);
    expect(parseCron('55-5/10 * * * *').minutes).toEqual([5, 55]);
    // A wrap whose remainder happens to divide the step is unchanged — the phase already aligned.
    expect(parseCron('0 22-2/2 * * *').hours).toEqual([0, 2, 22]);
    // Step 1 across a wrap is every hour in the range, which no phase can change.
    expect(parseCron('0 22-2 * * *').hours).toEqual([0, 1, 2, 22, 23]);
  });

  test('rejects malformed expressions with X_CRON_INVALID and a working example', () => {
    expect(codeOf(() => parseCron('0 3 * *'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('61 * * * *'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('0 3 * * FUNDAY'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('*/0 * * * *'))).toBe('X_CRON_INVALID');
    expect(fixOf(() => parseCron('nonsense'))).toContain("'0 3 * * *'");
    expect(isValidCron('0 3 * * *')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
  });

  test('rejects a number with trailing garbage instead of truncating it to a valid field', () => {
    // parseInt('5x') is 5, so this used to schedule Fridays for an expression nobody wrote.
    expect(isValidCron('* * * * 5x')).toBe(false);
    expect(codeOf(() => parseCron('* * * * 5x'))).toBe('X_CRON_INVALID');
    expect(causeOf(() => parseCron('* * * * 5x'))).toContain('"5x"');
    expect(isValidCron('* * * 12abc *')).toBe(false);
    expect(codeOf(() => parseCron('* * * 12abc *'))).toBe('X_CRON_INVALID');
    expect(causeOf(() => parseCron('* * * 12abc *'))).toContain('"12abc"');
    // The same rule inside ranges, lists and steps.
    expect(isValidCron('* * * * 1-5x')).toBe(false);
    expect(isValidCron('* * * * 1,5x')).toBe(false);
    expect(isValidCron('*/5x * * * *')).toBe(false);
    expect(isValidCron('0 3 * * mon2')).toBe(false);
  });

  test('still accepts the tokens that are integers or names', () => {
    expect(parseCron('* * * * 5').daysOfWeek).toEqual([5]);
    expect(parseCron('* * * 12 *').months).toEqual([12]);
    expect(parseCron('0 03 * * *').hours).toEqual([3]);
    expect(parseCron('0 0 * dec MONDAY')).toMatchObject({ months: [12], daysOfWeek: [1] });
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}

function fixOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { fix?: unknown }).fix);
  }
  return 'no-throw';
}
