// The fold, both forms. `applyPatches` is the array form an app can point at its own store, and
// `orderAfterPatches` is the ids-only half a live window uses; they must agree about membership and
// order, because two folds that disagree is one client rendering two different result sets.

import { describe, expect, test } from 'bun:test';
import { applyPatches, orderAfterPatches } from './apply-patches';
import type { Row, RowPatch } from './json';

const rows: readonly Row[] = [
  { id: 'p1', likes: 1 },
  { id: 'p2', likes: 2 },
];

function ids(of: readonly Row[]): readonly string[] {
  return of.map((row) => row.id);
}

describe('applyPatches', () => {
  test('an update merges changed columns only, and never overwrites the id', () => {
    const patches: readonly RowPatch[] = [
      { op: 'update', id: 'p1', row: { likes: 9, id: 'nope' }, lsn: 'a' },
    ];
    expect(applyPatches(rows, patches)).toEqual([
      { id: 'p1', likes: 9 },
      { id: 'p2', likes: 2 },
    ]);
  });

  test('a delete removes the row; an insert appends unless it names an index', () => {
    const patches: readonly RowPatch[] = [
      { op: 'delete', id: 'p1', row: null, lsn: 'a' },
      { op: 'insert', id: 'p3', row: { id: 'p3', likes: 3 }, lsn: 'a' },
      { op: 'insert', id: 'p0', row: { id: 'p0', likes: 0 }, lsn: 'a', index: 0 },
    ];
    expect(ids(applyPatches(rows, patches))).toEqual(['p0', 'p2', 'p3']);
  });

  test('a row the set already holds keeps its position, whatever index the patch carries', () => {
    const patches: readonly RowPatch[] = [
      { op: 'update', id: 'p2', row: { likes: 5 }, lsn: 'a', index: 0 },
    ];
    expect(ids(applyPatches(rows, patches))).toEqual(['p1', 'p2']);
  });

  test('a delete for a row nobody holds changes nothing', () => {
    expect(applyPatches(rows, [{ op: 'delete', id: 'ghost', row: null, lsn: 'a' }])).toEqual(rows);
  });

  test('the two folds agree: the array form is the id form plus the values', () => {
    const patches: readonly RowPatch[] = [
      { op: 'insert', id: 'p0', row: { id: 'p0', likes: 0 }, lsn: 'a', index: 0 },
      { op: 'update', id: 'p1', row: { likes: 4 }, lsn: 'a' },
      { op: 'delete', id: 'p2', row: null, lsn: 'a' },
    ];
    expect(ids(applyPatches(rows, patches))).toEqual([...orderAfterPatches(ids(rows), patches)]);
  });
});
