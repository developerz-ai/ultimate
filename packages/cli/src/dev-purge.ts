// The retention sweep this boot owns: the three framework tables that grow with traffic, the
// `purge()` job that empties them and the `task` that fires it hourly.
//
// WHY here and not in the packages that own the tables: `postgresIdempotencyStore` (tier 3),
// `postgresRateLimitStore` (tier 2) and `postgresAuthLimiter` (tier 2) cannot see each other and
// none of them may import `@ultimat3/jobs`. Boot is the one place that holds all three, which is
// the same reason it is boot that applies their DDL and installs them.
//
// WHY they had no caller at all until now: each store shipped a `purgeExpired()` documented as
// "an app runs this from a `task`" — and a task only ENQUEUES, so there was no job for one to
// enqueue and no app wrote either half. `x_rate_limit` takes one upsert per HTTP request the web
// role serves, assets included, so every deployment the framework produces was accumulating a row
// per source address forever.

import type { PostgresIdempotencyStore } from '@ultimat3/action';
import { purgeAuthLimits } from '@ultimat3/auth';
import type { PostgresRateLimitStore } from '@ultimat3/http';
import type { JobHandle, PurgeInput, PurgeTarget } from '@ultimat3/jobs';
import { DEFAULT_PURGE_CRON, getJob, getTask, purge, task } from '@ultimat3/jobs';

/** The durable queue key. Pinned, like every framework-owned job name — rows carry it. */
export const PURGE_JOB_NAME = 'x.purge';
/** The scheduler's key for the same sweep: `lastFiredAt` and the occurrence lock read it. */
export const PURGE_TASK_NAME = 'x.purge.hourly';

/**
 * The two stores this boot BUILT, handed over rather than rebuilt here. A second
 * `postgresIdempotencyStore({ executor })` would sweep on the default window even where the boot
 * had configured another — two answers to "how long is a record kept", and the shorter one
 * deletes reservations a retry is still entitled to.
 *
 * The auth limiter is absent on purpose: it does not exist yet at boot. `defineAuth` builds it
 * through the factory `configureAuthLimiters` installed, and that happens when the app's modules
 * import — after this. `purgeAuthLimits()` is the seam that reads whatever was built.
 */
export interface RetentionStores {
  readonly idempotency: PostgresIdempotencyStore;
  readonly rateLimit: PostgresRateLimitStore;
}

/**
 * Read per attempt by the job, and emptied by the disposer `installRetentionSweep` returns: a
 * sweep left declared after its boot has stopped must not reach through a closed pool. Module
 * scope for the reason `setJobDriver` and `configureKdfGate` are — a process has one boot at a
 * time, and the registry the job lives in is process-wide too.
 */
let installed: readonly PurgeTarget[] = [];

/** Declared once per process and re-declared only if a `resetJobs()` took it out of the registry. */
let sweep: JobHandle<PurgeInput> | undefined;

/**
 * `x_auth_failures` and `x_auth_lockouts` together, under the prefix they share: one target,
 * because `purgeAuthLimits()` clears both in one statement and two targets under one pair of
 * tables would be a second delete that removes nothing.
 */
const authTarget: PurgeTarget = {
  name: 'x_auth',
  // No `nowMs`: a limiter built through the seam holds the clock its host handed it, which is the
  // clock every `at_ms` in those tables was written from.
  purgeExpired: () => purgeAuthLimits(),
};

function retentionTargets(stores: RetentionStores): readonly PurgeTarget[] {
  return [
    {
      name: 'x_idempotency',
      purgeExpired: (): Promise<number> => stores.idempotency.purgeExpired(),
    },
    {
      name: 'x_rate_limit',
      // The job's clock, not the server's. `last_ms` is written by whichever process took the
      // token, so a purge measured against `now()` in Postgres computes a refill from the offset
      // between two clocks — and against a frozen one it read 20,000,000 seconds of refill and
      // deleted a bucket holding 0 of 4 tokens, which is a free limit reset from the cleanup.
      purgeExpired: (nowMs: number): Promise<number> => stores.rateLimit.purgeExpired(nowMs),
    },
    authTarget,
  ];
}

/**
 * Declared lazily and guarded on the registry rather than on a module flag alone: `resetJobs()` /
 * `resetTasks()` empty the registries a test shares with the next boot, and a memoised handle that
 * is no longer seated is one the worker's `getJob` can never find.
 */
function declareSweep(): void {
  if (getJob(PURGE_JOB_NAME) === undefined) {
    sweep = purge({ name: PURGE_JOB_NAME, targets: () => installed });
  }
  const handle = sweep;
  if (handle !== undefined && getTask(PURGE_TASK_NAME) === undefined) {
    task({
      name: PURGE_TASK_NAME,
      cron: DEFAULT_PURGE_CRON,
      // The one zone a framework-shipped schedule may name: an app's business hours are the app's,
      // and a retention sweep has none. `tz` is required by `task()` and never inferred.
      tz: 'UTC',
      // `skip`, the default: a scheduler that was down across four occurrences has four sweeps'
      // worth of expired rows in one table, and one pass removes all of them. Replaying the missed
      // occurrences would be three passes that each delete nothing.
      enqueue: () => [[handle, {}]],
    });
  }
}

/**
 * Put the sweep on the queue's registry and its schedule, and answer the release.
 *
 * IF NOTHING EVER RUNS IT the tables grow exactly as they did before — the sweep is a `job`, so it
 * needs a `worker` to claim it and a `scheduler` to enqueue it. A deployment with neither has no
 * background work at all, and this is one more thing it does not do.
 */
export function installRetentionSweep(stores: RetentionStores): () => void {
  installed = retentionTargets(stores);
  declareSweep();
  return () => {
    installed = [];
  };
}
