// `entity({ partitionBy })` checked at declaration: Postgres' rules — the key and every unique
// index hold the partition column, the column is a timestamp or a date — refused with
// `X_ENTITY_PARTITION_INVALID` and the edit, before any migration exists.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, timestamp, uuid } from './columns';
import { date } from './columns-data';
import { type PartitionContext, type PartitionInit, partitionOf } from './partition';

const COLUMNS = Object.entries({
  id: uuid().primaryKey(),
  at: timestamp(),
  day: date(),
  kind: text(),
});

const context = (over: Partial<PartitionContext> = {}): PartitionContext => ({
  table: 'events',
  columns: COLUMNS,
  primaryKey: ['id', 'at'],
  indexes: [],
  uniques: [],
  retain: false,
  view: false,
  ...over,
});

const MONTHLY: PartitionInit = { column: 'at', interval: 'month' };

const refusal = (init: PartitionInit, over: Partial<PartitionContext> = {}) => {
  try {
    partitionOf('Event', init, context(over));
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable(`refused without a code: ${String(error)}`);
  }
  return expect.unreachable('the declaration was accepted');
};

describe('partitionOf', () => {
  test('absent is no partitioning', () => {
    expect(partitionOf('Event', undefined, context())).toBeNull();
  });

  test('a monthly range by a timestamp in the key: physical column, three ahead by default', () => {
    expect(partitionOf('Event', MONTHLY, context())).toEqual({
      column: 'at',
      interval: 'month',
      ahead: 3,
    });
  });

  test('a date column, a retention window and an explicit ahead', () => {
    const init: PartitionInit = {
      column: 'day',
      interval: 'day',
      ahead: 7,
      retain: { after: '90d' },
    };
    expect(partitionOf('Event', init, context({ primaryKey: ['id', 'day'] }))).toEqual({
      column: 'day',
      interval: 'day',
      ahead: 7,
      retain: { after: '90d', afterMs: 90 * 86_400_000 },
    });
  });

  test('a key without the partition column is refused, the fix naming the composite key', () => {
    const refused = refusal(MONTHLY, { primaryKey: ['id'] });
    expect(refused.code).toBe('X_ENTITY_PARTITION_INVALID');
    expect(refused.cause).toContain('does not hold "at"');
    expect(refused.fix).toContain("primaryKey: ['id', 'at']");
  });

  test('a unique index or unique invariant without the partition column is refused', () => {
    const index = { name: 'events_kind_key', columns: ['kind'], unique: true };
    expect(refusal(MONTHLY, { indexes: [index] }).cause).toContain('unique index on (kind)');
    expect(refusal(MONTHLY, { uniques: [['kind']] }).code).toBe('X_ENTITY_PARTITION_INVALID');
    expect(partitionOf('Event', MONTHLY, context({ uniques: [['kind', 'at']] }))).not.toBeNull();
  });

  test.each([
    ['a text column', { column: 'kind', interval: 'month' }, {}, 'no timestamp() or date()'],
    ['an unknown column', { column: 'nope', interval: 'month' }, {}, 'no timestamp() or date()'],
    ['an unknown interval', { column: 'at', interval: 'hour' }, {}, 'interval "hour"'],
    ['a negative ahead', { column: 'at', interval: 'month', ahead: -1 }, {}, 'ahead'],
    ['a fractional ahead', { column: 'at', interval: 'month', ahead: 1.5 }, {}, 'ahead'],
    ['a zero window', { ...MONTHLY, retain: { after: '0d' } }, {}, 'retain.after'],
    ['a bad window', { ...MONTHLY, retain: { after: 'soon' } }, {}, 'retain.after'],
    ['row retain beside it', MONTHLY, { retain: true }, 'never rows'],
    ['a view', MONTHLY, { view: true }, 'is a view'],
    ['a long table name', MONTHLY, { table: 'e'.repeat(54) }, 'over 53 bytes'],
  ] as const)('%s is refused', (_, init, over, cause) => {
    const refused = refusal(init as PartitionInit, over);
    expect(refused.code).toBe('X_ENTITY_PARTITION_INVALID');
    expect(refused.cause).toContain(cause);
  });
});
