// A `compensates: true` run that failed for good, settled: its compensators run, last-in first-out,
// and only then is the row dead-lettered with the failure it unwound from. A compensator that fails
// hands the row back while the unwind has attempts left (`isFinalUnwindAttempt`); past them, or on
// an unknown `once` step, the row is dead with `X_JOB_COMPENSATION_FAILED`. Split from `execute.ts`.

import type { Clock, Ctx } from '@ultimat3/core';
import {
  failureStack,
  isUltimateError,
  logger,
  renderThrowable,
  reportError,
} from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver, SettleBy } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import type { JobExecution, JobOutcome } from './execute';
import type { AnyJobHandle } from './job';
import { backoffDelayMs, isFinalUnwindAttempt } from './retry';
import type { JobStopReason } from './retry-classification';
import { failureForRow } from './retry-classification';
import type { AnnounceOptions } from './settled';
import { announceSettled, settledCode } from './settled';
import type { StepRunner } from './steps';

/** What the attempt that failed for good knows about its own failure. Absent: already unwinding. */
export interface UnwindFailure {
  readonly thrown: unknown;
  /** As the row records it (`recordedFailure`). */
  readonly recorded: string;
  readonly stop: JobStopReason | undefined;
}

export interface UnwindSettleOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  readonly handle: AnyJobHandle;
  readonly runner: StepRunner;
  readonly ctx: Ctx;
  readonly clock?: Clock;
  /** When the attempt began, on `clock`. */
  readonly startedAt: number;
  readonly by: () => SettleBy;
  readonly landed: (did: boolean, settling: string) => boolean;
  /** `executeJob`'s: the run's steps and replay trace onto the execution it answers. */
  readonly settle: (execution: JobExecution) => Promise<JobExecution>;
  /** The body's scope and parsed payload, for `onSettled`. */
  readonly run: AnnounceOptions['run'];
  /** The worker's drain ended this attempt — the compensator's failure is not its own. */
  readonly drained: () => boolean;
}

type Ending = Pick<JobExecution, 'error' | 'code' | 'resumeAt' | 'stopReason'>;

/** The execution's `code`, when the thrown value carried one. */
const codeOf = (thrown: unknown): Pick<JobExecution, 'code'> => {
  const code = settledCode(thrown);
  return code === undefined ? {} : { code };
};

/** The execution this attempt answers, and `onSettled` after a settle that landed. */
function endings(options: UnwindSettleOptions) {
  const { handle, claimed } = options;
  return {
    finish: (outcome: JobOutcome, extra: Ending): Promise<JobExecution> =>
      options.settle({
        outcome,
        jobId: claimed.id,
        job: handle.name,
        attempt: claimed.attempt,
        durationMs: nowMs(options.clock) - options.startedAt,
        ...extra,
        steps: [],
        replayed: [],
      }),
    announce: (
      outcome: 'dead-lettered' | 'dropped',
      error: string,
      code: string | undefined,
    ): Promise<void> =>
      announceSettled({
        handle,
        claimed,
        ctx: options.ctx,
        ...(options.run === undefined ? {} : { run: options.run }),
        settlement: { outcome, error, code },
      }),
  };
}

/** An unknown `once` step stops the unwind on any attempt: only a person can answer it. */
const isUnknownOutcome = (thrown: unknown): boolean =>
  isUltimateError(thrown) &&
  thrown.code === 'X_JOB_COMPENSATION_FAILED' &&
  thrown.meta?.['outcome'] === 'unknown';

export async function unwindAndSettle(
  options: UnwindSettleOptions,
  failure: UnwindFailure | undefined,
): Promise<JobExecution> {
  const { driver, claimed, handle, runner, by, landed } = options;
  const { finish, announce } = endings(options);
  const policy = handle.retry;
  const keep = policy.deadLetter ?? true;
  const settledAs = keep ? 'dead-lettered' : 'dropped';
  let original: string;
  try {
    // A crash on the final attempt left no failure to read: the claim re-offered the row.
    original = await runner.unwind(failure?.recorded ?? LEASE_LAPSED_FINAL_ATTEMPT);
  } catch (thrown) {
    const message = renderThrowable(thrown);
    if (options.drained()) {
      landed(
        await driver.nack(claimed.id, { ...by(), delayMs: 0, countsAsAttempt: false }),
        'interrupted',
      );
      return finish('interrupted', { error: message });
    }
    if (!isUnknownOutcome(thrown) && !isFinalUnwindAttempt(policy, claimed.attempt)) {
      const delayMs = backoffDelayMs(policy, claimed.attempt);
      // The failure the run unwinds from stays `last_error`: no error here keeps the row's own.
      landed(
        await driver.nack(claimed.id, {
          ...by(),
          delayMs,
          ...(failure === undefined ? {} : { error: failure.recorded }),
          countsAsAttempt: true,
        }),
        'retried',
      );
      logger.warn('jobs.unwind.retried', {
        job: handle.name,
        jobId: claimed.id,
        attempt: claimed.attempt,
        error: message,
      });
      return finish('retried', {
        error: message,
        resumeAt: nowMs(options.clock) + delayMs,
      });
    }
    const recorded = failureForRow(thrown);
    const stack = failureStack(thrown);
    const settled = landed(
      await driver.nack(claimed.id, {
        ...by(),
        delayMs: 0,
        error: recorded,
        ...(stack === undefined ? {} : { stack }),
        countsAsAttempt: true,
        deadLetter: keep,
        fail: !keep,
      }),
      settledAs,
    );
    logger.warn('jobs.unwind.failed', { job: handle.name, jobId: claimed.id, error: message });
    reportError(thrown, {
      source: 'job',
      severity: 'error',
      scope: { operation: handle.name, extra: { jobId: claimed.id, runId: claimed.runId } },
    });
    if (settled) await announce(settledAs, recorded, settledCode(thrown));
    return finish(settledAs, { error: message, ...codeOf(thrown), stopReason: 'terminal' });
  }

  const stack = failure === undefined ? undefined : failureStack(failure.thrown);
  const settled = landed(
    await driver.nack(claimed.id, {
      ...by(),
      delayMs: 0,
      error: original,
      ...(stack === undefined ? {} : { stack }),
      countsAsAttempt: true,
      deadLetter: keep,
      fail: !keep,
    }),
    settledAs,
  );
  logger.warn('jobs.unwind.completed', {
    job: handle.name,
    jobId: claimed.id,
    attempt: claimed.attempt,
    error: original,
  });
  if (failure !== undefined) {
    reportError(failure.thrown, {
      source: 'job',
      severity: 'error',
      scope: { operation: handle.name, extra: { jobId: claimed.id, runId: claimed.runId } },
    });
  }
  if (settled) await announce(settledAs, original, settledCode(failure?.thrown));
  return finish(settledAs, {
    error: original,
    ...codeOf(failure?.thrown),
    stopReason: failure?.stop ?? 'attempts-exhausted',
  });
}
