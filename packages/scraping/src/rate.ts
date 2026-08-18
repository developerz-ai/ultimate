// Navigations per second, paced against the injected clock. A scraper with no pacing is a
// scraper that looks like a denial of service to the site it depends on, and the ban is charged
// to whoever owns the IP — usually the whole fleet, not the one run.

import type { ScrapeClock } from './clock';

/** Deliberately slow. Raising it is a decision; there is no way to turn pacing off. */
export const DEFAULT_NAVIGATION_RATE = 1;

export type Pacer = (signal?: AbortSignal) => Promise<void>;

export function createPacer(rate: number, clock: ScrapeClock): Pacer {
  const intervalMs = 1_000 / rate;
  let nextAt = 0;
  return async (signal?: AbortSignal): Promise<void> => {
    const now = clock.monotonic();
    const waitMs = Math.max(0, nextAt - now);
    // Booked BEFORE the wait, so two concurrent navigations queue behind each other instead of
    // both reading the same free slot and leaving together.
    nextAt = Math.max(now, nextAt) + intervalMs;
    if (waitMs > 0) await clock.sleep(waitMs, signal);
  };
}
