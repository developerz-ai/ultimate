// The pure rules of a two-pane split: bounds checked once, a value clamped into them, the key a
// separator answers, and a pointer read as a percentage from the inline START — mirrored under
// `rtl`, where the start pane is on the right.

import type { Direction } from '@ultimat3/core';
import type { AxisSpan } from '../drag/sort-view';
import { invalidValueError } from '../errors';

/** What one arrow press moves the separator by, in percent. */
export const PANE_KEY_STEP = 5;

export interface PaneBounds {
  readonly min: number;
  readonly max: number;
}

const isPercent = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 100;

/** `min` and `max` as given, refused when either is not a percentage or `min` is over `max`. */
export function paneBounds(min = 0, max = 100): PaneBounds {
  if (!isPercent(min)) throw invalidValueError('SplitPane', min, 'a min from 0 to 100');
  if (!isPercent(max)) throw invalidValueError('SplitPane', max, 'a max from 0 to 100');
  if (min > max) throw invalidValueError('SplitPane', `min ${min} > max ${max}`, 'min <= max');
  return { min, max };
}

/** A caller's `value` or `defaultValue`: a value outside the bounds is a bug, never clamped away. */
export function paneValue(value: number, bounds: PaneBounds): number {
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw invalidValueError('SplitPane', value, `a value from ${bounds.min} to ${bounds.max}`);
  }
  return value;
}

export function clampPane(value: number, bounds: PaneBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

/**
 * The value a key asks for, or null when the key is not the separator's. The inline arrows grow
 * the START pane toward the end of the line, so under `rtl` ArrowLeft grows it.
 */
export function paneKey(
  key: string,
  value: number,
  bounds: PaneBounds,
  dir: Direction,
): number | null {
  const toward = dir === 'rtl' ? -1 : 1;
  if (key === 'ArrowRight') return clampPane(value + PANE_KEY_STEP * toward, bounds);
  if (key === 'ArrowLeft') return clampPane(value - PANE_KEY_STEP * toward, bounds);
  if (key === 'ArrowUp') return clampPane(value + PANE_KEY_STEP, bounds);
  if (key === 'ArrowDown') return clampPane(value - PANE_KEY_STEP, bounds);
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  return null;
}

/** The start pane's share for a pointer at `x` across the pane box, rounded to a tenth. */
export function panePercentAt(
  x: number,
  box: AxisSpan,
  bounds: PaneBounds,
  dir: Direction,
): number {
  if (box.size <= 0) return bounds.min;
  const fromStart = dir === 'rtl' ? box.start + box.size - x : x - box.start;
  return clampPane(Math.round((fromStart / box.size) * 1000) / 10, bounds);
}
