// The clock a shot session runs on, and the page deadline a run uses when it names none. The
// system clock and `Bun.sleep`: a test hands `open()` its own `ShotClock`, where sleeping IS
// advancing, so a 30-second deadline under test finishes in microseconds.
import { systemClock } from '@ultimat3/core';
import type { ShotClock } from './browser-launcher-port';

/** A navigation or a wait with no `timeout` of its own gets this. */
export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

export const systemShotClock: ShotClock = Object.freeze({
  now: () => systemClock.now(),
  monotonic: () => systemClock.monotonic(),
  sleep: (ms: number) => Bun.sleep(ms),
});
