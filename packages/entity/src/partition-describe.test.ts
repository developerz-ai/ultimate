// `$describe()`'s `partition` key: present exactly when `partitionBy` was declared, so no entity
// that never said it moves `x verify`'s source-drift hash, and `@ultimat3/db` reads it as it is.

import { describe, expect, test } from 'bun:test';
import { timestamp, uuid } from './columns';
import { describeEntity } from './describe';
import { partitionOf } from './partition';

const COLUMNS = Object.entries({ id: uuid().primaryKey(), at: timestamp() });
const base = {
  name: 'pd_events',
  table: 'pd_events',
  columns: COLUMNS,
  primaryKey: ['id', 'at'],
  invariants: [],
  indexes: [],
  tags: ['entity:pd_events'],
  cacheTag: 'entity:pd_events',
  softDelete: false,
  tenantColumn: null,
};

describe('describeEntity · partition', () => {
  test('absent when not declared', () => {
    expect(describeEntity(base)).not.toHaveProperty('partition');
    expect(describeEntity({ ...base, partition: null })).not.toHaveProperty('partition');
  });

  test('the checked declaration, physical, when declared', () => {
    const partition = partitionOf(
      'pd_events',
      { column: 'at', interval: 'month', retain: { after: '400d' } },
      { ...base, retain: false, view: false, uniques: [] },
    );
    expect(describeEntity({ ...base, partition })).toMatchObject({
      partition: {
        column: 'at',
        interval: 'month',
        ahead: 3,
        retain: { after: '400d', afterMs: 400 * 86_400_000 },
      },
    });
  });
});
