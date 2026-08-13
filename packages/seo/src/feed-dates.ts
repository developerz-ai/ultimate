// The one place a feed timestamp is parsed or formatted. Item dates are app data — a CMS column,
// a front-matter line — so a string that is not a date at all is a live possibility, and a feed is
// a page a reader is polling, not a build step: `Date.parse` answers `NaN`, and `NaN` reaches
// `toISOString()` as a `RangeError` that takes the whole route down over one bad row.

import type { Clock } from '@ultimat3/core';

/** Milliseconds for a timestamp, or `undefined` when the string is not a date at all. */
export function epochOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The newest instant in a feed, or `undefined` when nothing in it carries a usable one.
 *
 * A loop, never `Math.max(...times)`: a spread passes one argument per item, so the call overflows
 * the engine's stack in proportion to how well the blog did — and it overflows sooner the deeper
 * the request stack already is, which makes the size that breaks it a property of the caller
 * rather than of the feed.
 */
export function newestEpoch(times: Iterable<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const ms of times) {
    if (ms !== undefined && (max === undefined || ms > max)) max = ms;
  }
  return max;
}

/**
 * The clock's instant, for a feed whose items carry no usable timestamp of their own. A `Clock`
 * handing back an invalid `Date` is the caller's bug, and the epoch is a wrong-but-renderable
 * answer — throwing here would be the crash this module exists to prevent, one seam over.
 */
export function nowEpoch(clock: Clock): number {
  const ms = clock.now().getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** RFC 3339, for Atom and JSON Feed. Takes an instant, so it can never be handed a `NaN`. */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** RFC 822, RSS 2.0's only date format. Same guarantee. */
export function rfc822Of(ms: number): string {
  return new Date(ms).toUTCString();
}
