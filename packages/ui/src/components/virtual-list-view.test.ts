import { describe, expect, test } from 'bun:test';
import { UiError } from '../errors';
import {
  AT_END_ENTER_PX,
  AT_END_LEAVE_PX,
  anchorAt,
  anchorCorrection,
  anchoredScrollTop,
  assertUniqueKeys,
  endDistance,
  nextAtEnd,
  pruneHeights,
  rowOffsets,
  visibleRange,
} from './virtual-list-view';

const even = (count: number, height = 10): readonly number[] =>
  rowOffsets(Array.from({ length: count }, () => height));

describe('virtual list arithmetic', () => {
  test('offsets are each row’s top, the total last', () => {
    expect(rowOffsets([10, 20, 5])).toEqual([0, 10, 30, 35]);
    expect(rowOffsets([])).toEqual([0]);
  });

  test('a bounded box renders the rows it shows plus overscan, never the rest', () => {
    const offsets = even(10_000);
    expect(visibleRange(offsets, 0, 100, 4)).toEqual({ start: 0, end: 14 });
    expect(visibleRange(offsets, 5000, 100, 4)).toEqual({ start: 496, end: 514 });
    const range = visibleRange(offsets, 99_950, 100, 4);
    expect(range.end).toBe(10_000);
    expect(range.end - range.start).toBeLessThan(100);
  });

  test('a zero-height box, or one holding the whole list, renders every row', () => {
    expect(visibleRange(even(50), 0, 0, 4)).toEqual({ start: 0, end: 50 });
    expect(visibleRange(even(5), 0, 500, 4)).toEqual({ start: 0, end: 5 });
    expect(visibleRange(even(0), 0, 100, 4)).toEqual({ start: 0, end: 0 });
  });

  test('a row above resizes: the anchored row’s offset is compensated by the difference', () => {
    const keys = ['a', 'b', 'c', 'd'];
    const before = rowOffsets([10, 10, 10, 10]);
    const anchor = anchorAt(keys, before, 23) ?? expect.unreachable('no anchor');
    expect(anchor).toEqual({ key: 'c', within: 3 });
    // `a` measured 40 tall instead of the 10 estimated: `c` moved down 30, and so must the box.
    expect(anchoredScrollTop(anchor, keys, rowOffsets([40, 10, 10, 10]))).toBe(53);
  });

  test('a prepend keeps the first visible row where it was', () => {
    const keys = ['c', 'd', 'e'];
    const anchor = anchorAt(keys, rowOffsets([10, 10, 10]), 10) ?? expect.unreachable('no anchor');
    expect(anchor.key).toBe('d');
    const after = ['a', 'b', ...keys];
    expect(anchoredScrollTop(anchor, after, rowOffsets([15, 15, 10, 10, 10]))).toBe(40);
  });

  test('the DOM correction puts the anchored row back where the reader saw it', () => {
    // The box's edge was 5px into row `r`; a prepend drew `r` 195px BELOW the edge: scroll 200 down.
    expect(anchorCorrection({ key: 'r', within: 5 }, 195)).toBe(200);
    // Already in place: nothing to do.
    expect(anchorCorrection({ key: 'r', within: 5 }, -5)).toBe(0);
  });

  test('an anchored row that left the list has no place to keep', () => {
    expect(anchoredScrollTop({ key: 'gone', within: 0 }, ['a'], [0, 10])).toBeUndefined();
    expect(anchorAt([], [0], 0)).toBeUndefined();
  });

  test('atEnd has hysteresis: entered close to the end, left only well away from it', () => {
    expect(endDistance(900, 100, 1000)).toBe(0);
    expect(nextAtEnd(false, AT_END_ENTER_PX)).toBe(true);
    expect(nextAtEnd(false, AT_END_ENTER_PX + 1)).toBe(false);
    // A row measured a little taller below the reader must not unpin them.
    expect(nextAtEnd(true, AT_END_LEAVE_PX)).toBe(true);
    expect(nextAtEnd(true, AT_END_LEAVE_PX + 1)).toBe(false);
  });

  test('two items under one key is X_UI_INVALID_VALUE naming the key', () => {
    expect(() => assertUniqueKeys(['a', 'b'])).not.toThrow();
    try {
      assertUniqueKeys(['a', 'b', 'a']);
      expect.unreachable('a duplicate key was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe('X_UI_INVALID_VALUE');
      expect((error as UiError).message).toContain('"a"');
    }
  });
});

describe('pruneHeights', () => {
  test('a measured height outlives its row only while the row is in the list', () => {
    const heights = new Map([
      ['a', 10],
      ['b', 20],
      ['c', 30],
    ]);
    pruneHeights(
      heights,
      new Map([
        ['b', 0],
        ['d', 1],
      ]),
    );
    expect([...heights]).toEqual([['b', 20]]);
  });
});
