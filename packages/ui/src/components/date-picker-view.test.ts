import { describe, expect, test } from 'bun:test';
import { type PlainDate, plainDate } from '@ultimat3/time';
import { enhancesWithCalendar, inputDate, opensPicker, writeInputDate } from './date-picker-view';

describe('date picker enhancement', () => {
  test('only a fine pointer gets the calendar; no matchMedia is a server or an old engine', () => {
    expect(enhancesWithCalendar((query) => ({ matches: query === '(pointer: fine)' }))).toBe(true);
    expect(enhancesWithCalendar(() => ({ matches: false }))).toBe(false);
    expect(enhancesWithCalendar(undefined)).toBe(false);
  });

  test('F4 and Alt+ArrowDown open it; a bare ArrowDown is the input’s own', () => {
    expect(opensPicker({ key: 'F4' })).toBe(true);
    expect(opensPicker({ key: 'ArrowDown', altKey: true })).toBe(true);
    expect(opensPicker({ key: 'ArrowDown' })).toBe(false);
  });

  test('the input’s text is a date only when it is a whole one', () => {
    expect<string | undefined>(inputDate('2026-03-01')).toBe('2026-03-01');
    expect(inputDate('')).toBeUndefined();
    expect(inputDate('2026-02-30')).toBeUndefined();
  });

  test('a picked day is written as typing would write it: value, then input and change', () => {
    const fired: string[] = [];
    const input = {
      value: '',
      dispatchEvent: (event: Event): boolean => {
        fired.push(event.type);
        return true;
      },
    };
    const day: PlainDate = plainDate('2026-03-14');
    writeInputDate(input, day);
    expect(input.value).toBe('2026-03-14');
    expect(fired).toEqual(['input', 'change']);
  });
});
