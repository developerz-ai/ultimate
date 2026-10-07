// The one page shape: `nextCursor` is null exactly when `hasMore` is false, and `pageOf` is the
// only way to build one — so a consumer's `while (page.hasMore)` and `while (page.nextCursor)`
// are the same loop.
import { describe, expect, test } from 'bun:test';
import type { Page } from './cursor-page';
import { pageOf } from './cursor-page';

describe('pageOf', () => {
  test('a cursor means another page follows', () => {
    const page = pageOf([1, 2], 'c2');
    expect(page).toEqual({ rows: [1, 2], nextCursor: 'c2', hasMore: true });
  });

  test('no cursor means this is the last page', () => {
    const page = pageOf([3], null);
    expect(page).toEqual({ rows: [3], nextCursor: null, hasMore: false });
  });

  test('an empty page is the last page', () => {
    expect(pageOf([], null)).toEqual({ rows: [], nextCursor: null, hasMore: false });
  });

  test('an empty cursor is no cursor: a page that says "more" must say where', () => {
    expect(pageOf([1], '')).toEqual({ rows: [1], nextCursor: null, hasMore: false });
  });

  test('a `while (page.hasMore)` loop stops on the last page, with no extra fetch', () => {
    const pages: readonly Page<number>[] = [pageOf([1], 'a'), pageOf([2], 'b'), pageOf([3], null)];
    const fetched: (string | null)[] = [null];
    let index = 0;
    let page = pages[index] as Page<number>;
    // `cursor-page-pins.ts` holds the narrowing inside `tsc -b`; this is the loop's runtime half.
    while (page.hasMore) {
      const after = page.nextCursor;
      fetched.push(after);
      index += 1;
      page = pages[index] as Page<number>;
    }
    // Three pages, three fetches: the loop stopped on the last page without asking for a fourth.
    expect(fetched).toEqual([null, 'a', 'b']);
  });
});
