// `entity({ partitionBy })` end to end through the declaration: refused at `entity()` when the key
// lacks the partition column, and otherwise described so `x db gen` writes a partitioned table.
// Applied with the `entity.ts` / `registry.ts` wiring (FENT-A-OUTSIDE.patch).

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

describe('entity({ partitionBy })', () => {
  test('an id-only key is refused at declaration, the fix naming the composite key', () => {
    let refused: unknown;
    try {
      entity('pe_bad', {
        columns: { id: uuid().primaryKey(), at: timestamp(), kind: text() },
        partitionBy: { column: 'at', interval: 'month' },
      });
    } catch (error) {
      refused = isUltimateError(error) ? [error.code, error.fix] : String(error);
    }
    expect(refused).toEqual([
      'X_ENTITY_PARTITION_INVALID',
      expect.stringContaining("primaryKey: ['id', 'at']"),
    ]);
  });

  test('a composite key is described and generates a partitioned table', () => {
    const events = entity('pe_events', {
      columns: { id: uuid(), at: timestamp(), kind: text() },
      primaryKey: ['id', 'at'],
      partitionBy: { column: 'at', interval: 'month', ahead: 2, retain: { after: '400d' } },
    });
    const described = events.$describe();
    expect(described.partition).toEqual({
      column: 'at',
      interval: 'month',
      ahead: 2,
      retain: { after: '400d', afterMs: 400 * 86_400_000 },
    });
    const up = generateMigration({ entities: [described], name: 'events' }).up;
    expect(up).toContain(') partition by range ("at");');
    expect(up).toContain(
      `select "ultimate_partitions"('pe_events', 'timestamptz', 'month', 2, null);`,
    );
  });
});
