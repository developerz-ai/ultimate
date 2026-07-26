import { describe, expect, test } from 'bun:test';
import {
  describeCron,
  isValidCron,
  matchesCron,
  nextCronOccurrence,
  nextCronOccurrences,
  parseCron,
} from './cron';
import { fromIso, toIso } from './instant';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const UTC = 'UTC';

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

  test('rejects malformed expressions with X_CRON_INVALID and a working example', () => {
    expect(codeOf(() => parseCron('0 3 * *'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('61 * * * *'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('0 3 * * FUNDAY'))).toBe('X_CRON_INVALID');
    expect(codeOf(() => parseCron('*/0 * * * *'))).toBe('X_CRON_INVALID');
    expect(fixOf(() => parseCron('nonsense'))).toContain("'0 3 * * *'");
    expect(isValidCron('0 3 * * *')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
  });
});

describe('nextCronOccurrence', () => {
  test('basic daily schedule in UTC', () => {
    const next = nextCronOccurrence('0 3 * * *', UTC, fromIso('2026-03-14T04:00:00Z'));
    expect(toIso(next)).toBe('2026-03-15T03:00:00.000Z');
  });

  test('*/15 steps within the hour', () => {
    const times = nextCronOccurrences('*/15 * * * *', UTC, fromIso('2026-03-14T09:07:00Z'), 3);
    expect(times.map(toIso)).toEqual([
      '2026-03-14T09:15:00.000Z',
      '2026-03-14T09:30:00.000Z',
      '2026-03-14T09:45:00.000Z',
    ]);
  });

  test('weekday-only schedule skips the weekend', () => {
    // 2026-03-14 is a Saturday.
    const next = nextCronOccurrence('0 9 * * MON-FRI', UTC, fromIso('2026-03-14T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-16T09:00:00.000Z');
  });

  test('day-of-month and day-of-week OR together (Vixie semantics)', () => {
    // "1st of the month OR any Monday" — both restricted means either matches.
    const next = nextCronOccurrence('0 0 1 * MON', UTC, fromIso('2026-03-14T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-16T00:00:00.000Z'); // the Monday comes first
  });
});

describe('nextCronOccurrence across a DST boundary', () => {
  // Europe/Berlin springs forward 2026-03-29 at 02:00 local (01:00Z).
  test('0 3 * * * stays at 03:00 local on both sides of the change', () => {
    const times = nextCronOccurrences('0 3 * * *', BERLIN, fromIso('2026-03-28T00:00:00Z'), 3);
    expect(times.map((at) => toZoned(at, BERLIN).hour)).toEqual([3, 3, 3]);
    // The UTC hour moves because the offset did — that is the whole point.
    expect(times.map(toIso)).toEqual([
      '2026-03-28T02:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T01:00:00.000Z',
    ]);
  });

  test('a job scheduled inside the gap still runs that day', () => {
    // 02:00 local does not exist on 2026-03-29; it must not be silently skipped.
    const next = nextCronOccurrence('0 2 * * *', BERLIN, fromIso('2026-03-29T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-29T01:00:00.000Z');
    expect(toZoned(next, BERLIN).hour).toBe(3);
  });

  test('and stays at 03:00 local across the autumn fall-back too', () => {
    // Berlin falls back 2026-10-25 at 03:00 local (01:00Z).
    const times = nextCronOccurrences('0 3 * * *', BERLIN, fromIso('2026-10-24T00:00:00Z'), 3);
    expect(times.map((at) => toZoned(at, BERLIN).hour)).toEqual([3, 3, 3]);
    expect(times.map(toIso)).toEqual([
      '2026-10-24T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-26T02:00:00.000Z',
    ]);
  });
});

describe('matchesCron', () => {
  test('matches on the zone wall clock, not UTC', () => {
    const at = fromIso('2026-03-14T02:00:00Z'); // 03:00 in Berlin
    expect(matchesCron('0 3 * * *', at, BERLIN)).toBe(true);
    expect(matchesCron('0 3 * * *', at, UTC)).toBe(false);
  });
});

describe('describeCron', () => {
  test('renders a human summary with Intl month and weekday names', () => {
    expect(describeCron('0 3 * * *', 'en')).toBe('at 03:00 every day');
    expect(describeCron('*/15 * * * *', 'en')).toBe('every 15 minutes');
    expect(describeCron('0 9 * * MON-FRI', 'en')).toContain('Monday');
    expect(describeCron('0 0 1 1 *', 'en')).toContain('January');
    expect(describeCron('0 0 1 1 *', 'de')).toContain('Januar');
  });

  test('phrases can be injected from t() so no English is hardcoded upstream', () => {
    expect(describeCron('0 3 * * *', 'de', { at: 'um {time}', everyDay: 'täglich' })).toBe(
      'um 03:00 täglich',
    );
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

function fixOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { fix?: unknown }).fix);
  }
  return 'no-throw';
}
