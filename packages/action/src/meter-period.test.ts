// The period boundaries a meter counts against: UTC, half-open, and the same for every instant
// inside one period — which is what makes two replicas agree on which row a call lands in.

import { describe, expect, test } from 'bun:test';
import { meterPeriodKey, meterWindow } from './meter-period';

const at = (iso: string): number => Date.parse(iso);
const iso = (window: { startMs: number; endMs: number }) => [
  new Date(window.startMs).toISOString(),
  new Date(window.endMs).toISOString(),
];

describe('meterWindow', () => {
  test('a day is UTC midnight to UTC midnight, whatever the instant inside it', () => {
    expect(iso(meterWindow('day', at('2026-11-06T23:59:59.999Z')))).toEqual([
      '2026-11-06T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
    ]);
    expect(iso(meterWindow('day', at('2026-11-07T00:00:00.000Z')))[0]).toBe(
      '2026-11-07T00:00:00.000Z',
    );
  });

  test('an hour is the UTC hour', () => {
    expect(iso(meterWindow('hour', at('2026-11-06T10:42:13.000Z')))).toEqual([
      '2026-11-06T10:00:00.000Z',
      '2026-11-06T11:00:00.000Z',
    ]);
  });

  test('a month ends on the first of the next, across a year boundary and a leap February', () => {
    expect(iso(meterWindow('month', at('2026-12-31T12:00:00.000Z')))).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
    expect(iso(meterWindow('month', at('2028-02-29T08:00:00.000Z')))).toEqual([
      '2028-02-01T00:00:00.000Z',
      '2028-03-01T00:00:00.000Z',
    ]);
  });

  test('the stored key names the zone, so it is never assumed', () => {
    expect(meterPeriodKey('day')).toBe('day@UTC');
  });
});
