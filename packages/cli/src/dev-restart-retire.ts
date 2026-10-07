// `x dev`'s restart, worker first (issue #677). A save that reaches a primitive-defining module
// restarts the child, and the drain that ends it used to be the FIRST thing it did: a job that ran
// past the drain budget was aborted `X_DRAINING` and requeued, so a non-idempotent one (a bank
// login) ran twice. The worker is retired first — `stop()` claims nothing and aborts nothing — and
// only then is the drain asked to release the port, the lock and the embedded database.

import { drain, logger, renderThrowable } from '@ultimat3/core';
import type { Worker } from '@ultimat3/jobs';
import { msg } from './messages';
import { writeErrorLine } from './write-line';

/** The two calls a retire makes, so a test hands in a worker without booting a queue. */
export type RetiringWorker = Pick<Worker, 'stats' | 'stop'>;

export interface RetireDeps {
  /** The process drain the restart ends in. Default: core's `drain`. */
  readonly drain: (reason: string) => Promise<void>;
  /** Where the wait is said. Default: stderr — fd 1 may be `--json`'s one document. */
  readonly say: (line: string) => void;
}

const DEFAULT_DEPS: RetireDeps = { drain, say: writeErrorLine };

/**
 * Retire `worker`, then drain. Unbounded on purpose: in development a restart that waits for a
 * long job is the cheaper failure than a side effect run twice, and the line it prints says how to
 * stop waiting — Ctrl-C is a real drain, which binds the worker's teardown to the drain deadline
 * and cuts off what is still running there. A retire that FAILS still drains: a restart left
 * half-done is a child that stopped claiming and never exits.
 */
export async function retireThenDrain(
  worker: RetiringWorker | null,
  deps: RetireDeps = DEFAULT_DEPS,
): Promise<void> {
  try {
    if (worker !== null) {
      const { inFlight } = await worker.stats();
      if (inFlight > 0) deps.say(msg('cli.dev.restartWaiting', { count: inFlight }));
      await worker.stop('x dev restart');
    }
  } catch (error) {
    logger.warn('cli.dev.restart-retire-failed', { error: renderThrowable(error) });
  } finally {
    await deps.drain('restart');
  }
}
