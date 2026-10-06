// Month arithmetic is the one calendar step whose length is not fixed, so this file pins the two
// rules that make it an answer: the day clamps to the target month's last day, and a zoned instant
// keeps its LOCAL wall time — a nonexistent one moved forward, a doubled one read at its first pass.

import { describe, expect, test } from 'bun:test';
import { TimeError } from './errors';
import { fromIso, type Instant, toIso } from './instant';
import { addMonthsInZone, addPlainMonths } from './months';
import { type PlainDate, plainDate } from './plain-date';
import { fromZonedDetailed, isoInZone } from './zoned';

const d = (value: string): PlainDate => plainDate(value);

const refusal = (run: () => unknown): TimeError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TimeError) return error;
    throw error;
  }
  return expect.unreachable('expected a TimeError');
};

describe('addPlainMonths', () => {
  test.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2000-01-31', 1, '2000-02-29'],
    ['1900-01-31', 1, '1900-02-28'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2024-03-31', -1, '2024-02-29'],
    ['2026-05-31', 1, '2026-06-30'],
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-11-30', 3, '2027-02-28'],
    ['2026-01-31', -1, '2025-12-31'],
    ['2026-02-28', -14, '2024-12-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-02-29', 48, '2028-02-29'],
    ['2026-01-31', 0, '2026-01-31'],
    ['2026-03-15', -27, '2023-12-15'],
  ] as const)('%s plus %d months is %s', (from, months, expected) => {
    expect(addPlainMonths(d(from), months)).toBe(d(expected));
  });

  test('a fractional, NaN or unsafe count is refused, never truncated', () => {
    for (const months of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(refusal(() => addPlainMonths(d('2026-01-31'), months)).code).toBe(
        'X_SCHEDULE_INVALID',
      );
    }
  });

  test('a result outside years 0000-9999 is refused rather than branded', () => {
    expect(refusal(() => addPlainMonths(d('9999-12-01'), 1)).code).toBe('X_SCHEDULE_INVALID');
    expect(refusal(() => addPlainMonths(d('0000-01-31'), -1)).code).toBe('X_SCHEDULE_INVALID');
  });

  test('from an anchor, a month-end renewal never drifts to the 28th after February', () => {
    const anchor = d('2026-01-31');
    const renewals = Array.from({ length: 4 }, (_, index) => addPlainMonths(anchor, index + 1));
    expect(renewals).toEqual([d('2026-02-28'), d('2026-03-31'), d('2026-04-30'), d('2026-05-31')]);
  });
});

const local = (at: Instant, zone: string): string => isoInZone(at, zone);

