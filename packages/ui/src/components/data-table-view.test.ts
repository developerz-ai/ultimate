// A priority decides where a value is visible, so the failure is a value on screen twice or on
// screen nowhere — neither renders wrong-looking, which is why the rule is pinned here.

import { describe, expect, test } from 'bun:test';
import { columnPriority, moreColumn, priorityAttr } from './data-table-view';

describe('columnPriority', () => {
  test('no priority is 1, the column that is a cell at every width', () => {
    expect(columnPriority(undefined)).toBe(1);
    expect([1, 2, 3].map(columnPriority)).toEqual([1, 2, 3]);
  });

  for (const bad of [0, 4, 1.5, Number.NaN, '2']) {
    test(`${String(bad)} is refused by code, never a column silently shown everywhere`, () => {
      expect(() => columnPriority(bad)).toThrow(/X_UI_INVALID_VALUE/);
    });
  }
});

describe('priorityAttr', () => {
  test('only a lower priority carries a hiding attribute', () => {
    expect(priorityAttr(1)).toBeUndefined();
    expect(priorityAttr(2)).toBe('2');
    expect(priorityAttr(3)).toBe('3');
  });
});

describe('moreColumn', () => {
  const col = (key: string, priority?: number) => ({ key, priority });

  test('a table that hides nothing gets no disclosure column at all', () => {
    expect(moreColumn([col('a'), col('b', 1)])).toBeUndefined();
  });

  test('holds every hidden column, in declaration order — none is dropped', () => {
    const more = moreColumn([col('a'), col('b', 3), col('c'), col('d', 2)]);
    expect(more?.columns.map((column) => column.key)).toEqual(['b', 'd']);
  });

  test('shows over the WIDEST range any of its columns is hidden over', () => {
    expect(moreColumn([col('a'), col('b', 2)])?.until).toBe('md');
    expect(moreColumn([col('a'), col('b', 2), col('c', 3)])?.until).toBe('lg');
  });
});
