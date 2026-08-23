// One claimed job run to completion, suspension or failure and settled with the driver — the
// single execution path, shared by the worker loop (`worker-run.ts`) and by the one caller outside
// this package, `@ultimat3/testing`'s job fixture. There is no `x jobs run` to share it with: the
// subcommands are `ls`, `show`, `retry`, `cancel`, `drain`. It owns the run's deadline, and
// a deadline here means CANCEL: the nack that follows makes the job claimable again, so a body
// still running past it would be a second copy of one job, racing the attempt that replaced it.

import type { Actor, Clock, Ctx, ServiceBag } from '@ultimat3/core';
import {
  anonymousActor,
  isUltimateError,
  logger,
  renderThrowable,
  reportError,
  runWithContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver } from './driver';
import { JobAbortedError, JobTimeoutError } from './errors';
import { eventBus } from './events';
import type { AnyJobHandle } from './job';
import type { JobStopReason } from './retry-classification';
import { nextRetryForError, recordedFailure } from './retry-classification';
import { createRunSignal } from './run-signal';
import type { EventLookup, StepRecord } from './steps';
import { createStepRunner, isStepSuspension } from './steps';
import { jobRunActor } from './tenant';

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

/**
 * The same defensive read, for the same reason: `Ctx.actor` is non-optional in the type and
 * `createContext` always sets it, but `WorkerOptions.context()` is the app's own function and a
 * cast context (`{} as Ctx`) reaches here without one. Anonymous is the honest stand-in — it
 * carries no org, so the job's declared tenant is the only thing that can put one on the run.
 */
function callerActor(ctx: Ctx): Actor {
  const actor: Actor | undefined = ctx.actor;
  return actor === undefined ? anonymousActor() : actor;
}

const NO_SERVICES: ServiceBag = Object.freeze({});

/**
 * The same defensive read a third time, and this one is load-bearing rather than merely kind:
 * `withChildContext` ITERATES the parent's bag to decide what carries forward, so a cast context
 * with no `services` would fail the run with a `TypeError` before the body ever started.
 */
function callerServices(ctx: Ctx): ServiceBag {
  const services: ServiceBag | undefined = ctx.services;
  return services === undefined ? NO_SERVICES : services;
}

