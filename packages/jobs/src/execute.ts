// One claimed job run to completion, suspension or failure and settled with the driver — the
// single execution path, shared by the worker loop (`worker-run.ts`) and by the one caller outside
// this package, `@ultimat3/testing`'s job fixture. There is no `x jobs run` to share it with: the
// subcommands are `ls`, `show`, `retry`, `cancel`, `drain`. It owns the run's deadline, and
// a deadline here means CANCEL: the nack that follows makes the job claimable again, so a body
// still running past it would be a second copy of one job, racing the attempt that replaced it.

import type { Clock, Ctx } from '@ultimat3/core';
import {
  failureStack,
  logger,
  renderThrowable,
  reportError,
  runWithContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import { outsideTransaction } from '@ultimat3/db';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver, SettleBy } from './driver';
import { claimOf } from './driver';
import { JobAbortedError } from './errors';
import { eventBus } from './events';
import { callerActor, callerServices, callerSignal, drainedBy } from './execute-ctx';
import type { JobExecution } from './execute-result';
import type { UnwindSettleOptions } from './execute-unwind';
import { unwindAndSettle } from './execute-unwind';
import type { AnyJobHandle } from './job';
import { createProgressReporter } from './progress';
import { isFinalAttempt, isUnwindAttempt } from './retry';
import {
  failureForRow,
  nextRetryForError,
  rateLimitDeferralMs,
  recordedFailure,
} from './retry-classification';
import { raceTimeout } from './run-deadline';
import { createRunSignal } from './run-signal';
import { announceSettled, settledCode } from './settled';
import type { EventLookup } from './steps';
import { isStepSuspension, stepRunner } from './steps';
import { isUnwindReached } from './steps-suspension';
import { jobRunActor, refuseRunTenant } from './tenant';

