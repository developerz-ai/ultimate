// A generated value for an `entity({ partitionBy })` column lands in a partition the migration made:
// the bucket holding the anchor, read off the entity's own `$describe().partition`, never a date of
// its own. Pure window arithmetic, then the whole graph over a real partitioned entity.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, date, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { seedGraph } from './seed-graph';
import { partitionWindow, valuesInWindow } from './seed-graph-partition';

afterAll(() => {
  clearRegistry();
});

const ANCHOR = new Date('2026-11-10T09:30:00.000Z');
const DAY = 86_400_000;

describe('partitionWindow', () => {
  const cases = [
    ['day', '2026-11-10T00:00:00.000Z', DAY],
    ['week', '2026-11-09T00:00:00.000Z', 7 * DAY],
    ['month', '2026-11-01T00:00:00.000Z', 30 * DAY],
    ['year', '2026-01-01T00:00:00.000Z', 365 * DAY],
  ] as const;
  for (const [interval, start, span] of cases) {
    test(`${interval}: the UTC bucket holding the anchor, as date_trunc makes it`, () => {
      const window = partitionWindow({ column: 'at', interval, ahead: 0 }, ANCHOR);
      expect([window?.startMs, window?.spanMs]).toEqual([Date.parse(start), span]);
    });
  }

  test('no partition: no window', () => {
    expect(partitionWindow(undefined, ANCHOR)).toBeNull();
    expect(partitionWindow(null, ANCHOR)).toBeNull();
  });
});

describe('valuesInWindow', () => {
  const window = { startMs: Date.parse('2026-11-01T00:00:00.000Z'), spanMs: 30 * DAY };
  const inside = (ms: number): boolean =>
    ms >= window.startMs && ms < window.startMs + window.spanMs;

  test('a timestamp and a date, every candidate inside, for any ordinal', () => {
    for (const ordinal of [1, 2, 31, 500, 10_000]) {
      const instants = valuesInWindow('timestamptz', window, ordinal, 3) as Date[];
      const days = valuesInWindow('date', window, ordinal, 3) as string[];
      expect(instants.every((at) => inside(at.getTime()))).toBe(true);
      expect(days.every((day) => inside(Date.parse(`${day}T00:00:00.000Z`)))).toBe(true);
      expect([instants.length > 1, days.length > 1]).toEqual([true, true]);
    }
  });

  test('a kind no partition bound reads: nothing of its own', () => {
    expect(valuesInWindow('text', window, 1, 0)).toEqual([]);
  });
});

const alerts = entity('sgp_alerts', {
  columns: { orgId: uuid().tenant(), meter: text({ max: 20 }), day: date() },
  primaryKey: ['orgId', 'meter', 'day'],
  partitionBy: { column: 'day', interval: 'month', ahead: 1 },
});
const events = entity('sgp_events', {
  columns: { id: uuid(), at: timestamp(), label: text({ max: 20 }) },
  primaryKey: ['id', 'at'],
  partitionBy: { column: 'at', interval: 'day', ahead: 2 },
});

describe('seedGraph over partitioned entities', () => {
  test('every row lands in the bucket of `now`, on a date and on a timestamp column', () => {
    const graph = seedGraph({ alerts, events }, { now: ANCHOR, perTable: 40 });
    const days = graph.inserts.filter((i) => i.entity === 'sgp_alerts').map((i) => i.row['day']);
    const ats = graph.inserts.filter((i) => i.entity === 'sgp_events').map((i) => i.row['at']);
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((day) => typeof day === 'string' && day.startsWith('2026-11-'))).toBe(true);
    expect(
      ats.every((at) => at instanceof Date && at.toISOString().startsWith('2026-11-10T')),
    ).toBe(true);
  });
});
