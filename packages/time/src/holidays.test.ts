// The holiday lookup is built once per list, and this file counts it: a Proxy over the list
// records every full iteration (the build), so "memoised" is a number the test reads, not a timing it hopes for.

import { describe, expect, test } from 'bun:test';
import { addBusinessDays, type BusinessCalendar, isHoliday } from './business';
import { holidaySet } from './holidays';
import { fromIso, toIso } from './instant';
import { plainDate } from './plain-date';
import { plainDateRange } from './plain-date-range';

const counted = (dates: readonly string[]): { list: readonly string[]; reads: () => number } => {
  let reads = 0;
  const list = new Proxy(dates, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads: () => reads };
};

describe('holidaySet', () => {
  test('one list is read once, however many lookups follow', () => {
    const { list, reads } = counted(['2026-12-25', '2026-12-26']);
    const calendar: BusinessCalendar = { zone: 'Europe/Berlin', holidays: list };
    const christmas = fromIso('2026-12-25T10:00:00Z');
    for (let index = 0; index < 100; index += 1) expect(isHoliday(christmas, calendar)).toBe(true);
    expect(reads()).toBe(1);
    expect(holidaySet(list)).toBe(holidaySet(list));
  });

  test('a replaced list is a new set, never the stale one', () => {
    const calendar: BusinessCalendar = { zone: 'UTC', holidays: ['2026-01-01'] };
    const newYear = fromIso('2026-01-01T12:00:00Z');
    expect(isHoliday(newYear, calendar)).toBe(true);
    calendar.holidays = ['2026-01-02'];
    expect(isHoliday(newYear, calendar)).toBe(false);
  });

  test('an in-place edit after first use throws, so the list and its set never disagree', () => {
    const dates = ['2026-01-01', '2026-12-25'];
    const calendar: BusinessCalendar = { zone: 'UTC', holidays: dates };
    expect(isHoliday(fromIso('2026-01-01T12:00:00Z'), calendar)).toBe(true);
    expect(() => {
      dates[0] = '2026-01-02';
    }).toThrow(TypeError);
    expect(() => dates.push('2026-01-02')).toThrow(TypeError);
    expect(dates).toEqual(['2026-01-01', '2026-12-25']);
    expect(isHoliday(fromIso('2026-01-01T12:00:00Z'), calendar)).toBe(true);
    expect(isHoliday(fromIso('2026-01-02T12:00:00Z'), calendar)).toBe(false);
  });

  test('no list is the one shared empty set', () => {
    expect(holidaySet(undefined).size).toBe(0);
    expect(holidaySet(undefined)).toBe(holidaySet(undefined));
  });

  test('addBusinessDays over a calendar holding a 21-day closure skips all 21 days', () => {
    const closure = plainDateRange(plainDate('2026-12-12'), plainDate('2027-01-01'));
    expect(closure.length).toBe(21);
    const calendar: BusinessCalendar = {
      zone: 'Europe/Berlin',
      weekendDays: [],
      holidays: [...closure],
    };
    const friday = fromIso('2026-12-11T09:00:00+01:00');
    expect(toIso(addBusinessDays(friday, 1, calendar))).toBe('2027-01-02T08:00:00.000Z');
  });
});
