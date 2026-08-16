// N concurrent misses on one key are ONE origin load. Without this a cache is an outage
// amplifier: the write only lands after `load()` resolves, so every request that arrives inside
// that window misses too and every one of them queries the origin. The share is per load and
// never a second cache — the entry clears as it settles, rejection included.

/** Shares one in-flight `work()` per key. `@ultimat3/realtime`'s `entry.reading`, one tier down. */
export interface SingleFlight {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** In-flight loads right now. A number that does not fall back to `0` is a leak. */
  readonly size: number;
}

export function createSingleFlight(): SingleFlight {
  const inflight = new Map<string, Promise<unknown>>();

  return {
    get size(): number {
      return inflight.size;
    },

    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const joined = inflight.get(key);
      // Two readers of one key asking for two different `T` is an app bug the cache cannot see;
      // the value they share is the same object either way, so the cast is the honest one.
      if (joined !== undefined) return joined as Promise<T>;

      // Wrapped so a `work()` that throws SYNCHRONOUSLY still rejects the joiners rather than
      // escaping past the map and leaving no entry to clear.
      const running: Promise<T> = (async () => await work())();
      inflight.set(key, running);

      const settled = (): void => {
        // Only the leader clears its own entry: a load started after this one settled must not be
        // dropped by a late callback from the load it replaced.
        if (inflight.get(key) === running) inflight.delete(key);
      };
      // A rejected load MUST clear too, or one failure is cached as a permanent rejection.
      void running.then(settled, settled);

      return running;
    },
  };
}
