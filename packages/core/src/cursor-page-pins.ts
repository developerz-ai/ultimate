// Compile-time pins for the one page shape (`cursor-page.ts`): the two facts cannot disagree in a
// value that typechecks, and `hasMore` narrows `nextCursor`. Source, not a `.test.ts`: tsconfig
// excludes tests, so a `@ts-expect-error` there asserts nothing. Emits nothing anybody imports.

import type { Page } from './cursor-page';

/** Fails to compile when `T` is anything but `true`. */
type Assert<T extends true> = T;

// @ts-expect-error — `hasMore: true` with no cursor is not a page: "more" must say where.
export const _MoreWithoutCursor: Page<number> = { rows: [], nextCursor: null, hasMore: true };

// @ts-expect-error — a cursor on the last page is not a page: it would continue a `while` loop.
export const _LastWithCursor: Page<number> = { rows: [], nextCursor: 'c', hasMore: false };

/** On the `hasMore` side `nextCursor` is a `string` — a loop passes it on with no `?? ''`. */
export type _HasMoreNarrowsCursor = Assert<
  Extract<Page<number>, { readonly hasMore: true }>['nextCursor'] extends string ? true : false
>;

/** On the last page it is exactly `null` — `while (page.nextCursor !== null)` is the same loop. */
export type _LastPageHasNoCursor = Assert<
  Extract<Page<number>, { readonly hasMore: false }>['nextCursor'] extends null ? true : false
>;
