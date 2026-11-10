// `generateMigration` over a description carrying `partition`: the parent's `partition by range`,
// the function and its first call after the table, the snapshot's `partitioned` record, and the
// removal refused. A plain table's migration is untouched by any of it.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration } from './generate';
import { PARTITION_FUNCTION, partitionMaintenance } from './generate-partition';
import { partitionedEvents } from './generate-partition-fixture';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const gen = (partitioned: boolean, current?: ReturnType<typeof generateMigration>) =>
  generateMigration({
    entities: [partitionedEvents('events', partitioned ? undefined : null)],
    name: 'events',
    now: NOW,
    ...(current === undefined ? {} : { current: current.snapshot }),
  });

describe('generateMigration · entity({ partitionBy })', () => {
  test('a new table is created partitioned, then its function and first partitions', () => {
    const up = gen(true).up;
    expect(up).toContain('\n) partition by range ("at");');
    const fn = up.indexOf(`create or replace function "${PARTITION_FUNCTION}"`);
    const call = up.indexOf(
      `select "${PARTITION_FUNCTION}"('events', 'timestamptz', 'month', 2, null);`,
    );
    const index = up.indexOf('create index');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(fn).toBeGreaterThan(index);
    expect(call).toBeGreaterThan(fn);
  });

  test('the migration is not destructive: the retention drop lives in a function body', () => {
    expect(gen(true).destructive).toBe(false);
  });

  test('the snapshot records the parent partitioned; a plain table records nothing new', () => {
    expect(gen(true).snapshot.tables[0]?.partitioned).toBe(true);
    expect(gen(false).snapshot.tables[0]).not.toHaveProperty('partitioned');
    expect(gen(false).up).not.toContain(PARTITION_FUNCTION);
  });

  test('regenerating an unchanged partitioned table writes nothing', () => {
    expect(gen(true, gen(true)).up).toBe('');
  });

  test('dropping partitionBy from a partitioned table is X_MIGRATION_PARTITION_CHANGE', () => {
    let code: unknown;
    try {
      gen(false, gen(true));
    } catch (error) {
      code = isUltimateError(error) ? error.code : error;
    }
    expect(code).toBe('X_MIGRATION_PARTITION_CHANGE');
  });

  test('changing the interval of a partitioned table is X_MIGRATION_PARTITION_CHANGE', () => {
    const monthly = gen(true);
    const daily = { column: 'at', interval: 'day', ahead: 2 } as const;
    let refused: unknown;
    try {
      generateMigration({
        entities: [partitionedEvents('events', daily)],
        current: monthly.snapshot,
        name: 'daily',
        now: NOW,
      });
    } catch (error) {
      refused = isUltimateError(error) ? [error.code, error.cause, error.fix] : error;
    }
    expect(refused).toEqual([
      'X_MIGRATION_PARTITION_CHANGE',
      expect.stringContaining('from month to day'),
      expect.stringContaining('backfill()'),
    ]);
  });

  test('maintenance binds every value and is absent on a plain table', () => {
    const plain = partitionMaintenance(partitionedEvents('events', null), NOW);
    expect(plain).toBeNull();
    const bound = partitionMaintenance(partitionedEvents('events'), NOW);
    expect(bound?.text).not.toContain('events');
    expect(bound?.values).toEqual([
      'events',
      'timestamptz',
      'month',
      2,
      null,
      NOW.toISOString(),
      null,
    ]);
  });
});
