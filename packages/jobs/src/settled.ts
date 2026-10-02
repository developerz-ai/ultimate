// `onSettled`: the ONE hook a job declares to learn how a run ended — completed (with what the
// body returned), dead-lettered, dropped, or refused by a busy concurrency key. Run AFTER the row
// is settled, by the worker whose settle landed, in the body's own tenant scope, on its own tries,
// and never able to change what the queue recorded: a hook that keeps throwing is logged and
// reported under `X_JOB_ON_SETTLED_FAILED`, and the row stays where it was put.
//
// AT MOST ONCE per settlement across a crash — a worker killed between the settle and the hook
// never runs it — so it is the place for a notification, a status column, a usage line. What must
// be recorded for certain is written by the BODY, inside a `step.run`, where it is at-least-once.

import type { Actor, Ctx } from '@ultimat3/core';
import {
  anonymousActor,
  isUltimateError,
  logger,
  reportError,
  runWithContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { JobOnSettledFailedError } from './errors-operator';
import type { AnyJobHandle } from './job';
import { jobRunActor } from './tenant';

/** Tries the hook gets, back to back. Its own budget: it spends none of the job's attempts. */
export const ON_SETTLED_ATTEMPTS = 3;

interface JobSettledBase {
  /** The attempt that was the last. A refused run reports the attempts its body had had: 0. */
  readonly attempt: number;
  readonly jobId: string;
  readonly runId: string;
  /** The context the hook runs under: the job's declared tenant on its actor. */
  readonly ctx: Ctx;
}

/** The body returned and the ack landed. `result` is what it returned, on THIS attempt. */
export interface JobCompleted<I, R> extends JobSettledBase {
  readonly outcome: 'completed';
  readonly input: I;
  /** Never stored and never serialised: the value itself, handed over in the worker's process. */
  readonly result: R;
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
}

export type JobSettled<I, R = unknown> = JobCompleted<I, R> | JobFailed<I>;

/** What the caller knows about the ending; the run's identity and scope are added here. */
export type Settlement =
  | { readonly outcome: 'completed'; readonly result: unknown }
  | {
      readonly outcome: JobFailed<unknown>['outcome'];
      readonly error: string;
      readonly code: string | undefined;
    };

/** The `X_*` code a thrown value carries, for `JobFailed.code`. */
export const settledCode = (thrown: unknown): string | undefined =>
  isUltimateError(thrown) ? thrown.code : undefined;

/** Runs `fn` as the body runs: the worker's context, the job's declared tenant on its actor. */
export type RunScope = <T>(fn: () => T) => T;

export interface AnnounceOptions {
  readonly handle: AnyJobHandle;
  readonly claimed: Pick<ClaimedJob, 'id' | 'runId' | 'attempt' | 'input'>;
  readonly settlement: Settlement;
  /** The worker's context. Read only when `run` is absent — a run whose body never started. */
  readonly ctx: Ctx;
  /** The body's own scope and parsed payload, when a body ran: `executeJob` already built both. */
  readonly run?: {
    readonly scope: RunScope;
    readonly input: { readonly value: unknown } | undefined;
  };
}

/**
 * The scope and payload of a run whose body never started (a refused one). The payload is parsed
 * and its tenant derived exactly as `executeJob` would have; a payload that no longer parses
 * leaves the worker's own context, under which a tenant-scoped write fails closed.
 */
function unstartedRun(options: AnnounceOptions): NonNullable<AnnounceOptions['run']> {
  const { handle, ctx } = options;
  const worker: RunScope = (fn) => runWithContext(ctx, fn);
  try {
    const value = handle.parse(options.claimed.input);
    const base: Actor | undefined = ctx.actor;
    const actor = jobRunActor(base ?? anonymousActor(), handle.tenantFor(value));
    return {
      scope: (fn) => runWithContext(ctx, () => withChildContext({ actor }, fn)),
      input: { value },
    };
  } catch {
    return { scope: worker, input: undefined };
  }
}

/**
 * Tell the job how its run ended. Never rejects: the caller has already settled the row and has
 * nothing to do with a hook's failure. A job that declared no hook costs one property read.
 */
export async function announceSettled(options: AnnounceOptions): Promise<void> {
  const { handle, claimed, settlement } = options;
  if (!handle.declaresOnSettled) return;
  const run = options.run ?? unstartedRun(options);
  const identity = { attempt: claimed.attempt, jobId: claimed.id, runId: claimed.runId };
  const hook = (): Promise<void> =>
    run.scope(() => {
      const base = { ...identity, ctx: useContext() };
      return handle.onSettled(
        settlement.outcome === 'completed'
          ? { ...base, ...settlement, input: run.input?.value }
          : { ...base, ...settlement, input: run.input?.value },
      );
    });

  let last: unknown;
  for (let attempt = 1; attempt <= ON_SETTLED_ATTEMPTS; attempt += 1) {
    try {
      await hook();
      return;
    } catch (error) {
      last = error;
    }
  }
  const failure = new JobOnSettledFailedError({
    job: handle.name,
    jobId: claimed.id,
    outcome: settlement.outcome,
    attempts: ON_SETTLED_ATTEMPTS,
    error: last,
  });
  logger.error('jobs.on-settled.failed', {
    job: handle.name,
    jobId: claimed.id,
    outcome: settlement.outcome,
    code: failure.code,
    cause: failure.cause,
    fix: failure.fix,
  });
  reportError(failure, {
    source: 'job',
    severity: 'error',
    scope: { operation: handle.name, extra: { jobId: claimed.id, runId: claimed.runId } },
  });
}
