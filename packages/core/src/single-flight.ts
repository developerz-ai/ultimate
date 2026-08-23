// Single responsibility: N concurrent callers on one key are ONE run of the work. Tier 0 because
// four packages needed it and only one had it — `@ultimat3/cache`'s `single-flight.ts` (this
// function's shape, verbatim), `@ultimat3/realtime`'s `entry.reading`, `@ultimat3/auth`'s
// hand-rolled `inflight ??=` in `jwks.ts`, and `@ultimat3/query`'s per-request memo.

/**
 * What a joiner contributes to the load it joined. Without one a joiner is a free rider: it takes
 * the leader's value AND the leader's write, so anything it declared about that write is dropped.
 */
export interface FlightJoin<C> {
  readonly context: C;
  /** Folds a joiner in. Called synchronously as it arrives, so the leader sees it before it writes. */
  readonly merge: (current: C, joining: C) => C;
}

/** Returns its own canceller rather than a handle, so no type differs across Bun and the browser. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export interface SingleFlightOptions {
  /**
   * How long a key may be held by one load. Optional, and off by default: a load with no deadline
   * that never settles holds its key for the life of the process, and every later caller joins a
   * promise that will never resolve. Eviction frees the KEY — the work itself is not cancellable
   * from here, and pretending otherwise would be a second, false promise.
   */
  readonly deadlineMs?: number | undefined;
  /** Injected so a deadline is provable without waiting for one. */
  readonly schedule?: Scheduler | undefined;
}

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

/** The leader's promise, the box its merged context lives in, and its deadline's canceller. */
interface Flight {
  readonly running: Promise<unknown>;
  readonly shared: { context: unknown };
  cancelDeadline: () => void;
}

const defaultScheduler: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(timer);
  };
};

export function createSingleFlight(options?: SingleFlightOptions): SingleFlight {
  const inflight = new Map<string, Flight>();
  const schedule = options?.schedule ?? defaultScheduler;
  const deadlineMs = options?.deadlineMs;

  // Identity, never key presence. `inflight.delete(key)` from a settling load drops whatever holds
  // the key NOW — which, once a deadline can evict, is a different load that has not settled: its
  // joiners would then be sharing a promise nothing in the map answers for.
  const evict = (key: string, entry: Flight): void => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };

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
      // Two readers of one key asking for two different `T` is a caller bug this cannot see; the
      // value they share is the same object either way, so the cast is the honest one.
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
      const entry: Flight = { running, shared, cancelDeadline: (): void => undefined };
      inflight.set(key, entry);

      if (deadlineMs !== undefined) {
        entry.cancelDeadline = schedule(() => {
          evict(key, entry);
        }, deadlineMs);
      }

      const settled = (): void => {
        entry.cancelDeadline();
        evict(key, entry);
      };
      // A rejected load MUST clear too, or one failure is cached as a permanent rejection.
      void running.then(settled, settled);

      return running;
    },
  };
}
