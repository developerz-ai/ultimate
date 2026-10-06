// The runs one worker holds right now, each with the claim it runs under — so a drain that reaches
// its cut-off can hand back every row still held instead of leaving it under a lease another
// worker waits a whole visibility timeout to see lapse. Split from `worker.ts`, whose job is the
// claim loop; this one is "what am I holding, and give it back".

import type { ClaimedJob, JobDriver } from './driver';
import { handBack } from './worker-hand-back';

export interface HeldRuns {
  /** How many runs are held — what `stats().inFlight` reports. */
  readonly size: number;
  /**
   * The job ids held, each once — what the registry row reports. Per RUN underneath, because one
   * worker can hold a job twice (a claim that lapsed under a body still running, then its own
   * re-claim): keyed by id, the first run to end dropped an id the second still held.
   */
  ids(): string[];
  /**
   * A run started. `release` is what the run's own `finally` would do for the process — the
   * in-flight count core's drain waits on, the fleet slot — run early when the run is handed back.
   */
  add(run: Promise<unknown>, claimed: ClaimedJob, release: () => Promise<void>): void;
  /** The run settled on its own: no longer held. */
  settle(run: Promise<unknown>): void;
  /** Resolves the moment nothing is held — settled or handed back. */
  empty(): Promise<void>;
  /**
   * Every run still held goes back to the queue — `countsAsAttempt: false`, no delay — and stops
   * being this worker's. Answers how many. The bodies themselves cannot be stopped; what they
   * write after this is fenced out by the claim that just moved (`StepFence`, `SQL_ACK`).
   */
  handBackAll(): Promise<number>;
}

interface Holding {
  readonly claimed: ClaimedJob;
  readonly release: () => Promise<void>;
}

export function createHeldRuns(options: {
  readonly driver: JobDriver;
  readonly workerId: string;
}): HeldRuns {
  const held = new Map<Promise<unknown>, Holding>();
  let waiters: (() => void)[] = [];

  /** Pending hand-backs: `empty()` answers only once their nacks have LANDED, never mid-wire. */
  let handingBack = 0;
  const wakeIfEmpty = (): void => {
    if (held.size > 0 || handingBack > 0 || waiters.length === 0) return;
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  };

  return {
    get size() {
      return held.size;
    },
    ids() {
      return [...new Set([...held.values()].map((holding) => holding.claimed.id))];
    },
    add(run, claimed, release) {
      held.set(run, { claimed, release });
    },
    settle(run) {
      held.delete(run);
      wakeIfEmpty();
    },
    empty() {
      if (held.size === 0 && handingBack === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    async handBackAll() {
      // Taken out of the set BEFORE the first await: a run settling while the nacks are on the
      // wire is a run the hand-back already owns, and must not be counted twice. And `empty()`
      // stays unanswered until the nacks land — the teardown waiting on it closes the driver next.
      const stranded = [...held.values()];
      held.clear();
      if (stranded.length === 0) return 0;
      handingBack += 1;
      try {
        await handBack(
          options.driver,
          stranded.map((holding) => holding.claimed),
          { delayMs: 0, workerId: options.workerId },
        );
        // After the nacks, never before: the slot is what lets the replacement run a
        // `concurrency: 1` job, and freed first it could be taken while the row was still ours.
        for (const holding of stranded) await holding.release();
      } finally {
        handingBack -= 1;
        wakeIfEmpty();
      }
      return stranded.length;
    },
  };
}
