// The queues a `worker` serves and the slots each gets: `jobs.queues`, `jobs.concurrency` and
// `jobs.visibilityTimeoutMs` off the app's own `app.config.ts`, and `WORKER_QUEUES` off the
// Deployment's env — the one per-Deployment answer, since every Deployment runs the same image and
// the same config (issues #673, #676).

import type { AppConfig, JobsConcurrency } from '@ultimat3/core';
import {
  ConfigInvalidError,
  logger,
  renderCauseValue,
  renderFixShellArg,
  UltimateError,
} from '@ultimat3/core';
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
  /**
   * `jobs.queues` as the app configured them, kept when `WORKER_QUEUES` replaced `queues`: with
   * the registered jobs' queues, the set an exact entry must belong to (`refuseUnknownQueues`).
   */
  readonly configured: readonly string[];
  readonly concurrency: JobsConcurrency | undefined;
  readonly visibilityTimeoutMs: number | undefined;
}

/** A root with no `app.config.ts`: no queue of its own, and the worker's own timings. */
const NO_WORKER_CONFIG: WorkerConfig = Object.freeze({
  queues: [],
  exact: false,
  configured: [],
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
          configured: config.jobs.queues,
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

/**
 * A `WORKER_QUEUES` entry no registered job and no `jobs.queues` entry names. The worker would
 * claim a queue nothing is enqueued on and leave the real ones waiting while its pod stays Ready —
 * a 15-minute outage behind a healthy roll (`banks-*`, never expanded, 2026-10-27). Refused at
 * boot instead, so the new pods crash and a rolling update stalls on the old ones.
 */
export class WorkerQueueUnknownError extends UltimateError {
  constructor(input: {
    unknown: readonly string[];
    known: readonly string[];
    named: readonly string[];
  }) {
    const patterns = input.unknown.filter((queue) => /[*?[\]{}]/.test(queue));
    // A pattern's fix is its expansion over the known queues: the list the author meant to write.
    const meant = input.named.flatMap((queue) =>
      patterns.includes(queue)
        ? input.known.filter((name) => new Bun.Glob(queue).match(name))
        : input.unknown.includes(queue)
          ? []
          : [queue],
    );
    const list = [...new Set(meant)].join(',');
    const pattern =
      patterns.length === 0
        ? ''
        : ` — WORKER_QUEUES is never expanded, so ${patterns.join(', ')} is a literal queue name`;
    super({
      code: 'X_WORKER_QUEUE_UNKNOWN',
      cause: `${WORKER_QUEUES_ENV} names ${input.unknown.map((queue) => renderCauseValue(queue)).join(', ')}, which no registered job is enqueued on and jobs.queues does not list${pattern}; the queues this app knows are ${input.known.length === 0 ? 'none' : input.known.join(', ')}`,
      fix: `WORKER_QUEUES=${renderFixShellArg(list === '' ? undefined : list, '<queue>,<queue>')} on this Deployment — or add the queue to jobs.queues in app.config.ts when jobs reach it by enqueue({ queue }) alone`,
      meta: { key: WORKER_QUEUES_ENV, unknown: input.unknown, known: input.known },
    });
  }
}

/**
 * An exact worker's entries, held to what the app knows: `jobs.queues` plus every registered
 * job's queue — the union an unset `WORKER_QUEUES` would serve. Thrown, never logged: an info line
 * is what let the worker run claiming nothing (2026-10-27).
 */
function refuseUnknownQueues(
  named: readonly string[],
  configured: readonly string[],
  registered: readonly string[],
): void {
  const known = [...new Set([...configured, ...registered])].sort();
  const unknown = named.filter((queue) => !known.includes(queue));
  if (unknown.length > 0) throw new WorkerQueueUnknownError({ unknown, known, named });
}

type WorkerConfigOptions = Pick<WorkerOptions, 'queues' | 'concurrency' | 'visibilityTimeoutMs'>;

/**
 * The `jobWorker` options the config supplies, read at START so every job the app registered
 * on import is counted — and an exact entry the app does not know is refused there. A key the
 * config leaves unset is omitted, never passed as `undefined`, so the worker's own default applies
 * (`exactOptionalPropertyTypes`).
 */
export function workerOptionsFor(config: WorkerConfig | undefined): WorkerConfigOptions {
  const registered = registeredJobs().map((handle) => handle.queue);
  const exact = config?.exact === true;
  if (exact) refuseUnknownQueues(config?.queues ?? [], config?.configured ?? [], registered);
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
