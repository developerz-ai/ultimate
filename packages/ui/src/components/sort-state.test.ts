import { describe, expect, test } from 'bun:test';
import { ariaSortFor, nextSortState } from './sort-state';

describe('nextSortState', () => {
  test('cycles unsorted -> asc -> desc -> unsorted on the same column', () => {
    const asc = nextSortState(undefined, 'name');
    expect(asc).toEqual({ key: 'name', direction: 'asc' });
    const desc = nextSortState(asc, 'name');
    expect(desc).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSortState(desc, 'name')).toBeUndefined();
  });

  test('switching columns restarts at ascending', () => {
    expect(nextSortState({ key: 'name', direction: 'desc' }, 'createdAt')).toEqual({
      key: 'createdAt',
      direction: 'asc',
    });
  });
});

describe('ariaSortFor', () => {
  test('reports none for every column except the sorted one', () => {
    const sort = { key: 'name', direction: 'asc' } as const;
    expect(ariaSortFor(sort, 'name')).toBe('ascending');
    expect(ariaSortFor(sort, 'other')).toBe('none');
    expect(ariaSortFor({ key: 'name', direction: 'desc' }, 'name')).toBe('descending');
    expect(ariaSortFor(undefined, 'name')).toBe('none');
  });
});
