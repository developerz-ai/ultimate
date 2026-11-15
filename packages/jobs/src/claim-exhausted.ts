// The claim round's half of a burial: what the claim is told of the registry (`burialPolicy`), and
// for a row it settled (`onExhausted`) — no body to end it — a log line, its `jobs_total` count and
// the job's `onSettled`, told beside the pass (`burialTeller`). AT LEAST ONCE: the claim records the
// debt in its own write, the telling pays it, and a dead burier's is re-driven.

import type { Clock, Ctx } from '@ultimat3/core';
import { logger, recordJob, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimOptions, JobDriver, JobRecord } from './driver';
import type { AnyJobHandle } from './job';
import { getJob, registeredJobs } from './job';
import { JOB_OUTCOME_LABELS } from './metrics';
import { SETTLE_GRACE_FACTOR } from './settle-redrive';
import { announceSettled } from './settled';

/** What a claim is told of the jobs: the row carries neither policy, the registry holds both. */
export type BurialPolicy = Required<Pick<ClaimOptions, 'dropExhausted' | 'settleOwed'>>;

/**
 * The names a claim buries `failed` (`retry.deadLetter: false`) and those whose burial owes
 * `onSettled`. Read per claim from the cached registry list: the registry changes at boot.
 */
export function burialPolicy(jobs: readonly AnyJobHandle[] = registeredJobs()): BurialPolicy {
  const dropExhausted: string[] = [];
  const settleOwed: string[] = [];
  for (const handle of jobs) {
    if (handle.retry.deadLetter === false) dropExhausted.push(handle.name);
    if (handle.declaresOnSettled) settleOwed.push(handle.name);
  }
  return { dropExhausted, settleOwed };
}

export interface AnnounceExhaustedOptions {
  /** What `onExhausted` handed this pass — every row the claim buried, as it now stands. */
  readonly exhausted: readonly JobRecord[];
  readonly workerId: string;
  /** The worker's own context: what the job's `onSettled` is scoped from, as a body would be. */
  readonly context: () => Ctx;
  /**
   * The driver that buried them, for its `onSettled` debt: the claim recorded one per buried row
   * of a hooked job, and a telling pays it. With no `settleDebt`, nothing is paid or re-driven.
   */
  readonly driver?: Pick<JobDriver, 'settleDebt'>;
  /** What the tellings measure their time on — the worker's clock. */
  readonly clock?: Clock;
}

/** What one pass buried, by how each row ended — what the worker's own counters take. */
export interface ExhaustedCounts {
  readonly deadLettered: number;
  readonly dropped: number;
}

/**
 * Announce every row one claim pass buried, and answer how each ended. Once per row, because the
 * claim buries a row once: the statement that settled it is the only one that hands it to
 * `onExhausted`. A row buried `failed` is a job declaring `retry.deadLetter: false`
 * (`ClaimOptions.dropExhausted`) — `dropped`, as its own nack would have ended it. Never rejects:
 * `announceSettled` owns a hook's failure, and a `context()` that throws is logged and left owed.
 *
 * The claim stamped every buried row's debt at once, and the leader counts one LOST a grace
 * (`onSettledTimeout` × `SETTLE_GRACE_FACTOR`) after that stamp. The tellings run one after
 * another, so a row is started only while its hook — bounded by `onSettledTimeout`, every try
 * included — still ends inside that grace: the re-drive's own rule (`settle-redrive.ts`). A row
 * past it is left owed, and told once by the leader, never by both at the same time.
 */
export async function announceExhausted(
  options: AnnounceExhaustedOptions,
): Promise<ExhaustedCounts> {
  let dropped = 0;
  // Read before the first hook: the claim's stamp is already behind it, never ahead.
  const buriedAt = nowMs(options.clock);
  for (const record of options.exhausted) {
    const error = record.lastError ?? '';
    const outcome = record.state === 'failed' ? 'dropped' : 'dead-lettered';
    if (outcome === 'dropped') dropped += 1;
    const label = JOB_OUTCOME_LABELS[outcome];
    if (label !== null) recordJob(record.queue, label);
    // `error`, not `warn`: nobody recovered from this one, and a job that outlives every worker
    // that takes it is a crash loop somebody has to look at.
    logger.error('jobs.claim.exhausted', {
      workerId: options.workerId,
      job: record.name,
      jobId: record.id,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      outcome,
      error,
    });
    const handle = getJob(record.name);
    if (handle === undefined) continue;
    const ceiling = handle.onSettledTimeoutMs;
    // Only a job with a hook owes a telling; the claim recorded no debt for the rest.
    if (
      handle.declaresOnSettled &&
      nowMs(options.clock) - buriedAt + ceiling > ceiling * SETTLE_GRACE_FACTOR
    ) {
      logger.warn('jobs.claim.exhausted-left-owed', {
        workerId: options.workerId,
        job: record.name,
        jobId: record.id,
      });
      continue;
    }
    let ctx: Ctx;
    try {
      ctx = options.context();
    } catch (raised) {
      // The app's own function, asked AFTER the row was settled: thrown, it failed the round.
      logger.error('jobs.claim.exhausted-unannounced', {
        workerId: options.workerId,
        job: record.name,
        jobId: record.id,
        error: renderThrowable(raised),
      });
      continue;
    }
    await announceSettled({
      handle,
      claimed: record,
      ctx,
      // No code: nothing was thrown, and `JobFailed.code` is never invented.
      settlement: { outcome, error, code: undefined },
      // The burial did not count a claim: the row's own is the one its debt is fenced on.
      owed: { debt: options.driver?.settleDebt, claim: record.claim ?? 0 },
    });
  }
  return { deadLettered: options.exhausted.length - dropped, dropped };
}

/**
 * The tellings a worker runs BESIDE its claim passes. Inside one, a pass stayed open for as long as
 * its hooks took — up to `onSettledTimeout` × `SETTLE_GRACE_FACTOR` — and the loop's heartbeat
 * judges the pass: a `'5m'` hook was a 503 on a healthy worker. Tracked, so a drain waits them out
 * before the driver closes, and a `tick()` awaits the ones its own pass started.
 */
export interface BurialTeller {
  /** Start telling one claim's burials (none: nothing). Never rejects; `counted` runs as it ends. */
  tell(
    options: AnnounceExhaustedOptions,
    counted: (counts: ExhaustedCounts) => void,
  ): Promise<void>;
  /** Every telling still running. */
  inFlight(): readonly Promise<void>[];
}

export function burialTeller(): BurialTeller {
  const running = new Set<Promise<void>>();
  return {
    tell(options, counted) {
      if (options.exhausted.length === 0) return Promise.resolve();
      const telling = announceExhausted(options)
        .then(counted)
        .catch((raised: unknown) => {
          // `announceExhausted` owns every failure it knows of; this is the one it does not. The
          // debts stay owed, so the leader re-drives them.
          logger.error('jobs.claim.exhausted-telling-failed', {
            workerId: options.workerId,
            error: renderThrowable(raised),
          });
        })
        .finally(() => {
          running.delete(telling);
        });
      running.add(telling);
      return telling;
    },
    inFlight: () => [...running],
  };
}
