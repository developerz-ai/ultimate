// The rules of a multi-row selection, pure: toggle, a Shift range, the whole page, the keyboard's
// intent, and pruning a row that left the list. `DataTable` and `Board` share them, so a table and
// a board cannot disagree about what Shift+click selects.
//
// "Every row the filter matches" is its own kind and carries the FILTER, never a list of ids from
// the page: a row the reader never saw is named by the query the server re-runs, not by the client.

/** Either the keys ticked on screen, or every row the list's filter matches, across pages. */
export type RowSelection =
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'matching'; readonly filter: string };

/** Nothing selected. */
export const NO_SELECTION: RowSelection = { kind: 'keys', keys: [] };

/** The page's tick-all box: off, mixed, or on. */
export type PageSelectionState = 'none' | 'some' | 'all';

export function isSelected(selection: RowSelection, key: string): boolean {
  return selection.kind === 'matching' || selection.keys.includes(key);
}

/** The keys a `matching` selection stands for on THIS page — every one of them. */
function keysOf(selection: RowSelection, visible: readonly string[]): readonly string[] {
  return selection.kind === 'matching' ? visible : selection.keys;
}

/** Sets each of `keys` on or off, keeping the rest of the selection in its order. */
function setKeys(
  selection: RowSelection,
  visible: readonly string[],
  keys: readonly string[],
  on: boolean,
): RowSelection {
  const before = keysOf(selection, visible);
  if (!on) {
    const drop = new Set(keys);
    return { kind: 'keys', keys: before.filter((key) => !drop.has(key)) };
  }
  const have = new Set(before);
  return { kind: 'keys', keys: [...before, ...keys.filter((key) => !have.has(key))] };
}

/** One row ticked or unticked. Unticking one row of a `matching` selection keeps the rest of the page. */
export function toggleKey(
  selection: RowSelection,
  visible: readonly string[],
  key: string,
): RowSelection {
  return setKeys(selection, visible, [key], !isSelected(selection, key));
}

/**
 * Shift+click and Shift+Arrow: every visible row from `anchor` to `target`, both ends included, set
 * to `on`. An anchor no longer on the page ranges from the target alone.
 */
export function selectRange(
  selection: RowSelection,
  visible: readonly string[],
  anchor: string,
  target: string,
  on: boolean,
): RowSelection {
  const to = visible.indexOf(target);
  if (to === -1) return selection;
  const found = visible.indexOf(anchor);
  const from = found === -1 ? to : found;
  const span = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
  return setKeys(selection, visible, span, on);
}

/** The tick-all box's state over the rows on this page. */
export function pageState(selection: RowSelection, visible: readonly string[]): PageSelectionState {
  if (visible.length === 0) return 'none';
  const ticked = visible.filter((key) => isSelected(selection, key)).length;
  if (ticked === 0) return 'none';
  return ticked === visible.length ? 'all' : 'some';
}

/** The tick-all box: a page not wholly selected becomes wholly selected, else none of it is. */
export function togglePage(selection: RowSelection, visible: readonly string[]): RowSelection {
  return setKeys(selection, visible, visible, pageState(selection, visible) !== 'all');
}

/**
 * A key that left the list leaves the selection, and a `matching` selection whose filter is no
 * longer the list's is no selection at all. Answers the SAME object when nothing changed, so a
 * caller can compare by identity and skip a write.
 */
export function pruneSelection(
  selection: RowSelection,
  visible: readonly string[],
  filter: string | undefined,
): RowSelection {
  if (selection.kind === 'matching') return selection.filter === filter ? selection : NO_SELECTION;
  const present = new Set(visible);
  const kept = selection.keys.filter((key) => present.has(key));
  return kept.length === selection.keys.length ? selection : { kind: 'keys', keys: kept };
}

/** How many rows the selection names: the filter's total for `matching`, else the ticked keys. */
export function selectedCount(selection: RowSelection, matchingCount: number): number {
  return selection.kind === 'matching' ? matchingCount : selection.keys.length;
}

/** What a key press on a row's box asks for; `null` leaves the event to the browser. */
export type SelectionIntent = 'next' | 'prev' | 'extend-next' | 'extend-prev' | 'all' | 'clear';

export interface SelectionKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * The ARIA grid pattern's selection keys, on the row boxes: Down/Up move between rows, Shift with
 * them extends the selection, Ctrl/Cmd+A selects the page, Escape clears. Space is the native
 * checkbox's own toggle and is never taken. Alt is left alone: it is the sort handle's modifier.
 */
export function selectionIntent(event: SelectionKeyEvent): SelectionIntent | null {
  if (event.altKey) return null;
  const command = event.ctrlKey || event.metaKey;
  if (command) return event.key === 'a' || event.key === 'A' ? 'all' : null;
  if (event.key === 'ArrowDown') return event.shiftKey ? 'extend-next' : 'next';
  if (event.key === 'ArrowUp') return event.shiftKey ? 'extend-prev' : 'prev';
  if (event.key === 'Escape' && !event.shiftKey) return 'clear';
  return null;
}
