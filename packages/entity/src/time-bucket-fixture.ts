// Single responsibility: the zone cases a series must bucket alike on every driver — each one an
// instant written out by hand from what Postgres 18 answered. Shared by the PGlite parity file and
// the real-server live file, so the two cannot drift into proving different tables.

import type { SeriesUnit } from './time-bucket';

export interface BucketCase {
  readonly name: string;
  readonly unit: SeriesUnit;
  readonly zone: string;
  readonly at: readonly string[];
  /** `[bucket, count]`, ascending. */
  readonly want: readonly (readonly [string, number])[];
}

export const BUCKET_CASES: readonly BucketCase[] = [
  {
    name: 'a row at 23:30 UTC is the next day in Tokyo',
    unit: 'day',
    zone: 'Asia/Tokyo',
    at: ['2026-03-31T23:30:00.000Z', '2026-03-31T14:59:00.000Z'],
    want: [
      ['2026-03-30T15:00:00.000Z', 1],
      ['2026-03-31T15:00:00.000Z', 1],
    ],
  },
  {
    name: 'a spring-forward day starts at local midnight before the jump',
    unit: 'day',
    zone: 'America/New_York',
    at: ['2026-03-08T05:00:00.000Z', '2026-03-09T03:59:00.000Z', '2026-03-09T04:00:00.000Z'],
    want: [
      ['2026-03-08T05:00:00.000Z', 2],
      ['2026-03-09T04:00:00.000Z', 1],
    ],
  },
  {
    name: 'the repeated hour of a fall-back day is two buckets',
    unit: 'hour',
    zone: 'America/New_York',
    at: ['2018-11-04T05:30:00.000Z', '2018-11-04T06:30:00.000Z'],
    want: [
      ['2018-11-04T05:00:00.000Z', 1],
      ['2018-11-04T06:00:00.000Z', 1],
    ],
  },
  {
    name: 'a half-hour zone starts its hour at :30 UTC',
    unit: 'hour',
    zone: 'Asia/Kolkata',
    at: ['2024-01-01T00:50:00.000Z', '2024-01-01T00:29:00.000Z'],
    want: [
      ['2023-12-31T23:30:00.000Z', 1],
      ['2024-01-01T00:30:00.000Z', 1],
    ],
  },
  {
    name: 'a midnight that happens twice resolves to the later instant (Asia/Gaza)',
    unit: 'day',
    zone: 'Asia/Gaza',
    at: ['2016-10-29T12:00:00.000Z'],
    want: [['2016-10-28T22:00:00.000Z', 1]],
  },
  {
    name: 'a midnight that never happens reads at the offset before the jump (America/Santiago)',
    unit: 'day',
    zone: 'America/Santiago',
    at: ['2022-09-11T12:00:00.000Z'],
    want: [['2022-09-11T04:00:00.000Z', 1]],
  },
  {
    name: 'a week starts on Monday, local midnight',
    unit: 'week',
    zone: 'Europe/Berlin',
    at: ['2026-11-08T12:00:00.000Z', '2026-11-02T00:30:00.000Z'],
    want: [['2026-11-01T23:00:00.000Z', 2]],
  },
  {
    name: 'a month is the first, local midnight',
    unit: 'month',
    zone: 'Asia/Tokyo',
    at: ['2024-03-31T23:30:00.000Z'],
    want: [['2024-03-31T15:00:00.000Z', 1]],
  },
  {
    name: 'a minute drops seconds and milliseconds only',
    unit: 'minute',
    zone: 'Asia/Kathmandu',
    at: ['2026-01-01T00:00:59.999Z', '2026-01-01T00:00:00.000Z'],
    want: [['2026-01-01T00:00:00.000Z', 2]],
  },
];
