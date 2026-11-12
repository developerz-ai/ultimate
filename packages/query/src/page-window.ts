// Single responsibility: read the rows ONE page serves, and where the next page resumes. The
// position and `hasMore` come from what the SOURCE read — never from what a per-row rule left of
// it, or a rule stricter than its scope ended the listing at the first row it dropped.
import { kindsOf } from './column-kinds';
import type { RuleCheck } from './scope-compose';
import { ruleCheckOf } from './scope-compose';
import type { QueryShape, SeekKey } from './shape';
import { compareRows, seekKeyOf, totalOrder } from './shape';
import type { SqlSource } from './source';
import { isAfterKey } from './source';

/**
 * Further windows a rule-checked page reads when the rule dropped rows, after the first. Bounded:
 * a viewer who may see one row in a million must not turn one page into a table scan. A page the
 * bound cuts short still carries a cursor at the last row READ, so nothing past it is stranded —
 * the client asks again and the scan resumes there. Work per page: at most
 * `(RULE_REFILL_WINDOWS + 1) × (first + 1)` source rows.
 */
export const RULE_REFILL_WINDOWS = 4;

export interface PageWindow {
  /** What the page serves: at most `first` rows, every one admitted. */
  readonly rows: readonly object[];
  /** The row the next page resumes after — the last SOURCE row consumed, admitted or not. */
  readonly position: object | undefined;
  /** Source rows up to and including `position`: what a declared `.limit()` counts as served. */
  readonly consumed: number;
  /** Another page follows. A cursor is minted exactly when this is true. */
  readonly more: boolean;
}

/** The page window over `base`, resuming strictly after `after`, within `left` rows of a limit. */
export function pageWindow(
  base: SqlSource<object>,
  after: SeekKey | null,
  first: number,
  left: number,
  shape: QueryShape,
): Promise<PageWindow> {
  const check = ruleCheckOf(base);
  return check === null
    ? plainWindow(base, after, first, left, shape)
    : refilledWindow(check, after, first, left, shape);
}

/** One read of `first + 1` rows: the extra row's presence *is* `hasMore`, with no count query. */
async function plainWindow(
  base: SqlSource<object>,
  after: SeekKey | null,
  first: number,
  left: number,
  shape: QueryShape,
): Promise<PageWindow> {
  const window = Math.min(left, first + 1);
  const source = base.seek === undefined ? base : base.seek(after, window);
  const executed = await source.execute();
  const scoped =
    base.seek === undefined ? inTotalOrder(executed, after, shape).slice(0, window) : executed;
  const rows = scoped.slice(0, first);
  return {
    rows,
    position: rows[rows.length - 1],
    consumed: rows.length,
    more: scoped.length > first,
  };
}

/**
 * Windows of unchecked rows until `first + 1` are admitted, the source (or its limit) runs out, or
 * the refill bound is reached. Every row read is consumed in order, so the cursor lands on a real
 * source position: a dropped row before it is dropped again on any re-read, never skipped past an
 * admitted one.
 */
async function refilledWindow(
  check: RuleCheck,
  after: SeekKey | null,
  first: number,
  left: number,
  shape: QueryShape,
): Promise<PageWindow> {
  const read: object[] = [];
  const admitted: number[] = [];
  let from = after;
  let budget = left;
  for (let pass = 0; pass <= RULE_REFILL_WINDOWS; pass += 1) {
    const window = Math.min(budget, first + 1);
    const rows = await check.seekUnchecked(from, window).execute();
    for (const row of rows) {
      read.push(row);
      if (check.admits(row)) admitted.push(read.length - 1);
    }
    budget -= rows.length;
    const tail = rows[rows.length - 1];
    // Ran out: the source had no more, or the declared limit has none left to give.
    if (rows.length < window || budget <= 0 || tail === undefined) {
      return served(read, admitted, first, false);
    }
    if (admitted.length > first) break;
    from = seekKeyOf(tail, shape);
  }
  return served(read, admitted, first, true);
}

/** The page over what a refill read; `unread` says the source may hold rows past the last read. */
function served(
  read: readonly object[],
  admitted: readonly number[],
  first: number,
  unread: boolean,
): PageWindow {
  const rows = admitted.slice(0, first).map((index) => read[index] as object);
  // An admitted row past the page: the page is full, and it ends at its own last row.
  const cut = admitted[first - 1];
  if (admitted.length > first && cut !== undefined) {
    return { rows, position: read[cut], consumed: cut + 1, more: true };
  }
  // Short. Resume after the last row READ — the rows the rule dropped are behind it, not lost.
  if (unread) return { rows, position: read[read.length - 1], consumed: read.length, more: true };
  return { rows, position: rows[rows.length - 1], consumed: read.length, more: false };
}

/**
 * The cursor names a POSITION in the ordering, so the fallback filters by that position — the
 * same comparison `Builder.seek()` pushes into SQL. Locating the cursor's row by id instead
 * looks equivalent and is not: the row can be gone by the next request, `findIndex` answers -1,
 * and every row from the top comes back as page two. Under a delete between two pages that is a
 * silent restart, which is the failure keyset pagination exists to make impossible.
 *
 * **It SORTS first, and that half was missing.** `isAfterKey` breaks a tie on the declared keys by
 * `id` — it has to, or the cut is not a position at all — while a foreign `SqlSource` ordered its
 * rows by the DECLARED keys alone. So a tie group arrived in an order the cut does not describe,
 * and the cut fell in the middle of it: page one served `a(10), d(20)`, the cursor named `(20, d)`,
 * and rows `b(20)` and `c(20)` matched no page in the listing. Rows VANISH — silently, and only
 * where two rows share a sort key.
 *
 * `Builder` has always done this: `execute()` sorts by `servedOrder()`, which appends `id` once a
 * read asked to be seekable. This is that rule applied to the path a `Builder` does not take, and
 * it is the ordering the cursor arithmetic already assumes on both sides. Reachable only for a
 * hand-written `SqlSource` with no `seek()` — the branch this whole function exists for.
 */
function inTotalOrder(
  rows: readonly object[],
  after: SeekKey | null,
  shape: QueryShape,
): readonly object[] {
  const keys = totalOrder(shape.orderBy);
  const kindOf = kindsOf(shape.entity);
  const ordered = [...rows].sort((left, right) => compareRows(left, right, keys, kindOf));
  if (after === null) return ordered;
  return ordered.filter((row) => isAfterKey(row, after, shape.orderBy, kindOf));
}
