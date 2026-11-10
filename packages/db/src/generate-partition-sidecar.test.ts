// A partitioned table's snapshot through the sidecar, as `x db gen` reads it: generate, write the
// snapshot as JSON, `parseSnapshot` it back, generate again. Every `partitionPlan` judgment has to
// survive the disk, or it judges nothing in a real app.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { PartitionDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { partitionedEvents } from './generate-partition-fixture';
import type { SchemaDescription } from './introspect';
import { parseSnapshot } from './snapshot-parse';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const MONTHLY: PartitionDescriptionLike = { column: 'at', interval: 'month', ahead: 2 };

/** The previous migration's snapshot, as `x db gen` finds it: through JSON and the parser. */
const fromDisk = (partition: PartitionDescriptionLike | null): SchemaDescription => {
  const snapshot = generateMigration({
    entities: [partitionedEvents('events', partition)],
    name: 'events',
    now: NOW,
  }).snapshot;
  const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (parsed === undefined) return expect.unreachable('the sidecar did not parse');
  return parsed;
};

const next = (partition: PartitionDescriptionLike | null) => {
  try {
    return generateMigration({
      entities: [partitionedEvents('events', partition)],
      current: fromDisk(MONTHLY),
      name: 'again',
      now: NOW,
    }).up;
  } catch (error) {
    return isUltimateError(error) ? error.code : expect.unreachable(String(error));
  }
};

describe('a partitioned snapshot, through the sidecar', () => {
  test('the parsed snapshot still records partitioned and its interval', () => {
    expect(fromDisk(MONTHLY).tables[0]).toMatchObject({
      partitioned: true,
      partitionInterval: 'month',
    });
  });

  test('an unchanged partitioned entity writes nothing', () => {
    expect(next(MONTHLY)).toBe('');
  });

  test('removing partitionBy is refused', () => {
    expect(next(null)).toBe('X_MIGRATION_PARTITION_CHANGE');
  });

  test('changing the interval is refused', () => {
    expect(next({ ...MONTHLY, interval: 'day' })).toBe('X_MIGRATION_PARTITION_CHANGE');
  });

  test('an interval outside the set takes the sidecar with it', () => {
    const bad = JSON.parse(JSON.stringify(fromDisk(MONTHLY)));
    bad.tables[0].partitionInterval = 'hour';
    expect(parseSnapshot(bad)).toBeUndefined();
  });
});
