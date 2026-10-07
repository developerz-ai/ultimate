// The framework's ONE page shape — an entity `findMany`, a query `.page()`, the `?_first` HTTP
// envelope and the typed client all answer it. Tier 0 so the repo (tier 2) and the read (tier 3)
// share it rather than each declaring a page whose `nextCursor` meant something different.

/**
 * One page of a cursor-paginated listing, with ONE meaning: `nextCursor` is the cursor for the
 * next page, and `null` exactly when `hasMore` is false.
 *
 * A union and not an interface, so the two facts cannot disagree in any value that typechecks:
 * `{ nextCursor: null, hasMore: true }` is a build error, and `if (page.hasMore)` narrows
 * `nextCursor` to `string`. `while (page.hasMore)` and `while (page.nextCursor !== null)` are the
 * same loop and both stop on the last page, with no extra round trip to learn it was the last.
 *
 * Before 25.0.0 there were two pages: entity's own `Page` (null = last page, no `hasMore`) and query's
 * `Page` (null only on an EMPTY page, `hasMore` carried "last") — so a `while (page.nextCursor)`
 * loop was right on one and fetched an empty page past the end of the other.
 */
export type Page<Row> =
  | {
      readonly rows: readonly Row[];
      /** Pass back as `cursor` (a repo) or `after` (a read) — `_after` on the wire. */
      readonly nextCursor: string;
      readonly hasMore: true;
    }
  | {
      readonly rows: readonly Row[];
      readonly nextCursor: null;
      readonly hasMore: false;
    };

/**
 * The only constructor: `hasMore` is DERIVED from the cursor, never passed beside it, so a
 * producer cannot answer "more" without saying where. A producer that learned "no more" passes
 * `null` — the cursor it could have minted for its last row is not a next page. An empty string is
 * no cursor (a falsy cursor would end a `while (page.nextCursor)` loop that `hasMore` continues).
 */
export function pageOf<Row>(rows: readonly Row[], nextCursor: string | null): Page<Row> {
  return nextCursor === null || nextCursor === ''
    ? { rows, nextCursor: null, hasMore: false }
    : { rows, nextCursor, hasMore: true };
}
