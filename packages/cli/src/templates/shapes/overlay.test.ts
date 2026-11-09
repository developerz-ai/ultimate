// The overlay mechanics: an edit whose anchor moved, and a catalog key the base no longer writes,
// are refused rather than skipped — a stale shape fails here, never in a stranger's first run.

import { describe, expect, test } from 'bun:test';
import { names } from '../naming';
import { applyEdit, applyOverlay, dropCatalogKeys, type ShapeOverlay } from './overlay';

const edit = (find: string) => ({ path: 'a.ts', find, replace: 'X' });

const overlay = (over: Partial<ShapeOverlay>): ShapeOverlay => ({
  example: false,
  drop: [],
  dropKeys: [],
  edits: () => [],
  files: () => [],
  ...over,
});

describe('unit · shape overlays', () => {
  test('an edit replaces its one anchor', () => {
    expect(applyEdit('a b c', edit('b'))).toBe('a X c');
  });

  test('an anchor that is missing or doubled is refused by code', () => {
    expect(() => applyEdit('a', edit('b'))).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
    expect(() => applyEdit('b b', edit('b'))).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });

  test('dropping a catalog key removes its subtree; an absent one is refused', () => {
    const catalog = JSON.stringify({ a: { b: 'x', c: 'y' }, d: 'z' });
    expect(JSON.parse(dropCatalogKeys(catalog, ['a.b', 'd']))).toEqual({ a: { c: 'y' } });
    expect(() => dropCatalogKeys(catalog, ['a.q'])).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });

  test('drop, replace and add, in the base order, with added files last', () => {
    const base = [
      { path: 'keep.ts', contents: 'k' },
      { path: 'gone/one.ts', contents: 'g' },
      { path: 'swap.ts', contents: 'old' },
    ];
    const out = applyOverlay(
      base,
      overlay({
        drop: ['gone/'],
        files: () => [
          { path: 'swap.ts', contents: 'new' },
          { path: 'more.ts', contents: 'm' },
        ],
      }),
      names('probe'),
    );
    expect(out.map((file) => [file.path, file.contents])).toEqual([
      ['keep.ts', 'k'],
      ['swap.ts', 'new'],
      ['more.ts', 'm'],
    ]);
  });

  test('an edit of a file the base does not write is refused', () => {
    const stale = overlay({ edits: () => [{ path: 'nowhere.ts', find: 'a', replace: 'b' }] });
    expect(() => applyOverlay([], stale, names('probe'))).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });
});
