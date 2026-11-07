// A timeline's day headers: consecutive items under one label, in the order given. Pure, so the
// grouping is testable with no renderer. Labels arrive formatted — the zone a "day" is read in is
// the caller's by the date rule, and this module never sees an instant.

export interface TimelineGroup<T> {
  /** The header above the run; `undefined` when the caller groups nothing. */
  readonly label: string | undefined;
  readonly items: readonly T[];
}

/**
 * Runs of items whose `groupBy` answers the same label. Consecutive, never sorted: a timeline is
 * already in the order it is read, and a label seen again after another is a second header — the
 * honest answer for a list the caller ordered by something other than the day.
 */
export function timelineGroups<T>(
  items: readonly T[],
  groupBy?: ((item: T) => string) | undefined,
): readonly TimelineGroup<T>[] {
  if (groupBy === undefined) return items.length === 0 ? [] : [{ label: undefined, items }];
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = groupBy(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
