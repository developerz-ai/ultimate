// Columns of sortable groups sharing one gesture: a card moves within a column or across to
// another by pointer, touch, the arrow keys, or — with scripting off — a target `select` per card.
// No card look and no column rules: `renderItem` and `canDrop` are the caller's.

import type { JSX } from 'solid-js';
import type { CanDrop, SortMove } from '../drag/sort-view';
import { boardGroups } from './board-view';
import { type SortFields, sortSurface } from './sort-surface';

export interface BoardColumn<T> {
  /** What `onMove` names as `fromGroup` / `toGroup` — a status, a lane id. */
  id: string;
  /** Already-translated column name. */
  label: string;
  items: readonly T[];
}

export interface BoardProps<T> {
  groups: readonly BoardColumn<T>[];
  /** Unique across EVERY column: a card is one node wherever it sits. */
  itemKey: (item: T) => string;
  renderItem: (item: T) => JSX.Element;
  /** Already-translated name of the whole board. */
  label: string;
  onMove: (move: SortMove) => unknown;
  /** The one seam for a business rule — a WIP limit, a status machine. */
  canDrop?: CanDrop<T> | undefined;
  /** The action URL the no-script target select posts to. */
  action?: string | undefined;
  fields?: SortFields | undefined;
  class?: string | undefined;
}

export function Board<T>(props: BoardProps<T>): JSX.Element {
  return sortSurface<T>({
    groups: () => boardGroups(props.groups, props.itemKey),
    itemKey: (item) => props.itemKey(item),
    renderItem: (item) => props.renderItem(item),
    onMove: (move) => props.onMove(move),
    canDrop: props.canDrop,
    action: props.action,
    fields: props.fields,
    layout: 'board',
    label: props.label,
    class: props.class,
  });
}