describe('addMonthsInZone', () => {
  test('keeps 09:00 local across the New York spring-forward (EST to EDT)', () => {
    const at = fromIso('2026-02-15T09:00:00-05:00');
    expect(local(addMonthsInZone(at, 1, 'America/New_York'), 'America/New_York')).toBe(
      '2026-03-15T09:00:00-04:00',
    );
  });

  test('clamps the day in the zone, not in UTC: 23:00 on Jan 31 in New York is Feb 28 23:00', () => {
    // 04:00Z on Feb 1 in UTC terms — UTC month math would have answered March 1.
    const at = fromIso('2026-01-31T23:00:00-05:00');
    expect(local(addMonthsInZone(at, 1, 'America/New_York'), 'America/New_York')).toBe(
      '2026-02-28T23:00:00-05:00',
    );
  });

  test('a nonexistent local time resolves forward by the gap (New York, 02:30 → 03:30 EDT)', () => {
    const at = fromIso('2026-02-08T02:30:00-05:00');
    const moved = addMonthsInZone(at, 1, 'America/New_York');
    expect(local(moved, 'America/New_York')).toBe('2026-03-08T03:30:00-04:00');
  });

  test('a doubled local time resolves to the earlier offset (New York, 01:30 EDT)', () => {
    const at = fromIso('2026-10-01T01:30:00-04:00');
    const moved = addMonthsInZone(at, 1, 'America/New_York');
    expect(toIso(moved)).toBe('2026-11-01T05:30:00.000Z');
    expect(local(moved, 'America/New_York')).toBe('2026-11-01T01:30:00-04:00');
  });

  test('Berlin spring-forward: 02:30 on 2026-03-29 never happens, so 03:30 CEST', () => {
    const at = fromIso('2026-01-29T02:30:00+01:00');
    expect(local(addMonthsInZone(at, 2, 'Europe/Berlin'), 'Europe/Berlin')).toBe(
      '2026-03-29T03:30:00+02:00',
    );
  });

  test('Berlin fall-back: 02:30 on 2026-10-25 happens twice, the CEST pass is taken', () => {
    const at = fromIso('2026-09-25T02:30:00+02:00');
    const moved = addMonthsInZone(at, 1, 'Europe/Berlin');
    expect(toIso(moved)).toBe('2026-10-25T00:30:00.000Z');
    expect(
      fromZonedDetailed({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin')
        .resolution,
    ).toBe('overlap');
  });

  test('Lord Howe moves its clock 30 minutes: 02:15 in the gap becomes 02:45 +11:00', () => {
    const at = fromIso('2026-09-04T02:15:00+10:30');
    expect(local(addMonthsInZone(at, 1, 'Australia/Lord_Howe'), 'Australia/Lord_Howe')).toBe(
      '2026-10-04T02:45:00+11:00',
    );
  });

  test('Lord Howe overlap: 01:45 on 2026-04-05 happens twice, the +11:00 pass is taken', () => {
    const at = fromIso('2026-03-05T01:45:00+11:00');
    const moved = addMonthsInZone(at, 1, 'Australia/Lord_Howe');
    expect(toIso(moved)).toBe('2026-04-04T14:45:00.000Z');
  });

  test('negative months go back across DST and a year boundary', () => {
    const at = fromIso('2026-04-15T09:00:00-04:00');
    expect(local(addMonthsInZone(at, -5, 'America/New_York'), 'America/New_York')).toBe(
      '2025-11-15T09:00:00-05:00',
    );
    const berlin = fromIso('2026-03-31T08:00:00+02:00');
    expect(local(addMonthsInZone(berlin, -1, 'Europe/Berlin'), 'Europe/Berlin')).toBe(
      '2026-02-28T08:00:00+01:00',
    );
  });

  test('Bogota has no DST: an anchored renewal keeps 00:00 and the 31st where it exists', () => {
    const anchor = fromIso('2026-01-31T00:00:00-05:00');
    const renewals = Array.from({ length: 12 }, (_, index) =>
      local(addMonthsInZone(anchor, index + 1, 'America/Bogota'), 'America/Bogota'),
    );
    expect(renewals[0]).toBe('2026-02-28T00:00:00-05:00');
    expect(renewals[1]).toBe('2026-03-31T00:00:00-05:00');
    expect(renewals[11]).toBe('2027-01-31T00:00:00-05:00');
    expect(renewals.every((value) => value.includes('T00:00:00-05:00'))).toBe(true);
  });

  test('zero months hands back an equal instant that is not the caller’s Date', () => {
    // The second pass of a doubled hour: recomputing it would land on the first pass.
    const at = fromIso('2026-11-01T01:30:00-05:00');
    const same = addMonthsInZone(at, 0, 'America/New_York');
    expect(same.getTime()).toBe(at.getTime());
    expect(same).not.toBe(at);
  });

  test('milliseconds ride along', () => {
    const at = fromIso('2026-01-10T12:00:00.123Z');
    expect(toIso(addMonthsInZone(at, 1, 'UTC'))).toBe('2026-02-10T12:00:00.123Z');
  });

  test('the zone is required and validated, a count is a whole number', () => {
    const at = fromIso('2026-01-10T12:00:00Z');
    expect(refusal(() => addMonthsInZone(at, 1, 'CET')).code).toBe('X_TIMEZONE_INVALID');
    const untyped = addMonthsInZone as (at: Instant, months: number, zone?: string) => Instant;
    expect(refusal(() => untyped(at, 1)).code).toBe('X_TIMEZONE_INVALID');
    expect(refusal(() => addMonthsInZone(at, 1.5, 'UTC')).code).toBe('X_SCHEDULE_INVALID');
  });
});
