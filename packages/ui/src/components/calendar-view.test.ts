import { describe, expect, test } from 'bun:test';
import { type PlainDate, plainDate } from '@ultimat3/time';
import { UiError } from '../errors';
import {
  assertBounds,
  monthGrid,
  monthLabel,
  plainDateProp,
  rovingDay,
  stepDay,
  weekdayLabels,
  weekdayOf,
  weekStartOf,
} from './calendar-view';

const d = (value: string): PlainDate => plainDate(value);

describe('calendar arithmetic', () => {
  test('week start comes from the locale: de on Monday, en-US on Sunday, an override wins', () => {
    expect(weekStartOf('de')).toBe(1);
    expect(weekStartOf('en-US')).toBe(7);
    expect(weekStartOf('en-US', 1)).toBe(1);
    expect(weekdayLabels('en-US', 7)[0]?.long).toBe('Sunday');
    expect(weekdayLabels('de', 1)[0]?.long).toBe('Montag');
  });

  test('every month is 6 rows of 7, so the box never jumps', () => {
    for (const month of ['2026-02-01', '2026-03-01', '2027-02-01', '2026-11-01']) {
      const grid = monthGrid(d(month), 1);
      expect(grid).toHaveLength(6);
      expect(grid.every((week) => week.length === 7)).toBe(true);
      expect(grid[0]?.[0] && weekdayOf(grid[0][0].date)).toBe(1);
    }
    // February 2026 starts on a Sunday: a Monday-first grid leads with six days of January.
    const feb = monthGrid(d('2026-02-14'), 1);
    expect(feb[0]?.map((day) => day.inMonth)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(feb.flat().filter((day) => day.inMonth)).toHaveLength(28);
  });

  test('a leap February has its 29th, and a DST month has every day once', () => {
    expect(
      monthGrid(d('2028-02-01'), 7)
        .flat()
        .filter((day) => day.inMonth),
    ).toHaveLength(29);
    // Europe's clocks change on 2026-03-29; a plain date has no zone, so the day is there once.
    const march = monthGrid(d('2026-03-01'), 1).flat();
    expect(march.filter((day) => day.date === '2026-03-29')).toHaveLength(1);
    expect(march.filter((day) => day.date === '2026-03-30')).toHaveLength(1);
  });

  test('arrows follow dir: right is forward in ltr and backward in rtl', () => {
    const at = d('2026-03-10');
    expect<string | undefined>(stepDay(at, 'ArrowRight', { dir: 'ltr', weekStart: 1 })).toBe(
      '2026-03-11',
    );
    expect<string | undefined>(stepDay(at, 'ArrowRight', { dir: 'rtl', weekStart: 1 })).toBe(
      '2026-03-09',
    );
    expect<string | undefined>(stepDay(at, 'ArrowDown', { dir: 'ltr', weekStart: 1 })).toBe(
      '2026-03-17',
    );
    expect<string | undefined>(stepDay(at, 'PageDown', { dir: 'ltr', weekStart: 1 })).toBe(
      '2026-04-10',
    );
    expect<string | undefined>(
      stepDay(at, 'PageUp', { dir: 'ltr', weekStart: 1, shiftKey: true }),
    ).toBe('2025-03-10');
    // 2026-03-10 is a Tuesday: Home is that week's Monday, or its Sunday in a Sunday-first locale.
    expect<string | undefined>(stepDay(at, 'Home', { dir: 'ltr', weekStart: 1 })).toBe(
      '2026-03-09',
    );
    expect<string | undefined>(stepDay(at, 'Home', { dir: 'ltr', weekStart: 7 })).toBe(
      '2026-03-08',
    );
    expect<string | undefined>(stepDay(at, 'End', { dir: 'ltr', weekStart: 1 })).toBe('2026-03-15');
    expect<string | undefined>(stepDay(at, 'Tab', { dir: 'ltr', weekStart: 1 })).toBeUndefined();
    // Jan 31 plus a month clamps to Feb 28, the time package's rule.
    expect<string | undefined>(
      stepDay(d('2026-01-31'), 'PageDown', { dir: 'ltr', weekStart: 1 }),
    ).toBe('2026-02-28');
  });

  test('an arrow steps over a disabled day, and stays put at a bound', () => {
    const weekend = (date: PlainDate): boolean => weekdayOf(date) >= 6;
    const friday = d('2026-03-13');
    expect<string | undefined>(
      stepDay(friday, 'ArrowRight', { dir: 'ltr', weekStart: 1, isDisabled: weekend }),
    ).toBe('2026-03-16');
    expect(
      stepDay(friday, 'ArrowRight', { dir: 'ltr', weekStart: 1, max: friday }),
    ).toBeUndefined();
  });

  test('a disabled day never holds the roving stop', () => {
    const grid = monthGrid(d('2026-03-01'), 1, { isDisabled: (date) => date === '2026-03-05' });
    expect<string | undefined>(rovingDay(grid, [d('2026-03-05'), undefined])).toBe('2026-03-01');
    expect<string | undefined>(rovingDay(grid, [undefined, d('2026-03-06')])).toBe('2026-03-06');
    // A day outside the month shown is not in the grid's tab order either.
    expect<string | undefined>(rovingDay(grid, [d('2026-04-02')])).toBe('2026-03-01');
    const closed = monthGrid(d('2026-03-01'), 1, { isDisabled: () => true });
    expect<string | undefined>(rovingDay(closed, [])).toBeUndefined();
  });

  test('labels are formatted in UTC from the plain date, never shifted by a zone', () => {
    expect(monthLabel(d('2026-03-01'), 'en-US')).toBe('March 2026');
    expect(monthLabel(d('2026-03-01'), 'de')).toBe('März 2026');
  });

  test('a non-PlainDate value and a min after max are X_UI_INVALID_VALUE naming the prop', () => {
    expect(() => plainDateProp('DatePicker value', '2026-02-30')).toThrow(UiError);
    try {
      assertBounds('Calendar', { min: d('2026-03-10'), max: d('2026-03-01') });
      expect.unreachable('a min after max was accepted');
    } catch (error) {
      expect((error as UiError).code).toBe('X_UI_INVALID_VALUE');
      expect((error as UiError).message).toContain('Calendar min');
    }
  });
});
