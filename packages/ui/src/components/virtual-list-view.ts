// The arithmetic of a virtual list, over numbers only: where each row starts, which rows a scroll
// position shows, where the reader is anchored, and whether they are at the end. No DOM — the
// component measures and these decide, so every rule here is tested without a browser.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';

/** Rows rendered before and after the visible ones, so a fast scroll lands on drawn rows. */
export const VIRTUAL_LIST_OVERSCAN = 4;
/** The block size of a row nobody has measured yet, in CSS px. */
export const VIRTUAL_LIST_ESTIMATE = 48;
/** Within this many px of the end the reader IS at the end... */
export const AT_END_ENTER_PX = 4;
/** ...and stays there until scrolled further than this: a measured row cannot unpin them. */
export const AT_END_LEAVE_PX = 48;

export interface VisibleRange {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/** Where the reader is: the first row on screen, and how far into it the box is scrolled. */
export interface ScrollAnchor {
  readonly key: string;
  readonly within: number;
}

/** Two rows under one key cannot both keep a node. The cause names the key. */
export function assertUniqueKeys(keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new UiError({
        code: UI_ERROR_CODES.invalidValue,
        cause: `<VirtualList> itemKey answered ${renderCauseValue(key)} for two items, so one row node would have to be both`,
        fix: 'itemKey: (item) => item.id   # on <VirtualList>: the primary key, unique within items',
      });
    }
    seen.add(key);
  }
}

/** Each row's start, plus the total as the last entry: `offsets[i]` is row `i`'s top. */
export function rowOffsets(heights: readonly number[]): readonly number[] {
  const offsets = [0];
  let at = 0;
  for (const height of heights) {
    at += height;
    offsets.push(at);
  }
  return offsets;
}

/** The last row whose top is at or above `position`. */
function rowAt(offsets: readonly number[], position: number): number {
  const rows = offsets.length - 1;
  let low = 0;
  let high = rows - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= position) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

/**
 * The rows to render. A box with no height (`viewport <= 0`) or one that holds the whole list is
 * not bounding anything, so it renders EVERY row — never nothing, and never a window of a page
 * that scrolls itself.
 */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): VisibleRange {
  const rows = offsets.length - 1;
  const total = offsets[rows] ?? 0;
  if (rows <= 0 || viewport <= 0 || viewport >= total) return { start: 0, end: Math.max(0, rows) };
  const top = Math.min(Math.max(0, scrollTop), total);
  const first = rowAt(offsets, top);
  const last = rowAt(offsets, Math.max(top, top + viewport - 1));
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(rows, last + 1 + overscan),
  };
}

/** The reader's place, as a key rather than a pixel: pixels move when a row above changes. */
export function anchorAt(
  keys: readonly string[],
  offsets: readonly number[],
  scrollTop: number,
): ScrollAnchor | undefined {
  if (keys.length === 0) return undefined;
  const index = rowAt(offsets, Math.max(0, scrollTop));
  const key = keys[index];
  return key === undefined ? undefined : { key, within: scrollTop - (offsets[index] ?? 0) };
}

/**
 * Where to scroll so the anchored row sits exactly where it sat: rows prepended, or measured
 * taller above it, move it down by their height and the box follows. `undefined` when the row is
 * gone — then there is no place to keep.
 */
export function anchoredScrollTop(
  anchor: ScrollAnchor,
  keys: readonly string[],
  offsets: readonly number[],
): number | undefined {
  const index = keys.indexOf(anchor.key);
  return index === -1 ? undefined : (offsets[index] ?? 0) + anchor.within;
}

/**
 * How far to scroll so the anchored row is back where the reader saw it: `offsetNow` is the row's
 * top relative to the box's edge after the change, and the anchor holds the edge's depth into it
 * before. Positive scrolls down — a row pushed down by a prepend comes back up.
 */
export function anchorCorrection(anchor: ScrollAnchor, offsetNow: number): number {
  return offsetNow + anchor.within;
}

/** How far the box's bottom edge is from the list's. */
export function endDistance(scrollTop: number, viewport: number, total: number): number {
  return Math.max(0, total - scrollTop - viewport);
}

/** At the end, with hysteresis: entered close to it, left only well away from it. */
export function nextAtEnd(wasAtEnd: boolean, distance: number): boolean {
  return wasAtEnd ? distance <= AT_END_LEAVE_PX : distance <= AT_END_ENTER_PX;
}
