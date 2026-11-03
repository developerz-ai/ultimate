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
  /**
   * The lifetime of whoever is calling, read at each `run`. Set, a joiner whose leader was aborted
   * and whose own signal is live re-leads with its own `work`: the leader's closed tab is not a
   * failure of the read it joined. Any other rejection is shared, ordinary failures included.
   * Absent means every joiner shares every rejection. Injected, so this file reads no context.
   */
  readonly signal?: (() => AbortSignal | undefined) | undefined;
  /**
   * Told each time `key` stops being held: settle, deadline or `evict`, and not when a load already
   * evicted settles. So a caller keeping state per held key mirrors the map exactly, with no gap
   * before the settle and no entry left behind by a load that never does.
   */
  readonly released?: ((key: string) => void) | undefined;
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
  /** The keys held by a load right now — what a caller that must `evict` by a rule walks. */
  keys(): readonly string[];
  /**
   * Free `key` NOW, so the next `run` leads a fresh load instead of joining the one in flight.
   * For a caller that learns the load in flight is already wrong — it began before a write its
   * result must reflect. The load is not cancelled and its own callers still get its value; only
   * later ones stop joining it. `false` when nothing held the key.
   */
  evict(key: string): boolean;
}

/** The leader's promise, its signal, the box its merged context lives in, its deadline's canceller. */
interface Flight {
  readonly running: Promise<unknown>;
  readonly signal: AbortSignal | undefined;
  readonly shared: { context: unknown };
  cancelDeadline: () => void;
}

const defaultScheduler: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(timer);
  };
};

export function singleFlight(options?: SingleFlightOptions): SingleFlight {
  const inflight = new Map<string, Flight>();
  const schedule = options?.schedule ?? defaultScheduler;
  const deadlineMs = options?.deadlineMs;
  const readSignal = options?.signal;
  const released = options?.released;

  // Identity, never key presence. `inflight.delete(key)` from a settling load drops whatever holds
  // the key NOW — which, once a deadline can evict, is a different load that has not settled: its
  // joiners would then be sharing a promise nothing in the map answers for.
  const evict = (key: string, entry: Flight): void => {
    if (inflight.get(key) !== entry) return;
    inflight.delete(key);
    released?.(key);
  };

  const run = <T, C = undefined>(
    key: string,
    work: (shared: () => C | undefined) => Promise<T>,
    join?: FlightJoin<C>,
  ): Promise<T> => {
    const joined = inflight.get(key);
    // Two readers of one key asking for two different `T` is a caller bug this cannot see; the
    // value they share is the same object either way, so the cast is the honest one.
    if (joined !== undefined) {
      if (join !== undefined) {
        joined.shared.context = join.merge(joined.shared.context as C, join.context);
      }
      if (readSignal === undefined) return joined.running as Promise<T>;
      const mine = readSignal();
      // Asked at the rejection, not now: either side may yet abort. `settled` was attached at lead,
      // ahead of this, so the key is already free; the first re-lead leads and the rest join it. No
      // cap is needed, as each further round spends one more aborted leader. `catch` runs under the
      // context it was attached in, so the re-lead's `work` is this joiner's, as this joiner.
      return (joined.running as Promise<T>).catch((error: unknown) => {
        if (joined.signal?.aborted !== true || mine?.aborted === true) throw error;
        return run(key, work, join);
      });
    }

    const shared: { context: unknown } = { context: join?.context };
    // Wrapped so a `work()` that throws SYNCHRONOUSLY still rejects the joiners rather than
    // escaping past the map and leaving no entry to clear.
    const running: Promise<T> = (async () => await work(() => shared.context as C | undefined))();
    const entry: Flight = {
      running,
      signal: readSignal?.(),
      shared,
      cancelDeadline: (): void => undefined,
    };
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
  };

  return {
    get size(): number {
      return inflight.size;
    },

    keys: () => [...inflight.keys()],

    evict(key: string): boolean {
      const held = inflight.get(key);
      if (held === undefined) return false;
      held.cancelDeadline();
      evict(key, held);
      return true;
    },

    run,
  };
}