export interface ExecuteJobOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  readonly handle: AnyJobHandle;
  readonly ctx: Ctx;
  readonly clock?: Clock;
  readonly events?: EventLookup;
  /**
   * Why this run may not start, decided before the body: the worker could not derive the run's
   * concurrency key (its `key` function threw, or the row no longer parses), so it holds no slot
   * and running it would be a run outside its own cap. Failed as an ordinary attempt.
   */
  readonly refusal?: unknown;
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
  // The attempt's END, apart from its cancellation: aborted in the `finally` however the attempt
  // ended, so the step runner records nothing after it. `cancel` — what `ctx.signal` follows — is
  // aborted only when another attempt may own the run: a failure, a suspension, an ack that did
  // not land. A body that COMPLETED and was acked owns a finished run, and a timer it armed (a log
  // flush, a deferred enqueue) still writes; reading as "cancelled" lost every such write.
  const ended = new AbortController();
  let completed = false;
  // `createRunSignal` and never `AbortSignal.any` — the second of the two sites this package's
  // `CLAUDE.md` states the rule as absolute for. In the worker path `callerSignal` is per-run and
  // nothing leaks; on `@ultimat3/testing`'s job-fixture path, which calls `executeJob` directly,
  // the caller's `ctx.signal` may be process-lifetime, and a composite cannot be undone — so every
  // job a fixture ran left a dependent signal on it for the life of the process. Disposed in the
  // `finally` at the bottom of the try, beside `cancel.abort`.
  const runSignal = createRunSignal([callerSignal(options.ctx), cancel.signal]);
  const signal = runSignal.signal;
  /**
   * This attempt no longer owns the run: `ctx.signal` aborts, so a write still under it is refused
   * (`abandonment()`). A second `abort()` keeps the first reason — a timed-out run still reports
   * the timeout. `dispose` AFTER it: it stops following the sources and never aborts.
   */
  const release = (): void => {
    cancel.abort(new JobAbortedError({ job: handle.name }));
    runSignal.dispose();
  };
  const ctx: Ctx = Object.freeze({
    ...options.ctx,
    signal,
    services: callerServices(options.ctx),
  });
  const runner = stepRunner({
    runId: claimed.runId,
    jobName: handle.name,
    store: driver.steps,
    fence: { job: handle.name, jobId: claimed.id, ...claimOf(claimed) },
    signal,
    // This attempt's OWN end — the deadline, the `finally` below — apart from the run's signal,
    // whose first reason may be the drain's: a drained step still records, an ended attempt never.
    ended: ended.signal,
    // The DECLARED per-step ceiling and event poll. Passed here or nowhere: this is the only
    // production construction of a runner, so a `StepRunnerOptions` field it omits is a feature
    // no `job()` can reach — which both of these were until 2026-08.
    ...(handle.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: handle.stepTimeoutMs }),
    ...(handle.eventPollMs === undefined ? {} : { eventPollMs: handle.eventPollMs }),
    // Compensation is the job's declaration; an attempt past the policy's last is the claim
    // re-offering a final attempt that crashed, and unwinds whatever its steps say.
    compensates: handle.compensates,
    unwind: handle.compensates && isUnwindAttempt(handle.retry, claimed.attempt),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    events: options.events ?? eventBus(),
  });

  // Who settles, and how long the attempt took — the fence and the counter's duration, in one
  // value both settles are handed.
  const by = (): SettleBy => ({
    ...claimOf(claimed),
    durationMs: nowMs(options.clock) - startedAt,
  });
  const introspect = driver.introspect;
  const progress = createProgressReporter({
    job: handle.name,
    jobId: claimed.id,
    write:
      introspect === undefined
        ? undefined
        : (value) => introspect.recordProgress(claimed.id, claimOf(claimed), value),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  /**
   * A settle that matched nothing: the row is another worker's now — this one's lease lapsed and
   * the queue re-delivered — or it was cancelled. Logged, never thrown: theirs is the verdict.
   */
  const landed = (did: boolean, settling: string): boolean => {
    if (!did) {
      logger.warn('jobs.settle.unowned', {
        job: handle.name,
        jobId: claimed.id,
        workerId: claimed.claimedBy,
        settling,
      });
    }
    return did;
  };
  /** The parsed payload, once it has parsed — what `onSettled` is handed. */
  let parsed: { readonly value: unknown } | undefined;
  /** What the body returned, for `onSettled` and for the execution this answers. */
  let result: unknown;
  /**
   * Runs `fn` as the body runs: `ctx` ambient, the job's DECLARED tenant on the actor. Until the
   * payload has parsed there is no tenant to derive, so the worker's own context stands in — and
   * a tenant-scoped read under it fails closed, which is right for a payload nobody could read.
   */
  //
  // Outside any transaction, always: a worker started inside a transaction scope (a test, a boot
  // that ran inside one) carried it into every timer of its loop, so each body saw that
  // transaction — committed long before — as ambient, `db()` answered with it, and an enqueue from
  // the body staged into its dead outbox. A job opens its own `withTransaction` when it wants one.
  let inRunScope = <T>(fn: () => T): T => outsideTransaction(() => runWithContext(ctx, fn));

  const settle = async (outcome: JobExecution): Promise<JobExecution> => {
    const steps = await driver.steps.list(claimed.runId);
    return { ...outcome, steps, replayed: runner.replayedNames() };
  };

  /** Everything `unwindAndSettle` needs of this attempt — built only when a run unwinds. */
  const unwinder = (): UnwindSettleOptions => ({
    driver,
    claimed,
    handle,
    runner,
    ctx,
    startedAt,
    by,
    landed,
    settle,
    run: { scope: inRunScope, input: parsed },
    drained: () => drainedBy(signal),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  try {
    // Raised INSIDE the try so it takes the one failure path below — classified, nacked, logged
    // and reported exactly as if the body had thrown it — and the body never starts.
    if (options.refusal !== undefined) throw options.refusal;
    const input = handle.parse(claimed.input);
    parsed = { value: input };
    // The job's DECLARED tenant, on the actor the body runs as. `tenant: 'none'` strips the org
    // rather than inheriting the worker's, so a tenant-scoped read inside such a job fails closed.
    const declared = handle.tenantFor(input);
    // A row queued for one org whose payload names another: refused before the body, terminally.
    refuseRunTenant(handle.name, declared, claimed.tenantId);
    const runActor = jobRunActor(callerActor(ctx), declared);
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
    inRunScope = (fn) =>
      outsideTransaction(() =>
        runWithContext(ctx, () => withChildContext({ actor: runActor }, fn)),
      );
    const work = inRunScope(() =>
      handle.run({
        input,
        step: runner.step,
        // The child itself, never a rebuilt sibling: the ctx a body is HANDED and the ctx the
        // entity guard READS have to be one object, which is what `tenancy-cross-surface` pins.
        ctx: useContext(),
        attempt: claimed.attempt,
        // The comparison `nextRetry` stops on, over the same two operands — never a second one.
        finalAttempt: isFinalAttempt(handle.retry, claimed.attempt),
        progress: progress.report,
        jobId: claimed.id,
        runId: claimed.runId,
      }),
    );

    result = await (handle.timeoutMs === undefined
      ? work
      : raceTimeout(work, handle.timeoutMs, handle.name, cancel));
    // An unwinding run's replay that RETURNED is still unwinding: the decision is durable.
    // `return await`, at every unwind: the `finally` below ends the attempt, and the compensators
    // must run — and write — before it does.
    if (handle.compensates && (await runner.unwinding())) {
      return await unwindAndSettle(unwinder(), undefined);
    }
    completed = true;
  } catch (error) {
    // Before ANY settle: the last value a body reported is written while the row is still this
    // worker's, which is the only time `recordProgress`'s fence lets it land.
    await progress.flush();
    if (isStepSuspension(error)) {
      const delayMs = Math.max(0, error.resumeAt - nowMs(options.clock));
      // `park: true` is the suspension itself — the row leaves the ready bucket — and
      // `countsAsAttempt: false` only says not to burn an attempt on it. A limiter shed passes the
      // second and not the first: it is a job still waiting, and it belongs in `queue_depth`.
      landed(
        await driver.nack(claimed.id, { ...by(), delayMs, countsAsAttempt: false, park: true }),
        'suspended',
      );
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
    // The code beside the message: a caller judging the failure (`x exercise`) reads a coded
    // refusal by its code, as it reads an action's, and the message alone had lost it.
    const thrownCode = settledCode(error);
    const coded = thrownCode === undefined ? {} : { code: thrownCode };
    // Unwinding already: the replay stopped at its first incomplete step (`UnwindReached`) or
    // ended any other way. Never retried forward — a drain still hands the attempt back.
    if (
      handle.compensates &&
      !drainedBy(signal) &&
      (isUnwindReached(error) || (await runner.unwinding().catch(() => false)))
    ) {
      return await unwindAndSettle(unwinder(), undefined);
    }
    if (drainedBy(signal)) {
      // The worker's drain told this body to stop, and it did. Whatever it stopped WITH is the
      // framework's doing — the reason itself back from `fetch`, `throwIfAborted`'s `X_ABORTED`,
      // a fenced step write, or an app's own coded error for a child the shutdown killed — so
      // the attempt is handed back rather than failed: `countsAsAttempt: false`, no park, no
      // dead letter, claimable at once by the worker replacing this one. Read off the SIGNAL and
      // not the error, because the body's error is not always the signal's reason, and an
      // attempt burned per deploy is the "always twice" draining exists to prevent. The `error`
      // is still recorded on the row: `x jobs show` should say why the last attempt ended.
      landed(
        await driver.nack(claimed.id, {
          ...by(),
          delayMs: 0,
          error: failureForRow(error),
          countsAsAttempt: false,
        }),
        'interrupted',
      );
      logger.info('jobs.attempt.interrupted', {
        job: handle.name,
        jobId: claimed.id,
        attempt: claimed.attempt,
        error: message,
      });
      return settle({
        outcome: 'interrupted',
        jobId: claimed.id,
        job: handle.name,
        attempt: claimed.attempt,
        durationMs: nowMs(options.clock) - startedAt,
        error: message,
        ...coded,
        steps: [],
        replayed: [],
      });
    }
    // A rate-limit refusal is "not yet": rescheduled for its Retry-After with the attempt
    // UNCOUNTED, like a suspension — but left in the ready bucket (no park): it is a job still
    // waiting, and it belongs in `queue_depth`. Counted, a backlog of rate-limited `llm()` jobs was
    // dead-lettered for having waited on a bucket that was only ever going to refill.
    const deferMs = rateLimitDeferralMs(handle.retry, claimed.attempt, error);
    if (deferMs !== undefined) {
      landed(
        await driver.nack(claimed.id, {
          ...by(),
          delayMs: deferMs,
          error: failureForRow(error),
          countsAsAttempt: false,
        }),
        'retried',
      );
      logger.info('jobs.attempt.rate_limited', {
        job: handle.name,
        jobId: claimed.id,
        attempt: claimed.attempt,
        delayMs: deferMs,
      });
      return settle({
        outcome: 'retried',
        jobId: claimed.id,
        job: handle.name,
        attempt: claimed.attempt,
        durationMs: nowMs(options.clock) - startedAt,
        error: message,
        ...coded,
        resumeAt: nowMs(options.clock) + deferMs,
        steps: [],
        replayed: [],
      });
    }
    // The ERROR decides too, not only the attempt count. A `terminal` code — a rotated password,
    // a schema mismatch, a permission denial — fails identically on every remaining attempt, so
    // spending them is a queue slot, a provider bill and, at a site that locks an account after
    // three wrong passwords, the framework destroying what it was asked to read. A code nobody
    // classified keeps the attempt-count path exactly as it was.
    const decision = nextRetryForError(handle.retry, claimed.attempt, error);
    const stop = decision.stoppedBy;
    // Failed for good with `deadLetter: false`: the row is DROPPED — settled `failed`. It was
    // nacked with neither flag, which both drivers file `ready`, so a job its author declared
    // "do not keep" was re-claimed and re-run forever with its attempt counter climbing.
    const dropped = !decision.retry && !decision.deadLetter;
    const recorded = recordedFailure(failureForRow(error), decision);
    // Failed for good, and the job undoes its steps: compensators first, the dead letter after.
    if (!decision.retry && handle.compensates) {
      return await unwindAndSettle(unwinder(), { thrown: error, recorded, stop });
    }
    const stack = failureStack(error);
    const settled = landed(
      await driver.nack(claimed.id, {
        ...by(),
        delayMs: decision.delayMs,
        error: recorded,
        ...(stack === undefined ? {} : { stack }),
        countsAsAttempt: true,
        deadLetter: !decision.retry && decision.deadLetter,
        fail: dropped,
      }),
      decision.retry ? 'retried' : dropped ? 'dropped' : 'dead-lettered',
    );
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
    // After the row is settled, and only by the worker whose settle landed: a run this worker no
    // longer owns is not this worker's ending to announce. Under the body's own scope, so the
    // hook's tenant-scoped writes — "mark this connection broken" — are the job's tenant's.
    if (!decision.retry && settled) {
      await announceSettled({
        handle,
        claimed,
        ctx,
        run: { scope: inRunScope, input: parsed },
        settlement: {
          outcome: dropped ? 'dropped' : 'dead-lettered',
          error: recorded,
          code: settledCode(error),
        },
      });
    }
    return settle({
      outcome: decision.retry ? 'retried' : dropped ? 'dropped' : 'dead-lettered',
      jobId: claimed.id,
      job: handle.name,
      attempt: claimed.attempt,
      durationMs: nowMs(options.clock) - startedAt,
      error: message,
      ...coded,
      // When the retry falls due, on this process's clock — what lets the worker that failed it
      // pass again at that moment instead of finding out on a backed-off poll.
      ...(decision.retry ? { resumeAt: nowMs(options.clock) + decision.delayMs } : {}),
      ...(stop === undefined ? {} : { stopReason: stop }),
      steps: [],
      replayed: [],
    });
  } finally {
    // The attempt is over however it ended, so no step from it may still record: a step left in
    // flight by a handler that returned without awaiting it would settle into a run the next
    // attempt may own. The runner fences its writes on `ended`.
    ended.abort(new JobAbortedError({ job: handle.name }));
    if (!completed) release();
  }

  // Only reachable when the BODY succeeded, and settlement is deliberately outside the catch
  // above: an `ack` that rejects — a pool timeout, a reset on that one statement — is not an
  // attempt failure. Nacking it would re-queue work that already ran to completion and report
  // the run as `retried`, so `jobs_total{outcome}` would count a failure that never happened.
  // Let it reach the worker instead, which logs `jobs.worker.settle-failed`; the lease then
  // lapses and the queue re-delivers, which is the honest outcome for "we could not say it ended".
  await progress.flush();
  let acked = false;
  try {
    acked = landed(await driver.ack(claimed.id, by()), 'completed');
  } finally {
    // Unacked, the row is another worker's (or re-delivered once the lease lapses): cancelled.
    if (!acked) release();
    // Acked, the run is finished and owned by nobody: the signal stops following its sources and
    // stays un-aborted, so work the body deliberately left running keeps landing.
    else runSignal.dispose();
  }
  // Announced only when the ack LANDED: a row cancelled or re-delivered under this body is
  // somebody else's to settle, and `completed` would be a claim about a row that is not `done`.
  if (acked) {
    await announceSettled({
      handle,
      claimed,
      ctx,
      run: { scope: inRunScope, input: parsed },
      settlement: { outcome: 'completed', result },
    });
  }
  return settle({
    outcome: 'completed',
    jobId: claimed.id,
    job: handle.name,
    attempt: claimed.attempt,
    durationMs: nowMs(options.clock) - startedAt,
    result,
    steps: [],
    replayed: [],
  });
}
