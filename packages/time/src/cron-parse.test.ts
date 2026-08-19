// The cron field grammar: what parses, what is refused, and that the seconds field is read rather
// than dropped — a silently discarded field schedules a task at a time nobody asked for.

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

  test('refuses an Object.prototype key with X_CRON_INVALID, not a bare TypeError', () => {
    // `MACROS[trimmed]` reached the prototype chain, so `'constructor'` expanded to a FUNCTION and
    // died in `.split()` — a bare Error out of the one function whose contract is a coded refusal,
    // and `error.code === 'X_CRON_INVALID'` matched nothing.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(codeOf(() => parseCron(key))).toBe('X_CRON_INVALID');
      expect(isValidCron(key)).toBe(false);
    }
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

  test('a wrapping day-of-week range strides over a 7-day week, not an 8-day one', () => {
    // The dow field is spelled 0-7 because 0 and 7 are both Sunday, so `max - min + 1` is 8 and a
    // wrap walked a week with a phantom day in it: `sat-tue/2` answered sat, sun, tue instead of
    // sat, mon — a task firing on days nobody scheduled, every week.
    expect(parseCron('0 3 * * sat-tue/2').daysOfWeek).toEqual([1, 6]); // sat, mon
    expect(parseCron('0 0 * * fri-mon/2').daysOfWeek).toEqual([5, 7]); // fri, sun
    // A step that divides the wrap evenly lands on the far end; one that does not stops short.
    expect(parseCron('0 0 * * fri-mon/3').daysOfWeek).toEqual([1, 5]); // fri, mon
    expect(parseCron('0 0 * * sat-mon/3').daysOfWeek).toEqual([6]); // sat alone
    // Step 1 across the wrap is every day in the range — the case that was right by accident.
    expect(parseCron('0 0 * * sat-tue').daysOfWeek).toEqual([1, 2, 6, 7]);
    expect(parseCron('0 0 * * fri-mon').daysOfWeek).toEqual([1, 5, 6, 7]);
    // Sunday spelled 7 on either end of a wrap is the same Sunday as 0.
    expect(parseCron('0 0 * * 7-2').daysOfWeek).toEqual([1, 2, 7]);
    expect(parseCron('0 0 * * 6-0').daysOfWeek).toEqual([6, 7]);
    // Non-wrapping dow ranges and steps are untouched by the span.
    expect(parseCron('0 0 * * sun-sat').daysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseCron('0 0 * * 0-7').daysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseCron('0 0 * * 5-7').daysOfWeek).toEqual([5, 6, 7]);
    expect(parseCron('0 0 * * 1-5/2').daysOfWeek).toEqual([1, 3, 5]);
    expect(parseCron('0 0 * * */2').daysOfWeek).toEqual([2, 4, 6, 7]);
    // `5/2` runs to the field maximum, and the dow maximum is 7 — fri and sun, as Vixie reads it.
    expect(parseCron('0 0 * * 5/2').daysOfWeek).toEqual([5, 7]);
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

// T9. `isValidCron('0 0 30 2 *')` answered `true` for an expression that can never fire, and the
// refusal only arrived ~150 ms later, from `nextCronOccurrence`, after 200,000 walk steps. The
// combination is decidable from the parsed fields, so it is decided where the fields are parsed.
describe('parseCron refuses a day that no selected month has', () => {
  test('the 30th of February can never fire, and is refused where it is written', () => {
    expect(isValidCron('0 0 30 2 *')).toBe(false);
    expect(isValidCron('0 0 31 2 *')).toBe(false);
    expect(isValidCron('0 0 31 4,6,9,11 *')).toBe(false);
    expect(codeOf(() => parseCron('0 0 30 2 *'))).toBe('X_CRON_INVALID');
    expect(String(errorOf(() => parseCron('0 0 30 2 *')).cause)).toContain('february');
  });

  test('the 29th of February stays valid — leap years exist', () => {
    expect(isValidCron('0 0 29 2 *')).toBe(true);
    expect(isValidCron('0 0 31 1,3,5,7,8,10,12 *')).toBe(true);
    expect(isValidCron('0 0 30 4 *')).toBe(true);
  });

  test('one reachable month in the list is enough', () => {
    // `30 2,3 *` fires every 30 March. Only a list where NO month can hold the day is impossible.
    expect(isValidCron('0 0 30 2,3 *')).toBe(true);
    expect(isValidCron('0 0 31 2,4 *')).toBe(false);
  });

  test("a restricted day-of-week keeps it valid — Vixie's OR gives it a way to fire", () => {
    // `0 0 30 2 5` means "the 30th of February OR any Friday in February", which is every Friday
    // in February. Refusing it would break a working schedule.
    expect(isValidCron('0 0 30 2 5')).toBe(true);
    expect(isValidCron('0 0 30 2 mon-fri')).toBe(true);
  });

  test('an unrestricted day-of-month is never impossible', () => {
    expect(isValidCron('0 0 * 2 *')).toBe(true);
    expect(isValidCron('0 0 ? 2 5')).toBe(true);
  });
});

function errorOf(run: () => unknown): { cause?: unknown } {
  try {
    run();
  } catch (error) {
    return error as { cause?: unknown };
  }
  return { cause: 'no-throw' };
}
