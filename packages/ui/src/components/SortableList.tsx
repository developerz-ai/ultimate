// A list a person reorders by hand: a handle per row that lifts by pointer, touch or keyboard, and
// a drop that REQUESTS a move through `onMove` — the caller's action decides. With scripting off
// each row carries Move up and Move down as real form buttons posting to `action`.

import type { JSX } from 'solid-js';
import type { CanDrop, SortMove } from '../drag/sort-view';
import { type SortFields, sortSurface } from './sort-surface';

export interface SortableListProps<T> {
  items: readonly T[];
  /** Unique per item; the row keeps its node under it across live updates. */
  itemKey: (item: T) => string;
  /** The row's look is the caller's: a `Card`, a line of text. */
  renderItem: (item: T) => JSX.Element;
  /** Already-translated name of the list, read with every announcement. */
  label: string;
  /** Called once per drop that moves something. A rejection puts the row back and says so. */
  onMove: (move: SortMove) => unknown;
  canDrop?: CanDrop<T> | undefined;
  /** The action URL the no-script Up and Down buttons post to. Without it, no fallback renders. */
  action?: string | undefined;
  /** The field names those buttons post: `id`, `fromGroup`, `toGroup`, `toIndex` by default. */
  fields?: SortFields | undefined;
  /** The id `onMove` names as `fromGroup` and `toGroup`. Defaults to `list`. */
  group?: string | undefined;
  class?: string | undefined;
}

export function SortableList<T>(props: SortableListProps<T>): JSX.Element {
  return sortSurface<T>({
    groups: () => [{ id: props.group ?? 'list', label: props.label, items: props.items }],
    itemKey: (item) => props.itemKey(item),
    renderItem: (item) => props.renderItem(item),
    onMove: (move) => props.onMove(move),
    canDrop: props.canDrop,
    action: props.action,
    fields: props.fields,
    layout: 'list',
    label: props.label,
    class: props.class,
  });
}
