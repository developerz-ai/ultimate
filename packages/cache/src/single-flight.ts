// N concurrent misses on one key are ONE origin load. Without this a cache is an outage
// amplifier: the write only lands after `load()` resolves, so every request that arrives inside
// that window misses too and every one of them queries the origin. The share is per load and
// never a second cache — the entry clears as it settles, rejection included.

/**
 * What a joiner contributes to the load it joined. Without one a joiner is a free rider: it takes
 * the leader's value AND the leader's write, so anything it declared about that write is dropped.
 */
export interface FlightJoin<C> {
  readonly context: C;
  /** Folds a joiner in. Called synchronously as it arrives, so the leader sees it before it writes. */
  readonly merge: (current: C, joining: C) => C;
}

/** Shares one in-flight `work()` per key. `@ultimat3/realtime`'s `entry.reading`, one tier down. */
export interface SingleFlight {
  /**
   * `work` receives a reader for the merged context — read it LATE (after the load settles), or
   * it answers with only what the leader brought.
   */
  run<T, C = undefined>(
    key: string,
    work: (shared: () => C | undefined) => Promise<T>,
    join?: FlightJoin<C>,
  ): Promise<T>;
  /** In-flight loads right now. A number that does not fall back to `0` is a leak. */
  readonly size: number;
}

/** The leader's promise, plus the box its merged context lives in — one identity for both. */
interface Flight {
  readonly running: Promise<unknown>;
  readonly shared: { context: unknown };
}

export function createSingleFlight(): SingleFlight {
  const inflight = new Map<string, Flight>();

  return {
    get size(): number {
      return inflight.size;
    },

    run<T, C = undefined>(
      key: string,
      work: (shared: () => C | undefined) => Promise<T>,
      join?: FlightJoin<C>,
    ): Promise<T> {
      const joined = inflight.get(key);
      // Two readers of one key asking for two different `T` is an app bug the cache cannot see;
      // the value they share is the same object either way, so the cast is the honest one.
      if (joined !== undefined) {
        if (join !== undefined) {
          joined.shared.context = join.merge(joined.shared.context as C, join.context);
        }
        return joined.running as Promise<T>;
      }

      const shared: { context: unknown } = { context: join?.context };
      // Wrapped so a `work()` that throws SYNCHRONOUSLY still rejects the joiners rather than
      // escaping past the map and leaving no entry to clear.
      const running: Promise<T> = (async () => await work(() => shared.context as C | undefined))();
      const entry: Flight = { running, shared };
      inflight.set(key, entry);

      const settled = (): void => {
        // Only the leader clears its own entry: a load started after this one settled must not be
        // dropped by a late callback from the load it replaced.
        if (inflight.get(key) === entry) inflight.delete(key);
      };
      // A rejected load MUST clear too, or one failure is cached as a permanent rejection.
      void running.then(settled, settled);

      return running;
    },
  };
}
