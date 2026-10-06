/**
 * The holiday lookup behind `isHoliday`: one `Set` per holiday LIST, built on first use. A business
 * calendar is asked about every day it walks, and `includes` on a long closure list made each walk
 * quadratic in the list.
 */

/**
 * Keyed on the list itself, in a `WeakMap`: the cache is bounded by the lists still alive, with no
 * cap to tune and no entry outliving its calendar, and a calendar whose `holidays` is REPLACED
 * misses at once.
 *
 * The list is FROZEN when its set is built, so the two can never disagree. `readonly` is only a
 * type, and an in-place edit (a push, or an element overwritten at the same length) would otherwise
 * be answered from the stale set. Detecting one costs a pass over the list per lookup — the cost
 * the set exists to remove — so the edit is made impossible instead: in strict code (every ES
 * module) it throws a `TypeError` at the line that tried it. Freezing an already-frozen list, or one
 * `plainDateRange` returned, changes nothing.
 */
const memo = new WeakMap<readonly string[], ReadonlySet<string>>();

const EMPTY: ReadonlySet<string> = new Set<string>();

/** The holiday dates of a calendar, as a set — the same set for the same list, always. */
export function holidaySet(holidays: readonly string[] | undefined): ReadonlySet<string> {
  if (holidays === undefined) return EMPTY;
  const hit = memo.get(holidays);
  if (hit !== undefined) return hit;
  Object.freeze(holidays);
  const set = new Set(holidays);
  memo.set(holidays, set);
  return set;
}
