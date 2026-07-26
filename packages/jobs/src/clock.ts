// Internal: every scheduling decision in this package is made in epoch ms against an
// injected Clock, so tests never sleep and a frozen clock cannot be bypassed.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { parseDuration } from '@ultimat3/time';

export type DurationInput = string | number;

/** A Clock may hand back a `Date` or epoch ms; scheduling needs one comparable number. */
export function nowMs(clock: Clock = systemClock): number {
  const reading: unknown = clock.now();
  if (reading instanceof Date) return reading.getTime();
  return Number(reading);
}

/** `'3d'` | `'30s'` | `1500` -> ms. Numbers pass through so callers may stay explicit. */
export function toMs(duration: DurationInput): number {
  if (typeof duration === 'number') return duration;
  const parsed: unknown = parseDuration(duration);
  if (parsed instanceof Date) return parsed.getTime();
  return Number(parsed);
}
