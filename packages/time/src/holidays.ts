/**
 * The holiday lookup behind `isHoliday`: one `Set` per holiday LIST, built on first use. A business
 * calendar is asked about every day it walks, and `includes` on a long closure list made each walk
 * quadratic in the list.
 */

/**
 * Keyed on the list itself, in a `WeakMap`, so the cache is bounded by the lists still alive — no
 * cap to tune, no entry outliving the calendar that owns it — and a calendar whose `holidays` is
 * REPLACED misses at once. The length rides along because the type's `readonly` is only a type: a
 * list pushed to in place is rebuilt rather than answered stale. An element overwritten in place at
 * the same length is the one edit this cannot see — replace the list instead.
 */
const memo = new WeakMap<
  readonly string[],
  { readonly length: number; readonly set: Set<string> }
>();

const EMPTY: ReadonlySet<string> = new Set<string>();

/** The holiday dates of a calendar, as a set — the same set for the same list, until it changes. */
export function holidaySet(holidays: readonly string[] | undefined): ReadonlySet<string> {
  if (holidays === undefined) return EMPTY;
  const hit = memo.get(holidays);
  if (hit !== undefined && hit.length === holidays.length) return hit.set;
  const set = new Set(holidays);
  memo.set(holidays, { length: holidays.length, set });
  return set;
}
