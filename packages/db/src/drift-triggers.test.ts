// The two lifecycle drift kinds, judged on hand-built halves: a recorded trigger the catalog lacks,
// a retain table the catalog holds partitioned, and silence where the catalog was never read.

import { describe, expect, test } from 'bun:test';
import { compareTriggers } from './drift-triggers';
import type { TableDescription } from './introspect';

const table = (extra: Partial<TableDescription>): TableDescription => ({
  schema: 'public',
  name: 'events',
  columns: [],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  ...extra,
});
const trigger = { name: 'ultimate_history', install: ['select 1;'] };

describe('compareTriggers', () => {
  test('a recorded trigger missing from the catalog is drift whose fix runs its install', () => {
    const found = compareTriggers(table({ triggerNames: [] }), table({ triggers: [trigger] }));
    expect(found.map((d) => d.kind)).toEqual(['missing-lifecycle-trigger']);
    expect(found[0]?.fix).toContain('select 1;');
  });

  test('present is clean, and an unread catalog says nothing', () => {
    expect(
      compareTriggers(
        table({ triggerNames: ['ultimate_history'] }),
        table({ triggers: [trigger] }),
      ),
    ).toEqual([]);
    expect(compareTriggers(table({}), table({ triggers: [trigger] }))).toEqual([]);
  });

  test('retain on a partitioned parent is refused', () => {
    const found = compareTriggers(table({ partitioned: true }), table({ retain: true }));
    expect(found.map((d) => d.kind)).toEqual(['retain-partitioned']);
    expect(compareTriggers(table({}), table({ retain: true }))).toEqual([]);
  });
});
