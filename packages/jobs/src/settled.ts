// `onSettled`: the ONE hook a job declares to learn how a run ended — completed (with what the
// body returned), dead-lettered, dropped, or refused by a busy concurrency key. Run AFTER the row
// is settled, by the worker whose settle landed, in the body's own tenant scope, on its own tries,
// and never able to change what the queue recorded: a hook that keeps throwing is logged and
// reported under `X_JOB_ON_SETTLED_FAILED`, and the row stays where it was put.
//
// AT LEAST ONCE per settlement across a crash (J11): the settle records the debt in its own write
// (`SettleBy.owesSettle`), the hook's return clears it, and the scheduler leader re-drives a debt
// a dead worker left (`settle-redrive.ts`, `redriven: true`) — a completion only when its body
// returned `undefined`, since a result is never stored. Write the hook to be repeated.

import type { Actor, Ctx } from '@ultimat3/core';
import {
  anonymousActor,
  isUltimateError,
  logger,
  renderThrowable,
  reportError,
  runToCompletion,
  runWithContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import type { SettleDebt } from './driver-settle';
import { JobTimeoutError } from './errors';
import { JobOnSettledFailedError } from './errors-operator';
import type { AnyJobHandle } from './job';
import type { JobCompleted, JobFailed, Settlement } from './settled-types';
import { withStepTimeout } from './steps-timeout';
import { jobRunActor } from './tenant';

/** Tries the hook gets, back to back. Its own budget: it spends none of the job's attempts. */
export const ON_SETTLED_ATTEMPTS = 3;

/**
 * The hook's ceiling unless the job declares `onSettledTimeout`, every try included. A notification
 * is seconds of work, and this is what stops N hooks on a dead host wedging a worker of N slots.
 */
export const ON_SETTLED_TIMEOUT_MS = 30_000;

export type { JobCompleted, JobFailed, JobSettled, Settlement } from './settled-types';

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
  /**
   * The debt the settle recorded (`SettleBy.owesSettle`): paid once the hook has returned or used
   * every try, under the claim the row was settled with. Absent, nothing was recorded to pay.
   */
  readonly owed?: { readonly debt: SettleDebt | undefined; readonly claim: number };
}

type Identity = 'attempt' | 'jobId' | 'runId' | 'ctx';
type Ending = Omit<JobCompleted<unknown, unknown>, Identity> | Omit<JobFailed<unknown>, Identity>;

/** What the hook is handed, apart from the run's identity and context. */
function endingOf(settlement: Settlement, input: unknown): Ending {
  const { redriven, ...ending } = settlement;
  return { ...ending, input, ...(redriven === true ? { redriven, reason: 'lost' } : {}) };
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
 * Tell the job how its run ended, then pay the debt the settle recorded. Never rejects: the caller
 * has already settled the row and has nothing to do with a hook's failure. A job that declared no
 * hook costs one property read.
 */
export async function announceSettled(options: AnnounceOptions): Promise<void> {
  if (!options.handle.declaresOnSettled) return;
  await tell(options);
  const owed = options.owed;
  if (owed?.debt === undefined) return;
  // A hook that used every try is paid too: the debt is for a crash, and a hook that keeps
  // throwing is `X_JOB_ON_SETTLED_FAILED`'s, re-driven forever otherwise. A clear that fails
  // leaves it owed, and the leader runs the hook once more: at least once, never at most.
  await owed.debt.clear(options.claimed.id, owed.claim).catch((error: unknown) => {
    logger.warn('jobs.on-settled.unpaid', {
      job: options.handle.name,
      jobId: options.claimed.id,
      error: renderThrowable(error),
    });
  });
}

async function tell(options: AnnounceOptions): Promise<void> {
  const { handle, claimed, settlement } = options;
  const run = options.run ?? unstartedRun(options);
  const identity = { attempt: claimed.attempt, jobId: claimed.id, runId: claimed.runId };
  const timeoutMs = handle.onSettledTimeoutMs;
  // One budget over every try, read by the hook as `ctx.signal`: past it, its writes refuse too.
  const ceiling = new AbortController();
  const hook = (): Promise<void> =>
    // A live signal: the attempt's own `finally` aborted the run's before the ack, so every completed
    // hook ran cancelled, its `fetch(url, { signal })` failing and its writes refused.
    run.scope(() =>
      runToCompletion(
        () => {
          const base = { ...identity, ctx: useContext() };
          return handle.onSettled({ ...base, ...endingOf(settlement, run.input?.value) });
        },
        { signal: ceiling.signal, deadlineAt: useContext().now().getTime() + timeoutMs },
      ),
    );

  let last: unknown;
  let tries = 0;
  const everyTry = async (): Promise<boolean> => {
    while (tries < ON_SETTLED_ATTEMPTS && !ceiling.signal.aborted) {
      tries += 1;
      try {
        await hook();
        return true;
      } catch (error) {
        last = error;
      }
    }
    return false;
  };
  try {
    const landed = await withStepTimeout(
      everyTry(),
      timeoutMs,
      ceiling,
      () =>
        new JobTimeoutError({
          job: handle.name,
          step: 'onSettled',
          timeoutMs,
          fix: `job({ name: '${handle.name}', onSettledTimeout: '5m' })   # raises the hook's ceiling; or pass ctx.signal to what the hook waits on`,
        }),
    );
    if (landed) return;
  } catch (error) {
    last = error;
  }
  const failure = new JobOnSettledFailedError({
    job: handle.name,
    jobId: claimed.id,
    outcome: settlement.outcome,
    attempts: tries,
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
