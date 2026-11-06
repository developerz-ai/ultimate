// Reordering's rules with plain numbers: positions, the preview, keyboard steps across groups under
// both directions, pointer targets, and a drop `canDrop` refuses keeping its origin.

import { describe, expect, test } from 'bun:test';
import {
  dropMove,
  moveBetween,
  pointerGroup,
  pointerIndex,
  type SortGroup,
  sortKeyStep,
  sortPositions,
  sortSpeech,
} from './sort-view';

const board: readonly SortGroup<string>[] = [
  { id: 'todo', items: ['a', 'b', 'c'] },
  { id: 'doing', items: ['d'] },
  { id: 'done', items: [] },
];
const key = (item: string): string => item;

describe('sortPositions', () => {
  test('names every item by group and index', () => {
    const at = sortPositions(board, key);
    expect(at.get('c')).toEqual({ group: 0, index: 2 });
    expect(at.get('d')).toEqual({ group: 1, index: 0 });
  });

  test('a key shared across two groups is X_UI_INVALID_VALUE naming it', () => {
    const twice = [
      { id: 'x', items: ['a'] },
      { id: 'y', items: ['a'] },
    ];
    expect(() => sortPositions(twice, key)).toThrow(/X_UI_INVALID_VALUE|two items/);
    try {
      sortPositions(twice, key);
      expect.unreachable('a duplicate key across groups was accepted');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_UI_INVALID_VALUE');
      expect(String((error as { cause?: unknown }).cause)).toContain('"a"');
    }
  });
});

describe('moveBetween', () => {
  test('within a group, the index is the final one', () => {
    const moved = moveBetween(board, { group: 0, index: 0 }, { group: 0, index: 2 });
    expect(moved[0]?.items).toEqual(['b', 'c', 'a']);
  });

  test('across groups the item leaves one and lands in the other', () => {
    const moved = moveBetween(board, { group: 0, index: 1 }, { group: 2, index: 0 });
    expect(moved[0]?.items).toEqual(['a', 'c']);
    expect(moved[2]?.items).toEqual(['b']);
  });

  test('the input is never mutated: a preview is not truth', () => {
    moveBetween(board, { group: 0, index: 0 }, { group: 1, index: 1 });
    expect(board[0]?.items).toEqual(['a', 'b', 'c']);
  });
});

describe('sortKeyStep', () => {
  test('ArrowDown and ArrowUp walk the group and stop at its ends', () => {
    expect(sortKeyStep(board, { group: 0, index: 0 }, 'ArrowDown', 'ltr')).toEqual({
      group: 0,
      index: 1,
    });
    expect(sortKeyStep(board, { group: 0, index: 0 }, 'ArrowUp', 'ltr')).toBeNull();
    expect(sortKeyStep(board, { group: 0, index: 2 }, 'ArrowDown', 'ltr')).toBeNull();
    expect(sortKeyStep(board, { group: 0, index: 2 }, 'Home', 'ltr')).toEqual({
      group: 0,
      index: 0,
    });
  });

  test('ArrowRight is the next column in ltr and the previous one in rtl', () => {
    expect(sortKeyStep(board, { group: 1, index: 0 }, 'ArrowRight', 'ltr')).toEqual({
      group: 2,
      index: 0,
    });
    expect(sortKeyStep(board, { group: 1, index: 0 }, 'ArrowRight', 'rtl')).toEqual({
      group: 0,
      index: 0,
    });
    expect(sortKeyStep(board, { group: 0, index: 0 }, 'ArrowLeft', 'ltr')).toBeNull();
  });

  test('across columns the index clamps to the destination length', () => {
    expect(sortKeyStep(board, { group: 0, index: 2 }, 'ArrowRight', 'ltr')).toEqual({
      group: 1,
      index: 1,
    });
  });

  test('a column canDrop refuses is skipped, not landed in', () => {
    const step = sortKeyStep(
      board,
      { group: 0, index: 0 },
      'ArrowRight',
      'ltr',
      (g) => g !== 'doing',
    );
    expect(step).toEqual({ group: 2, index: 0 });
  });
});

describe('pointer targets', () => {
  const spans = [
    { start: 0, size: 40 },
    { start: 40, size: 40 },
  ];
  test('past an item midpoint is after it', () => {
    expect(pointerIndex(10, spans)).toBe(0);
    expect(pointerIndex(21, spans)).toBe(1);
    expect(pointerIndex(79, spans)).toBe(2);
  });

  test('a pointer between columns lands in the nearest, side by side or stacked', () => {
    const row = (start: number) => ({
      inline: { start, size: 100 },
      block: { start: 0, size: 300 },
    });
    expect(pointerGroup({ x: 50, y: 10 }, [row(0), row(120)])).toBe(0);
    expect(pointerGroup({ x: 117, y: 10 }, [row(0), row(120)])).toBe(1);
    expect(pointerGroup({ x: 500, y: 900 }, [row(0), row(120)])).toBe(1);
    const stacked = (start: number) => ({
      inline: { start: 0, size: 300 },
      block: { start, size: 100 },
    });
    expect(pointerGroup({ x: 150, y: 150 }, [stacked(0), stacked(120), stacked(240)])).toBe(1);
  });
});

describe('dropMove', () => {
  test('a move names the item, both groups and the final index', () => {
    expect(dropMove(board, 'b', 'b', { group: 0, index: 1 }, { group: 1, index: 0 })).toEqual({
      id: 'b',
      fromGroup: 'todo',
      toGroup: 'doing',
      toIndex: 0,
    });
  });

  test('back where it started requests nothing', () => {
    expect(dropMove(board, 'a', 'a', { group: 0, index: 0 }, { group: 0, index: 0 })).toBeNull();
  });

  test('canDrop false keeps the origin and requests nothing', () => {
    const refuse = (): boolean => false;
    expect(
      dropMove(board, 'a', 'a', { group: 0, index: 0 }, { group: 2, index: 0 }, refuse),
    ).toBeNull();
    // A reorder inside its own group is never a canDrop question.
    expect(
      dropMove(board, 'a', 'a', { group: 0, index: 0 }, { group: 0, index: 1 }, refuse),
    ).not.toBeNull();
  });
});

test('sortSpeech gives a 1-based position, the size and the group name', () => {
  expect(sortSpeech(board, { group: 0, index: 1 }, (id) => id.toUpperCase())).toEqual({
    position: 2,
    total: 3,
    group: 'TODO',
  });
});
