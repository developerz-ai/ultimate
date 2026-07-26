import { describe, expect, test } from 'bun:test';
import {
  addBusinessDays,
  businessDaysBetween,
  isWeekend,
  WEEKEND_FRI_SAT,
  WEEKEND_SAT_SUN,
} from './business';
import { fromIso } from './instant';
import { toZoned } from './zoned';

const BERLIN = 'Europe/Berlin';
const DUBAI = 'Asia/Dubai';

describe('isWeekend', () => {
  test('the weekend is configuration, not Saturday and Sunday', () => {
    const friday = fromIso('2026-03-13T12:00:00Z');
    const saturday = fromIso('2026-03-14T12:00:00Z');
    const sunday = fromIso('2026-03-15T12:00:00Z');
    expect(isWeekend(friday, BERLIN, WEEKEND_SAT_SUN)).toBe(false);
    expect(isWeekend(saturday, BERLIN, WEEKEND_SAT_SUN)).toBe(true);
    // Gulf calendar: Friday and Saturday are the weekend, Sunday is a work day.
    expect(isWeekend(friday, DUBAI, WEEKEND_FRI_SAT)).toBe(true);
    expect(isWeekend(sunday, DUBAI, WEEKEND_FRI_SAT)).toBe(false);
  });

  test('the zone decides which local day it is', () => {
    // 2026-03-16T00:30Z is still Sunday evening in New York, already Monday in Berlin.
    const at = fromIso('2026-03-16T00:30:00Z');
    expect(isWeekend(at, BERLIN)).toBe(false);
    expect(isWeekend(at, 'America/New_York')).toBe(true);
  });
});

describe('addBusinessDays', () => {
  test('skips weekends and holidays while keeping the local time of day', () => {
    const friday = fromIso('2026-03-13T12:00:00Z');
    expect(toZoned(addBusinessDays(friday, 1, { zone: BERLIN }), BERLIN)).toMatchObject({
      day: 16,
      hour: 13,
    });
    expect(
      toZoned(addBusinessDays(friday, 1, { zone: BERLIN, holidays: ['2026-03-16'] }), BERLIN).day,
    ).toBe(17);
  });

  test('honours a Friday/Saturday weekend', () => {
    // Thursday + 1 business day → Sunday in the Gulf, not Friday.
    const thursday = fromIso('2026-03-12T12:00:00Z');
    const next = addBusinessDays(thursday, 1, { zone: DUBAI, weekendDays: WEEKEND_FRI_SAT });
    expect(toZoned(next, DUBAI).day).toBe(15);
  });

  test('goes backwards and treats 0 as a no-op', () => {
    const monday = fromIso('2026-03-16T12:00:00Z');
    expect(toZoned(addBusinessDays(monday, -1, { zone: BERLIN }), BERLIN).day).toBe(13);
    expect(addBusinessDays(monday, 0, { zone: BERLIN })).toBe(monday);
  });

  test('counts business days across a week', () => {
    const monday = fromIso('2026-03-16T09:00:00Z');
    const nextMonday = fromIso('2026-03-23T09:00:00Z');
    expect(businessDaysBetween(monday, nextMonday, { zone: BERLIN })).toBe(5);
  });
});
