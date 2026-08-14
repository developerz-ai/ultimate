// One claimed job run to completion, suspension or failure and settled with the driver — the
// single execution path the worker loop and `x jobs run` share. It owns the run's deadline, and
// a deadline here means CANCEL: the nack that follows makes the job claimable again, so a body
// still running past it would be a second copy of one job, racing the attempt that replaced it.

import type { Clock, Ctx } from '@ultimat3/core';
import { isUltimateError, logger, reportError } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver } from './driver';
import { JobAbortedError, JobTimeoutError } from './errors';
import { eventBus } from './events';
import type { AnyJobHandle } from './job';
import { nextRetry } from './retry';
import type { EventLookup, StepRecord } from './steps';
import { createStepRunner, isStepSuspension } from './steps';

export type JobOutcome = 'completed' | 'suspended' | 'retried' | 'dead-lettered';

/** Stands in for a caller with nothing to cancel, so the composition below has one shape. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * `Ctx.signal` is non-optional in the type and `createContext` always sets it — but a context can
 * still arrive across a cast (`@ultimat3/http`'s `asCtx`, a test's `{} as Ctx`) without one, and
 * a job that crashed on a missing field would be a far worse answer than a job with no caller to
 * follow. Read it, do not assume it.
 */
function callerSignal(ctx: Ctx): AbortSignal {
  return ctx.signal instanceof AbortSignal ? ctx.signal : NEVER_ABORTED;
}

export interface JobExecution {
  readonly outcome: JobOutcome;
  readonly jobId: string;
  readonly job: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly resumeAt?: number;
  readonly error?: string;
  readonly steps: readonly StepRecord[];
  readonly replayed: readonly string[];
}

export interface ExecuteJobOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  readonly handle: AnyJobHandle;
  readonly ctx: Ctx;
  readonly clock?: Clock;
  readonly events?: EventLookup;
}

/**
 * Run one claimed job to completion, suspension or failure, and settle it with the driver.
 * Shared by the worker loop and `x jobs run` so both take exactly the same code path.
 */
export async function executeJob(options: ExecuteJobOptions): Promise<JobExecution> {
  const { driver, claimed, handle } = options;
  const startedAt = nowMs(options.clock);
  // This attempt's cancellation. `ctx.signal` is the framework's ONE cancellation seam — the same
  // one `throwIfAborted` reads in an action — so a job body learns its deadline passed exactly
  // where every other body does, with no jobs-only parameter to know about. Composed with the
  // caller's signal rather than replacing it: a ctx that was already going away still is.
  const cancel = new AbortController();
  const signal = AbortSignal.any([callerSignal(options.ctx), cancel.signal]);
  const ctx: Ctx = Object.freeze({ ...options.ctx, signal });
  const runner = createStepRunner({
    runId: claimed.runId,
    jobName: handle.name,
    store: driver.steps,
    signal,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    events: options.events ?? eventBus(),
  });

  const settle = async (outcome: JobExecution): Promise<JobExecution> => {
    const steps = await driver.steps.list(claimed.runId);
    return { ...outcome, steps, replayed: runner.replayedNames() };
  };

  try {
    const input = handle.parse(claimed.input);
    const work = handle.run({
      input,
      step: runner.step,
      ctx,
      attempt: claimed.attempt,
      jobId: claimed.id,
      runId: claimed.runId,
    });

    await (handle.timeoutMs === undefined
      ? work
      : raceTimeout(work, handle.timeoutMs, handle.name, cancel));

    await driver.ack(claimed.id);
    return settle({
      outcome: 'completed',
      jobId: claimed.id,
      job: handle.name,
      attempt: claimed.attempt,
      durationMs: nowMs(options.clock) - startedAt,
      steps: [],
      replayed: [],
    });
  } catch (error) {
    if (isStepSuspension(error)) {
      const delayMs = Math.max(0, error.resumeAt - nowMs(options.clock));
      // countsAsAttempt: false — parking a run is not a failure.
      await driver.nack(claimed.id, { delayMs, countsAsAttempt: false });
      return settle({
        outcome: 'suspended',
        jobId: claimed.id,
        job: handle.name,
        attempt: claimed.attempt,
        durationMs: nowMs(options.clock) - startedAt,
        resumeAt: error.resumeAt,
        steps: [],
        replayed: [],
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    const decision = nextRetry(handle.retry, claimed.attempt);
    await driver.nack(claimed.id, {
      delayMs: decision.delayMs,
      error: message,
      countsAsAttempt: true,
      deadLetter: !decision.retry && decision.deadLetter,
    });
    logger.warn('jobs.attempt.failed', {
      job: handle.name,
      jobId: claimed.id,
      attempt: claimed.attempt,
      retry: decision.retry,
      error: message,
    });
    // This package's ONE error-reporting call site, and it is here rather than in the loop because
    // this is the only frame that still holds the thrown value — the loop sees a message string.
    // A retry is a failure the framework recovered from, so it is a `warning`; a dead letter is
    // one nobody recovered from. `x jobs run` takes this path too, which is the point: one
    // execution path means one place a failed job can become visible.
    reportError(error, {
      source: 'job',
      severity: decision.retry ? 'warning' : 'error',
      scope: {
        operation: handle.name,
        extra: {
          jobId: claimed.id,
          runId: claimed.runId,
          attempt: claimed.attempt,
          retry: decision.retry,
        },
      },
    });
    return settle({
      outcome: decision.retry ? 'retried' : 'dead-lettered',
      jobId: claimed.id,
      job: handle.name,
      attempt: claimed.attempt,
      durationMs: nowMs(options.clock) - startedAt,
      error: message,
      steps: [],
      replayed: [],
    });
  } finally {
    // The attempt is over however it ended, so nothing from it may still be writing: a step left
    // in flight by a handler that returned without awaiting it settles into a run the next
    // attempt already owns. The runner fences its writes on this signal. A second `abort()` keeps
    // the first reason, so a timed-out run still reports the timeout, not this.
    cancel.abort(new JobAbortedError({ job: handle.name }));
  }
}

/**
 * The run's deadline. It CANCELS before it rejects, and the order is the whole point: the caller
 * nacks on this rejection and the queue hands the job straight to another worker, so the body has
 * to have been told to stop before that becomes possible.
 *
 * Nothing in JS can kill a body that ignores the signal, so what is left is to say so: a run that
 * settles after its deadline logs `jobs.timeout.abandoned`, which is how an app finds the handler
 * that never reads `ctx.signal`. A body that stopped BECAUSE it was cancelled is the intended end
 * and stays quiet.
 */
function raceTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
  job: string,
  cancel: AbortController,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      const failure = new JobTimeoutError({ job, timeoutMs });
      cancel.abort(failure);
      reject(failure);
    }, timeoutMs);
    const abandoned = (ended: 'resolved' | 'rejected', error?: unknown): void => {
      logger.warn('jobs.timeout.abandoned', {
        job,
        timeoutMs,
        ended,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      });
    };
    work.then(
      (value) => {
        clearTimeout(timer);
        if (expired) abandoned('resolved');
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (!expired) reject(error);
        else if (!isCancellation(error, cancel.signal.reason)) abandoned('rejected', error);
      },
    );
  });
}

/** The body stopped because we cancelled it: our own reason back, or a fenced step write. */
function isCancellation(error: unknown, reason: unknown): boolean {
  return error === reason || (isUltimateError(error) && error.code === 'X_ABORTED');
}
