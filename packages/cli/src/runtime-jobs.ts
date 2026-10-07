// `jobs.queues`, `jobs.concurrency` and `jobs.visibilityTimeoutMs`, read out of the app's own
// `app.config.ts` for the `worker` role, out of the config `startServices` loads once. Until 22.0.0
// `jobWorker` was called with none of them, so a `mail` queue ran nothing.

import type { AppConfig } from '@ultimat3/core';
import { registeredJobs, type WorkerOptions } from '@ultimat3/jobs';

/** What the worker takes from the config. An absent number keeps the worker's own default. */
export interface WorkerConfig {
  readonly queues: readonly string[];
  readonly concurrency: number | undefined;
  readonly visibilityTimeoutMs: number | undefined;
}

/** A root with no `app.config.ts`: no queue of its own, and the worker's own timings. */
const NO_WORKER_CONFIG: WorkerConfig = Object.freeze({
  queues: [],
  concurrency: undefined,
  visibilityTimeoutMs: undefined,
});

export function workerConfigOf(config: AppConfig | undefined): WorkerConfig {
  if (config === undefined) return NO_WORKER_CONFIG;
  const { queues, concurrency, visibilityTimeoutMs } = config.jobs;
  return { queues, concurrency, visibilityTimeoutMs };
}

/**
 * The queues a worker serves: the configured ones, then every queue a registered job is enqueued
 * on. The union and not the list, decided 2026-09-23: `x new` and the deployed demo configure
 * `['<app>-default']` while a `job()` naming no queue lands on `default`, so obeying the list alone
 * would leave every such job queued for ever — the silent direction. `undefined` when both are
 * empty, which is `jobWorker`'s own `['default']`.
 */
export function workerQueuesFor(
  configured: readonly string[],
  registered: readonly string[],
): readonly string[] | undefined {
  const served = [...new Set([...configured, ...registered])];
  return served.length === 0 ? undefined : served;
}

type WorkerConfigOptions = Pick<WorkerOptions, 'queues' | 'concurrency' | 'visibilityTimeoutMs'>;

/**
 * The `jobWorker` options the config supplies, read at START so every job the app registered
 * on import is counted. A key the config leaves unset is omitted, never passed as `undefined`, so
 * the worker's own default applies (`exactOptionalPropertyTypes`).
 */
export function workerOptionsFor(config: WorkerConfig | undefined): WorkerConfigOptions {
  const queues = workerQueuesFor(
    config?.queues ?? [],
    registeredJobs().map((handle) => handle.queue),
  );
  return {
    ...(queues === undefined ? {} : { queues }),
    ...(config?.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    ...(config?.visibilityTimeoutMs === undefined
      ? {}
      : { visibilityTimeoutMs: config.visibilityTimeoutMs }),
  };
}
