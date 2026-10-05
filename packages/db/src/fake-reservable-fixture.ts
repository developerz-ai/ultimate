// Single responsibility: a `ReservableClient` whose pin is countable, wrapped over any `DbClient`.
// The leak it exists to catch is invisible to the recording client — the statements are identical
// whether or not the reservation ever came back, and only the counter says which happened. Shared
// rather than copied: a second copy of a fixture asserts less than the first, silently.

import type { DbClient, ReservableClient } from './client';

/** Pins taken and pins given back. A leak is `reserves > releases`; the fix makes them equal. */
export interface PinCounts {
  reserves: number;
  releases: number;
}

export interface ReservableFake {
  readonly client: ReservableClient;
  readonly pins: PinCounts;
}

/**
 * Wrap `inner` in a pool that counts its reservations. `release()` is idempotent and
 * `[Symbol.dispose]` is the same call, exactly as both real drivers are — so a double release
 * counts once and only a genuine leak leaves the counters uneven.
 */
export function reservableOver(inner: DbClient): ReservableFake {
  const pins: PinCounts = { reserves: 0, releases: 0 };
  return {
    pins,
    client: {
      query: (fragment) => inner.query(fragment),
      one: (fragment) => inner.one(fragment),
      execute: (fragment) => inner.execute(fragment),
      reserve: async () => {
        pins.reserves += 1;
        let held = true;
        const release = (): void => {
          if (!held) return;
          held = false;
          pins.releases += 1;
        };
        return {
          query: (fragment) => inner.query(fragment),
          one: (fragment) => inner.one(fragment),
          execute: (fragment) => inner.execute(fragment),
          release,
          [Symbol.dispose]: release,
        };
      },
    },
  };
}
