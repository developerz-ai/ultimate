// The pure rules of reordering: where an item is, where a pointer or a key puts it, and whether the
// drop is a request at all. No DOM and no clock, so `SortableList` and `Board` share one answer and
// every rule is tested under `dir="rtl"` with plain numbers.

import type { Direction } from '@ultimat3/core';
import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';

/** One column of a board, or the single group of a list. `id` is what `onMove` names. */
export interface SortGroup<T> {
  readonly id: string;
  readonly items: readonly T[];
}

/** Where an item sits: the group's position in the list of groups, and its index inside it. */
export interface SortPosition {
  readonly group: number;
  readonly index: number;
}

/** What a drop asks for. `toIndex` is the item's index in `toGroup` AFTER the move. */
export interface SortMove {
  readonly id: string;
  readonly fromGroup: string;
  readonly toGroup: string;
  readonly toIndex: number;
}

/** A span along one axis, as a measured rect gives it. */
export interface AxisSpan {
  readonly start: number;
  readonly size: number;
}

/** `canDrop(item, groupId)`: the one seam a business rule (a WIP limit, a status machine) uses. */
export type CanDrop<T> = (item: T, group: string) => boolean;

function duplicateKeyError(key: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `itemKey answered ${renderCauseValue(key)} for two items, across every group of the list or board — a dragged item must be exactly one node`,
    fix: 'itemKey: (item) => item.id   # on <SortableList> or <Board>: a key unique across every group',
  });
}

/** Every item's position by key. Two items under one key, in any group, is refused. */
export function sortPositions<T>(
  groups: readonly SortGroup<T>[],
  itemKey: (item: T) => string,
): Map<string, SortPosition> {
  const at = new Map<string, SortPosition>();
  groups.forEach((group, g) => {
    group.items.forEach((item, index) => {
      const key = itemKey(item);
      if (at.has(key)) throw duplicateKeyError(key);
      at.set(key, { group: g, index });
    });
  });
  return at;
}

/** The groups with one item taken from `from` and put at `to` — the drag preview, never truth. */
export function moveBetween<T>(
  groups: readonly SortGroup<T>[],
  from: SortPosition,
  to: SortPosition,
): readonly SortGroup<T>[] {
  const source = groups[from.group];
  const item = source?.items[from.index];
  if (source === undefined || item === undefined || groups[to.group] === undefined) return groups;
  const lifted = groups.map((group, g) =>
    g === from.group
      ? { id: group.id, items: group.items.filter((_, i) => i !== from.index) }
      : group,
  );
  return lifted.map((group, g) => {
    if (g !== to.group) return group;
    const index = Math.max(0, Math.min(to.index, group.items.length));
    return {
      id: group.id,
      items: [...group.items.slice(0, index), item, ...group.items.slice(index)],
    };
  });
}

/** The first group from `start` walking by `step` that accepts the item, or null at the edge. */
function nextGroup<T>(
  groups: readonly SortGroup<T>[],
  start: number,
  step: number,
  accepts: (group: string) => boolean,
): number | null {
  for (let g = start + step; g >= 0 && g < groups.length; g += step) {
    const group = groups[g];
    if (group !== undefined && accepts(group.id)) return g;
  }
  return null;
}

/**
 * One key while an item is lifted, over the PREVIEW groups (the item already sits at `at`).
 * Up and Down walk the group; the inline arrows walk the groups, mirrored under `rtl`, skipping a
 * group `canDrop` refuses; Home and End go to the group's ends. Null: the key does not move it.
 */
export function sortKeyStep<T>(
  groups: readonly SortGroup<T>[],
  at: SortPosition,
  key: string,
  dir: Direction,
  canDrop: (group: string) => boolean = () => true,
): SortPosition | null {
  const length = groups[at.group]?.items.length ?? 0;
  const within = (index: number): SortPosition | null => {
    const clamped = Math.max(0, Math.min(index, length - 1));
    return clamped === at.index ? null : { group: at.group, index: clamped };
  };
  if (key === 'ArrowUp') return within(at.index - 1);
  if (key === 'ArrowDown') return within(at.index + 1);
  if (key === 'Home') return within(0);
  if (key === 'End') return within(length - 1);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const forward = key === 'ArrowRight' ? 1 : -1;
  const step = dir === 'rtl' ? -forward : forward;
  const g = nextGroup(groups, at.group, step, canDrop);
  if (g === null) return null;
  // The destination does not hold the item yet, so its insertion points run 0..length.
  return { group: g, index: Math.min(at.index, groups[g]?.items.length ?? 0) };
}

/**
 * The insertion index a pointer at `pointer` (one axis) asks for, among `spans` — the measured
 * items of the destination group WITHOUT the dragged one. Past an item's midpoint is after it.
 */
export function pointerIndex(pointer: number, spans: readonly AxisSpan[]): number {
  let index = 0;
  for (const span of spans) if (pointer > span.start + span.size / 2) index += 1;
  return index;
}

/** A measured box: one span per axis. */
export interface AxisBox {
  readonly inline: AxisSpan;
  readonly block: AxisSpan;
}

const outside = (pointer: number, span: AxisSpan): number =>
  pointer < span.start ? span.start - pointer : Math.max(0, pointer - span.start - span.size);

/**
 * The group whose box holds the pointer, else the nearest one: a drop between columns lands. Both
 * axes, so columns side by side and columns stacked on a narrow screen answer alike.
 */
export function pointerGroup(
  point: { readonly x: number; readonly y: number },
  boxes: readonly AxisBox[],
): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  boxes.forEach((box, g) => {
    const away = Math.hypot(outside(point.x, box.inline), outside(point.y, box.block));
    if (away < distance) {
      distance = away;
      best = g;
    }
  });
  return best;
}

/**
 * The move a drop requests, or null when there is none to make: back where it started, or a
 * group `canDrop` refuses — both keep the origin and call nothing.
 */
export function dropMove<T>(
  groups: readonly SortGroup<T>[],
  item: T,
  id: string,
  from: SortPosition,
  to: SortPosition,
  canDrop?: CanDrop<T>,
): SortMove | null {
  const fromGroup = groups[from.group]?.id;
  const toGroup = groups[to.group]?.id;
  if (fromGroup === undefined || toGroup === undefined) return null;
  if (from.group === to.group && from.index === to.index) return null;
  if (canDrop !== undefined && from.group !== to.group && !canDrop(item, toGroup)) return null;
  return { id, fromGroup, toGroup, toIndex: to.index };
}

/** The numbers every announcement takes: a 1-based position, the group's size, and its name. */
export function sortSpeech<T>(
  groups: readonly SortGroup<T>[],
  at: SortPosition,
  groupLabel: (id: string) => string,
): { readonly position: number; readonly total: number; readonly group: string } {
  const group = groups[at.group];
  return {
    position: at.index + 1,
    total: group?.items.length ?? 0,
    group: group === undefined ? '' : groupLabel(group.id),
  };
}
