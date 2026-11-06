// The trim behind a live chart: append the newest point, keep the last `max`. Pure and free of any
// chart module, so a live island pays for one function — and every point that survives keeps its
// key, which is what keeps its node (and the focus on it) through the tick (`hitIds`).

import { finiteCount } from '@ultimat3/core';

export interface LiveWindowOptions {
  /** How many points the window holds, at least 1. A whole number — it counts points. */
  readonly max: number;
}

/** `series` with `point` appended and the oldest dropped past `max`. Never mutates `series`. */
export function liveWindow<T>(
  series: readonly T[],
  point: T,
  options: LiveWindowOptions,
): readonly T[] {
  // `slice(-NaN)` is the whole array and `slice(-Infinity)` too: an unbounded window, which is
  // the leak a live chart left open for an hour is.
  const max = finiteCount('liveWindow', 'max', options.max, 1);
  const next = [...series, point];
  return next.length > max ? next.slice(next.length - max) : next;
}
