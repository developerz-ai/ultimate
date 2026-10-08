// The queues a `worker` serves and the slots each gets: `jobs.queues`, `jobs.concurrency` and
// `jobs.visibilityTimeoutMs` off the app's own `app.config.ts`, and `WORKER_QUEUES` off the
// Deployment's env — the one per-Deployment answer, since every Deployment runs the same image and
// the same config (issues #673, #676).

import type { AppConfig, JobsConcurrency } from '@ultimat3/core';
import { ConfigInvalidError, logger, renderCauseValue, renderFixShellArg } from '@ultimat3/core';
import { registeredJobs, type WorkerOptions } from '@ultimat3/jobs';
import type { Env } from './runtime-bindings';

/** The env key a worker Deployment names its queues with: `WORKER_QUEUES=banks,banks-long`. */
export const WORKER_QUEUES_ENV = 'WORKER_QUEUES';

/** What the worker takes from the config. An absent number keeps the worker's own default. */
export interface WorkerConfig {
  readonly queues: readonly string[];
  /**
   * `true` when `WORKER_QUEUES` named `queues`: they are served EXACTLY, never widened by the
   * queues registered jobs are enqueued on. `false` is the union `workerQueuesFor` explains.
   */
  readonly exact: boolean;
  readonly concurrency: JobsConcurrency | undefined;
  readonly visibilityTimeoutMs: number | undefined;
}

/** A root with no `app.config.ts`: no queue of its own, and the worker's own timings. */
const NO_WORKER_CONFIG: WorkerConfig = Object.freeze({
  queues: [],
  exact: false,
  concurrency: undefined,
  visibilityTimeoutMs: undefined,
});

/**
 * `WORKER_QUEUES`, read: `undefined` when unset or blank (`ROLE`'s rule — an empty value is a
 * template that said nothing), else its names trimmed and deduplicated in the order written. An
 * empty entry (`banks,,long`) is REFUSED, not skipped: it is a queue somebody meant to name, and
 * the worker that dropped it would leave that queue's jobs waiting with nothing in the log.
 */
export function workerQueuesFromEnv(env: Env): readonly string[] | undefined {
  const raw = env[WORKER_QUEUES_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const names = raw.split(',').map((name) => name.trim());
  const named = [...new Set(names.filter((name) => name !== ''))];
  if (!names.includes('')) return named;
  throw new ConfigInvalidError({
    cause: `${WORKER_QUEUES_ENV} ${renderCauseValue(raw)} contains an empty queue name — every comma-separated entry must name a queue`,
    fix: `WORKER_QUEUES=${renderFixShellArg(named.join(','), '<queue>,<queue>')} on this Deployment — or unset WORKER_QUEUES to serve jobs.queues and every registered job's queue`,
    meta: { key: WORKER_QUEUES_ENV },
  });
}

export function workerConfigOf(config: AppConfig | undefined, env: Env = {}): WorkerConfig {
  const fromEnv = workerQueuesFromEnv(env);
  const base =
    config === undefined
      ? NO_WORKER_CONFIG
      : {
          queues: config.jobs.queues,
          exact: false,
          concurrency: config.jobs.concurrency,
          visibilityTimeoutMs: config.jobs.visibilityTimeoutMs,
        };
  return fromEnv === undefined ? base : { ...base, queues: fromEnv, exact: true };
}

/**
 * The queues a worker serves: the configured ones, then every queue a registered job is enqueued
 * on. The union and not the list, decided 2026-09-23: `x new` and the deployed demo configure
 * `['<app>-default']` while a `job()` naming no queue lands on `default`, so obeying the list alone
 * would leave every such job queued for ever — the silent direction. `exact` (a Deployment that
 * set `WORKER_QUEUES`) is the list alone: that operator split the queues across Deployments on
 * purpose, and widening one to the rest is what made their grace periods mean nothing (#673).
 * `undefined` when nothing is served, which is `jobWorker`'s own `['default']`.
 */
export function workerQueuesFor(
  configured: readonly string[],
  registered: readonly string[],
  exact = false,
): readonly string[] | undefined {
  const served = [...new Set(exact ? configured : [...configured, ...registered])];
  return served.length === 0 ? undefined : served;
}

/**
 * An exact worker's one boot line about what it leaves: the queues registered jobs are enqueued
 * on that it will never claim. A warning and not a refusal — another Deployment serving them is
 * the whole point of the split — but this process cannot see that one, so it says what to check.
 */
function reportUnserved(served: readonly string[], registered: readonly string[]): void {
  const queues = [...new Set(registered)].filter((queue) => !served.includes(queue)).sort();
  if (queues.length === 0) return;
  logger.warn('jobs.worker.queue-unserved', {
    queues,
    served,
    fix: `x jobs list --json — every queue listed with no worker needs one: WORKER_QUEUES=<queue>,<queue> on another worker Deployment, or add it to this one's`,
  });
}

type WorkerConfigOptions = Pick<WorkerOptions, 'queues' | 'concurrency' | 'visibilityTimeoutMs'>;

/**
 * The `jobWorker` options the config supplies, read at START so every job the app registered
 * on import is counted. A key the config leaves unset is omitted, never passed as `undefined`, so
 * the worker's own default applies (`exactOptionalPropertyTypes`).
 */
export function workerOptionsFor(config: WorkerConfig | undefined): WorkerConfigOptions {
  const registered = registeredJobs().map((handle) => handle.queue);
  const exact = config?.exact === true;
  const queues = workerQueuesFor(config?.queues ?? [], registered, exact);
  if (exact) reportUnserved(queues ?? [], registered);
  // Passed as written: `jobWorker` reads a table by own key and runs a queue it does not name at
  // core's `JOBS_CONCURRENCY_DEFAULT` — the one slot default, so no second table is built here.
  const concurrency = config?.concurrency;
  return {
    ...(queues === undefined ? {} : { queues }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(config?.visibilityTimeoutMs === undefined
      ? {}
      : { visibilityTimeoutMs: config.visibilityTimeoutMs }),
  };
}
