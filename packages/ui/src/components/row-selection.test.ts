// The selection rules a table and a board share: what a click, a Shift range, the tick-all box and
// each key ask for, and that a row which left the list — or a filter that changed — leaves the
// selection. "All matching" is the filter, so no test here ever sees an id the page did not show.

import { describe, expect, test } from 'bun:test';
import {
  isSelected,
  NO_SELECTION,
  pageState,
  pruneSelection,
  type RowSelection,
  selectedCount,
  selectionIntent,
  selectRange,
  toggleKey,
  togglePage,
} from './row-selection';

const PAGE = ['a', 'b', 'c', 'd', 'e'];
const keys = (...list: string[]): RowSelection => ({ kind: 'keys', keys: list });
const ALL: RowSelection = { kind: 'matching', filter: 'status=open' };
const press = (
  key: string,
  mods: Partial<Record<'shift' | 'ctrl' | 'meta' | 'alt', boolean>> = {},
) =>
  selectionIntent({
    key,
    shiftKey: mods.shift === true,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    altKey: mods.alt === true,
  });

describe('toggling one row', () => {
  test('ticks, then unticks, keeping the rest in order', () => {
    const once = toggleKey(keys('c'), PAGE, 'a');
    expect(once).toEqual(keys('c', 'a'));
    expect(toggleKey(once, PAGE, 'c')).toEqual(keys('a'));
  });

  test('unticking one row of "all matching" keeps the rest of the PAGE, never the filter', () => {
    expect(toggleKey(ALL, PAGE, 'b')).toEqual(keys('a', 'c', 'd', 'e'));
  });
});

describe('a Shift range', () => {
  test('sets every row between the anchor and the target, both ways', () => {
    expect(selectRange(NO_SELECTION, PAGE, 'b', 'd', true)).toEqual(keys('b', 'c', 'd'));
    expect(selectRange(NO_SELECTION, PAGE, 'd', 'b', true)).toEqual(keys('b', 'c', 'd'));
  });

  test('a range to an unticked target unticks the span', () => {
    expect(selectRange(keys('a', 'b', 'c', 'd'), PAGE, 'a', 'c', false)).toEqual(keys('d'));
  });

  test('an anchor that left the page ranges from the target alone', () => {
    expect(selectRange(NO_SELECTION, PAGE, 'gone', 'c', true)).toEqual(keys('c'));
  });

  test('a target not on the page changes nothing', () => {
    const before = keys('a');
    expect(selectRange(before, PAGE, 'a', 'gone', true)).toBe(before);
  });
});

describe('the tick-all box', () => {
  test('reads none, some and all over the visible rows only', () => {
    expect(pageState(NO_SELECTION, PAGE)).toBe('none');
    expect(pageState(keys('a', 'elsewhere'), PAGE)).toBe('some');
    expect(pageState(keys(...PAGE), PAGE)).toBe('all');
    expect(pageState(ALL, PAGE)).toBe('all');
    expect(pageState(keys('a'), [])).toBe('none');
  });

  test('some becomes all, all becomes none', () => {
    expect(togglePage(keys('b'), PAGE)).toEqual(keys('b', 'a', 'c', 'd', 'e'));
    expect(togglePage(keys(...PAGE), PAGE)).toEqual(keys());
  });
});

describe('a row that left the list leaves the selection', () => {
  test('a vanished key is dropped', () => {
    expect(pruneSelection(keys('a', 'z', 'c'), PAGE, undefined)).toEqual(keys('a', 'c'));
  });

  test('nothing to drop answers the SAME object, so the caller writes nothing', () => {
    const before = keys('a', 'c');
    expect(pruneSelection(before, PAGE, undefined)).toBe(before);
    expect(pruneSelection(ALL, PAGE, 'status=open')).toBe(ALL);
  });

  test('"all matching" under another filter is no selection at all', () => {
    expect(pruneSelection(ALL, PAGE, 'status=closed')).toBe(NO_SELECTION);
    expect(pruneSelection(ALL, PAGE, undefined)).toBe(NO_SELECTION);
  });
});

describe('counting', () => {
  test('"all matching" counts the filter’s total, keys count themselves', () => {
    expect(selectedCount(ALL, 1234)).toBe(1234);
    expect(selectedCount(keys('a', 'b'), 1234)).toBe(2);
    expect(isSelected(ALL, 'never-seen')).toBe(true);
    expect(isSelected(keys('a'), 'b')).toBe(false);
  });
});

describe('the keyboard, as the ARIA grid pattern', () => {
  test('Down and Up move, Shift with them extends', () => {
    expect(press('ArrowDown')).toBe('next');
    expect(press('ArrowUp')).toBe('prev');
    expect(press('ArrowDown', { shift: true })).toBe('extend-next');
    expect(press('ArrowUp', { shift: true })).toBe('extend-prev');
  });

  test('Ctrl+A and Cmd+A select the page, Escape clears', () => {
    expect(press('a', { ctrl: true })).toBe('all');
    expect(press('A', { meta: true })).toBe('all');
    expect(press('Escape')).toBe('clear');
  });

  test('Space stays the checkbox’s own, and Alt stays the sort handle’s', () => {
    expect(press(' ')).toBeNull();
    expect(press('ArrowDown', { alt: true })).toBeNull();
    expect(press('c', { ctrl: true })).toBeNull();
  });
});
