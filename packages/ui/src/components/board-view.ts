// A board's columns, checked: column ids unique (a move names one) and card keys unique across
// every column (a card is one node). Refused as X_UI_INVALID_VALUE naming the id.

import { type SortGroup, sortPositions } from '../drag/sort-view';
import { invalidValueError } from '../errors';

export interface BoardGroupInput<T> {
  readonly id: string;
  readonly label: string;
  readonly items: readonly T[];
}

export function boardGroups<T, G extends BoardGroupInput<T>>(
  groups: readonly G[],
  itemKey: (item: T) => string,
): readonly G[] {
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id))
      throw invalidValueError('Board', group.id, 'a column id unique on the board');
    seen.add(group.id);
  }
  sortPositions(groups as readonly SortGroup<T>[], itemKey);
  return groups;
}
