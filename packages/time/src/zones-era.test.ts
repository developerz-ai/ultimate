// An instant before year 1 reads as its ASTRONOMICAL year — 0, -1, -5 — on every path that reads a
// zone's wall clock. `Intl` formats such a year in the BC era (year 0 is "1 BC"), and a reader
// that dropped the era answered 1 for year 0 and 6 for year -5, so every offset there was a year
// off and a wall clock the zone does show resolved as a DST gap.

import { describe, expect, test } from 'bun:test';
import type { Instant } from './instant';
import { fromZonedDetailed, toZoned } from './zoned';
import { offsetAt, utcEpoch, zonePartsAt } from './zones';

const at = (year: number, month = 6, day = 15, hour = 12): Instant =>
  new Date(utcEpoch(year, month, day, hour)) as Instant;

describe('a wall clock before year 1', () => {
  test.each([0, -1, -5, -2000])('year %p reads back as itself, in UTC and in a zone', (year) => {
    expect(zonePartsAt('UTC', at(year))).toMatchObject({ year, month: 6, day: 15, hour: 12 });
    expect(toZoned(at(year), 'UTC').year).toBe(year);
    // Local mean time before standard zones: Berlin's LMT is +00:53:28, so the wall clock is 12:53.
    expect(zonePartsAt('Europe/Berlin', at(year)).year).toBe(year);
  });

  test('the offset there is the zone’s, not a year’s worth of milliseconds', () => {
    expect(offsetAt('UTC', at(0))).toBe(0);
    expect(offsetAt('UTC', at(-5))).toBe(0);
    expect(offsetAt('Europe/Berlin', at(-5))).toBe(offsetAt('Europe/Berlin', at(5)));
  });

  test('a wall clock in year 0 or -5 resolves exactly, never as a DST gap', () => {
    for (const year of [0, -5]) {
      const resolved = fromZonedDetailed(
        { year, month: 6, day: 15, hour: 12, minute: 0, second: 0 },
        'UTC',
      );
      expect([year, resolved.resolution, resolved.instant.getTime()]).toEqual([
        year,
        'exact',
        at(year).getTime(),
      ]);
    }
  });

  test('the era boundary: 1 BC ends and AD 1 begins one day apart', () => {
    expect(zonePartsAt('UTC', at(0, 12, 31))).toMatchObject({ year: 0, month: 12, day: 31 });
    expect(zonePartsAt('UTC', at(1, 1, 1))).toMatchObject({ year: 1, month: 1, day: 1 });
  });
});
