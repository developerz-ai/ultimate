// The claim loop's TIMER: when the next pass runs. The floor while passes find work, backing off
// while they do not (`idle-backoff.ts`) — or resting until the next row is due, when a pass said
// when that is and the wake is live — and three things that cut a wait short: work arriving
// (`enqueue-signal.ts`), a slot coming free, a row this worker handed back becoming due.

import { onEnqueued, wakeIsLive } from './enqueue-signal';
import {
  createIdleBackoff,
  DUE_MARGIN_MS,
  IDLE_REST_MAX_MS,
  REST_SLICE_MS,
  restAfter,
} from './idle-backoff';

export interface ClaimLoopOptions {
  readonly subject: string;
  readonly floorMs: number;
  readonly ceilingMs?: number;
  /** The queues this worker serves: a wake naming any other is not for it. */
  readonly queues: readonly string[];
  /** One pass. It reports what it found through `passed()`, so a manual `tick()` counts too. */
  readonly round: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
  /**
   * The driver's fleet-wide announcement (`JobDriver.wake`). Without one no other process hears of
   * an enqueue, so the loop never rests past its poll; with one, a row this loop handed back
   * with a due time it can no longer keep — it stopped first — is announced to the loops that can.
   */
  readonly wake?: ((queue?: string) => Promise<void>) | undefined;
  /** What every wait is armed on. Default: real, unrefed timeouts; a test hands in its own. */
  readonly timers?: LoopTimers;
}

