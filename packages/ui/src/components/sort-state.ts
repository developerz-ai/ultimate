// Pure sort-state reducer shared by Table and DataTable. Kept out of the .tsx so
// the ordering rules are testable without a renderer.

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

/**
 * Click cycle on a column header: unsorted -> asc -> desc -> unsorted.
 * Clicking a different column always starts that column at `asc`.
 */
export function nextSortState(current: SortState | undefined, key: string): SortState | undefined {
  if (current === undefined || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return undefined;
}

/** The value for `aria-sort` on a column header. */
export function ariaSortFor(
  current: SortState | undefined,
  key: string,
): 'ascending' | 'descending' | 'none' {
  if (current === undefined || current.key !== key) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}
