// `ROLE=worker`'s retire, on SIGUSR2 (issue #669): stop claiming, finish every held job however
// long it takes, abort nothing — then the ordinary drain, so the process exits 0. It is what a
// Kubernetes `preStop` sends before the SIGTERM a rollout ends in, for a job whose side effect may
// happen at most once and may outlast the drain budget. Framework-owned: no port, no app code.

import { drain, logger, markRetiring, renderThrowable } from '@ultimat3/core';
import type { Worker } from '@ultimat3/jobs';

/** The signal a worker retires on. Free in Bun and Node (SIGUSR1 is the inspector's). */
export const RETIRE_SIGNAL = 'SIGUSR2';

/** The two calls a retire makes on the worker. */
export type RetiringWorker = Pick<Worker, 'stats' | 'stop'>;

/** Where the signal is heard — `process` by default, a hand-raised source in a test. */
export interface RetireSignals {
  on(signal: typeof RETIRE_SIGNAL, listener: () => void): void;
  off(signal: typeof RETIRE_SIGNAL, listener: () => void): void;
}

export interface WorkerRetireOptions {
  /** Default `process.platform`. `win32` installs nothing: Windows has no SIGUSR2. */
  readonly platform?: string;
  readonly signals?: RetireSignals;
  /** What the retire ends in. Default core's `drain` — the hold then releases and exits 0. */
  readonly drain?: (signal: string) => Promise<void>;
}

export interface WorkerRetire {
  /** The worker the boot started (`null` when it started none) — a signal before this waits. */
  adopt(worker: RetiringWorker | null): void;
  /** Give the listener back: a boot that failed, or a hold that is over. */
  disarm(): void;
}

const NOTHING: WorkerRetire = Object.freeze({ adopt: () => undefined, disarm: () => undefined });

/**
 * Listen for `RETIRE_SIGNAL` NOW, before the boot: Bun's default for an unhandled SIGUSR2 ends the
 * process, so a `preStop` that lands while the pod still boots must meet this listener, which waits
 * for the worker and then retires it. One retire per process; a second signal joins it.
 *
 * Exits rather than holds, decided 2026-10-07: the `preStop` has no channel back but PID 1 itself,
 * so "retired" has to be observable as "PID 1 is gone" — and a pod that has stopped claiming serves
 * nothing it could keep holding for. A SIGTERM landing mid-retire is the ordinary drain: it binds
 * the retire to the worker's budget — `drain.workerDeadlineMs`, else `drain.deadlineMs` — and cuts
 * off at the margin (`packages/jobs/src/worker.ts`). `isRetiring()` is true from the signal on.
 */
export function armWorkerRetire(options: WorkerRetireOptions = {}): WorkerRetire {
  if ((options.platform ?? process.platform) === 'win32') return NOTHING;
  const signals: RetireSignals = options.signals ?? process;
  const finish = options.drain ?? drain;
  let adopt: (worker: RetiringWorker | null) => void = () => undefined;
  const adopted = new Promise<RetiringWorker | null>((resolve) => {
    adopt = resolve;
  });
  let retiring = false;

  const retire = async (): Promise<void> => {
    const worker = await adopted;
    try {
      if (worker !== null) {
        const before = await worker.stats();
        logger.info('jobs.worker.retiring', {
          signal: RETIRE_SIGNAL,
          workerId: before.workerId,
          inFlight: before.inFlight,
        });
        await worker.stop(RETIRE_SIGNAL);
        const after = await worker.stats();
        logger.info('jobs.worker.retired', {
          signal: RETIRE_SIGNAL,
          workerId: after.workerId,
          state: after.state,
          inFlight: after.inFlight,
        });
      }
    } catch (error) {
      logger.warn('jobs.worker.retire-failed', { error: renderThrowable(error) });
    } finally {
      await finish(RETIRE_SIGNAL);
    }
  };

  const listener = (): void => {
    if (retiring) return;
    retiring = true;
    // At the signal, before the worker is awaited or stopped: the app's `isRetiring()` is how its
    // own code (a heartbeat, a status row) sees a retire that `isDraining()` only shows at the end.
    markRetiring();
    // Never rejects: `retire` catches its own failure and always reaches the drain.
    void retire();
  };
  signals.on(RETIRE_SIGNAL, listener);
  return {
    adopt: (worker) => adopt(worker),
    disarm: () => signals.off(RETIRE_SIGNAL, listener),
  };
}
