// A range of calendar dates is how a closure becomes holidays, so its two ends and its bound are
// the contract: inclusive by default, exclusive on request, a whole positive step, and a refusal
// before an absurd span allocates anything.

import { describe, expect, test } from 'bun:test';
import { TimeError } from './errors';
import { type PlainDate, plainDate } from './plain-date';
import { MAX_PLAIN_DATE_RANGE_DAYS, plainDateRange } from './plain-date-range';

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

describe('plainDateRange', () => {
  test('inclusive by default, across a month and a year', () => {
    expect(plainDateRange(d('2026-12-30'), d('2027-01-02'))).toEqual([
      d('2026-12-30'),
      d('2026-12-31'),
      d('2027-01-01'),
      d('2027-01-02'),
    ]);
  });

  test('a one-day range is that day; exclusive drops the end', () => {
    expect(plainDateRange(d('2026-03-01'), d('2026-03-01'))).toEqual([d('2026-03-01')]);
    expect(plainDateRange(d('2026-03-01'), d('2026-03-01'), { exclusive: true })).toEqual([]);
    expect(plainDateRange(d('2026-02-27'), d('2026-03-01'), { exclusive: true })).toEqual([
      d('2026-02-27'),
      d('2026-02-28'),
    ]);
  });

  test('crosses Feb 29 of a leap year', () => {
    expect(plainDateRange(d('2024-02-28'), d('2024-03-01'))).toEqual([
      d('2024-02-28'),
      d('2024-02-29'),
      d('2024-03-01'),
    ]);
  });

  test('a step in days, landing on the end only when the step reaches it', () => {
    expect(plainDateRange(d('2026-01-01'), d('2026-01-15'), { stepDays: 7 })).toEqual([
      d('2026-01-01'),
      d('2026-01-08'),
      d('2026-01-15'),
    ]);
    expect(
      plainDateRange(d('2026-01-01'), d('2026-01-15'), { stepDays: 7, exclusive: true }),
    ).toEqual([d('2026-01-01'), d('2026-01-08')]);
    expect(plainDateRange(d('2026-01-01'), d('2026-01-10'), { stepDays: 4 })).toEqual([
      d('2026-01-01'),
      d('2026-01-05'),
      d('2026-01-09'),
    ]);
  });

  test('the result is frozen', () => {
    expect(Object.isFrozen(plainDateRange(d('2026-01-01'), d('2026-01-03')))).toBe(true);
  });

  test('a reversed range is refused, not answered empty, with the swapped call as its fix', () => {
    const error = refusal(() => plainDateRange(d('2026-01-02'), d('2026-01-01')));
    expect(error.code).toBe('X_SCHEDULE_INVALID');
    expect(error.fix).toStartWith(
      'plainDateRange(plainDate("2026-01-01"), plainDate("2026-01-02"))   # ',
    );
  });

  test('a step that is not a positive whole number is refused', () => {
    for (const stepDays of [0, -1, 1.5, Number.NaN]) {
      expect(
        refusal(() => plainDateRange(d('2026-01-01'), d('2026-01-10'), { stepDays })).code,
      ).toBe('X_SCHEDULE_INVALID');
    }
    expect(
      refusal(() => plainDateRange(d('2026-01-01'), d('2026-01-10'), { stepDays: 0 })).fix,
    ).toStartWith(
      'plainDateRange(plainDate("2026-01-01"), plainDate("2026-01-10"), { stepDays: 1 })',
    );
  });

  test('the span is bounded at ten years, whatever the step', () => {
    const start = d('2026-01-01');
    expect(MAX_PLAIN_DATE_RANGE_DAYS).toBe(3660);
    expect(plainDateRange(start, d('2036-01-09')).length).toBe(3660 + 1);
    const error = refusal(() => plainDateRange(start, d('2036-01-10')));
    expect(error.code).toBe('X_SCHEDULE_INVALID');
    expect(error.message).toContain('3660');
    expect(error.fix).toStartWith(
      'plainDateRange(plainDate("2026-01-01"), addPlainDays(plainDate("2026-01-01"), 3660))   # ',
    );
    expect(refusal(() => plainDateRange(start, d('9999-12-31'), { stepDays: 365 })).code).toBe(
      'X_SCHEDULE_INVALID',
    );
  });

  test('a string that is not a calendar date is refused', () => {
    const untyped = plainDateRange as (start: string, end: string) => readonly PlainDate[];
    expect(refusal(() => untyped('2026-02-30', '2026-03-01')).code).toBe('X_SCHEDULE_INVALID');
  });
});
