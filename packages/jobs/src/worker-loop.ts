// The claim loop's TIMER: when the next pass runs. The floor while passes find work, backing off
// while they do not (`idle-backoff.ts`), and three things that cut a wait short — work arriving
// (`enqueue-signal.ts`), a slot coming free, and a row this worker handed back becoming due.
// Split off `worker.ts` at its size ceiling: that file is what a pass DOES.

import { onEnqueued } from './enqueue-signal';
import { createIdleBackoff } from './idle-backoff';

export interface ClaimLoopOptions {
  readonly subject: string;
  readonly floorMs: number;
  readonly ceilingMs?: number;
  /** The queues this worker serves: a wake naming any other is not for it. */
  readonly queues: readonly string[];
  /** One pass. It reports what it found through `passed()`, so a manual `tick()` counts too. */
  readonly round: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
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
  /** A pass ended: `found` decides the next wait. */
  passed(found: boolean): void;
  /** The wait the loop will arm, or has armed. */
  delayMs(): number;
  /**
   * A slot came free, or a handed-back row is due: one pass NOW if the wait in hand is longer
   * than the floor — and no reset, so a pass that finds nothing costs one statement, not a ramp.
   */
  kick(): void;
  /** A row this worker settled back onto the queue is claimable again in `ms`. */
  dueIn(ms: number): void;
}

/** A due time further out than this is the poll's to find: no timer is held for a 3-day sleep. */
const DUE_HINT_MAX_MS = 60_000;
/** After the due time, never on it: the row's `run_at` is the database's clock, not this one. */
const DUE_MARGIN_MS = 10;

export function createClaimLoop(options: ClaimLoopOptions): ClaimLoop {
  const floor = options.floorMs;
  const backoff = createIdleBackoff({
    subject: options.subject,
    floorMs: floor,
    ...(options.ceilingMs === undefined ? {} : { ceilingMs: options.ceilingMs }),
  });
  const timers = options.timers ?? REAL_TIMERS;
  let delayMs = floor;
  let active = false;
  let timer: unknown;
  /** The timer's own pass is in flight. A wake landing now asks for ONE more, never a second chain. */
  let passing = false;
  let again = false;
  let unsubscribe: (() => void) | undefined;
  /** One timer per floor-wide bucket of due times, so a burst of retries holds a bounded few. */
  const due = new Map<number, unknown>();

  const arm = (): void => {
    timer = timers.set(() => {
      timer = undefined;
      passing = true;
      void options
        .round()
        .catch((error: unknown) => {
          // A failed pass never reached `passed()`, so the wait in hand is whatever cut the last
          // one short — 0 after a wake — and re-arming on it is a loop that spins for as long as
          // the database is down. Not an idle pass either: try again at the floor.
          delayMs = backoff.next(true);
          options.onError(error);
        })
        .finally(() => {
          passing = false;
          if (!active) return;
          if (again) delayMs = 0;
          again = false;
          arm();
        });
    }, delayMs);
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
    if (delayMs > floor) now();
  };

  return {
    start() {
      if (active) return;
      active = true;
      delayMs = floor;
      unsubscribe = onEnqueued(wake);
      arm();
    },
    stop() {
      active = false;
      again = false;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      for (const hint of due.values()) timers.clear(hint);
      due.clear();
      unsubscribe?.();
      unsubscribe = undefined;
    },
    idle: () => backoff.idle(),
    passed(found) {
      delayMs = backoff.next(found);
    },
    delayMs: () => delayMs,
    kick,
    dueIn(ms) {
      if (!active || !Number.isFinite(ms) || ms > DUE_HINT_MAX_MS) return;
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
