// What `onSettled` is handed: how one run ended, as the hook reads it, and what its caller knows
// of the ending before the run's identity is added. Split off `settled.ts`, which runs the hook;
// re-exported from it unchanged.

import type { Ctx } from '@ultimat3/core';

interface JobSettledBase {
  /** The attempt that was the last. A refused run reports the attempts its body had had: 0. */
  readonly attempt: number;
  readonly jobId: string;
  readonly runId: string;
  /** The context the hook runs under: the job's declared tenant on its actor. */
  readonly ctx: Ctx;
}

/**
 * The body returned and the ack landed. `result` is what it returned, on THIS attempt.
 *
 * `redriven: true` (`reason: 'lost'`): the worker whose ack landed died before its hook returned,
 * and the scheduler leader tells the hook again. A result is never stored, so only a body that
 * returned `undefined` is owed a re-drive — the value it is handed is then the true one. A
 * completion that returned a value is told at most once across a crash.
 */
export interface JobCompleted<I, R> extends JobSettledBase {
  readonly outcome: 'completed';
  readonly input: I;
  /** Never stored and never serialised: the value itself, handed over in the worker's process. */
  readonly result: R;
  /** Absent when the worker that settled the row tells it; `true` on the leader's re-drive. */
  readonly redriven?: true;
  /** Why the hook is told again: the worker that settled the row did not live to tell it. */
  readonly reason?: 'lost';
}

/**
 * The run ended without completing, for good. `dead-lettered`: parked in the dead-letter queue.
 * `dropped`: failed for good on a job declaring `retry.deadLetter: false`. `refused`:
 * `whenBusy: 'fail'` over a busy concurrency key — the body never ran.
 */
export interface JobFailed<I> extends JobSettledBase {
  readonly outcome: 'dead-lettered' | 'dropped' | 'refused';
  /** The payload — `undefined` when the stored one no longer parses, which is why it died. */
  readonly input: I | undefined;
  /** The failure the row records as `lastError`, fix included. */
  readonly error: string;
  /** Its `X_*` code, when what was thrown carried one. Never invented for a throw that had none. */
  readonly code: string | undefined;
  /** `true` when the scheduler leader re-drives a hook a dead worker owed (`reason: 'lost'`). */
  readonly redriven?: true;
  readonly reason?: 'lost';
}

export type JobSettled<I, R = unknown> = JobCompleted<I, R> | JobFailed<I>;

/** What the caller knows about the ending; the run's identity and scope are added here. */
export type Settlement =
  | { readonly outcome: 'completed'; readonly result: unknown; readonly redriven?: true }
  | {
      readonly outcome: JobFailed<unknown>['outcome'];
      readonly error: string;
      readonly code: string | undefined;
      readonly redriven?: true;
    };
