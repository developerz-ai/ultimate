import { describe, expect, test } from 'bun:test';
import {
  firedSince,
  matchesCron,
  nextCronOccurrence,
  nextCronOccurrenceMs,
  nextCronOccurrences,
} from './cron-occurrence';
import { fromIso, toIso } from './instant';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const UTC = 'UTC';

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

  test('a wrapping stepped weekday range fires on the days it names, and no others', () => {
    // 2026-03-14 is a Saturday. `sat-tue/2` is Saturday and Monday; a task on this schedule used
    // to fire on Sunday and Tuesday instead, every week, because the stride walked an 8-day week.
    const times = nextCronOccurrences('0 3 * * sat-tue/2', UTC, fromIso('2026-03-14T00:00:00Z'), 4);
    expect(times.map(toIso)).toEqual([
      '2026-03-14T03:00:00.000Z', // Saturday
      '2026-03-16T03:00:00.000Z', // Monday
      '2026-03-21T03:00:00.000Z', // Saturday
      '2026-03-23T03:00:00.000Z', // Monday
    ]);
  });

  test('day-of-month and day-of-week OR together (Vixie semantics)', () => {
    // "1st of the month OR any Monday" — both restricted means either matches.
    const next = nextCronOccurrence('0 0 1 * MON', UTC, fromIso('2026-03-14T00:00:00Z'));
    expect(toIso(next)).toBe('2026-03-16T00:00:00.000Z'); // the Monday comes first
  });

  test('an unmatchable date fails with the search budget it actually spent', () => {
    // February never has a 30th, so the walk runs out of steps rather than looping forever.
    const error = errorOf(() =>
      nextCronOccurrence('0 0 30 2 *', UTC, fromIso('2026-03-14T00:00:00Z')),
    );
    const cause = String(error.cause);
    expect(error.code).toBe('X_CRON_INVALID');
    expect(cause).toContain('search steps');
    // A step is a field advancement, so the guard cannot honestly promise a span in years.
    expect(cause).not.toContain('years');
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

describe('firedSince', () => {
  test('is true only when an occurrence falls inside the half-open window', () => {
    const since = fromIso('2026-03-14T02:30:00Z');
    expect(firedSince('0 3 * * *', UTC, since, fromIso('2026-03-14T03:00:00Z'))).toBe(true);
    expect(firedSince('0 3 * * *', UTC, since, fromIso('2026-03-14T02:59:00Z'))).toBe(false);
    // An empty or reversed window never fires, whatever the expression.
    expect(firedSince('* * * * *', UTC, since, since)).toBe(false);
    expect(firedSince('* * * * *', UTC, since, fromIso('2026-03-14T02:00:00Z'))).toBe(false);
  });
});

describe('nextCronOccurrenceMs', () => {
  test('takes and returns epoch milliseconds for callers that only have a number', () => {
    const afterMs = Date.UTC(2026, 2, 14, 4, 0, 0);
    expect(nextCronOccurrenceMs('0 3 * * *', UTC, afterMs)).toBe(Date.UTC(2026, 2, 15, 3, 0, 0));
  });
});

function errorOf(run: () => unknown): { code?: unknown; cause?: unknown } {
  try {
    run();
  } catch (error) {
    return error as { code?: unknown; cause?: unknown };
  }
  return { code: 'no-throw', cause: 'no-throw' };
}