/** The two calls the loop makes on a timer. The handle is whatever `set` answered. */
export interface LoopTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Unrefed: never the thing keeping a drained process alive — the hooks stop this loop. */
const REAL_TIMERS: LoopTimers = {
  set(run, ms) {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface ClaimLoop {
  start(): void;
  stop(): void;
  /** True once a pass has come back empty. */
  idle(): boolean;
  /**
   * A pass ended: `found` decides the next wait. `full` — some ask came back with every row it
   * asked for — means a backlog is likely, so a slot freeing before the next pass claims at once.
   * An empty pass that heard `nextDue` RESTS until then (wake live), skipping the ramp.
   */
  passed(found: boolean, full?: boolean): void;
  /**
   * An empty ask of the pass in flight said when its next row falls due (`ClaimOptions.onEmpty`):
   * `null` for none. The pass's earliest is what `passed()` rests on, then forgotten. A queue no
   * ask covered is held by this worker's own runs, and a run's end `kick()`s.
   */
  nextDue(dueInMs: number | null): void;
  /**
   * Whether a claim should say when its next row is due: once a pass has found nothing. A busy
   * worker's claims would pay to plan an arm that never runs (`SQL_CLAIM_IDLE`).
   */
  wantsDue(): boolean;
  /** The wait the loop will arm, or has armed. */
  delayMs(): number;
  /**
   * A slot came free, or a handed-back row is due: one pass NOW if the wait in hand is longer
   * than the floor, or the last pass came back full — and no reset, so a pass that finds nothing
   * costs one statement, not a ramp.
   */
  kick(): void;
  /** A row this worker settled back onto the queue is claimable again in `ms`. */
  dueIn(ms: number): void;
}

/**
 * Whether one ask came back FULL — every row it asked for STARTED. Counted on what a pass admitted,
 * never on what it claimed: rows a concurrency or rate cap sent back are not a backlog this worker
 * can run, and kicking on them is a claim plus N nacks per completion.
 */
export function fillsAsk(admitted: ReadonlyMap<string, number>, limit: number): boolean {
  let ran = 0;
  for (const count of admitted.values()) ran += count;
  return ran > 0 && ran >= limit;
}

/** A due time further out than this is the poll's to find: no timer is held for a 3-day sleep. */
const DUE_HINT_MAX_MS = IDLE_REST_MAX_MS;

export function createClaimLoop(options: ClaimLoopOptions): ClaimLoop {
  const floor = options.floorMs;
  const backoff = createIdleBackoff({
    subject: options.subject,
    floorMs: floor,
    ...(options.ceilingMs === undefined ? {} : { ceilingMs: options.ceilingMs }),
  });
  const timers = options.timers ?? REAL_TIMERS;
  let delayMs = floor;
  /** The wait in hand is a REST (`passed`'s due time, wake live): armed in slices. */
  let resting = false;
  /** What this pass's empty asks said (`nextDue`): `undefined` until one did. */
  let horizon: number | null | undefined;
  /** The last pass found work. A wake does not clear it: only a pass decides. */
  let busy = false;
  let active = false;
  /** Started, then stopped: a hand-back now is one this loop cannot keep (`handOff`). */
  let ended = false;
  let timer: unknown;
  /** The timer's own pass is in flight. A wake landing now asks for ONE more, never a second chain. */
  let passing = false;
  let again = false;
  /**
   * The last pass came back full. A pass that found work waits the FLOOR, and a kick shorter than
   * that did nothing — so a backlog drained at one batch per floor: 8 slots / 250 ms = 32 claims/s,
   * which `scripts/bench/worker-throughput.bench.ts` measured exactly. Cleared by the next pass.
   */
  let backlog = false;
  let unsubscribe: (() => void) | undefined;
  /** One timer per floor-wide bucket of due times, so a burst of retries holds a bounded few. */
  const due = new Map<number, unknown>();

  const arm = (): void => {
    armIn(delayMs);
  };

  const armIn = (ms: number): void => {
    const slice = resting && ms > REST_SLICE_MS;
    timer = timers.set(
      () => {
        timer = undefined;
        if (slice && wakeIsLive()) {
          armIn(ms - REST_SLICE_MS);
          return;
        }
        pass();
      },
      slice ? REST_SLICE_MS : ms,
    );
  };

  const pass = (): void => {
    passing = true;
    void options
      .round()
      .catch((error: unknown) => {
        // A failed pass never reached `passed()`, so the wait in hand is whatever cut the last
        // one short — 0 after a wake — and re-arming on it is a loop that spins for as long as
        // the database is down. Not an idle pass either: try again at the floor.
        delayMs = backoff.next(true);
        resting = false;
        options.onError(error);
      })
      .finally(() => {
        passing = false;
        if (!active) return;
        if (again) delayMs = 0;
        again = false;
        arm();
      });
  };

  /** The next pass, now — or right behind the one in flight, whose snapshot may predate the news. */
  const now = (): void => {
    if (!active) return;
    if (passing) {
      again = true;
      return;
    }
    if (timer === undefined) return;
    timers.clear(timer);
    delayMs = 0;
    resting = false;
    arm();
  };

  /**
   * Work arrived (`enqueue-signal.ts`): the next pass runs now, and the ones after it at the
   * floor. The reset is what covers a row the wake did NOT announce — a second enqueue inside
   * one notification slot, a job due a moment from now on a skewed clock.
   */
  const wake = (queue?: string): void => {
    if (queue !== undefined && !options.queues.includes(queue)) return;
    backoff.reset();
    now();
  };

  const kick = (): void => {
    if (delayMs > floor || backlog) now();
  };

  /**
   * A due time this loop will not be here to keep: a peer resting on a horizon read before the
   * row was handed back would sleep past it, up to `IDLE_REST_MAX_MS`. One announcement makes
   * every resting loop re-read its horizon. Failure is the poll's to cover: logged, not thrown.
   */
  const handOff = (): void => {
    options.wake?.().catch(options.onError);
  };

  return {
    start() {
      if (active) return;
      active = true;
      ended = false;
      delayMs = floor;
      unsubscribe = onEnqueued(wake);
      arm();
    },
    stop() {
      ended = ended || active;
      active = false;
      again = false;
      backlog = false;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      for (const hint of due.values()) timers.clear(hint);
      if (due.size > 0) handOff();
      due.clear();
      unsubscribe?.();
      unsubscribe = undefined;
    },
    idle: () => backoff.idle(),
    nextDue(dueInMs) {
      if (horizon === undefined || horizon === null) horizon = dueInMs;
      else if (dueInMs !== null) horizon = Math.min(horizon, dueInMs);
    },
    wantsDue: () => !busy,
    passed(found, full = false) {
      const dueInMs = horizon;
      horizon = undefined;
      busy = found;
      backlog = full;
      ({ delayMs, resting } = restAfter({
        found,
        dueInMs,
        backoffMs: backoff.next(found),
        floorMs: floor,
        declaredCeilingMs: options.ceilingMs,
        settled: backoff.settled(),
        announced: options.wake !== undefined,
      }));
    },
    delayMs: () => delayMs,
    kick,
    dueIn(ms) {
      if (!Number.isFinite(ms) || ms > DUE_HINT_MAX_MS) return;
      // Handed back by a run the drain outlived: this loop is stopped, a peer's is not.
      if (!active) {
        if (ended) handOff();
        return;
      }
      const wait = Math.max(0, ms) + DUE_MARGIN_MS;
      const step = Math.max(floor, DUE_MARGIN_MS);
      const bucket = Math.ceil((performance.now() + wait) / step);
      if (due.has(bucket)) return;
      const hint = timers.set(() => {
        due.delete(bucket);
        kick();
      }, wait);
      due.set(bucket, hint);
    },
  };
}