export interface JobExecution {
  readonly outcome: JobOutcome;
  readonly jobId: string;
  readonly job: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly resumeAt?: number;
  readonly error?: string;
  /** Why this attempt was the last. Absent while the job is still being retried. */
  readonly stopReason?: JobStopReason;
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
 * Shared by the worker loop and by `@ultimat3/testing`'s job fixture, so a job under test takes
 * exactly the code path the worker takes.
 */
export async function executeJob(options: ExecuteJobOptions): Promise<JobExecution> {
  const { driver, claimed, handle } = options;
  const startedAt = nowMs(options.clock);
  // This attempt's cancellation. `ctx.signal` is the framework's ONE cancellation seam — the same
  // one `throwIfAborted` reads in an action — so a job body learns its deadline passed exactly
  // where every other body does, with no jobs-only parameter to know about. Composed with the
  // caller's signal rather than replacing it: a ctx that was already going away still is.
  const cancel = new AbortController();
  // `createRunSignal` and never `AbortSignal.any` — the second of the two sites this package's
  // `CLAUDE.md` states the rule as absolute for. In the worker path `callerSignal` is per-run and
  // nothing leaks; on `@ultimat3/testing`'s job-fixture path, which calls `executeJob` directly,
  // the caller's `ctx.signal` may be process-lifetime, and a composite cannot be undone — so every
  // job a fixture ran left a dependent signal on it for the life of the process. Disposed in the
  // `finally` at the bottom of the try, beside `cancel.abort`.
  const runSignal = createRunSignal([callerSignal(options.ctx), cancel.signal]);
  const signal = runSignal.signal;
  const ctx: Ctx = Object.freeze({
    ...options.ctx,
    signal,
    services: callerServices(options.ctx),
  });
  const runner = createStepRunner({
    runId: claimed.runId,
    jobName: handle.name,
    store: driver.steps,
    signal,
    // The DECLARED per-step ceiling and event poll. Passed here or nowhere: this is the only
    // production construction of a runner, so a `StepRunnerOptions` field it omits is a feature
    // no `job()` can reach — which both of these were until 2026-08.
    ...(handle.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: handle.stepTimeoutMs }),
    ...(handle.eventPollMs === undefined ? {} : { eventPollMs: handle.eventPollMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    events: options.events ?? eventBus(),
  });

  const settle = async (outcome: JobExecution): Promise<JobExecution> => {
    const steps = await driver.steps.list(claimed.runId);
    return { ...outcome, steps, replayed: runner.replayedNames() };
  };

  try {
    const input = handle.parse(claimed.input);
    // The job's DECLARED tenant, on the actor the body runs as. `tenant: 'none'` strips the org
    // rather than inheriting the worker's, so a tenant-scoped read inside such a job fails closed.
    const runActor = jobRunActor(callerActor(ctx), handle.tenantFor(input));
    // Installed as the AMBIENT context and not only handed over as a parameter. This is the whole
    // of the fix: `@ultimat3/entity`'s tenant guard derives from `tryUseContext()`, so a ctx passed
    // as an argument was read by nobody — `actorTenant` answered `undefined`, `scopedPlan` derived
    // no predicate, `verifyScope` returned early, and a row naming another org was written by a
    // job while the identical write over HTTP was refused as `X_TENANCY_ACTOR_MISMATCH`.
    //
    // `withChildContext` and NOT a spread of `ctx`, for the reason it exists: a registered service
    // CLOSES OVER the context it was built for (`defineService`), so the worker's `ctx.posts` would
    // still answer the worker's org while every ambient repository call answered the job's — one
    // run acting as two tenants, which is the same hole one layer up. It rebuilds every managed
    // factory against `runActor` and carries only the services no factory owns.
    const work = runWithContext(ctx, () =>
      withChildContext({ actor: runActor }, () =>
        handle.run({
          input,
          step: runner.step,
          // The child itself, never a rebuilt sibling: the ctx a body is HANDED and the ctx the
          // entity guard READS have to be one object, which is what `tenancy-cross-surface` pins.
          ctx: useContext(),
          attempt: claimed.attempt,
          jobId: claimed.id,
          runId: claimed.runId,
        }),
      ),
    );

    await (handle.timeoutMs === undefined
      ? work
      : raceTimeout(work, handle.timeoutMs, handle.name, cancel));
  } catch (error) {
    if (isStepSuspension(error)) {
      const delayMs = Math.max(0, error.resumeAt - nowMs(options.clock));
      // `park: true` is the suspension itself — the row leaves the ready bucket — and
      // `countsAsAttempt: false` only says not to burn an attempt on it. A limiter shed passes the
      // second and not the first: it is a job still waiting, and it belongs in `queue_depth`.
      await driver.nack(claimed.id, { delayMs, countsAsAttempt: false, park: true });
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

    const message = renderThrowable(error);
    // The ERROR decides too, not only the attempt count. A `terminal` code — a rotated password,
    // a schema mismatch, a permission denial — fails identically on every remaining attempt, so
    // spending them is a queue slot, a provider bill and, at a site that locks an account after
    // three wrong passwords, the framework destroying what it was asked to read. A code nobody
    // classified keeps the attempt-count path exactly as it was.
    const decision = nextRetryForError(handle.retry, claimed.attempt, error);
    const stop = decision.stoppedBy;
    await driver.nack(claimed.id, {
      delayMs: decision.delayMs,
      error: recordedFailure(message, decision),
      countsAsAttempt: true,
      deadLetter: !decision.retry && decision.deadLetter,
    });
    logger.warn('jobs.attempt.failed', {
      job: handle.name,
      jobId: claimed.id,
      attempt: claimed.attempt,
      retry: decision.retry,
      // "stopped because terminal" and "stopped because the attempts ran out" are different
      // incidents with the same `retry: false`, and only one of them is fixed by raising attempts.
      ...(stop === undefined ? {} : { stop }),
      error: message,
    });
    // This package's ONE error-reporting call site, and it is here rather than in the loop because
    // this is the only frame that still holds the thrown value — the loop sees a message string.
    // A retry is a failure the framework recovered from, so it is a `warning`; a dead letter is
    // one nobody recovered from. A job driven by `@ultimat3/testing`'s fixture takes this path
    // too, which is the point: one execution path means one place a failed job becomes visible.
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
          ...(stop === undefined ? {} : { stop }),
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
      ...(stop === undefined ? {} : { stopReason: stop }),
      steps: [],
      replayed: [],
    });
  } finally {
    // The attempt is over however it ended, so nothing from it may still be writing: a step left
    // in flight by a handler that returned without awaiting it settles into a run the next
    // attempt already owns. The runner fences its writes on this signal. A second `abort()` keeps
    // the first reason, so a timed-out run still reports the timeout, not this.
    cancel.abort(new JobAbortedError({ job: handle.name }));
    // AFTER the abort, so the runner's fence still sees it: `dispose` stops following the sources,
    // it never aborts, and the signal keeps whatever state the abort above left it in.
    runSignal.dispose();
  }

  // Only reachable when the BODY succeeded, and settlement is deliberately outside the catch
  // above: an `ack` that rejects — a pool timeout, a reset on that one statement — is not an
  // attempt failure. Nacking it would re-queue work that already ran to completion and report
  // the run as `retried`, so `jobs_total{outcome}` would count a failure that never happened.
  // Let it reach the worker instead, which logs `jobs.worker.settle-failed`; the lease then
  // lapses and the queue re-delivers, which is the honest outcome for "we could not say it ended".
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
        ...(error === undefined ? {} : { error: renderThrowable(error) }),
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
